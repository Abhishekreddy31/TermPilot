import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { PROTOCOL_VERSION, TERMINAL_LIMITS, WS_CLOSE } from '@termpilot/shared';
import { TestClient, csrfToken, loginToken, startTestServer, type TestServer } from '../helpers/server.js';
import { IS_WINDOWS, eventually, sleep } from '../helpers/platform.js';

const MINUTE = 60_000;
/** Upper bound on output delivered after a stalled reader resumes: high-water mark plus generous OS socket buffers. */
const FLOW_BACKLOG_LIMIT = 16 * 1024 * 1024;

/** Status the server answers a WebSocket upgrade with. */
function upgradeStatus(port: number, headers: Record<string, string>, path = '/ws'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('WebSocket server', () => {
  let t: TestServer;
  let token: string;
  const clients: TestClient[] = [];

  const connect = async (withToken = token) => {
    const client = await TestClient.connect(t.wsUrl, withToken);
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    t = await startTestServer();
    token = await loginToken(t.baseUrl);
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await t.close();
  });

  describe('handshake', () => {
    it('rejects upgrades for foreign hosts and origins', async () => {
      const port = t.server.port;
      expect(await upgradeStatus(port, { Host: `localhost:${port}` })).toBe(101);
      expect(await upgradeStatus(port, { Host: 'attacker.example' })).toBe(403);
      expect(await upgradeStatus(port, { Host: `localhost:${port}`, Origin: 'https://attacker.example' })).toBe(403);
      expect(await upgradeStatus(port, { Host: `localhost:${port}` }, '/other')).toBe(404);
    });

    it('caps authenticated devices and asks extra ones to retry later', async () => {
      await t.close();
      t = await startTestServer({ maxConnections: 1 });
      token = await loginToken(t.baseUrl);
      await connect();
      const extra = await TestClient.open(t.wsUrl);
      extra.send({ type: 'auth', token, protocol: PROTOCOL_VERSION });
      expect((await extra.next('error')).message).toMatch(/Too many devices/);
      expect((await extra.waitClosed()).code).toBe(WS_CLOSE.tryAgainLater);
    });

    it('limits unauthenticated sockets per client so idle ones cannot lock the owner out', async () => {
      await t.close();
      t = await startTestServer({ maxConnections: 2, trustTunnelProxy: true });
      token = await loginToken(t.baseUrl);
      const attacker = { 'CF-Connecting-IP': '198.51.100.7' };
      for (let i = 0; i < 4; i++) clients.push(await TestClient.open(t.wsUrl, attacker));
      expect(await upgradeStatus(t.server.port, { Host: `localhost:${t.server.port}`, ...attacker })).toBe(429);
      // The owner, from another address, still gets in.
      const owner = await TestClient.open(t.wsUrl, { 'CF-Connecting-IP': '203.0.113.9' });
      clients.push(owner);
      owner.send({ type: 'auth', token, protocol: PROTOCOL_VERSION });
      await owner.next('auth_ok');
    });
  });

  describe('authentication', () => {
    it('requires auth before anything else', async () => {
      const client = await TestClient.open(t.wsUrl);
      clients.push(client);
      client.send({ type: 'list' });
      expect((await client.next('error')).message).toMatch(/auth/i);
    });

    it('closes on an invalid token', async () => {
      const client = await TestClient.open(t.wsUrl);
      client.send({ type: 'auth', token: 'bad', protocol: PROTOCOL_VERSION });
      expect(await client.next('auth_failed')).toMatchObject({ reason: 'invalid_token' });
      expect((await client.waitClosed()).code).toBe(WS_CLOSE.unauthorized);
    });

    it('tells an outdated client to reload', async () => {
      const client = await TestClient.open(t.wsUrl);
      client.send({ type: 'auth', token, protocol: PROTOCOL_VERSION - 1 });
      expect(await client.next('auth_failed')).toMatchObject({ reason: 'protocol_mismatch' });
      expect((await client.waitClosed()).code).toBe(WS_CLOSE.protocolMismatch);
    });

    it('closes connections that never authenticate', async () => {
      await t.close();
      t = await startTestServer({ authTimeoutMs: 100 });
      const client = await TestClient.open(t.wsUrl);
      expect((await client.waitClosed()).code).toBe(WS_CLOSE.authTimeout);
    });

    it('does not rate-limit a device that reconnects often with a valid login', async () => {
      for (let i = 0; i < 15; i++) {
        const client = await TestClient.connect(t.wsUrl, token);
        await client.close();
      }
    });

    it('rate-limits failed authentication attempts', async () => {
      const results: string[] = [];
      for (let i = 0; i < 11; i++) {
        const client = await TestClient.open(t.wsUrl);
        client.send({ type: 'auth', token: 'bad', protocol: PROTOCOL_VERSION });
        const reply = await client.next('auth_failed');
        results.push(reply.reason);
        await client.waitClosed();
      }
      expect(results.at(-1)).toBe('rate_limited');
    });
  });

  describe('messages', () => {
    it('reports invalid JSON, invalid messages and binary frames without disconnecting', async () => {
      const client = await connect();
      client.ws.send('{nope');
      expect((await client.next('error')).message).toBe('Invalid JSON message');
      let from = client.mark;
      client.send({ type: 'resize', sessionId: 's', cols: 0, rows: 1 });
      expect((await client.next('error', { from })).message).toMatch(/cols/);
      from = client.mark;
      client.ws.send(Buffer.from([1, 2, 3]));
      expect((await client.next('error', { from })).message).toMatch(/Binary/);
      from = client.mark;
      client.send({ type: 'list' });
      await client.next('session_list', { from });
    });

    it('accepts an input frame at the maximum size', async () => {
      const client = await connect();
      const id = await client.createShell();
      const from = client.mark;
      // Control characters need six bytes each in JSON; the payload limit must allow for that.
      client.send({ type: 'input', sessionId: id, data: '\u0001'.repeat(TERMINAL_LIMITS.maxInputLength) });
      client.send({ type: 'list' });
      await client.next('session_list', { from });
      expect(client.messages.slice(from).some((m) => m.type === 'error')).toBe(false);
      expect(client.closeInfo).toBeNull();
    });
  });

  describe('shell sessions', () => {
    it('runs commands and streams output', async () => {
      const client = await connect();
      const id = await client.createShell();
      client.send({ type: 'input', sessionId: id, data: 'echo integration-ok\r' });
      await client.waitForOutput(id, 'integration-ok');
    });

    it('replays recent output on attach', async () => {
      const client = await connect();
      const id = await client.createShell();
      client.send({ type: 'input', sessionId: id, data: 'echo before-attach\r' });
      await client.waitForOutput(id, 'before-attach');
      const from = client.mark;
      client.send({ type: 'attach', sessionId: id, size: { cols: 90, rows: 30 } });
      const attached = await client.next('session_attached', { from });
      expect(attached.replay).toContain('before-attach');
      // Size the replay was produced at (the shell's size before this attach), not the new one.
      expect(attached).toMatchObject({ cols: 80, rows: 24 });
      const again = client.mark;
      client.send({ type: 'attach', sessionId: id, size: { cols: 90, rows: 30 } });
      expect(await client.next('session_attached', { from: again })).toMatchObject({ cols: 90, rows: 30 });
    });

    it('closes on request and when the shell exits', async () => {
      const client = await connect();
      const a = await client.createShell();
      const b = await client.createShell();
      client.send({ type: 'close', sessionId: a });
      expect(await client.next((m) => m.type === 'session_closed' && m.sessionId === a)).toMatchObject({ reason: 'closed' });
      client.send({ type: 'input', sessionId: b, data: 'exit 4\r' });
      expect(await client.next((m) => m.type === 'session_closed' && m.sessionId === b)).toMatchObject({ reason: 'exited', exitCode: 4 });
    });

    it('enforces the session limit with a clear error', async () => {
      await t.close();
      t = await startTestServer({ maxSessions: 1 });
      token = await loginToken(t.baseUrl);
      const client = await connect();
      await client.createShell();
      const from = client.mark;
      client.send({ type: 'create' });
      expect((await client.next('error', { from })).message).toMatch(/Maximum of 1 terminals/);
    });

    it('keeps shells running across a disconnect and gives them back on reconnect', async () => {
      const phone = await connect();
      const id = await phone.createShell();
      phone.send({ type: 'input', sessionId: id, data: 'echo survived-disconnect\r' });
      await phone.waitForOutput(id, 'survived-disconnect');
      await phone.close();

      const again = await connect();
      again.send({ type: 'list' });
      const list = await again.next('session_list');
      expect(list.sessions.map((s) => s.id)).toEqual([id]);
      again.send({ type: 'attach', sessionId: id, size: { cols: 80, rows: 24 } });
      expect((await again.next('session_attached')).replay).toContain('survived-disconnect');
      again.send({ type: 'input', sessionId: id, data: 'echo still-alive\r' });
      await again.waitForOutput(id, 'still-alive');
    });

    it('keeps a quiet long-running command alive (no idle kill)', async () => {
      await t.close();
      t = await startTestServer({ maintenanceMs: 20 });
      token = await loginToken(t.baseUrl);
      const client = await connect();
      const id = await client.createShell();
      await sleep(200); // many maintenance passes with no output at all
      client.send({ type: 'input', sessionId: id, data: 'echo not-reaped\r' });
      await client.waitForOutput(id, 'not-reaped');
    });

    it('shares a user\'s shells between their devices and hides them from other users', async () => {
      await t.server.auth.createUser('other', 'other-pass');
      const phone = await connect();
      const id = await phone.createShell();
      const laptop = await connect(await loginToken(t.baseUrl));
      laptop.send({ type: 'list' });
      expect((await laptop.next('session_list')).sessions.map((s) => s.id)).toEqual([id]);

      const stranger = await connect(await loginToken(t.baseUrl, { username: 'other', password: 'other-pass' }));
      stranger.send({ type: 'list' });
      expect((await stranger.next('session_list')).sessions).toEqual([]);
      stranger.send({ type: 'input', sessionId: id, data: 'echo pwned\r' });
      expect(await stranger.next('error')).toMatchObject({ sessionId: id, message: expect.stringMatching(/not found/) });
    });
  });

  describe('login lifetime', () => {
    it('ends shells and connections on logout', async () => {
      const client = await connect();
      const id = await client.createShell();
      await fetch(`${t.baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken(t.baseUrl) },
        body: JSON.stringify({ token }),
      });
      expect((await client.waitClosed()).code).toBe(WS_CLOSE.sessionExpired);
      // A new login of the same user starts clean.
      const fresh = await connect(await loginToken(t.baseUrl));
      fresh.send({ type: 'list' });
      expect((await fresh.next('session_list')).sessions.map((s) => s.id)).not.toContain(id);
    });

    it('keeps shells while another login of the user is still valid', async () => {
      const phone = await connect();
      const id = await phone.createShell();
      const laptopToken = await loginToken(t.baseUrl);
      await fetch(`${t.baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken(t.baseUrl) },
        body: JSON.stringify({ token }),
      });
      await phone.waitClosed();
      const laptop = await connect(laptopToken);
      laptop.send({ type: 'list' });
      expect((await laptop.next('session_list')).sessions.map((s) => s.id)).toEqual([id]);
    });

    it('closes the connection and reaps shells when the login expires', async () => {
      let now = Date.now();
      await t.close();
      t = await startTestServer({ maintenanceMs: 20, auth: { idleTimeoutMs: 30 * MINUTE, absoluteTimeoutMs: 60 * MINUTE, now: () => now } });
      token = await loginToken(t.baseUrl);
      const client = await connect();
      await client.createShell();
      now += 61 * MINUTE;
      expect((await client.waitClosed()).code).toBe(WS_CLOSE.sessionExpired);
      await eventually(async () => {
        const probe = await TestClient.connect(t.wsUrl, await loginToken(t.baseUrl));
        probe.send({ type: 'list' });
        const empty = (await probe.next('session_list')).sessions.length === 0;
        await probe.close();
        return empty;
      });
    });
  });

  describe.skipIf(IS_WINDOWS)('flow control', () => {
    it('pauses a flooding command while the client stops reading, then resumes', async () => {
      await t.close();
      t = await startTestServer({ flowControl: { highWaterMark: 64 * 1024, lowWaterMark: 16 * 1024 } });
      token = await loginToken(t.baseUrl);
      const client = await connect();
      const id = await client.createShell();
      // Random base64 barely compresses, so (unlike `yes`) it really fills the socket buffers.
      client.send({ type: 'input', sessionId: id, data: 'cat /dev/urandom | base64\r' });
      await eventually(() => client.output(id).length > 1024 * 1024);

      const socket = (client.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
      socket.pause();
      await sleep(1_000);
      const from = client.mark;
      socket.resume();
      client.send({ type: 'input', sessionId: id, data: '\x03' });
      client.send({ type: 'input', sessionId: id, data: 'echo flow-resumed\r' });
      await client.waitForOutput(id, 'flow-resumed', from, 20_000);

      // With the PTY paused, the backlog is bounded by the high-water mark plus kernel socket
      // buffers. Without flow control the server would have queued everything `yes` produced.
      const backlog = client.output(id, from).length;
      console.log(`flow-control backlog after a 1s stall: ${backlog} chars`);
      expect(backlog).toBeLessThan(FLOW_BACKLOG_LIMIT);
    });
  });
});
