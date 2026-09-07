/**
 * MCP JSON-RPC method handlers for the HR app.
 *
 * UI delivery follows this runtime's split-asset contract: the shell
 * (`builtUi.renderHtml()`) and its hashed `assets/` files travel over separate
 * `resources/read` calls, so the Hub fetches each asset once per installation
 * generation and re-serves it from its own origin. In development the live Vite
 * dev server is the single source of truth instead (HMR + breakpoints).
 *
 * Backend tools are the ones the HR UI calls:
 *   - `hr_management_dashboard` — the UI resource itself.
 *   - `debug_log`              — frontend → IDE terminal logging.
 *   - `hrm.payroll.*`          — passthrough to the Hub's `privos.db.*`.
 *   - `hrm.mail.send/retry`    — queued EmailJS delivery + Room email history.
 *   - `hr_bulk_export`         — license-guarded bulk export.
 * Everything reaching the Hub from here goes through `callHubTool`
 * (`hub-tool-call.ts`), this runtime's replacement for the legacy outbound
 * relay `tools/call`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

import {
	serveBuiltUi,
	INVALID_PARAMS,
	type ServeBuiltUi,
} from '@privos_ai/app-server';

import _pkg from '../privos-app.json';
import { getAppIconDataUri } from './app-icon';
import { createLicenseGuard } from './license';
import { callHubTool } from './hub-tool-call';
import { EmailHistoryRepository } from './services/EmailHistoryRepository';
import { mailService } from './services/MailService';
import { TrackedMailService } from './services/TrackedMailService';
import { isValidEmailAddress } from './utils/email-validation';

const pkg = _pkg as Record<string, any>;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const TOOL_NAME = 'hr_management_dashboard';
const BULK_EXPORT_TOOL = 'hr_bulk_export';

const trackedMailService = new TrackedMailService(new EmailHistoryRepository(callHubTool), mailService);

/**
 * `ui://<appSlug>/…` — `appSlug` MUST be `app.appId`, i.e. `privos-app.json`'s `name`,
 * never a different, human-friendlier host string. The Hub resolves `serveBuiltUi`'s
 * asset/manifest URIs from the registered app id, not from this resource URI — a mismatch
 * here 404s every asset behind a correct-looking "App assets unavailable" watchdog.
 */
const UI_RESOURCE_URI = `ui://${pkg.name}/form.html`;
/** `appSlug` for `serveBuiltUi` — must equal `app.appId`. Derived from {@link UI_RESOURCE_URI}'s
 * host so the two can never drift apart. */
const UI_APP_SLUG = new URL(UI_RESOURCE_URI).host;
/** Sits beside {@link UI_RESOURCE_URI}, not under the `assets/` prefix — the SDK's own convention. */
const ASSETS_MANIFEST_URI = `${UI_RESOURCE_URI.slice(0, UI_RESOURCE_URI.lastIndexOf('/') + 1)}assets-manifest.json`;

const appIcon = getAppIconDataUri();

/** The tool list this app answers `tools/list` with — the exact set declared in the manifest. */
const TOOL_DEFINITIONS = (pkg.tools as any[] | undefined)?.map((tool) => ({
	name: tool.name,
	title: tool.title,
	description: tool.description,
	inputSchema: tool.inputSchema,
	...(tool.ui ? { _meta: { ui: tool.ui } } : {}),
})) ?? [];

const DIST_UI_DIR = path.join(moduleDir, '../dist/ui');
const DIST_UI_INDEX = path.join(DIST_UI_DIR, 'index.html');

/**
 * Built lazily, and rebuilt whenever `dist/ui/index.html` changes on disk.
 *
 * Lazily, because constructing before `dist/ui` exists (e.g. `npm test` runs ahead of
 * `npm run build`) must not crash every caller that merely imports this module.
 * `serveBuiltUi` throws at construction on a malformed build (non-relative asset tags,
 * unhashed/oversized/`.map` files under `assets/`) — that failure surfaces the first time
 * the UI is actually requested, never earlier.
 *
 * Rebuilt on change, because `serveBuiltUi` caches the shell HTML and the asset list at
 * construction. A server left running across a `npm run build` would otherwise keep serving
 * the PREVIOUS shell, whose hashed filenames the build just replaced: the Hub asks for an
 * asset that no longer exists on disk, `readAsset` returns null, and the browser gets a 400
 * from the Hub's own UI route with no clue that a stale in-process cache caused it. The
 * mtime check restores the invalidation the pre-migration handler had.
 */
