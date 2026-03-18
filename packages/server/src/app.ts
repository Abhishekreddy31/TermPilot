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
  const ptyManager = new PtyManager({
    maxSessions: opts.maxSessions ?? 20,
    idleTimeoutMs: 5 * 60 * 1000,
    defaultShell: opts.defaultShell,
  });

  const tmuxManager = new TmuxManager();
  let activeConnections = 0;

  // Track which sessions belong to which WebSocket (independent mode)
  // Track tmux attach handles per WebSocket (mirror mode)
  const wsSessionMap = new Map<WebSocket, Set<string>>();
  const wsMirrorMap = new Map<WebSocket, Map<string, AttachResult>>();

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' wss: ws:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:");

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.writeHead(204);
      res.end();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/health' && req.method === 'GET') {
      handleHealth(res, ptyManager);
      return;
    }

    if (req.url === '/api/auth/login' && req.method === 'POST') {
      handleLogin(req, res, auth, loginLimiter);
      return;
    }

    // Serve static files for the built client
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: MAX_WS_PAYLOAD,
    verifyClient: ({ req }, done) => {
      // Connection limit
      if (activeConnections >= MAX_WS_CONNECTIONS) {
        done(false, 503, 'Too many connections');
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      if (!token || !auth.validateSession(token)) {
        done(false, 401, 'Unauthorized');
        return;
      }

      done(true);
    },
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    activeConnections++;
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const token = url.searchParams.get('token')!;
    wsSessionMap.set(ws, new Set());

    // Ping/pong keepalive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30_000);

    ws.on('message', (raw: Buffer) => {
      auth.touchSession(token);

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendError(ws, 'Invalid JSON message');
        return;
      }

      handleMessage(ws, msg, ptyManager, tmuxManager, wsSessionMap, wsMirrorMap);
    });

    ws.on('close', () => {
      activeConnections--;
      clearInterval(pingInterval);

      // Clean up independent sessions
      const sessions = wsSessionMap.get(ws);
      if (sessions) {
        for (const sid of [...sessions]) {
          try {
            ptyManager.destroySession(sid);
          } catch {
            // session may already be gone
          }
        }
      }
      wsSessionMap.delete(ws);

      // Clean up mirror-mode attach handles
      const mirrors = wsMirrorMap.get(ws);
      if (mirrors) {
        for (const [, handle] of mirrors) {
          handle.cleanup();
        }
      }
      wsMirrorMap.delete(ws);
    });

    ws.on('error', () => {
      // Handled by close event
    });
  });

  return new Promise<TermPilotServer>((resolve) => {
    httpServer.listen(opts.port, opts.host || '0.0.0.0', () => {
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
    // === Independent mode ===
    case 'create':
      handleCreate(ws, msg, ptyManager, wsSessionMap);
      break;
    case 'input':
      handleInput(ws, msg, ptyManager, wsMirrorMap);
      break;
    case 'resize':
      handleResize(ws, msg, ptyManager, wsMirrorMap);
      break;
    case 'destroy':
      handleDestroy(ws, msg, ptyManager, wsSessionMap);
      break;
    case 'list':
      handleList(ws, ptyManager, wsSessionMap);
      break;

    // === Mirror mode (tmux) ===
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

    // Subscribe to PTY output
    const unsubData = ptyManager.onData(session.id, (data) => {
      safeSend(ws, JSON.stringify({
        type: 'output',
        sessionId: session.id,
        data,
      }));
    });

    // Subscribe to PTY exit — only send if not intentionally destroyed
    const unsubExit = ptyManager.onExit(session.id, ({ exitCode, signal }) => {
      wsSessionMap.get(ws)?.delete(session.id);
      safeSend(ws, JSON.stringify({
        type: 'session_destroyed',
        sessionId: session.id,
        exitCode,
        signal,
      }));
    });

    // Store unsubscribe functions for cleanup on ws close
    const origSessions = wsSessionMap.get(ws);
    if (origSessions) {
      // Attach cleanup metadata
      (origSessions as any)[`_unsub_${session.id}`] = () => { unsubData(); unsubExit(); };
    }

    safeSend(ws, JSON.stringify({
      type: 'session_created',
      sessionId: session.id,
    }));
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
}

function handleInput(
  ws: WebSocket,
  msg: Record<string, unknown>,
  ptyManager: PtyManager,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): void {
  try {
    const sessionId = msg.sessionId as string;
    const data = msg.data as string;
    if (!sessionId || typeof data !== 'string') {
      sendError(ws, 'Invalid input message: sessionId and data required');
      return;
    }

    // Check if this is a mirror-mode session first
    const mirrors = wsMirrorMap.get(ws);
    const mirror = mirrors?.get(sessionId);
    if (mirror) {
      mirror.pty.write(data);
      return;
    }

    // Otherwise, independent session
    ptyManager.writeToSession(sessionId, data);
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
}

function handleResize(
  ws: WebSocket,
  msg: Record<string, unknown>,
  ptyManager: PtyManager,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): void {
  try {
    const sessionId = msg.sessionId as string;
    if (!sessionId) {
      sendError(ws, 'Invalid resize message');
      return;
    }

    const { cols, rows } = clampDimensions(msg.cols, msg.rows);

    // Check if this is a mirror-mode session first
    const mirrors = wsMirrorMap.get(ws);
    const mirror = mirrors?.get(sessionId);
    if (mirror) {
      mirror.pty.resize(cols, rows);
      return;
    }

    // Otherwise, independent session
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
    ptyManager.destroySession(sessionId);
    wsSessionMap.get(ws)?.delete(sessionId);
    safeSend(ws, JSON.stringify({
      type: 'session_destroyed',
      sessionId,
    }));
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
}

function handleList(ws: WebSocket, ptyManager: PtyManager, wsSessionMap: Map<WebSocket, Set<string>>): void {
  const ownedIds = wsSessionMap.get(ws);
  const sessions = ptyManager.listSessions()
    .filter((s) => ownedIds?.has(s.id))
    .map((s) => ({
      id: s.id,
      cols: s.cols,
      rows: s.rows,
      alive: s.alive,
      createdAt: s.createdAt,
    }));
  safeSend(ws, JSON.stringify({ type: 'session_list', sessions }));
}

function handleHealth(res: ServerResponse, ptyManager: PtyManager): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    activeSessions: ptyManager.listSessions().length,
    uptime: process.uptime(),
  }));
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthService,
  limiter: RateLimiter
): Promise<void> {
  const ip = req.socket.remoteAddress || 'unknown';

  if (!limiter.isAllowed(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many attempts. Try again later.' }));
    return;
  }

  // Request timeout to prevent slow-loris
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
    return; // Connection was destroyed by timeout
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
  ws: WebSocket,
  msg: Record<string, unknown>,
  tmux: TmuxManager,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): void {
  try {
    const sessionName = msg.sessionName as string;
    if (!sessionName) {
      sendError(ws, 'sessionName required for tmux_attach');
      return;
    }

    const { cols, rows } = clampDimensions(msg.cols, msg.rows);
    const mirrorId = `tmux:${sessionName}`;

    let mirrors = wsMirrorMap.get(ws);
    if (!mirrors) {
      mirrors = new Map();
      wsMirrorMap.set(ws, mirrors);
    }

    if (mirrors.has(mirrorId)) {
      sendError(ws, `Already attached to tmux session "${sessionName}"`);
      return;
    }

    const handle = tmux.attachSession(sessionName, { cols, rows });

    handle.pty.onData((data: string) => {
      safeSend(ws, JSON.stringify({
        type: 'output',
        sessionId: mirrorId,
        data,
      }));
    });

    handle.pty.onExit(() => {
      mirrors?.delete(mirrorId);
      safeSend(ws, JSON.stringify({
        type: 'tmux_detached',
        sessionId: mirrorId,
        sessionName,
      }));
    });

    mirrors.set(mirrorId, handle);

    safeSend(ws, JSON.stringify({
      type: 'tmux_attached',
      sessionId: mirrorId,
      sessionName,
    }));
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
}

function handleTmuxDetach(
  ws: WebSocket,
  msg: Record<string, unknown>,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): void {
  const sessionName = msg.sessionName as string;
  if (!sessionName) {
    sendError(ws, 'sessionName required');
    return;
  }

  const mirrorId = `tmux:${sessionName}`;
  const mirrors = wsMirrorMap.get(ws);
  const handle = mirrors?.get(mirrorId);

  if (handle) {
    handle.cleanup();
    mirrors?.delete(mirrorId);
    safeSend(ws, JSON.stringify({
      type: 'tmux_detached',
      sessionId: mirrorId,
      sessionName,
    }));
  } else {
    sendError(ws, `Not attached to tmux session "${sessionName}"`);
  }
}

async function handleTmuxCreate(
  ws: WebSocket,
  msg: Record<string, unknown>,
  tmux: TmuxManager
): Promise<void> {
  try {
    const name = msg.name as string;
    if (!name) {
      sendError(ws, 'name required for tmux_create');
      return;
    }
    await tmux.createSession(name);
    safeSend(ws, JSON.stringify({ type: 'tmux_created', name }));
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
}

async function handleTmuxKill(
  ws: WebSocket,
  msg: Record<string, unknown>,
  tmux: TmuxManager,
  wsMirrorMap: Map<WebSocket, Map<string, AttachResult>>
): Promise<void> {
  try {
    const name = msg.name as string;
    if (!name) {
      sendError(ws, 'name required for tmux_kill');
      return;
    }

    // Detach all clients attached to this session
    const mirrorId = `tmux:${name}`;
    for (const [, mirrors] of wsMirrorMap) {
      const handle = mirrors.get(mirrorId);
      if (handle) {
        handle.cleanup();
        mirrors.delete(mirrorId);
      }
    }

    await tmux.killSession(name);
    safeSend(ws, JSON.stringify({ type: 'tmux_killed', name }));
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
}

async function handleTmuxWindows(
  ws: WebSocket,
  msg: Record<string, unknown>,
  tmux: TmuxManager
): Promise<void> {
  try {
    const sessionName = msg.sessionName as string;
    if (!sessionName) {
      sendError(ws, 'sessionName required');
      return;
    }
    const windows = await tmux.getSessionWindows(sessionName);
    safeSend(ws, JSON.stringify({ type: 'tmux_windows', sessionName, windows }));
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
}

function sendError(ws: WebSocket, message: string, sessionId?: string): void {
  safeSend(ws, JSON.stringify({ type: 'error', message, sessionId }));
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

// Resolve client dist directory (relative to server package)
const CLIENT_DIST = resolve(new URL('.', import.meta.url).pathname, '..', '..', 'client', 'dist');
const CLIENT_DIST_PREFIX = CLIENT_DIST + '/';

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  let filePath = resolve(CLIENT_DIST, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));

  // Prevent path traversal (resolve + prefix check)
  if (!filePath.startsWith(CLIENT_DIST_PREFIX) && filePath !== CLIENT_DIST + '/index.html') {
    // Re-check with the resolved path
    if (!filePath.startsWith(CLIENT_DIST)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
  }

  // Try the exact file, then fallback to index.html (SPA routing)
  try {
    await access(filePath);
  } catch {
    filePath = join(CLIENT_DIST, 'index.html');
    try {
      await access(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. Build the client first: pnpm --filter @termpilot/client build' }));
      return;
    }
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = await readFile(filePath);
    const cacheControl = ext === '.html' || ext === '.webmanifest'
      ? 'no-cache'
      : 'public, max-age=31536000, immutable';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
    });
    res.end(content);
  } catch {
    res.writeHead(500);
    res.end('Internal server error');
  }
}
