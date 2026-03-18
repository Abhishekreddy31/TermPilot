import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, type TermPilotServer } from '../../src/app.js';

let server: TermPilotServer;
let port: number;
let authToken: string;

async function connectWs(token?: string): Promise<WebSocket> {
  const url = `ws://localhost:${port}/ws${token ? `?token=${token}` : ''}`;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return ws;
}

function sendJson(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

function waitForMessage(ws: WebSocket, filter?: (msg: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (!filter || filter(msg)) {
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

describe('WebSocket Server Integration', () => {
  beforeEach(async () => {
    server = await createServer({ port: 0, defaultShell: '/bin/bash' });
    port = server.port;

    // Create user and get auth token
    await server.auth.createUser('test', 'testpass');
    const result = await server.auth.authenticate('test', 'testpass');
    authToken = result.token!;
  });

  afterEach(async () => {
    await server.close();
  });

  describe('authentication', () => {
    it('should reject connections without a token', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      const rejected = await new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(false));
        ws.on('error', () => resolve(true));
        ws.on('close', () => resolve(true));
      });
      expect(rejected).toBe(true);
    });

    it('should reject connections with invalid token', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=bad`);
      const rejected = await new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(false));
        ws.on('error', () => resolve(true));
        ws.on('close', () => resolve(true));
      });
      expect(rejected).toBe(true);
    });

    it('should accept connections with valid token', async () => {
      const ws = await connectWs(authToken);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });

  describe('session lifecycle', () => {
    it('should create a terminal session', async () => {
      const ws = await connectWs(authToken);
      const msgPromise = waitForMessage(ws);
      sendJson(ws, { type: 'create', cols: 80, rows: 24 });
      const response = await msgPromise;

      expect(response.type).toBe('session_created');
      expect(response.sessionId).toBeTruthy();
      ws.close();
    });

    it('should receive terminal output after creating session', async () => {
      const ws = await connectWs(authToken);

      // Create session
      const createPromise = waitForMessage(ws);
      sendJson(ws, { type: 'create', cols: 80, rows: 24 });
      const createResp = await createPromise;
      const sessionId = createResp.sessionId as string;

      // Wait for shell prompt output
      const outputPromise = waitForMessage(ws);
      const output = await outputPromise;
      expect(output.type).toBe('output');
      expect(output.sessionId).toBe(sessionId);
      expect(typeof output.data).toBe('string');

      ws.close();
    });

    it('should send input to terminal', async () => {
      const ws = await connectWs(authToken);

      const createPromise = waitForMessage(ws);
      sendJson(ws, { type: 'create', cols: 80, rows: 24 });
      const createResp = await createPromise;
      const sessionId = createResp.sessionId as string;

      // Drain initial output
      await waitForMessage(ws);

      // Send input
      const outputPromise = waitForMessage(ws);
      sendJson(ws, { type: 'input', sessionId, data: 'echo hello\n' });
      const output = await outputPromise;
      expect(output.type).toBe('output');

      ws.close();
    });

    it('should resize a terminal session', async () => {
      const ws = await connectWs(authToken);

      const createPromise = waitForMessage(ws);
      sendJson(ws, { type: 'create', cols: 80, rows: 24 });
      const createResp = await createPromise;
      const sessionId = createResp.sessionId as string;

      // Resize should not throw
      sendJson(ws, { type: 'resize', sessionId, cols: 120, rows: 40 });

      // Small delay to process
      await new Promise((r) => setTimeout(r, 50));
      ws.close();
    });

    it('should destroy a terminal session', async () => {
      const ws = await connectWs(authToken);

      const createPromise = waitForMessage(ws);
      sendJson(ws, { type: 'create', cols: 80, rows: 24 });
      const createResp = await createPromise;
      const sessionId = createResp.sessionId as string;

      const destroyPromise = waitForMessage(ws, (m) => m.type === 'session_destroyed');
      sendJson(ws, { type: 'destroy', sessionId });
      const destroyResp = await destroyPromise;
      expect(destroyResp.type).toBe('session_destroyed');
      expect(destroyResp.sessionId).toBe(sessionId);

      ws.close();
    });

    it('should list active sessions', async () => {
      const ws = await connectWs(authToken);

      // Create a session first
      const createPromise = waitForMessage(ws);
      sendJson(ws, { type: 'create', cols: 80, rows: 24 });
      await createPromise;

      const listPromise = waitForMessage(ws);
      sendJson(ws, { type: 'list' });
      const listResp = await listPromise;
      expect(listResp.type).toBe('session_list');
      expect(Array.isArray(listResp.sessions)).toBe(true);
      expect((listResp.sessions as unknown[]).length).toBe(1);

      ws.close();
    });
  });

  describe('error handling', () => {
    it('should return error for invalid message type', async () => {
      const ws = await connectWs(authToken);
      const errPromise = waitForMessage(ws);
      sendJson(ws, { type: 'bogus' });
      const errResp = await errPromise;
      expect(errResp.type).toBe('error');
      ws.close();
    });

    it('should return error for input to non-existent session', async () => {
      const ws = await connectWs(authToken);
      const errPromise = waitForMessage(ws);
      sendJson(ws, { type: 'input', sessionId: 'fake', data: 'test' });
      const errResp = await errPromise;
      expect(errResp.type).toBe('error');
      ws.close();
    });
  });

  describe('health endpoint', () => {
    it('should return health status', async () => {
      const res = await fetch(`http://localhost:${port}/health`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(typeof data.activeSessions).toBe('number');
    });
  });

  describe('login endpoint', () => {
    it('should return token on valid credentials', async () => {
      const res = await fetch(`http://localhost:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'test', password: 'testpass' }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.token).toBeTruthy();
    });

    it('should reject invalid credentials', async () => {
      const res = await fetch(`http://localhost:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'test', password: 'wrong' }),
      });
      expect(res.status).toBe(401);
    });
  });
});
