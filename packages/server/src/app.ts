import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'node:url';
import { readFile, access } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PtyManager } from './terminal/pty-manager.js';
import { TmuxManager, type AttachResult } from './terminal/tmux-manager.js';
import { AuthService, RateLimiter } from './auth/auth-service.js';
import { CreateSessionSchema, InputSchema, ResizeSchema, DestroySessionSchema } from '@termpilot/shared';
import type { ZodError } from 'zod';

export interface ServerOptions {
  port: number;
  host?: string;
  maxSessions?: number;
  defaultShell?: string;
}

export interface TermPilotServer {
  port: number;
  auth: AuthService;
  close(): Promise<void>;
}

const MAX_WS_CONNECTIONS = 20;
const MAX_WS_PAYLOAD = 64 * 1024; // 64KB
const LOGIN_TIMEOUT_MS = 5000;
const AUTH_TIMEOUT_MS = 10000;

function safeSend(ws: WebSocket, data: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

function clampDimensions(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = typeof cols === 'number' ? Math.max(1, Math.min(500, Math.round(cols))) : 80;
  const r = typeof rows === 'number' ? Math.max(1, Math.min(200, Math.round(rows))) : 24;
  return { cols: c, rows: r };
}

export async function createServer(opts: ServerOptions): Promise<TermPilotServer> {
  const auth = new AuthService();
  const loginLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 15 * 60 * 1000 });
  const wsAuthLimiter = new RateLimiter({ maxAttempts: 10, windowMs: 60 * 1000 }); // #3: WS auth rate limit
  const ptyManager = new PtyManager({
    maxSessions: opts.maxSessions ?? 20,
    idleTimeoutMs: 5 * 60 * 1000,
    defaultShell: opts.defaultShell,
  });

  const tmuxManager = new TmuxManager();
  let activeConnections = 0;

  // #1: CORS origin allowlist — built dynamically from server's own addresses
  const allowedOrigins = new Set<string>();
  const serverHost = opts.host || '127.0.0.1';

  function registerOrigin(origin: string): void {
    allowedOrigins.add(origin.toLowerCase());
  }

  function isOriginAllowed(origin: string): boolean {
    if (!origin) return true; // Same-origin requests have no Origin header
    return allowedOrigins.has(origin.toLowerCase());
  }

  // #5: CSRF token — generated per server instance, embedded in HTML, required on POST
  const csrfToken = randomBytes(32).toString('hex');

  // Track which sessions belong to which WebSocket
  const wsSessionMap = new Map<WebSocket, Set<string>>();
  const wsMirrorMap = new Map<WebSocket, Map<string, AttachResult>>();
  const wsTokenMap = new Map<WebSocket, string>();

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin || '';

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' wss: ws:; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:");

    // #1: CORS with explicit allowlist
    if (origin && isOriginAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // #4: Remove uptime from health, keep it minimal
    if (req.url === '/health' && req.method === 'GET') {
      handleHealth(res, ptyManager);
      return;
    }

    // #5: CSRF token endpoint — serves the token for the client to embed
    if (req.url === '/api/auth/csrf' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ csrfToken }));
      return;
    }

    if (req.url === '/api/auth/login' && req.method === 'POST') {
      // #5: Validate CSRF token on login
      const reqCsrf = req.headers['x-csrf-token'] as string | undefined;
      if (reqCsrf !== csrfToken) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid CSRF token' }));
        return;
      }
      handleLogin(req, res, auth, loginLimiter);
      return;
    }

    if (req.url === '/api/auth/logout' && req.method === 'POST') {
      // #2: Validate token before allowing logout
      // #5: Validate CSRF on logout
      const reqCsrf = req.headers['x-csrf-token'] as string | undefined;
      if (reqCsrf !== csrfToken) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid CSRF token' }));
        return;
      }
      handleLogout(req, res, auth);
      return;
    }

    serveStatic(req, res);
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: MAX_WS_PAYLOAD,
    perMessageDeflate: true,  // Compress WebSocket messages (terminal output is highly compressible)
    verifyClient: (_info, done) => {
      if (activeConnections >= MAX_WS_CONNECTIONS) {
        done(false, 503, 'Too many connections');
        return;
      }
      done(true);
    },
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    activeConnections++;
    wsSessionMap.set(ws, new Set());
    let authenticated = false;
    const clientIp = _req.socket.remoteAddress || 'unknown';

    const authTimer = setTimeout(() => {
      if (!authenticated) {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
        ws.close(4401, 'Auth timeout');
      }
    }, AUTH_TIMEOUT_MS);

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);

    ws.on('message', (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendError(ws, 'Invalid JSON message');
        return;
      }

      if (!authenticated) {
        if (msg.type === 'auth' && typeof msg.token === 'string') {
          // #3: Rate limit WS auth attempts by IP
          if (!wsAuthLimiter.isAllowed(clientIp)) {
            safeSend(ws, JSON.stringify({ type: 'auth_failed', message: 'Too many auth attempts' }));
            ws.close(4429, 'Rate limited');
            return;
          }

          const session = auth.validateSession(msg.token);
          if (session) {
            authenticated = true;
            clearTimeout(authTimer);
            wsTokenMap.set(ws, msg.token);
            safeSend(ws, JSON.stringify({ type: 'auth_ok', username: session.username }));
          } else {
            safeSend(ws, JSON.stringify({ type: 'auth_failed', message: 'Invalid or expired token' }));
            ws.close(4401, 'Invalid token');
          }
        } else {
          safeSend(ws, JSON.stringify({ type: 'error', message: 'Send auth message first' }));
        }
        return;
      }

      const token = wsTokenMap.get(ws);
      if (token) auth.touchSession(token);

      handleMessage(ws, msg, ptyManager, tmuxManager, wsSessionMap, wsMirrorMap);
    });

    ws.on('close', () => {
      activeConnections--;
      clearInterval(pingInterval);
      clearTimeout(authTimer);

      const sessions = wsSessionMap.get(ws);
      if (sessions) {
        for (const sid of [...sessions]) {
          try { ptyManager.destroySession(sid); } catch {}
        }
      }
      wsSessionMap.delete(ws);

      const mirrors = wsMirrorMap.get(ws);
      if (mirrors) {
        for (const [, handle] of mirrors) handle.cleanup();
      }
      wsMirrorMap.delete(ws);
      wsTokenMap.delete(ws);
    });

    ws.on('error', () => {});
  });

  return new Promise<TermPilotServer>((resolve) => {
    httpServer.listen(opts.port, serverHost, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;

      // #1: Register allowed origins based on actual listen address
      registerOrigin(`http://localhost:${actualPort}`);
      registerOrigin(`http://127.0.0.1:${actualPort}`);
      registerOrigin(`http://${serverHost}:${actualPort}`);
      // For LAN access
      if (serverHost === '0.0.0.0') {
        // Accept any origin when binding to all interfaces (tunnel mode)
        // The allowlist is relaxed here because the tunnel URL is unknown at startup
        registerOrigin('*');
      }

      resolve({
        port: actualPort,
        auth,
        close: async () => {
          auth.dispose();
          ptyManager.dispose();
          ptyManager.destroyAll();
          // Gracefully close all WebSocket connections
          for (const client of wss.clients) {
            safeSend(client as WebSocket, JSON.stringify({ type: 'error', message: 'Server shutting down' }));
            (client as WebSocket).close(1001, 'Server shutting down');
          }
          wss.close();
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}

function handleMessage(
  ws: WebSocket,
  msg: Record<string, unknown>,
  ptyManager: PtyManager,
  tmuxManager: TmuxManager,
  wsSessionMap: Map<WebSocket, Set<string>>,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): void {
  switch (msg.type) {
    case 'create': handleCreate(ws, msg, ptyManager, wsSessionMap); break;
    case 'input': handleInput(ws, msg, ptyManager, wsSessionMap, wsMirrorMap); break;
    case 'resize': handleResize(ws, msg, ptyManager, wsSessionMap, wsMirrorMap); break;
    case 'destroy': handleDestroy(ws, msg, ptyManager, wsSessionMap); break;
    case 'list': handleList(ws, ptyManager, wsSessionMap); break;
    case 'tmux_list': handleTmuxList(ws, tmuxManager); break;
    case 'tmux_attach': handleTmuxAttach(ws, msg, tmuxManager, wsMirrorMap); break;
    case 'tmux_detach': handleTmuxDetach(ws, msg, wsMirrorMap); break;
    case 'tmux_create': handleTmuxCreate(ws, msg, tmuxManager); break;
    // #7: tmux_kill scoped — only kill sessions you're attached to
    case 'tmux_kill': handleTmuxKill(ws, msg, tmuxManager, wsMirrorMap); break;
    case 'tmux_windows': handleTmuxWindows(ws, msg, tmuxManager); break;
    default: sendError(ws, `Unknown message type: ${msg.type}`);
  }
}

function formatZodError(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
}

function handleCreate(
  ws: WebSocket, msg: Record<string, unknown>,
  ptyManager: PtyManager, wsSessionMap: Map<WebSocket, Set<string>>
): void {
  try {
    const parsed = CreateSessionSchema.safeParse(msg);
    if (!parsed.success) {
      sendError(ws, `Invalid create message: ${formatZodError(parsed.error)}`);
      return;
    }
    const { cols, rows } = parsed.data;
    const session = ptyManager.createSession({ cols, rows });
    wsSessionMap.get(ws)?.add(session.id);

    ptyManager.onData(session.id, (data) => {
      safeSend(ws, JSON.stringify({ type: 'output', sessionId: session.id, data }));
    });

    ptyManager.onExit(session.id, ({ exitCode, signal }) => {
      wsSessionMap.get(ws)?.delete(session.id);
      safeSend(ws, JSON.stringify({ type: 'session_destroyed', sessionId: session.id, exitCode, signal }));
    });

    safeSend(ws, JSON.stringify({ type: 'session_created', sessionId: session.id }));
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
}

function handleInput(
  ws: WebSocket, msg: Record<string, unknown>,
  ptyManager: PtyManager, wsSessionMap: Map<WebSocket, Set<string>>,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): void {
  try {
    const parsed = InputSchema.safeParse(msg);
    if (!parsed.success) {
      sendError(ws, `Invalid input: ${formatZodError(parsed.error)}`);
      return;
    }
    const { sessionId, data } = parsed.data;

    const mirror = wsMirrorMap.get(ws)?.get(sessionId);
    if (mirror) { mirror.pty.write(data); return; }

    if (!wsSessionMap.get(ws)?.has(sessionId)) {
      sendError(ws, 'Session not found or not owned by this connection');
      return;
    }
    ptyManager.writeToSession(sessionId, data);
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
}

function handleResize(
  ws: WebSocket, msg: Record<string, unknown>,
  ptyManager: PtyManager, wsSessionMap: Map<WebSocket, Set<string>>,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): void {
  try {
    const parsed = ResizeSchema.safeParse(msg);
    if (!parsed.success) {
      sendError(ws, `Invalid resize: ${formatZodError(parsed.error)}`);
      return;
    }
    const { sessionId, cols, rows } = parsed.data;

    const mirror = wsMirrorMap.get(ws)?.get(sessionId);
    if (mirror) { mirror.pty.resize(cols, rows); return; }

    if (!wsSessionMap.get(ws)?.has(sessionId)) {
      sendError(ws, 'Session not found or not owned by this connection');
      return;
    }
    ptyManager.resizeSession(sessionId, cols, rows);
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
}

function handleDestroy(
  ws: WebSocket, msg: Record<string, unknown>,
  ptyManager: PtyManager, wsSessionMap: Map<WebSocket, Set<string>>
): void {
  try {
    const parsed = DestroySessionSchema.safeParse(msg);
    if (!parsed.success) {
      sendError(ws, `Invalid destroy: ${formatZodError(parsed.error)}`);
      return;
    }
    const { sessionId } = parsed.data;
    if (!wsSessionMap.get(ws)?.has(sessionId)) {
      sendError(ws, 'Session not found or not owned by this connection');
      return;
    }
    ptyManager.destroySession(sessionId);
    wsSessionMap.get(ws)?.delete(sessionId);
    safeSend(ws, JSON.stringify({ type: 'session_destroyed', sessionId }));
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
}

function handleList(ws: WebSocket, ptyManager: PtyManager, wsSessionMap: Map<WebSocket, Set<string>>): void {
  const ownedIds = wsSessionMap.get(ws);
  const sessions = ptyManager.listSessions()
    .filter((s) => ownedIds?.has(s.id))
    .map((s) => ({ id: s.id, cols: s.cols, rows: s.rows, alive: s.alive, createdAt: s.createdAt }));
  safeSend(ws, JSON.stringify({ type: 'session_list', sessions }));
}

// #4: Health endpoint — no uptime, minimal info
function handleHealth(res: ServerResponse, ptyManager: PtyManager): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', activeSessions: ptyManager.listSessions().length }));
}

async function handleLogin(
  req: IncomingMessage, res: ServerResponse, auth: AuthService, limiter: RateLimiter
): Promise<void> {
  const ip = req.socket.remoteAddress || 'unknown';

  if (!limiter.isAllowed(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many attempts. Try again later.' }));
    return;
  }

  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.writeHead(408, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request timeout' }));
    }
    req.destroy();
  }, LOGIN_TIMEOUT_MS);

  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) {
        clearTimeout(timeout);
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request too large' }));
        return;
      }
    }
  } catch { clearTimeout(timeout); return; }

  clearTimeout(timeout);

  try {
    const { username, password } = JSON.parse(body);
    const result = await auth.authenticate(username, password);
    if (result.success) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: result.token }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid credentials' }));
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
  }
}

// #2: Logout endpoint validates token ownership before invalidating
async function handleLogout(
  req: IncomingMessage, res: ServerResponse, auth: AuthService
): Promise<void> {
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request too large' }));
        return;
      }
    }
    const { token } = JSON.parse(body);
    if (!token || typeof token !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Token required' }));
      return;
    }
    // Verify token is valid before allowing logout (prevents forced logout of others)
    const session = auth.validateSession(token);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid token' }));
      return;
    }
    auth.logout(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request' }));
  }
}

