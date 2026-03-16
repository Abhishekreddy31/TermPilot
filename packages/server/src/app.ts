import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PtyManager } from './terminal/pty-manager.js';
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

export async function createServer(opts: ServerOptions): Promise<TermPilotServer> {
  const auth = new AuthService();
  const loginLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 15 * 60 * 1000 });
  const ptyManager = new PtyManager({
    maxSessions: opts.maxSessions ?? 20,
    idleTimeoutMs: 5 * 60 * 1000,
    defaultShell: opts.defaultShell,
  });

  // Track which sessions belong to which WebSocket
  const wsSessionMap = new Map<WebSocket, Set<string>>();

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS and security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

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
    verifyClient: ({ req }, done) => {
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

      handleMessage(ws, msg, ptyManager, wsSessionMap);
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      // Clean up sessions owned by this WebSocket
      const sessions = wsSessionMap.get(ws);
      if (sessions) {
        for (const sid of sessions) {
          try {
            ptyManager.destroySession(sid);
          } catch {
            // session may already be gone
          }
        }
      }
      wsSessionMap.delete(ws);
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
  wsSessionMap: Map<WebSocket, Set<string>>
): void {
  switch (msg.type) {
    case 'create':
      handleCreate(ws, msg, ptyManager, wsSessionMap);
      break;
    case 'input':
      handleInput(ws, msg, ptyManager);
      break;
    case 'resize':
      handleResize(ws, msg, ptyManager);
      break;
    case 'destroy':
      handleDestroy(ws, msg, ptyManager, wsSessionMap);
      break;
    case 'list':
      handleList(ws, ptyManager);
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
    const cols = typeof msg.cols === 'number' ? msg.cols : 80;
    const rows = typeof msg.rows === 'number' ? msg.rows : 24;
    const session = ptyManager.createSession({ cols, rows });

    wsSessionMap.get(ws)?.add(session.id);

    // Subscribe to PTY output
    ptyManager.onData(session.id, (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'output',
          sessionId: session.id,
          data,
        }));
      }
    });

    // Subscribe to PTY exit
    ptyManager.onExit(session.id, ({ exitCode, signal }) => {
      wsSessionMap.get(ws)?.delete(session.id);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'session_destroyed',
          sessionId: session.id,
          exitCode,
          signal,
        }));
      }
    });

    ws.send(JSON.stringify({
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
  ptyManager: PtyManager
): void {
  try {
    const sessionId = msg.sessionId as string;
    const data = msg.data as string;
    if (!sessionId || typeof data !== 'string') {
      sendError(ws, 'Invalid input message: sessionId and data required');
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
  ptyManager: PtyManager
): void {
  try {
    const sessionId = msg.sessionId as string;
    const cols = msg.cols as number;
    const rows = msg.rows as number;
    if (!sessionId || typeof cols !== 'number' || typeof rows !== 'number') {
      sendError(ws, 'Invalid resize message');
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
    ptyManager.destroySession(sessionId);
    wsSessionMap.get(ws)?.delete(sessionId);
    ws.send(JSON.stringify({
      type: 'session_destroyed',
      sessionId,
    }));
  } catch (err) {
    sendError(ws, (err as Error).message);
  }
}

function handleList(ws: WebSocket, ptyManager: PtyManager): void {
  const sessions = ptyManager.listSessions().map((s) => ({
    id: s.id,
    cols: s.cols,
    rows: s.rows,
    alive: s.alive,
    createdAt: s.createdAt,
  }));
  ws.send(JSON.stringify({ type: 'session_list', sessions }));
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

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request too large' }));
      return;
    }
  }

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

function sendError(ws: WebSocket, message: string, sessionId?: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', message, sessionId }));
  }
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
const CLIENT_DIST = join(new URL('.', import.meta.url).pathname, '..', '..', 'client', 'dist');

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  let filePath = join(CLIENT_DIST, url.pathname === '/' ? 'index.html' : url.pathname);

  // Prevent path traversal
  if (!filePath.startsWith(CLIENT_DIST)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Try the exact file, then fallback to index.html (SPA routing)
  if (!existsSync(filePath)) {
    filePath = join(CLIENT_DIST, 'index.html');
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Build the client first: pnpm --filter @termpilot/client build' }));
    return;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = readFileSync(filePath);

  // Cache static assets (hashed filenames)
  const cacheControl = ext === '.html' || ext === '.webmanifest'
    ? 'no-cache'
    : 'public, max-age=31536000, immutable';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
  });
  res.end(content);
}
