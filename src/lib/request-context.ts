import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

/**
 * Who is calling, carried through the whole request without being passed.
 *
 * The audit writer (lib/audit.ts) records the device and the endpoint a change
 * came through, and it is called from a hundred places deep inside the
 * services, none of which hold the request. Threading `req` down to every one
 * of them would touch every money path in the API for the sake of a few
 * strings. Instead the middleware below puts them in an AsyncLocalStorage at
 * the top of the request, and the writer reads them from there — through
 * awaits, transactions and Mongoose callbacks alike, because the store follows
 * the async chain.
 *
 * A worker running outside any request (loan escalation, HP arrears) finds no
 * store, and its entries record nothing here. That absence is the fact: the
 * change was the system's, not a person's on a device.
 */
export interface RequestContext {
  /** From pino-http, so an entry can be matched to its line in the server logs. */
  requestId?: string;
  /** `POST`, `PATCH`… */
  method: string;
  /** The path as called, without the query string: `/api/v1/susu/accounts/…/deposits`. */
  path: string;
  /** The caller's user agent — the browser, or the collector app's HTTP client. */
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** How much user-agent string is worth keeping. Real ones are ~120 characters. */
const USER_AGENT_MAX = 300;

/** Mount after the HTTP logger, which mints `req.id`, and before every router. */
export const requestContext: RequestHandler = (req, _res, next) => {
  const agent = req.headers['user-agent'];
  const id = req.id;
  const context: RequestContext = {
    ...(typeof id === 'string' || typeof id === 'number' ? { requestId: String(id) } : {}),
    method: req.method,
    path: req.originalUrl.split('?')[0] ?? req.originalUrl,
    ...(typeof agent === 'string' && agent.length > 0
      ? { userAgent: agent.slice(0, USER_AGENT_MAX) }
      : {}),
  };
  storage.run(context, next);
};

/** The context of the request being served, or undefined outside one. */
export function currentRequest(): RequestContext | undefined {
  return storage.getStore();
}

/** Run `fn` as if inside a request — for tests, and for anything replaying one. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}