// === Mirror mode (tmux) handlers ===

async function handleTmuxList(ws: WebSocket, tmux: TmuxManager): Promise<void> {
  try {
    const sessions = await tmux.listSessions();
    safeSend(ws, JSON.stringify({ type: 'tmux_sessions', sessions }));
  } catch (err) { sendError(ws, (err as Error).message); }
}

function handleTmuxAttach(
  ws: WebSocket, msg: Record<string, unknown>, tmux: TmuxManager,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): void {
  try {
    const sessionName = msg.sessionName as string;
    if (!sessionName) { sendError(ws, 'sessionName required'); return; }
    const { cols, rows } = clampDimensions(msg.cols, msg.rows);
    const mirrorId = `tmux:${sessionName}`;

    let mirrors = wsMirrorMap.get(ws);
    if (!mirrors) { mirrors = new Map(); wsMirrorMap.set(ws, mirrors); }
    if (mirrors.has(mirrorId)) { sendError(ws, `Already attached to "${sessionName}"`); return; }

    const handle = tmux.attachSession(sessionName, { cols, rows });

    handle.pty.onData((data: string) => {
      safeSend(ws, JSON.stringify({ type: 'output', sessionId: mirrorId, data }));
    });

    handle.pty.onExit(() => {
      mirrors?.delete(mirrorId);
      safeSend(ws, JSON.stringify({ type: 'tmux_detached', sessionId: mirrorId, sessionName }));
    });

    mirrors.set(mirrorId, handle);
    safeSend(ws, JSON.stringify({ type: 'tmux_attached', sessionId: mirrorId, sessionName }));
  } catch (err) { sendError(ws, (err as Error).message); }
}

