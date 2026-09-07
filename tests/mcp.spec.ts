import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleMcpMessage } from '../src/mcp-message-handlers';

vi.mock('../src/hub-tool-call', () => ({
  callHubTool: vi.fn(async (toolName: string, args: Record<string, unknown>, roomId?: string) => ({
    content: [{ type: 'text', text: JSON.stringify({ toolName, args, roomId }) }],
  })),
}));

const { callHubTool } = await import('../src/hub-tool-call');

describe('JSON-RPC handlers', () => {
  afterEach(() => {
    delete process.env.PRIVOS_APP_LICENSE;
    vi.mocked(callHubTool).mockClear();
  });

  it('initializes and lists exactly the tools the manifest declares', async () => {
    expect((await handleMcpMessage('initialize', 1, {})).serverInfo.name).toBeTruthy();
    const listed = await handleMcpMessage('tools/list', 2, {});
    const names = listed.tools.map((tool: any) => tool.name);
    expect(names).toEqual([
      'hr_management_dashboard',
      'debug_log',
      'hrm.payroll.query',
      'hrm.payroll.create',
      'hrm.payroll.update',
      'hrm.payroll.delete',
      'hrm.mail.send',
      'hrm.mail.retry',
      'hr_bulk_export',
    ]);
    // Only the dashboard carries a UI resource; the rest are pure data tools.
    expect(listed.tools.filter((tool: any) => tool._meta?.ui)).toHaveLength(1);
  });

  it('maps hrm.payroll.* onto the Hub privos.db.* tools, stripping transport-only fields', async () => {
    const result = await handleMcpMessage('tools/call', 3, {
      name: 'hrm.payroll.query',
      arguments: { roomId: 'room-1', password: 'never-forwarded', collection: 'payroll_records', where: [] },
    });
    expect(callHubTool).toHaveBeenCalledWith('privos.db.query', { collection: 'payroll_records', where: [] }, 'room-1');
    // `password` and `roomId` are transport metadata, never `privos.db.*` arguments.
    expect(result.content[0].text).not.toContain('never-forwarded');
    expect(JSON.parse(result.content[0].text).args).not.toHaveProperty('roomId');
  });

  it('rejects an unknown tool name', async () => {
    await expect(handleMcpMessage('tools/call', 4, { name: 'nope', arguments: {} })).rejects.toThrow('Unknown tool: nope');
  });

  it('validates hrm.mail.send before queueing anything', async () => {
    await expect(
      handleMcpMessage('tools/call', 5, { name: 'hrm.mail.send', arguments: { toName: 'A', subject: 's', htmlContent: 'x' } }),
    ).rejects.toThrow('Missing required arguments');

    await expect(
      handleMcpMessage('tools/call', 6, {
        name: 'hrm.mail.send',
        arguments: { toName: 'A', toEmail: 'not-an-email', subject: 's', htmlContent: 'x' },
      }),
    ).rejects.toThrow('Recipient email is invalid');

    // A tracked send needs BOTH a room and a supported source, or the history record
    // would be written against the wrong room.
    await expect(
      handleMcpMessage('tools/call', 7, {
        name: 'hrm.mail.send',
        arguments: { toName: 'A', toEmail: 'a@example.com', subject: 's', htmlContent: 'x', source: 'unsupported' },
      }),
    ).rejects.toThrow('Tracked mail requires roomId and a supported source');
  });

  it('requires both arguments for hrm.mail.retry', async () => {
    await expect(
      handleMcpMessage('tools/call', 8, { name: 'hrm.mail.retry', arguments: { roomId: 'room-1' } }),
    ).rejects.toThrow('Missing required arguments');
  });

  it('gates hr_bulk_export on the licensed tier', async () => {
    await expect(
      handleMcpMessage('tools/call', 9, { name: 'hr_bulk_export', arguments: { records: [{ id: 1 }] } }),
    ).rejects.toThrow('requires the Pro tier');

    process.env.PRIVOS_APP_LICENSE = '{"tier":"pro","state":"active"}';
    const result = await handleMcpMessage('tools/call', 10, { name: 'hr_bulk_export', arguments: { records: [{ id: 1 }] } });
    expect(JSON.parse(result.content[0].text).exported).toBe(1);
  });
});
