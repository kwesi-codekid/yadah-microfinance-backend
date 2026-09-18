import { describe, expect, it } from 'vitest';
import { currentRequest, runWithRequestContext } from './request-context.js';

describe('the request context', () => {
  const context = {
    requestId: 'req-1',
    method: 'POST',
    path: '/api/v1/susu/accounts/abc/deposits',
    userAgent: 'Mozilla/5.0',
  };

  it('is absent outside a request', () => {
    expect(currentRequest()).toBeUndefined();
  });

  it('follows the async chain inside one', async () => {
    await runWithRequestContext(context, async () => {
      expect(currentRequest()).toBe(context);
      await new Promise((resolve) => setTimeout(resolve, 1));
      await Promise.resolve();
      expect(currentRequest()).toBe(context);
    });
    expect(currentRequest()).toBeUndefined();
  });
});