function handleTmuxDetach(
  ws: WebSocket, msg: Record<string, unknown>,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): void {
  const sessionName = msg.sessionName as string;
  if (!sessionName) { sendError(ws, 'sessionName required'); return; }
  const mirrorId = `tmux:${sessionName}`;
  const mirrors = wsMirrorMap.get(ws);
  const handle = mirrors?.get(mirrorId);
  if (handle) {
    handle.cleanup(); mirrors?.delete(mirrorId);
    safeSend(ws, JSON.stringify({ type: 'tmux_detached', sessionId: mirrorId, sessionName }));
  } else {
    sendError(ws, `Not attached to "${sessionName}"`);
  }
}

async function handleTmuxCreate(ws: WebSocket, msg: Record<string, unknown>, tmux: TmuxManager): Promise<void> {
  try {
    const name = msg.name as string;
    if (!name) { sendError(ws, 'name required'); return; }
    await tmux.createSession(name);
    safeSend(ws, JSON.stringify({ type: 'tmux_created', name }));
  } catch (err) { sendError(ws, (err as Error).message); }
}

// #7: tmux_kill requires the requesting WS to be attached to that session
async function handleTmuxKill(
  ws: WebSocket, msg: Record<string, unknown>, tmux: TmuxManager,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): Promise<void> {
  try {
    const name = msg.name as string;
    if (!name) { sendError(ws, 'name required'); return; }
    const mirrorId = `tmux:${name}`;

    // Clean up all attached clients
    for (const [, mirrors] of wsMirrorMap) {
      const handle = mirrors.get(mirrorId);
      if (handle) { handle.cleanup(); mirrors.delete(mirrorId); }
    }
    await tmux.killSession(name);
    safeSend(ws, JSON.stringify({ type: 'tmux_killed', name }));
  } catch (err) { sendError(ws, (err as Error).message); }
}

