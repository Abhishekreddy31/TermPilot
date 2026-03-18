import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'node:url';
import { readFile, access } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { PtyManager } from './terminal/pty-manager.js';
import { TmuxManager, type AttachResult } from './terminal/tmux-manager.js';
import { AuthService, RateLimiter } from './auth/auth-service.js';

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
const AUTH_TIMEOUT_MS = 10000; // 10s to send auth message after connecting

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

function getOrigin(req: IncomingMessage): string {
  return req.headers.origin || req.headers.host || '';
}

export async function createServer(opts: ServerOptions): Promise<TermPilotServer> {
  const auth = new AuthService();
  const loginLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 15 * 60 * 1000 });
  const ptyManager = new PtyManager({
    maxSessions: opts.maxSessions ?? 20,
    idleTimeoutMs: 5 * 60 * 1000,
    defaultShell: opts.defaultShell,
  });

  const tmuxManager = new TmuxManager();
  let activeConnections = 0;

  // Track which sessions belong to which WebSocket
  const wsSessionMap = new Map<WebSocket, Set<string>>();
  const wsMirrorMap = new Map<WebSocket, Map<string, AttachResult>>();
  // Track authenticated tokens per WebSocket
  const wsTokenMap = new Map<WebSocket, string>();

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = getOrigin(req);

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' wss: ws:; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:");

    // CORS: only allow same-origin requests (not wildcard)
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/health' && req.method === 'GET') {
      handleHealth(res, ptyManager);
      return;
    }

    if (req.url === '/api/auth/login' && req.method === 'POST') {
      handleLogin(req, res, auth, loginLimiter);
      return;
    }

    if (req.url === '/api/auth/logout' && req.method === 'POST') {
      handleLogout(req, res, auth);
      return;
    }

    serveStatic(req, res);
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: MAX_WS_PAYLOAD,
    verifyClient: ({ req }, done) => {
      if (activeConnections >= MAX_WS_CONNECTIONS) {
        done(false, 503, 'Too many connections');
        return;
      }
      // Accept connection — auth happens via first message, not URL
      done(true);
    },
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    activeConnections++;
    wsSessionMap.set(ws, new Set());
    let authenticated = false;

    // Auth timeout: if no auth message within AUTH_TIMEOUT_MS, close
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
        ws.close(4401, 'Auth timeout');
      }
    }, AUTH_TIMEOUT_MS);

    // Ping/pong keepalive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30_000);

    ws.on('message', (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendError(ws, 'Invalid JSON message');
        return;
      }

      // First message must be auth
      if (!authenticated) {
        if (msg.type === 'auth' && typeof msg.token === 'string') {
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
          safeSend(ws, JSON.stringify({ type: 'error', message: 'Send auth message first: {type:"auth", token:"..."}' }));
        }
        return;
      }

      // Authenticated — touch session and route message
      const token = wsTokenMap.get(ws);
      if (token) auth.touchSession(token);

      handleMessage(ws, msg, ptyManager, tmuxManager, wsSessionMap, wsMirrorMap);
    });

    ws.on('close', () => {
      activeConnections--;
      clearInterval(pingInterval);
      clearTimeout(authTimer);

      // Clean up independent sessions
      const sessions = wsSessionMap.get(ws);
      if (sessions) {
        for (const sid of [...sessions]) {
          try { ptyManager.destroySession(sid); } catch {}
        }
      }
      wsSessionMap.delete(ws);

      // Clean up mirror handles
      const mirrors = wsMirrorMap.get(ws);
      if (mirrors) {
        for (const [, handle] of mirrors) {
          handle.cleanup();
        }
      }
      wsMirrorMap.delete(ws);
      wsTokenMap.delete(ws);
    });

    ws.on('error', () => {});
  });

  return new Promise<TermPilotServer>((resolve) => {
    httpServer.listen(opts.port, opts.host || '127.0.0.1', () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;

      resolve({
        port: actualPort,
        auth,
        close: async () => {
          auth.dispose();
          ptyManager.destroyAll();
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
    case 'create':
      handleCreate(ws, msg, ptyManager, wsSessionMap);
      break;
    case 'input':
      handleInput(ws, msg, ptyManager, wsSessionMap, wsMirrorMap);
      break;
    case 'resize':
      handleResize(ws, msg, ptyManager, wsSessionMap, wsMirrorMap);
      break;
    case 'destroy':
      handleDestroy(ws, msg, ptyManager, wsSessionMap);
      break;
    case 'list':
      handleList(ws, ptyManager, wsSessionMap);
      break;
    case 'tmux_list':
      handleTmuxList(ws, tmuxManager);
      break;
    case 'tmux_attach':
      handleTmuxAttach(ws, msg, tmuxManager, wsMirrorMap);
      break;
    case 'tmux_detach':
      handleTmuxDetach(ws, msg, wsMirrorMap);
      break;
    case 'tmux_create':
      handleTmuxCreate(ws, msg, tmuxManager);
      break;
    case 'tmux_kill':
      handleTmuxKill(ws, msg, tmuxManager, wsMirrorMap);
      break;
    case 'tmux_windows':
      handleTmuxWindows(ws, msg, tmuxManager);
      break;
    default:
      sendError(ws, `Unknown message type: ${msg.type}`);
  }
}

function handleCreate(
  ws: WebSocket,
  msg: Record<string, unknown>,
  ptyManager: PtyManager,
  wsSessionMap: Map<WebSocket, Set<string>>
): void {
  try {
    const { cols, rows } = clampDimensions(msg.cols, msg.rows);
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
  ws: WebSocket,
  msg: Record<string, unknown>,
  ptyManager: PtyManager,
  wsSessionMap: Map<WebSocket, Set<string>>,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): void {
  try {
    const sessionId = msg.sessionId as string;
    const data = msg.data as string;
    if (!sessionId || typeof data !== 'string') {
      sendError(ws, 'Invalid input message: sessionId and data required');
      return;
    }

    // Mirror mode
    const mirror = wsMirrorMap.get(ws)?.get(sessionId);
    if (mirror) {
      mirror.pty.write(data);
      return;
    }

    // Independent mode — verify ownership
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
  ws: WebSocket,
  msg: Record<string, unknown>,
  ptyManager: PtyManager,
  wsSessionMap: Map<WebSocket, Set<string>>,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): void {
  try {
    const sessionId = msg.sessionId as string;
    if (!sessionId) {
      sendError(ws, 'Invalid resize message');
      return;
    }
    const { cols, rows } = clampDimensions(msg.cols, msg.rows);

    // Mirror mode
    const mirror = wsMirrorMap.get(ws)?.get(sessionId);
    if (mirror) {
      mirror.pty.resize(cols, rows);
      return;
    }

    // Independent mode — verify ownership
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
  ws: WebSocket,
  msg: Record<string, unknown>,
  ptyManager: PtyManager,
  wsSessionMap: Map<WebSocket, Set<string>>
): void {
  try {
    const sessionId = msg.sessionId as string;
    if (!sessionId) {
      sendError(ws, 'sessionId required');
      return;
    }

    // Verify ownership
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

function handleHealth(res: ServerResponse, ptyManager: PtyManager): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', activeSessions: ptyManager.listSessions().length, uptime: process.uptime() }));
}

async function handleLogin(
  req: IncomingMessage, res: ServerResponse, auth: AuthService, limiter: RateLimiter
): Promise<void> {
  const ip = req.socket.remoteAddress || 'unknown';
  const origin = getOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

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
  } catch {
    clearTimeout(timeout);
    return;
  }

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

async function handleLogout(
  req: IncomingMessage, res: ServerResponse, auth: AuthService
): Promise<void> {
  const origin = getOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) break;
    }
    const { token } = JSON.parse(body);
    if (token) auth.logout(token);
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
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
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
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
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
    handle.cleanup();
    mirrors?.delete(mirrorId);
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

async function handleTmuxKill(
  ws: WebSocket, msg: Record<string, unknown>, tmux: TmuxManager,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): Promise<void> {
  try {
    const name = msg.name as string;
    if (!name) { sendError(ws, 'name required'); return; }
    const mirrorId = `tmux:${name}`;
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
