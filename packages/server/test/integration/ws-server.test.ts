import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, type TermPilotServer } from '../../src/app.js';

let server: TermPilotServer;
let port: number;
let authToken: string;

async function connectWs(token?: string): Promise<WebSocket> {
  const url = `ws://localhost:${port}/ws`;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  // Send auth as first message (new protocol)
  if (token) {
    ws.send(JSON.stringify({ type: 'auth', token }));
    // Wait for auth_ok
    await new Promise<void>((resolve, reject) => {
      ws.once('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth_ok') resolve();
        else reject(new Error(`Auth failed: ${msg.type}`));
      });
    });
  }

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
    await server.auth.createUser('test', 'testpass');
    const result = await server.auth.authenticate('test', 'testpass');
    authToken = result.token!;
  });

  afterEach(async () => {
    await server.close();
  });

  describe('authentication', () => {
    it('should reject connections without auth message', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      // Send a non-auth message
      ws.send(JSON.stringify({ type: 'list' }));
      const msg = await new Promise<Record<string, unknown>>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      expect(msg.type).toBe('error');
      ws.close();
    });

    it('should reject connections with invalid token', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      ws.send(JSON.stringify({ type: 'auth', token: 'bad' }));
      const msg = await new Promise<Record<string, unknown>>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      expect(msg.type).toBe('auth_failed');

      const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
      expect(code).toBe(4401);
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
      const msgPromise = waitForMessage(ws, (m) => m.type === 'session_created');
      sendJson(ws, { type: 'create', cols: 80, rows: 24 });
      const response = await msgPromise;
      expect(response.type).toBe('session_created');
      expect(response.sessionId).toBeTruthy();
      ws.close();
    });

    it('should receive terminal output after creating session', async () => {
      const ws = await connectWs(authToken);
      const createPromise = waitForMessage(ws, (m) => m.type === 'session_created');
      sendJson(ws, { type: 'create', cols: 80, rows: 24 });
      const createResp = await createPromise;
      const sessionId = createResp.sessionId as string;

      const outputPromise = waitForMessage(ws, (m) => m.type === 'output');
      const output = await outputPromise;
      expect(output.type).toBe('output');
      expect(output.sessionId).toBe(sessionId);
      ws.close();
    });

    it('should send input to terminal', async () => {
      const ws = await connectWs(authToken);
      const createPromise = waitForMessage(ws, (m) => m.type === 'session_created');
      sendJson(ws, { type: 'create', cols: 80, rows: 24 });
      const createResp = await createPromise;
      const sessionId = createResp.sessionId as string;

      await waitForMessage(ws, (m) => m.type === 'output');
      const outputPromise = waitForMessage(ws, (m) => m.type === 'output');
      sendJson(ws, { type: 'input', sessionId, data: 'echo hello\n' });
      const output = await outputPromise;
      expect(output.type).toBe('output');
      ws.close();
    });

    it('should resize a terminal session', async () => {
      const ws = await connectWs(authToken);
      const createPromise = waitForMessage(ws, (m) => m.type === 'session_created');
      sendJson(ws, { type: 'create', cols: 80, rows: 24 });
      await createPromise;
      const sessionId = (await createPromise).sessionId as string;

      sendJson(ws, { type: 'resize', sessionId, cols: 120, rows: 40 });
      await new Promise((r) => setTimeout(r, 50));
      ws.close();
    });

    it('should destroy a terminal session', async () => {
      const ws = await connectWs(authToken);
      const createPromise = waitForMessage(ws, (m) => m.type === 'session_created');
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
      const createPromise = waitForMessage(ws, (m) => m.type === 'session_created');
      sendJson(ws, { type: 'create', cols: 80, rows: 24 });
      await createPromise;

      const listPromise = waitForMessage(ws, (m) => m.type === 'session_list');
      sendJson(ws, { type: 'list' });
      const listResp = await listPromise;
      expect(listResp.type).toBe('session_list');
      expect(Array.isArray(listResp.sessions)).toBe(true);
      expect((listResp.sessions as unknown[]).length).toBe(1);
      ws.close();
    });

    it('should reject input to session not owned by this connection', async () => {
      const ws = await connectWs(authToken);
      const errPromise = waitForMessage(ws, (m) => m.type === 'error');
      sendJson(ws, { type: 'input', sessionId: 'fake-uuid', data: 'test' });
      const errResp = await errPromise;
      expect(errResp.type).toBe('error');
      ws.close();
    });
  });

  describe('error handling', () => {
    it('should return error for invalid message type', async () => {
      const ws = await connectWs(authToken);
      const errPromise = waitForMessage(ws, (m) => m.type === 'error');
      sendJson(ws, { type: 'bogus' });
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

  describe('logout endpoint', () => {
    it('should invalidate token on logout', async () => {
      const res = await fetch(`http://localhost:${port}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: authToken }),
      });
      expect(res.ok).toBe(true);

      // Token should now be invalid
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((resolve) => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'auth', token: authToken }));
      const msg = await new Promise<Record<string, unknown>>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      expect(msg.type).toBe('auth_failed');
      ws.close();
    });
  });
});