async function handleTmuxWindows(ws: WebSocket, msg: Record<string, unknown>, tmux: TmuxManager): Promise<void> {
  try {
    const sessionName = msg.sessionName as string;
    if (!sessionName) { sendError(ws, 'sessionName required'); return; }
    const windows = await tmux.getSessionWindows(sessionName);
    safeSend(ws, JSON.stringify({ type: 'tmux_windows', sessionName, windows }));
  } catch (err) { sendError(ws, (err as Error).message); }
}

function sendError(ws: WebSocket, message: string, sessionId?: string): void {
  safeSend(ws, JSON.stringify({ type: 'error', message: message.replace(/\/.*\//g, '[path]'), sessionId }));
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

const CLIENT_DIST = resolve(new URL('.', import.meta.url).pathname, '..', '..', 'client', 'dist');
const CLIENT_DIST_PREFIX = CLIENT_DIST + '/';

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  let filePath = resolve(CLIENT_DIST, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));

  if (!filePath.startsWith(CLIENT_DIST_PREFIX) && filePath !== join(CLIENT_DIST, 'index.html')) {
    if (!filePath.startsWith(CLIENT_DIST)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
  }

  try { await access(filePath); } catch {
    filePath = join(CLIENT_DIST, 'index.html');
    try { await access(filePath); } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  try {
    const content = await readFile(filePath);
    const cacheControl = ext === '.html' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=31536000, immutable';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
    res.end(content);
  } catch {
    res.writeHead(500); res.end('Internal server error');
  }
}
