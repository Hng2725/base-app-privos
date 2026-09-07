/**
 * Backend → Hub tool transport for this app's own server-side features
 * (payroll passthrough, email-history bookkeeping).
 *
 * The legacy dev environment let the app push an outbound `tools/call` back up
 * its own relay WebSocket (`relay-client.ts`'s `callHubTool`). The SDK's Relay
 * client is request/response only — the socket carries Hub → app dispatch, never
 * app → Hub calls — so the successor path on this runtime is the same one the
 * SDK documents for server-side Hub work: `POST /api/v1/mcp-apps.tool-call`
 * authenticated with this app's own installation agent-bot credential
 * (`x-user-id` + `x-auth-token`, supplied by a workspace admin as
 * `PRIVOS_AGENT_BOT_USER_ID` / `PRIVOS_AGENT_BOT_CREDENTIAL`).
 *
 * Body shape is fixed by the Hub: `{ mcpAppId, toolName, arguments, roomId }`.
 * The MCP envelope (`{ content: [{ type: 'text', text }] }`) is returned
 * verbatim so callers keep the exact response shape the old relay path handed
 * them — `EmailHistoryRepository.parseToolResponse` and the frontend's
 * `JSON.parse(res.content[0].text)` both continue to work unchanged.
 */
import { createAgentBotHubClient } from '@privos_ai/app-server';

import { resolveHubOrigin } from './resolve-hub-origin';
import { resolveOwnMcpAppId } from './resolve-own-mcp-app-id';

const TOOL_CALL_PATH = '/api/v1/mcp-apps.tool-call';

const MISSING_APP_ID =
	"This app cannot resolve its own installation id, so it cannot call the Hub's tools from the backend. " +
	'In development, re-run `npm run pair` (or `npm run dev`) so the cached credentials include MCP_APP_ID; ' +
	'in managed/standalone-production this resolves automatically once paired.';

/** One granted permission each backend-mediated Hub tool exercises (documentation only). */
const SCOPE_BY_TOOL_PREFIX: ReadonlyArray<readonly [string, string]> = [
	['privos.db.registerCollection', 'db:schema:write'],
	['privos.db.getSchema', 'db:schema:read'],
	['privos.db.query', 'db:read'],
	['privos.db.', 'db:write'],
	['privos.lists.get', 'lists:read'],
	['privos.stages.get', 'lists:read'],
	['privos.lists.', 'lists:write'],
];

/** Best-effort scope label for a Hub tool name; the Hub is still the authority. */
function requiredScopeFor(toolName: string): string {
	for (const [prefix, scope] of SCOPE_BY_TOOL_PREFIX) {
		if (toolName.startsWith(prefix)) return scope;
	}
	return 'basic:information';
}

export interface HubToolEnvelope {
	content: Array<{ type: string; text?: string }>;
}

/**
 * Call one Hub tool as this app's own installation bot and return the raw MCP
 * envelope. Throws a plain `Error` carrying the Hub's own message on failure so
 * callers can surface it exactly as the relay path did.
 */
export async function callHubTool(
	toolName: string,
	args: Record<string, unknown> = {},
	roomId?: string,
): Promise<HubToolEnvelope> {
	const mcpAppId = await resolveOwnMcpAppId();
	if (!mcpAppId) throw new Error(MISSING_APP_ID);

	const hub = createAgentBotHubClient({ resolveHubOrigin });
	const response = await hub.authorizedFetch(TOOL_CALL_PATH, {
		method: 'POST',
		requiredScope: requiredScopeFor(toolName),
		retryMode: 'never',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ mcpAppId, toolName, arguments: args, ...(roomId ? { roomId } : {}) }),
	});

	const raw = await response.text();
	let parsed: Record<string, unknown> = {};
	try {
		parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
	} catch {
		parsed = {};
	}
	if (!response.ok || parsed.success === false) {
		const reason = typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
		throw new Error(`${toolName} failed: ${reason}`);
	}

	const content = Array.isArray(parsed.content) ? (parsed.content as HubToolEnvelope['content']) : [];
	return { content };
}
