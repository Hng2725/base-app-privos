import { describe, expect, it } from 'vitest';

import { restCall } from '../src/ui/privos-rest';

function fakeApp(response: { statusCode: number; body: any }) {
  return { rest: async () => response } as any;
}

describe('restCall', () => {
  it('surfaces the Hub error detail on a >=400 status instead of a bare status code', async () => {
    const app = fakeApp({ statusCode: 400, body: { success: false, error: 'List not found' } });
    await expect(restCall(app, 'POST', 'items.create', {})).rejects.toThrow('List not found');
  });

  it('surfaces the Hub error detail on a 200 success:false body', async () => {
    const app = fakeApp({ statusCode: 200, body: { success: false, error: 'Invalid bot: no active token' } });
    await expect(restCall(app, 'POST', 'ai-messages.send', {})).rejects.toThrow('Invalid bot: no active token');
  });

  it('falls back to a generic message when no detail is present', async () => {
    const app = fakeApp({ statusCode: 500, body: {} });
    await expect(restCall(app, 'GET', 'some.route', {})).rejects.toThrow('Request failed (500)');
  });

  it('resolves normally on success', async () => {
    const app = fakeApp({ statusCode: 200, body: { success: true, items: [] } });
    await expect(restCall(app, 'GET', 'items.listByListId', {})).resolves.toEqual({ success: true, items: [] });
  });
});
