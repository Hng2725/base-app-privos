# Permission justifications

`privos-app.json` is the authoritative declaration. This table maps every permission to a shipped
call site and explains the behavior when an optional permission is absent.

| Permission | Requirement | Execution | Why / call site | Behavior when absent |
|---|---|---|---|---|
| `basic:information` | Required | Room; user + background | Resolves the approved room, the current user and their room roles before any tab renders — `usePrivosContext()` throughout the dashboard, and `privos.context.get` in `payroll/access/usePayrollAccessPolling.ts`, which re-reads it on a poll because the Payroll tab is owner-only. | Installation is cancelled if rejected. |
| `lists:read` | Required | Room; user + background | Reads the recruitment boards, CV pipeline items, employee profiles and email-history records this room owns — `list-items-table.tsx` (`items.listByListId`), `pipeline-service.ts`, `lifecycle/services/PrivOSLifecycleService.ts` and `email-history/email-history-service.ts`. | Installation is cancelled if rejected. |
| `lists:write` | Optional | Room; user + background | Creates and edits boards, CV items, employee profiles and email-history records — `list-items-table.tsx` (`items.update` / `items.delete`), `recruitment-panel.tsx`, `cv-scored/CVScoredTab.tsx`, `lifecycle/components/*`, and the backend's `services/EmailHistoryRepository.ts`. | The dashboard remains read-only. |
| `files:read` | Optional | Room; user + background | Reads CVs, job descriptions, skill files, email templates and generated documents stored in the room — `privos-rest.ts` `getFileContent()`, `pipeline-service.ts` and `email-templates/interview-email-template-repository.ts`. | Document previews, CV screening and template loading are unavailable. |
| `files:write` | Optional | Room; user + background | Uploads CVs, job descriptions, skill files, email templates and generated DOCX exports — `privos-rest.ts` `createOrUpdateFile()` / `ensureFolderPath()` (via `app.uploadFile()`), `docx-export-service.ts` and `bot-drafting-tab.tsx`. | Uploads and document generation are disabled; existing records are unchanged. |
| `sandbox:ai-chat` | Optional | Room; user | Reads the assistant session history that answers CV screening, JD editing and drafting prompts — `ai-messages.list` in `company-home.tsx` and `pipeline-service.ts`. | Assistant answers cannot be displayed. |
| `sandbox:ai-chat:write` | Optional | Room; user | Posts prompts into the room assistant session — `ai-messages.send` in `company-home.tsx` and `pipeline-service.ts`. | The assistant tabs become read-only. |
| `sandbox:generate` | Optional | Room; user | Starts the room sandbox run that produces each assistant answer — `ai-messages.startGeneration` in `company-home.tsx` and `pipeline-service.ts`. | The assistant tabs cannot produce new answers. |
| `db:read` | Optional | Room; user + background | Reads this room's payroll records — `payroll/services/PayrollService.ts` `getRecords()`, through the backend `hrm.payroll.query` passthrough. | The Payroll tab cannot load payroll records. |
| `db:write` | Optional | Room; user + background | Creates, updates and deletes payroll records — `payroll/services/PayrollService.ts` `saveRecord()` / `deleteRecord()`, through `hrm.payroll.create` / `.update` / `.delete`. | The Payroll tab becomes read-only. |
| `db:schema:read` | Optional | Room; user + background | Reads the payroll collection's registered schema before records are read or written — `payroll/services/PayrollService.ts` `initializeSchema()`. | The Payroll tab cannot verify its collection schema. |
| `db:schema:write` | Optional | Room; user + background | Registers the payroll collection schema once per room — `privos.db.registerCollection` in `payroll/services/PayrollService.ts`. | The Payroll tab cannot initialise its collection. |

Everything the iframe calls runs **as the current user**, mediated by the host bridge
(`app.rest()` / `app.callServerTool()` / `app.uploadFile()`), and is gated by this
installation's exact grant.

Two server-side features are the exception, because they must keep working when no browser
session is attached: the `hrm.payroll.*` passthrough and the room email history written by
`hrm.mail.send` / `hrm.mail.retry`. Both reach the Hub through this app's own installation
agent-bot credential (`POST /api/v1/mcp-apps.tool-call`, see `src/hub-tool-call.ts`), which a
workspace admin issues as `PRIVOS_AGENT_BOT_USER_ID` + `PRIVOS_AGENT_BOT_CREDENTIAL`. Without
that credential those two features report a clear configuration error; nothing else in the app
depends on it.

The app-owned `hr_bulk_export` tool does not request a workspace permission. It processes caller
input and is gated by the Pro license feature. The Hub still enforces installation status, receipt,
epoch, target room, exact grant, and current-user ACL on every mediated platform operation.