let builtUi: ServeBuiltUi | null = null;
let builtUiMtimeMs = 0;
function getBuiltUi(): ServeBuiltUi {
	let mtimeMs = 0;
	try {
		mtimeMs = fs.statSync(DIST_UI_INDEX).mtimeMs;
	} catch {
		// Leave it at 0 and let `serveBuiltUi` report the missing build in its own words.
	}
	if (!builtUi || mtimeMs !== builtUiMtimeMs) {
		builtUi = serveBuiltUi({ distDir: DIST_UI_DIR, appSlug: UI_APP_SLUG });
		builtUiMtimeMs = mtimeMs;
	}
	return builtUi;
}

/**
 * When set, the UI is served live from a Vite dev server at this public origin
 * (HMR + breakpoints) instead of the split production bundle. See dev-server.ts.
 */
let devPublicUrl: string | null = null;

/** Enable dev mode: iframe loads UI from the Vite dev server at `publicUrl`. */
export function setDevPublicUrl(publicUrl: string): void {
	devPublicUrl = publicUrl.replace(/\/$/, '');
}

/** The shell HTML for the current mode — live dev server, or the built-and-cached production shell. */
function currentShellHtml(): string {
	return devPublicUrl ? getDevUiHtml(devPublicUrl) : getBuiltUi().renderHtml();
}

/** Wrap a value in the MCP text-content envelope the frontend parses. */
function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
	return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

/** Handle an incoming MCP JSON-RPC request and return the result. */
export async function handleMcpMessage(method: string, _id: number, params: any): Promise<any> {
	switch (method) {
		case 'initialize':
			return {
				protocolVersion: '2025-03-26',
				capabilities: {
					tools: {},
					extensions: {
						'io.modelcontextprotocol/ui': {
							mimeTypes: ['text/html;profile=mcp-app'],
						},
					},
				},
				serverInfo: {
					name: pkg.title || pkg.name,
					version: pkg.version,
					...(appIcon && { icon: appIcon }),
					// Advertise the exact schema-v3 declaration; Hub owns catalog metadata
					// and still enforces the approved subset server-side.
					...(Array.isArray(pkg.permissions) && { permissions: pkg.permissions }),
				},
			};

		case 'notifications/initialized':
			return {};

		case 'tools/list':
			return { tools: TOOL_DEFINITIONS };

		case 'tools/call':
			return handleToolCall(params);

		case 'resources/read':
			return handleResourcesRead(params?.uri);

		default:
			throw new Error(`Unknown method: ${method}`);
	}
}

