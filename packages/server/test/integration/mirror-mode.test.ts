import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import { createServer, type TermPilotServer } from '../../src/app.js';

let server: TermPilotServer;
let port: number;
let authToken: string;

async function connectWs(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
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

describe('Mirror Mode (tmux) Integration', () => {
  beforeEach(async () => {
    server = await createServer({ port: 0, defaultShell: '/bin/bash' });
    port = server.port;
    await server.auth.createUser('test', 'testpass');
    const result = await server.auth.authenticate('test', 'testpass');
    authToken = result.token!;

    // Create a tmux session for testing
    try {
      execFileSync('tmux', ['new-session', '-d', '-s', 'mirror-test']);
    } catch {
      // might already exist
    }
  });

  afterEach(async () => {
    try {
      execFileSync('tmux', ['kill-session', '-t', 'mirror-test']);
    } catch {
      // already dead
    }
    await server.close();
  });

  it('should list tmux sessions', async () => {
    const ws = await connectWs(authToken);
    const msgPromise = waitForMessage(ws, (m) => m.type === 'tmux_sessions');
    sendJson(ws, { type: 'tmux_list' });
    const response = await msgPromise;

    expect(response.type).toBe('tmux_sessions');
    expect(Array.isArray(response.sessions)).toBe(true);
    const sessions = response.sessions as Array<{ name: string }>;
    expect(sessions.some((s) => s.name === 'mirror-test')).toBe(true);

    ws.close();
  });

  it('should attach to a tmux session and receive output', async () => {
    const ws = await connectWs(authToken);

    const attachPromise = waitForMessage(ws, (m) => m.type === 'tmux_attached');
    sendJson(ws, { type: 'tmux_attach', sessionName: 'mirror-test', cols: 80, rows: 24 });
    const attachResp = await attachPromise;

    expect(attachResp.type).toBe('tmux_attached');
    expect(attachResp.sessionName).toBe('mirror-test');
    expect(attachResp.sessionId).toBe('tmux:mirror-test');

    // Should receive terminal output
    const outputPromise = waitForMessage(ws, (m) => m.type === 'output');
    const output = await outputPromise;
    expect(output.type).toBe('output');
    expect(output.sessionId).toBe('tmux:mirror-test');

    ws.close();
  });

  it('should send input to a mirrored tmux session', async () => {
    const ws = await connectWs(authToken);

    const attachPromise = waitForMessage(ws, (m) => m.type === 'tmux_attached');
    sendJson(ws, { type: 'tmux_attach', sessionName: 'mirror-test', cols: 80, rows: 24 });
    await attachPromise;

    // Drain initial output
    await waitForMessage(ws, (m) => m.type === 'output');

    // Send input and wait for echo
    sendJson(ws, { type: 'input', sessionId: 'tmux:mirror-test', data: 'echo mirror-works\n' });

    const output = await waitForMessage(ws, (m) =>
      m.type === 'output' && typeof m.data === 'string' && m.data.includes('mirror-works')
    );
    expect(output.data).toContain('mirror-works');

    ws.close();
  });

  it('should detach from a tmux session', async () => {
    const ws = await connectWs(authToken);

    const attachPromise = waitForMessage(ws, (m) => m.type === 'tmux_attached');
    sendJson(ws, { type: 'tmux_attach', sessionName: 'mirror-test', cols: 80, rows: 24 });
    await attachPromise;

    const detachPromise = waitForMessage(ws, (m) => m.type === 'tmux_detached');
    sendJson(ws, { type: 'tmux_detach', sessionName: 'mirror-test' });
    const detachResp = await detachPromise;

    expect(detachResp.type).toBe('tmux_detached');
    expect(detachResp.sessionName).toBe('mirror-test');

    ws.close();
  });

  it('should create a new tmux session', async () => {
    const ws = await connectWs(authToken);

    const createPromise = waitForMessage(ws, (m) => m.type === 'tmux_created');
    sendJson(ws, { type: 'tmux_create', name: 'mirror-test-new' });
    const createResp = await createPromise;

    expect(createResp.type).toBe('tmux_created');
    expect(createResp.name).toBe('mirror-test-new');

    // Clean up
    try {
      execFileSync('tmux', ['kill-session', '-t', 'mirror-test-new']);
    } catch {}

    ws.close();
  });

  it('should kill a tmux session', async () => {
    // Create one to kill
    execFileSync('tmux', ['new-session', '-d', '-s', 'mirror-test-killme']);

    const ws = await connectWs(authToken);

    const killPromise = waitForMessage(ws, (m) => m.type === 'tmux_killed');
    sendJson(ws, { type: 'tmux_kill', name: 'mirror-test-killme' });
    const killResp = await killPromise;

    expect(killResp.type).toBe('tmux_killed');
    expect(killResp.name).toBe('mirror-test-killme');

    ws.close();
  });

  it('should work alongside independent sessions', async () => {
    const ws = await connectWs(authToken);

    // Create an independent session
    const createPromise = waitForMessage(ws, (m) => m.type === 'session_created');
    sendJson(ws, { type: 'create', cols: 80, rows: 24 });
    const createResp = await createPromise;
    const independentId = createResp.sessionId as string;

    // Attach to tmux mirror
    const attachPromise = waitForMessage(ws, (m) => m.type === 'tmux_attached');
    sendJson(ws, { type: 'tmux_attach', sessionName: 'mirror-test', cols: 80, rows: 24 });
    const attachResp = await attachPromise;
    const mirrorId = attachResp.sessionId as string;

    // Both should be usable
    expect(independentId).toBeTruthy();
    expect(mirrorId).toBe('tmux:mirror-test');
    expect(independentId).not.toBe(mirrorId);

    ws.close();
  });
});
