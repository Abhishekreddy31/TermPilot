import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { LoginRequestSchema, LogoutRequestSchema } from '@termpilot/shared/schemas';
import type { AuthService, RateLimiter } from '../auth/auth-service.js';

export const MAX_JSON_BODY_BYTES = 4 * 1024;
export const BODY_TIMEOUT_MS = 5_000;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/** Read and parse a small JSON body, enforcing a size limit and a deadline. */
export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS): Promise<unknown> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(new HttpError(408, 'Request timeout')), timeoutMs);
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new HttpError(413, 'Request too large');
      chunks.push(chunk as Buffer);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Could not read request body');
  } finally {
    clearTimeout(timer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function tokensEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface ApiDependencies {
  auth: AuthService;
  loginLimiter: RateLimiter;
  csrfToken: string;
  clientAddress: (req: IncomingMessage) => string;
  /** Called after a successful logout with the token that ended. */
  onLogout: (token: string) => void;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/**
 * JSON API. Returns a handler for the request, or null if the path is not an API route.
 */
export function createApiRouter(deps: ApiDependencies): (pathname: string, method: string) => Handler | null {
  const requireCsrf = (handler: Handler): Handler => (req, res) => {
    if (!tokensEqual(req.headers['x-csrf-token'] as string | undefined, deps.csrfToken)) {
      sendJson(res, 403, { error: 'Invalid CSRF token' });
      return;
    }
    return handler(req, res);
  };

  const routes: Record<string, Record<string, Handler>> = {
    '/health': {
      GET: (_req, res) => sendJson(res, 200, { status: 'ok' }),
    },
    '/api/auth/csrf': {
      GET: (_req, res) => sendJson(res, 200, { csrfToken: deps.csrfToken }),
    },
    '/api/auth/login': {
      POST: requireCsrf(async (req, res) => {
        const client = deps.clientAddress(req);
        if (!deps.loginLimiter.tryBegin(client)) {
          sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
          return;
        }
        const parsed = LoginRequestSchema.safeParse(await readJsonBody(req).catch((err: unknown) => {
          deps.loginLimiter.succeeded(client); // a malformed request is not a password guess
          throw err;
        }));
        if (!parsed.success) {
          deps.loginLimiter.succeeded(client);
          sendJson(res, 400, { error: 'Username and password are required' });
          return;
        }
        const result = await deps.auth.authenticate(parsed.data.username, parsed.data.password);
        if (result.success) {
          deps.loginLimiter.succeeded(client);
          sendJson(res, 200, { token: result.token });
        } else {
          sendJson(res, 401, { error: 'Invalid credentials' });
        }
      }),
    },
    '/api/auth/logout': {
      POST: requireCsrf(async (req, res) => {
        const parsed = LogoutRequestSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          sendJson(res, 400, { error: 'Token required' });
          return;
        }
        // Only the holder of a valid token can end it.
        if (!deps.auth.validateSession(parsed.data.token)) {
          sendJson(res, 401, { error: 'Invalid token' });
          return;
        }
        deps.auth.logout(parsed.data.token);
        deps.onLogout(parsed.data.token);
        sendJson(res, 200, { ok: true });
      }),
    },
  };

  return (pathname, method) => {
    const route = routes[pathname];
    if (!route) return null;
    const handler = route[method];
    if (handler) return handler;
    return (_req, res) => sendJson(res, 405, { error: 'Method not allowed' }, { Allow: Object.keys(route).join(', ') });
  };
}
