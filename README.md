# HR & HRM — PrivOS MCP app

An HR management app for PrivOS: recruitment boards, a CV screening pipeline, employee lifecycle
profiles, payroll, document drafting, and room email history — delivered as one dashboard inside the
Hub iframe, backed by an MCP app server.

This is the HR Mini App, migrated onto the published `@privos_ai/app-react` and
`@privos_ai/app-server` packages. It builds and runs entirely from this repository; there is no
local package checkout to link.

## The dashboard

One tool, `hr_management_dashboard`, opens the whole UI. Its tabs:

| Tab | What it does | Source |
|---|---|---|
| **Company** | Company profile and the room assistant that crawls and summarises a company website. | [`src/ui/company-home.tsx`](src/ui/company-home.tsx) |
| **Email** | Room email history mailbox — sent/failed per source, with retry. | [`src/ui/email-history/`](src/ui/email-history/) |
| **Tuyển dụng** | Recruitment boards: openings, JDs, candidate intake. | [`src/ui/recruitment-panel.tsx`](src/ui/recruitment-panel.tsx) |
| **CV Pipeline** | Uploads CVs, drives the screening agent, tracks each candidate through the pipeline. | [`src/ui/pipeline-dashboard.tsx`](src/ui/pipeline-dashboard.tsx), [`src/ui/pipeline-service.ts`](src/ui/pipeline-service.ts) |
| **CV đã chấm** | Scored CVs on a kanban board, with interview-invitation mail from an editable template. | [`src/ui/cv-scored/`](src/ui/cv-scored/) |
| **Chỉnh sửa JD** | Conversational JD editing against the room assistant. | [`src/ui/jd-chatbot-functional.tsx`](src/ui/jd-chatbot-functional.tsx) |
| **Hồ sơ NS** | Employee lifecycle: profiles, onboarding kanban, employee mail. | [`src/ui/lifecycle/`](src/ui/lifecycle/) |
| **Quản lý Lương** | Payroll records and XLSX export. Visible only to a room owner, re-checked on a poll. | [`src/ui/payroll/`](src/ui/payroll/) |
| **Bot soạn thảo** | Document drafting from HR / internal / ND-30 templates, exported to DOCX. | [`src/ui/bot-drafting-tab.tsx`](src/ui/bot-drafting-tab.tsx), [`src/ui/drafting/`](src/ui/drafting/) |

Everything the iframe calls runs **as the current user** through the host bridge (`app.rest()`,
`app.callServerTool()`, `app.uploadFile()`), gated by this installation's approved grant.

## Backend tools

| Tool | Purpose |
|---|---|
| `hr_management_dashboard` | Serves the UI resource. |
| `debug_log` | Frontend → app-server terminal logging. |
| `hrm.payroll.query` / `.create` / `.update` / `.delete` | Passthrough to the Hub's `privos.db.*` payroll collection. |
| `hrm.mail.send` | Queued EmailJS delivery plus a room email-history record. |
| `hrm.mail.retry` | Re-sends one failed history record from its stored recipient and content. |
| `hr_bulk_export` | License-guarded bulk export (Pro tier). |

### How the backend reaches the Hub

The legacy environment pushed an outbound `tools/call` back up the app's own relay socket. That
direction does not exist on this runtime: the SDK's Relay client is Hub → app dispatch only. The
two features that must work with no browser session attached — the `hrm.payroll.*` passthrough and
the room email history — instead call `POST /api/v1/mcp-apps.tool-call` with this app's own
**installation agent-bot credential**, which a workspace admin issues from the app's settings page
(`PRIVOS_AGENT_BOT_USER_ID` + `PRIVOS_AGENT_BOT_CREDENTIAL`).

See [`src/hub-tool-call.ts`](src/hub-tool-call.ts). Every such call carries the `roomId` it is
acting in, so the Hub resolves the grant against the right room; without the credential those two
features report a clear configuration error and nothing else in the dashboard is affected.

## Runtime trust model

`@privos_ai/app-server`'s `resolveRuntimeMode()` picks exactly one of three modes, in this
precedence, and never guesses:

1. **`managed`** — a workload identity socket is present (App Cluster mounts one per
   installation). No pair URL, OAuth client secret, or browser user token is ever used.
