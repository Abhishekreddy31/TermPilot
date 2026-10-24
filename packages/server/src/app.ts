import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { PROTOCOL_VERSION, TERMINAL_LIMITS, WS_CLOSE } from '@termpilot/shared';
import { ClientMessageSchema, describeValidationError } from '@termpilot/shared/schemas';
import { AuthService, RateLimiter, type AuthServiceOptions } from './auth/auth-service.js';
import { PtyManager } from './terminal/pty-manager.js';
import { SessionRegistry } from './terminal/session-registry.js';
import { TmuxManager } from './terminal/tmux-manager.js';
import { shellSpawnSpec } from './terminal/shell.js';
import { HostGuard, clientAddress, defaultAllowedHosts, isWildcardHost, machineHostnames } from './http/request-guard.js';
import { HttpError, createApiRouter, sendJson } from './http/api.js';
import { createMissingClientHandler, createStaticHandler, resolveClientDist } from './http/static-files.js';
import { ClientConnection, DEFAULT_FLOW_CONTROL, type FlowControlOptions } from './ws/client-connection.js';
import { handleMessage } from './ws/message-handler.js';
import { debug } from './log.js';

export const SERVER_DEFAULTS = {
  host: '127.0.0.1',
  maxSessions: 20,
  /** Authenticated connections (devices) at once. */
  maxConnections: 20,
  /**
   * Connections that have not authenticated yet are limited separately, per client
   * address and in total, so idle sockets from one source cannot take the slots
   * the owner's devices need.
   */
  maxPendingPerAddress: 4,
  maxPendingTotal: 64,
  maxReplayChars: 100 * 1024,
  authTimeoutMs: 10_000,
  heartbeatMs: 30_000,
  maintenanceMs: 60_000,
  /** Failed logins allowed per client address per window. */
  login: { maxFailures: 5, windowMs: 15 * 60 * 1000 },
  /** Failed WebSocket authentications (bad or expired tokens) per client address per window. */
  wsAuth: { maxFailures: 10, windowMs: 60 * 1000 },
} as const;

/**
 * Largest frame a well-behaved client can send: an input message at the maximum
 * data length where every character needed a six-byte JSON escape (\u0000).
 */
const MAX_WS_PAYLOAD = TERMINAL_LIMITS.maxInputLength * 6 + 1024;

const SHUTDOWN_GRACE_MS = 1_000;
const MAX_PORT = 65_535;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // xterm.js positions its DOM with inline styles.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
};

export interface ServerOptions {
  port: number;
  host?: string;
  /** How many following ports to try when `port` is taken. */
  portRetries?: number;
  /** Extra hostnames (or `.domain` suffixes) browsers may use to reach the server. */
  allowedHosts?: string[];
  /** Read the client address from CF-Connecting-IP on loopback connections (tunnel mode). */
  trustTunnelProxy?: boolean;
  maxSessions?: number;
  maxConnections?: number;
  /** Shell to spawn for new terminals; defaults to the user's login shell. */
  shell?: string;
  auth?: AuthServiceOptions;
  /** Directory of the built client. Defaults to the packaged or monorepo build. */
  clientDist?: string;
  maintenanceMs?: number;
  authTimeoutMs?: number;
  flowControl?: FlowControlOptions;
}

export interface TermPilotServer {
  readonly port: number;
  readonly host: string;
  readonly auth: AuthService;
  /** Accept requests for another hostname, e.g. the tunnel's public hostname once known. */
  allowHost(hostname: string): void;
  close(): Promise<void>;
}

export function listen(server: Server, port: number, host: string, retries: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (candidate: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < retries && candidate !== 0 && candidate < MAX_PORT) {
          attempt++;
          tryPort(candidate + 1);
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : candidate);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, host);
    };
    tryPort(port);
  });
}

