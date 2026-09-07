import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

import appManifest from '../privos-app.json';
import { handleMcpMessage } from '../src/mcp-message-handlers';

// Read the real `resourceUri` off the published manifest rather than duplicating it as a second
// literal — the wire contract requires `appSlug` (the `ui://` host) to equal `app.appId`
// (`privos-app.json`'s `name`), and a hardcoded literal here could drift from both independently
// and hide exactly the mismatch this file exists to catch.
const uiTool = (appManifest.tools as { ui?: { resourceUri?: string } }[]).find((tool) => tool.ui?.resourceUri);
const UI_RESOURCE_URI = uiTool!.ui!.resourceUri!;
const ASSETS_MANIFEST_URI = `${UI_RESOURCE_URI.slice(0, UI_RESOURCE_URI.lastIndexOf('/') + 1)}assets-manifest.json`;
const ASSET_URI_PREFIX = `${UI_RESOURCE_URI.slice(0, UI_RESOURCE_URI.lastIndexOf('/') + 1)}assets/`;

// `verify:fast-pr` runs `test` before `build`, so these assertions on the production shell/asset
// contract cannot assume `dist/ui` already exists — build it here first, the same way
// packaging.spec.ts self-invokes its own script instead of assuming prior pipeline steps ran.
beforeAll(() => {
  // Invoke vite's JS entry through the current node binary rather than the
  // `node_modules/.bin/vite` shim: on Windows the extensionless shim is a shell
  // script Node cannot spawn, so this silently threw ENOENT and skipped every
  // assertion below — including the appSlug check this file exists to make.
  const result = spawnSync(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), 'build'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `vite build failed ahead of the UI shell tests:\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  }
}, 120_000);

describe('UI resource identity (appSlug = app.appId, never a different host)', () => {
  it('keeps the ui:// host equal to the registered app id — a mismatch 404s every asset', () => {
    expect(new URL(UI_RESOURCE_URI).host).toBe(appManifest.name);
  });
});

describe('built UI shell and split assets', () => {
  it('serves a shell with the relay meta tag, the boot watchdog, and only relative asset tags', async () => {
    const result = await handleMcpMessage('resources/read', 1, { uri: UI_RESOURCE_URI });
    const html = result.contents[0].text as string;

    expect(html).toContain('<meta name="privos-ui-assets" content="relay">');
    expect(html).toContain('__privosUiBooted');
    expect(html).toContain('ui/asset-load-failed');
    // Every script/link tag must reference `./assets/…` — never an absolute or external URL.
    for (const match of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)) {
      expect(match[1]).toMatch(/^\.?\/?assets\//);
    }
  });

  /**
   * The other half of the watchdog contract, and the one that actually bit: the shell's
   * `setTimeout(fail, 10000)` wipes `#root` unless the app sets `window.__privosUiBooted` on its
   * first commit. A UI that renders perfectly but never sets the flag looks fine for ten seconds
   * and is then replaced by "App assets unavailable — Retry", on a loop, with nothing wrong on the
   * server side at all. Assert the built bundle carries the assignment.
   */
  it('ships a bundle that sets the watchdog success flag', async () => {
    const result = await handleMcpMessage('resources/read', 2, { uri: ASSETS_MANIFEST_URI });
    const { files } = JSON.parse(result.contents[0].text as string) as { files: { name: string }[] };
    const bundles = files
      .filter((file) => file.name.endsWith('.js'))
      .map((file) => fs.readFileSync(path.resolve('dist/ui/assets', file.name), 'utf8'));

    expect(bundles.some((code) => /__privosUiBooted\s*=\s*!0|__privosUiBooted\s*=\s*true/.test(code))).toBe(true);
  });

  it('lists build files through the sibling assets-manifest resource', async () => {
    const result = await handleMcpMessage('resources/read', 3, { uri: ASSETS_MANIFEST_URI });
    const manifest = JSON.parse(result.contents[0].text as string) as { files: { name: string; size: number; type: string }[] };

    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.files.some((f) => f.name.endsWith('.js'))).toBe(true);
    expect(manifest.files.some((f) => f.name.endsWith('.css'))).toBe(true);
    // Every asset must stay under the wire contract's 2 MB per-file cap; the heavy
    // document/spreadsheet libraries are split into their own chunks to keep it that way.
    for (const file of manifest.files) expect(file.size).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  /**
   * `hashCharacters: 'hex'` in vite.config.ts, asserted rather than assumed. Rollup's default
   * base64url alphabet includes `-` and `_`, so roughly one build in thirty emits a name like
   * `index--IpuopkB.js`. The SDK's own filename rule tolerates it, but the double dash then
   * has to survive every other consumer of that shared rule — including the Hub route that
   * re-serves these files — and a name that only fails on some builds reads as a code
   * regression, not a build one. Hex hashes cannot produce it.
   */
  it('emits hex-hashed asset names with no separator ambiguity', async () => {
    const result = await handleMcpMessage('resources/read', 9, { uri: ASSETS_MANIFEST_URI });
    const { files } = JSON.parse(result.contents[0].text as string) as { files: { name: string }[] };

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.name, `${file.name} is not <name>-<hexhash>.<ext>`).toMatch(
        /^[A-Za-z0-9][A-Za-z0-9._]*-[0-9a-f]{8,}\.[a-z0-9]+$/,
      );
    }
  });

  it('serves a listed asset and refuses an unlisted or .map uri with JSON-RPC -32602', async () => {
    const manifestResult = await handleMcpMessage('resources/read', 4, { uri: ASSETS_MANIFEST_URI });
    const { files } = JSON.parse(manifestResult.contents[0].text as string) as { files: { name: string }[] };
    const jsFile = files.find((f) => f.name.endsWith('.js'))!;

    const asset = await handleMcpMessage('resources/read', 5, {
      uri: `${ASSET_URI_PREFIX}${jsFile.name}`,
    });
    expect(asset.contents[0].mimeType).toBe('text/javascript');
    expect(typeof asset.contents[0].text).toBe('string');

    const unknown = await handleMcpMessage('resources/read', 6, {
      uri: `${ASSET_URI_PREFIX}does-not-exist.js.map`,
    }).catch((err: Error & { code?: number }) => err);
    expect(unknown).toBeInstanceOf(Error);
    expect((unknown as Error & { code?: number }).code).toBe(-32602);
  });

  /**
   * `serveBuiltUi` caches the shell and the asset list at construction, so a server left
   * running across a rebuild would serve the previous shell — referencing hashed filenames the
   * build has already deleted. The Hub then 400s on its own UI route and nothing points at the
   * stale in-process cache. Assert the handler notices a new build instead.
   */
  it('picks up a rebuilt dist/ui without a server restart', async () => {
    const indexPath = path.resolve('dist/ui/index.html');
    const original = fs.readFileSync(indexPath, 'utf8');

    const before = await handleMcpMessage('resources/read', 10, { uri: UI_RESOURCE_URI });
    expect(before.contents[0].text).not.toContain('<!--rebuilt-marker-->');

    try {
      fs.writeFileSync(indexPath, original.replace('</head>', '<!--rebuilt-marker-->\n</head>'));
      const after = await handleMcpMessage('resources/read', 11, { uri: UI_RESOURCE_URI });
      expect(after.contents[0].text).toContain('<!--rebuilt-marker-->');
    } finally {
      fs.writeFileSync(indexPath, original);
    }
  });

  it('serves the identical shell from both the tools/call embedded resource and resources/read', async () => {
    const viaResourcesRead = await handleMcpMessage('resources/read', 7, { uri: UI_RESOURCE_URI });
    const viaToolsCall = await handleMcpMessage('tools/call', 8, {
      name: 'hr_management_dashboard',
      arguments: {},
    });
    expect(viaToolsCall.content[0].resource.text).toBe(viaResourcesRead.contents[0].text);
  });
});