async function handleToolCall(params: any): Promise<any> {
	const name: string | undefined = params?.name;

	if (name === 'debug_log') {
		console.log('\n\n--- [FRONTEND DEBUG LOG] ---');
		console.log(params.arguments?.message);
		console.log(JSON.stringify(params.arguments?.data, null, 2));
		console.log('----------------------------\n\n');
		return textResult('Logged to terminal');
	}

	if (name === BULK_EXPORT_TOOL) {
		const records = Array.isArray(params?.arguments?.records) ? params.arguments.records : [];
		const guard = createLicenseGuard();
		guard.assert('bulk-export');
		guard.assertWithin('records', records.length);
		return textResult({ exported: records.length, records });
	}

	// `hrm.payroll.*` is a thin backend alias for the Hub's own `privos.db.*`
	// collection tools, kept so the payroll UI keeps one stable tool namespace.
	// `roomId` names the room the Hub resolves this app's grant against; it is
	// transport metadata, not a `privos.db.*` argument, so it is stripped here.
	if (name?.startsWith('hrm.payroll.')) {
		const hubToolName = name.replace('hrm.payroll.', 'privos.db.');
		const { password: _password, roomId, ...safeArgs } = { ...(params.arguments || {}) } as Record<string, unknown>;
		return callHubTool(hubToolName, safeArgs, typeof roomId === 'string' ? roomId : undefined);
	}

	if (name === 'hrm.mail.send') {
		const args = params.arguments;
		console.log('[MCP DEBUG] Đã nhận yêu cầu hrm.mail.send:', { toEmail: args?.toEmail, subject: args?.subject });

		if (!args?.toName || !args?.toEmail || !args?.subject || !args?.htmlContent) {
			throw new Error('Missing required arguments for hrm.mail.send');
		}
		if (!isValidEmailAddress(args.toEmail)) {
			throw new Error('Recipient email is invalid for hrm.mail.send');
		}

		if (args.roomId || args.source) {
			if (!args.roomId || (args.source !== 'cv_scored' && args.source !== 'lifecycle')) {
				throw new Error('Tracked mail requires roomId and a supported source');
			}
			const record = await trackedMailService.send({
				roomId: args.roomId,
				source: args.source,
				recipientName: args.toName,
				recipientEmail: args.toEmail,
				subject: args.subject,
				htmlContent: args.htmlContent,
				cvItemId: args.cvItemId,
				cvListId: args.cvListId,
				jdName: args.jdName,
				requestedBy: args.requestedBy,
			});
			return textResult({ itemId: record.id, status: record.status });
		}

		await mailService.queueMail({
			toName: args.toName,
			toEmail: args.toEmail,
			subject: args.subject,
			htmlContent: args.htmlContent,
		});

		return textResult('Email has been sent successfully.');
	}

	if (name === 'hrm.mail.retry') {
		const args = params.arguments;
		if (!args?.roomId || !args?.itemId) {
			throw new Error('Missing required arguments for hrm.mail.retry');
		}
		const record = await trackedMailService.retry(args.roomId, args.itemId);
		return textResult({ itemId: record.id, status: record.status });
	}

	if (name !== TOOL_NAME) {
		throw new Error(`Unknown tool: ${name || '<missing>'}`);
	}
	return {
		content: [
			{
				type: 'resource',
				resource: {
					uri: UI_RESOURCE_URI,
					mimeType: 'text/html;profile=mcp-app',
					text: currentShellHtml(),
				},
			},
		],
	};
}

/**
 * `resources/read` branches on the requested URI: the shell, the assets manifest, or one
 * split asset. Any other URI is refused rather than silently echoing the UI HTML.
 *
 * Dev mode short-circuits ahead of all of this: the live Vite dev server is the only
 * source of truth there (no split assets exist to read), so it keeps echoing the dev
 * shell for whatever URI was requested.
 */
function handleResourcesRead(uri: unknown): { contents: unknown[] } {
	if (devPublicUrl) {
		return {
			contents: [
				{
					uri: typeof uri === 'string' ? uri : UI_RESOURCE_URI,
					mimeType: 'text/html;profile=mcp-app',
					text: currentShellHtml(),
				},
			],
		};
	}

	if (uri === UI_RESOURCE_URI) {
		return { contents: [{ uri: UI_RESOURCE_URI, mimeType: 'text/html;profile=mcp-app', text: currentShellHtml() }] };
	}

	if (uri === ASSETS_MANIFEST_URI) {
		return {
			contents: [{ uri: ASSETS_MANIFEST_URI, mimeType: 'application/json', text: JSON.stringify(getBuiltUi().readAssetsManifest()) }],
		};
	}

	const asset = typeof uri === 'string' ? getBuiltUi().readAsset(uri) : null;
	if (asset) return { contents: [asset] };

	// Log the refused URI: the SDK's `mcp.request.error` event carries only the error
	// code, so an appSlug/manifest mismatch (the Hub asking under a stale pinned
	// manifest) is otherwise invisible on this side of the relay.
	const requested = typeof uri === 'string' ? uri : '<missing>';
	console.error(`[resources/read] refused unknown resource: ${requested} (this app serves ${UI_RESOURCE_URI})`);
	throw Object.assign(new Error(`Unknown resource: ${requested}`), { code: INVALID_PARAMS });
}

/**
 * Build HTML referencing a live Vite dev server (HMR + TypeScript breakpoints).
 * Loads @vite/client and the React Fast Refresh preamble cross-origin from the
 * tunnel, then the real entry module — equivalent to what Vite injects into a
 * transformed index.html, but emitted here since the relay serves the document.
 */
function getDevUiHtml(publicUrl: string): string {
	const base = `${publicUrl}/ui`;
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${pkg.title || 'HR & HRM'} (dev)</title>
  <script type="module" src="${base}/@vite/client"></script>
  <script type="module">
    import RefreshRuntime from "${base}/@react-refresh";
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${base}/main.tsx"></script>
</body>
</html>`;
}