/** The API keeps working without a built client, so `pnpm dev` (Vite serves the client) still runs. */
function staticHandler(clientDist: string | undefined) {
  if (clientDist) return createStaticHandler(clientDist);
  try {
    return createStaticHandler(resolveClientDist());
  } catch (err) {
    const reason = (err as Error).message;
    console.warn(`Warning: ${reason}`);
    return createMissingClientHandler(reason);
  }
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export async function createServer(opts: ServerOptions): Promise<TermPilotServer> {
  const host = opts.host ?? SERVER_DEFAULTS.host;
  const maxConnections = opts.maxConnections ?? SERVER_DEFAULTS.maxConnections;
  const authTimeoutMs = opts.authTimeoutMs ?? SERVER_DEFAULTS.authTimeoutMs;
  const trustTunnelProxy = opts.trustTunnelProxy ?? false;

  const auth = new AuthService(opts.auth);
  const loginLimiter = new RateLimiter(SERVER_DEFAULTS.login);
  const wsAuthLimiter = new RateLimiter(SERVER_DEFAULTS.wsAuth);
  const ptys = new PtyManager({
    maxProcesses: opts.maxSessions ?? SERVER_DEFAULTS.maxSessions,
    maxReplayChars: SERVER_DEFAULTS.maxReplayChars,
  });
  const sessions = new SessionRegistry(ptys);
  const tmux = new TmuxManager();
  const shellSpec = () => shellSpawnSpec(opts.shell);
  const guard = new HostGuard(
    [...defaultAllowedHosts(host), ...(opts.allowedHosts ?? [])],
    isWildcardHost(host) ? machineHostnames : undefined,
  );
  const addressOf = (req: IncomingMessage) => clientAddress(req, trustTunnelProxy);
  const connections = new Set<ClientConnection>();
  const pendingByAddress = new Map<string, number>();
  const changePending = (address: string, delta: number) => {
    const count = (pendingByAddress.get(address) ?? 0) + delta;
    if (count > 0) pendingByAddress.set(address, count);
    else pendingByAddress.delete(address);
  };
  const authenticatedCount = () => [...connections].filter((c) => c.authenticated).length;
  const pendingTotal = () => [...pendingByAddress.values()].reduce((sum, count) => sum + count, 0);

  /** End connections whose login is no longer valid, and terminals whose owner has no login left. */
  const enforceLoginLifetimes = () => {
    auth.cleanExpiredSessions();
    for (const conn of connections) {
      if (conn.token && !auth.validateSession(conn.token)) {
        conn.close(WS_CLOSE.sessionExpired, 'Login expired');
      }
    }
    sessions.reapInactiveOwners((owner) => auth.hasActiveSession(owner));
  };

  const api = createApiRouter({
    auth,
    loginLimiter,
    csrfToken: randomBytes(32).toString('hex'),
    clientAddress: addressOf,
    onLogout: enforceLoginLifetimes,
  });
  const serveStatic = staticHandler(opts.clientDist);

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

    if (!guard.check(req)) {
      sendJson(res, 403, { error: 'Host or origin not allowed. Use --allowed-hosts to permit it.' });
      return;
    }

    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const handler = api(pathname, req.method ?? 'GET');
    const run = handler ? handler(req, res) : serveStatic(req, res);
    Promise.resolve(run).catch((err: unknown) => {
      if (res.headersSent || res.destroyed) return;
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
      else sendJson(res, 500, { error: 'Internal server error' });
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD, perMessageDeflate: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');
    if (!guard.check(req)) return rejectUpgrade(socket, 403, 'Forbidden');
    if ((pendingByAddress.get(addressOf(req)) ?? 0) >= SERVER_DEFAULTS.maxPendingPerAddress) {
      return rejectUpgrade(socket, 429, 'Too Many Requests');
    }
    if (pendingTotal() >= SERVER_DEFAULTS.maxPendingTotal) {
      return rejectUpgrade(socket, 503, 'Service Unavailable');
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const conn = new ClientConnection(ws, opts.flowControl ?? DEFAULT_FLOW_CONTROL);
    connections.add(conn);
    const ip = addressOf(req);
    changePending(ip, 1);
    debug(`ws open from ${ip}`);
    let pending = true;
    const leavePending = () => {
      if (!pending) return;
      pending = false;
      changePending(ip, -1);
    };

    const authTimer = setTimeout(() => {
      if (!conn.authenticated) conn.close(WS_CLOSE.authTimeout, 'Authentication timeout');
    }, authTimeoutMs);

    // Pings keep NAT/proxy mappings alive; each pong shows the user is still here.
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, SERVER_DEFAULTS.heartbeatMs);
    ws.on('pong', () => {
      alive = true;
      if (conn.token) auth.touchSession(conn.token);
    });

    // Messages are handled strictly in order, even when one awaits tmux.
    let queue = Promise.resolve();

    ws.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        conn.send({ type: 'error', message: 'Binary frames are not supported' });
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        conn.send({ type: 'error', message: 'Invalid JSON message' });
        return;
      }
      const parsed = ClientMessageSchema.safeParse(json);
      if (!parsed.success) {
        conn.send({ type: 'error', message: `Invalid message: ${describeValidationError(parsed.error)}` });
        return;
      }
      const message = parsed.data;

      if (!conn.authenticated) {
        if (message.type !== 'auth') {
          conn.send({ type: 'error', message: 'Send an auth message first' });
          return;
        }
        if (!wsAuthLimiter.tryBegin(ip)) {
          conn.send({ type: 'auth_failed', reason: 'rate_limited', message: 'Too many attempts. Try again later.' });
          conn.close(WS_CLOSE.rateLimited, 'Rate limited');
          return;
        }
        if (message.protocol !== PROTOCOL_VERSION) {
          wsAuthLimiter.succeeded(ip); // an outdated page, not a token guess
          conn.send({ type: 'auth_failed', reason: 'protocol_mismatch', message: 'This page is out of date. Reload to update.' });
          conn.close(WS_CLOSE.protocolMismatch, 'Protocol mismatch');
          return;
        }
        const login = auth.validateSession(message.token);
        if (login) wsAuthLimiter.succeeded(ip);
        if (!login) {
          conn.send({ type: 'auth_failed', reason: 'invalid_token', message: 'Invalid or expired login' });
          conn.close(WS_CLOSE.unauthorized, 'Invalid token');
          return;
        }
        clearTimeout(authTimer);
        leavePending();
        if (authenticatedCount() >= maxConnections) {
          conn.send({ type: 'error', message: `Too many devices connected (maximum ${maxConnections}).` });
          conn.close(WS_CLOSE.tryAgainLater, 'Too many connections');
          return;
        }
        conn.token = message.token;
        conn.username = login.username;
        auth.touchSession(message.token);
        conn.send({ type: 'auth_ok', username: login.username, protocol: PROTOCOL_VERSION });
        debug(`ws authenticated from ${ip}`);
        return;
      }

      if (message.type === 'auth') {
        conn.send({ type: 'error', message: 'Already authenticated' });
        return;
      }
      auth.touchSession(conn.token!);
      queue = queue.then(() => handleMessage(conn, message, { sessions, tmux, shellSpec }));
    });

    ws.on('close', (code: number, reason: Buffer) => {
      debug(`ws closed from ${ip}: code ${code}${reason.length ? ` (${reason.toString()})` : ''}`);
      clearTimeout(authTimer);
      leavePending();
      clearInterval(heartbeat);
      connections.delete(conn);
      sessions.disconnect(conn);
      conn.dispose();
    });

    ws.on('error', (err: Error) => {
      // `close` follows and performs the cleanup.
      debug(`ws error from ${ip}: ${err.message}`);
    });
  });

  const maintenance = setInterval(enforceLoginLifetimes, opts.maintenanceMs ?? SERVER_DEFAULTS.maintenanceMs);
  maintenance.unref();

  const port = await listen(httpServer, opts.port, host, opts.portRetries ?? 0).catch((err) => {
    clearInterval(maintenance);
    throw err;
  });

  let closing: Promise<void> | null = null;

  return {
    port,
    host,
    auth,
    allowHost: (hostname) => guard.allow(hostname),
    close() {
      closing ??= (async () => {
        clearInterval(maintenance);
        for (const ws of wss.clients) {
          ws.close(1001, 'Server shutting down');
          // Do not let an unresponsive client hold shutdown open.
          setTimeout(() => ws.terminate(), SHUTDOWN_GRACE_MS).unref();
        }
        sessions.closeAll();
        ptys.killAll();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        httpServer.closeIdleConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      })();
      return closing;
    },
  };
}