2. **`standalone-production`** — a paired standalone identity file is present (see
   [Standalone production](#standalone-production-self-hosted-against-a-standalone-hub) below).
3. **`development`** — neither is present, and `NODE_ENV` is not `production`.

Both a workload socket and a paired identity file present is a fatal startup error (stale state
from a prior deployment mode, or a misconfigured host — never silently picked). `NODE_ENV=production`
with neither is also a fatal startup error: there is no unsigned-production fallback in any mode.

In `managed` mode, App Cluster mounts a per-installation Unix socket. `@privos_ai/app-server`
creates an ephemeral P-256 DPoP key in memory, obtains short-lived sender-constrained workload
tokens through the socket, and refreshes them without writing credentials to disk or environment
variables. Hub-to-app `/mcp` requests travel through private Cluster dispatch and carry a
short-lived signed assertion bound to the request body, installation, replica, receipt hash, and
permission epoch. The iframe receives only non-secret host context.

Production accepts these non-secret values from the platform:

- `PRIVOS_HUB_ORIGIN`
- `PRIVOS_APP_ID`
- `PRIVOS_INSTALLATION_ID`
- `PRIVOS_WORKLOAD_SOCKET` (normally `/run/privos/identity.sock`)

## Local development

Requirements: Node.js 22+, npm, Git, and Docker.

```bash
npm ci
cp .env.example .env
npm run dev
```

`npm run dev` resolves to `development` mode (no workload socket, no paired identity file) and
connects over the Relay WebSocket. Obtain a pairing URL from PrivOS Admin and paste it into the
prompt; credentials — including `MCP_APP_ID`, which every backend Hub call needs — are cached to
`.env` for the next run. This relaxed-compatibility path is only ever reachable when `NODE_ENV` is
not `production`; the SDK's mode resolver refuses `development` outright otherwise.

> If `privos-standalone-identity.json` exists in the repository root, mode resolution picks
> `standalone-production` instead and `npm run dev` will not enter the development relay loop.
> Remove or rename that file to develop against a fresh pairing.

The Vite UI defaults to `http://localhost:5179`. `DEV_TUNNEL=cloudflared` is optional when the
browser displaying Hub is on another machine.

## Managed direct runtime

The Marketplace image starts Direct HTTP transport by default (`managed` mode once the platform
mounts `PRIVOS_WORKLOAD_SOCKET`; falls back to `development` mode locally when it isn't mounted):

```bash
npm run build
PORT=3000 npm start
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
curl http://127.0.0.1:3000/.well-known/mcp/manifest.json
```

Development compatibility reports manifest-verified readiness without a broker. In production,
`/health` only proves the process is alive; `/ready` returns 200 only after the manifest is valid,
workload identity is paired, and the current receipt/epoch is active. A public or unsigned
production `POST /mcp` returns 403.

## Standalone production (self-hosted against a standalone hub)

A publisher can also run this exact app against a portal-less, self-hosted Hub — same manifest,
same tools, same permission contract as a Marketplace install, but the app pairs directly with the
Hub over the Relay WebSocket instead of App Cluster mounting a socket. Direct HTTP `/mcp` has no
trust source in this mode and always returns 403 (`DISPATCH_ASSERTION_INVALID`); every MCP
dispatch rides the Relay connection with a mandatory Hub-signed assertion.

### Pair, twice

```bash
npm run pair
```

The command asks for the one-time pairing URL the Hub operator gives you — it takes no arguments,
so the URL never lands in your shell history. It then announces `privos-app.json` over the pairing
socket, which means no admin ever handles the manifest file: the app states what it wants, and an
admin decides what it gets.

Run it **twice**, because the two runs mean different things:

1. The first run REGISTERS the app. The Hub stores the announced contract, grants nothing, and
   reports `awaitingApproval`. No identity file is written and the app does not start — dispatch
   trust belongs to the generation an approved permission ceiling creates, and there is nothing
   to run until then. Approve the declared permissions in Hub Admin > Apps.
2. Run it again with a fresh pairing URL from that app's own settings. The Hub re-hands the same
   credentials plus its dispatch trust, the identity file is written, and **the app starts
   automatically** — `pair` continues into `start:standalone`, so there is no second command to
   remember.

The identity file lands at `./privos-standalone-identity.json` (override with
`PRIVOS_STANDALONE_IDENTITY_FILE`) at mode `0600`, and the Hub's fingerprint is printed:

```
PrivOS Hub fingerprint: SHA256:<43-char base64url> — verify this out-of-band before trusting dispatch from this Hub.
```

**Verify this fingerprint out-of-band** — over a channel other than the one that gave you the
pairing URL (a phone call, a separately-verified chat, the operator's own documentation). The
fingerprint is the same SSH-host-key-style trust-on-first-use model as `ssh` printing a host key:
a compromised pairing URL could otherwise hand you a Hub that signs dispatch you'd wrongly trust.
Because the second `pair` run starts the app for itself, verify the fingerprint the moment it is
printed and stop the process if it does not match.

### Identity file handling

The identity file is the sole source of Relay OAuth credentials and Hub dispatch trust for this
mode — treat it like an SSH private key:

- Back it up. Losing it means re-pairing (a new pairing URL from the Hub operator); there is no
  recovery path from the file alone.
- Never commit it, `docker cp` it into an image, or log its contents. `scripts/package-source.sh`
  already refuses to package any `.env*` / credential-like file; keep this file out of the
  Marketplace source archive the same way.
- A re-pair attempt over an existing file refuses (`IDENTITY_FILE_ALREADY_EXISTS`) rather than
  silently overwriting it — remove the file first if you intend to re-pair from scratch.

### Run

The second `pair` run already started the app. Every later start — after a reboot, a redeploy, or
any ordinary restart — uses the identity file that pairing wrote, and needs no pairing URL:

```bash
npm run start:standalone
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```

`/ready` reports `not_ready` (503) with a specific `reason` — `IDENTITY_NOT_LOADED`,
`RELAY_NOT_AUTHENTICATED`, `MANIFEST_LINT_INVALID`, or `MANIFEST_DRIFT` — until the identity
loads, the Relay connection authenticates, and the locally-built manifest's canonical digest still
matches the digest pinned at pairing time.

### Rotation

The Hub can push secret rotation, trust rotation (re-key or a generation/manifest update), and
capability changes over the same authenticated Relay connection, each as an ES256-signed control
notification verified against the identity file's *currently* pinned Hub key before it is applied.
No operator action is required; the identity file is rewritten atomically (temp file + rename) in
place.

### Upgrade path (manifest changes)

`/ready` returns `MANIFEST_DRIFT` when the locally-built `privos-app.json` no longer matches the
canonical manifest digest pinned at pairing — this is the standalone analogue of the managed
image-label digest check. A manifest change (new tool, new permission, new env declaration) needs
re-approval: the Hub operator re-reviews the new manifest and pushes a trust rotation carrying the
new digest before `/ready` goes green again. There is no way to silently start serving traffic
under a manifest the Hub never approved.

The operator's side of that re-approval is Hub Admin → Apps → this app → Settings → **Refresh**
(see the Hub's "Install and operate your own MCP app" doc). Re-pairing this app while it is live is
refused and points back to Refresh — it is never needed for a manifest change.

Every signed exchange in this mode — dispatch assertions and control notifications alike — is
capped at a 30-second signature lifetime with zero verifier headroom (`exp - iat <= 30`, hard
capped even if the Hub asked for more). NTP-synchronized clocks on both the Hub and this app are a
hard requirement, not an optimization; `/ready`'s `RELAY_NOT_AUTHENTICATED` reason is the
observable symptom of clock skew large enough to fail verification.

## Permission contract

[`privos-app.json`](privos-app.json) is the canonical reviewed manifest. Each permission declares:

- required or optional;
- workspace/room context and user/background execution context;
- a stable feature identifier and publisher reason;
- deterministic degraded behavior for every optional permission.

The declaration is exactly what the dashboard calls: `basic:information` and `lists:read` are
required; `lists:write`, `files:read`, `files:write`, `sandbox:ai-chat`, `sandbox:ai-chat:write`,
`sandbox:generate`, and `db:read` / `db:write` / `db:schema:read` / `db:schema:write` are optional
and each degrade to a named, deterministic behavior.

Required permissions are locked during approval. Optional permissions start from the exact
approved subset and may be disabled later; Hub enforces the new epoch immediately. UI capability
checks only hide or explain features and are never the authorization boundary. See
[`SCOPES.md`](SCOPES.md) for the declaration-to-call-site map.

Run the shared linter to print the deterministic canonical manifest and publisher permission hashes:

```bash
npm run manifest:lint
```

Portal and Hub add the versioned authoritative permission catalog, data policy, and immutable image
digest when computing the final permission-contract hash.

## License behavior

The manifest declares a Free tier (50 records) and Pro tier (5,000 records plus `bulk-export`).
The backend calls `license.assert('bulk-export')` and `assertWithin('records', count)`. A lapsed Pro
license degrades to Free without deleting records.

Local Pro test:

```bash
PRIVOS_APP_LICENSE='{"tier":"pro","state":"active"}' npm start
```

## UI build and asset delivery

`npm run build` compiles `src/ui` with Vite (`vite.config.ts`: `base: './'`, code-split
`manualChunks`, `build.manifest: true`, `build.sourcemap: false`, `build.assetsInlineLimit: 0`)
into a small shell (`dist/ui/index.html`) plus hashed, content-addressed files under
`dist/ui/assets/`. `@privos_ai/app-server`'s `serveBuiltUi` helper (`src/mcp-message-handlers.ts`)
reads that build output once and answers three kinds of `resources/read` request: the shell
(`ui://ai.privos.mcp-app-hr-and-hrm/form.html`, meta-tagged for relay delivery, with an inline boot
watchdog), the assets manifest (`ui://ai.privos.mcp-app-hr-and-hrm/assets-manifest.json`), and each
individual asset (`ui://ai.privos.mcp-app-hr-and-hrm/assets/<file>`). Any other URI is refused with
JSON-RPC `-32602`.

The Hub fetches the shell once per open and the hashed assets once per installation generation,
caches them, and re-serves everyone from its own origin behind a short-lived per-user token —
**this app's built bundle is never served to end users unmodified from this container**, and it
must never embed a secret (no `VITE_*` build-time env values; the platform's own non-secret
values are read at runtime instead, see [Environment configuration](#environment-configuration)).
Two build constraints follow directly from that: no sourcemaps are ever produced, and nothing may
be served from a Vite `publicDir` — every asset the UI references must be a real hashed file under
`dist/ui/assets/`, which the build enforces at construction time (`serveBuiltUi` throws on an
unhashed, oversized, or `.map` file, or on a shell with a non-relative asset reference).

Each asset is capped at 2 MB, which is why `docx`, `xlsx` and the icon set get their own
`manualChunks` entries rather than riding along in the entry bundle.

**This build requires the installing Hub to be at tenant.N or later** — an older Hub has no route
to fetch the split-out asset files, and the shell's boot watchdog shows an "App assets unavailable
— Retry" panel instead of a blank frame until the tenant is upgraded.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run preflight
npm run docker:build
```

Preflight validates the manifest schema, canonical hashes, documented call sites, Docker inputs,
license guards, safe source packaging, and the served manifest. Its versioned rules mirror Portal
until the Marketplace validation package is published.

`npm test` and `npm run preflight` shell out to `bash` for `scripts/package-source.sh`; on Windows,
run them from Git Bash, since PowerShell resolves `bash` to WSL.

## Safe source packaging

```bash
npm run package
```

This creates `dist-source/ai.privos.mcp-app-hr-and-hrm-<version>.zip` plus a SHA-256 provenance
file from Git-tracked source. It rejects dirty trees by default, credential-like files, `.env`,
dependencies, build output, and archives over 200 MiB. `--allow-dirty` is for local inspection only.

The multi-stage image installs only lockfile-pinned package inputs, runs as `node`, supports a
read-only root filesystem, and needs no production credential environment variables.

## Environment configuration

`privos-app.json` declares the values an operator supplies from Hub **Admin → Apps → Settings →
Environment**. The declaration is part of the digest-pinned manifest, so it is fixed per published
version; the Portal validates it at submission and the reviewer sees every secret the app asks for.

| Key | Required | Secret | Purpose |
|-----|----------|--------|---------|
| `EMAILJS_SERVICE_ID` | no | no | EmailJS service the HR mail queue delivers through. |
| `EMAILJS_TEMPLATE_ID` | no | no | EmailJS template used for HR mail. |
| `EMAILJS_PUBLIC_KEY` | no | no | EmailJS public key (user id) of the sending account. |
| `EMAILJS_PRIVATE_KEY` | no | **yes** | Sent as `accessToken` when the EmailJS service enforces strict mode. |
| `PRIVOS_AGENT_BOT_USER_ID` | no | no | This app's installation agent-bot Hub user id. |
| `PRIVOS_AGENT_BOT_CREDENTIAL` | no | **yes** | Its Hub API token; issued and rotated only by a workspace admin. |

Two rules this app follows, and every publisher should:

- **A missing value never blocks installation.** The operator fills it in afterwards, so the app
  starts and reports its own unconfigured state — `hrm.mail.send` fails with a specific message
  naming the missing EmailJS variables rather than the whole dashboard refusing to load.
- **A secret is reported, never printed.** Nothing echoes `EMAILJS_PRIVATE_KEY` or
  `PRIVOS_AGENT_BOT_CREDENTIAL` back through a room; that is precisely what the platform's
  write-only storage exists to prevent.

Applying values restarts the app container. The environment is read at start like any process
environment; there is no runtime config-fetch API.

### Variables the platform injects

```ts
import { getPlatformContext, publicUrlFor } from '@privos_ai/app-server';

const { publicUrl, accessMode } = getPlatformContext();
const iconUrl = publicUrlFor('/public/icon.svg');
```

`PRIVOS_PUBLIC_URL` is this app's own public origin and `PRIVOS_ACCESS_MODE` is `managed-runtime`
or `publisher-hosted`. Tool calls and interface requests do **not** arrive on the public origin —
those ride the signed broker dispatch on `/mcp`. Use it for public static media, webhook callbacks,
and OAuth redirect URIs. Both helpers are undefined-safe, so the app still runs where nothing is
injected.

## Privacy, support, and release

Marketplace review/build source remains publisher-confidential; buyer workspaces receive the
digest-pinned image. See [`PRIVACY.md`](PRIVACY.md), [`TERMS.md`](TERMS.md), and
[`CHANGELOG.md`](CHANGELOG.md). Support is available through GitHub Issues or `dev@privos.ai`.
