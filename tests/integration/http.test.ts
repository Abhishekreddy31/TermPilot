import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { TEST_USER, csrfToken, loginToken, startTestServer, type TestServer } from '../helpers/server.js';

/** fetch() cannot set Host, so raw requests use node:http. */
function rawRequest(port: number, headers: Record<string, string>, path = '/'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function login(t: TestServer, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${t.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken(t.baseUrl), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('HTTP server', () => {
  let t: TestServer;

  beforeEach(async () => {
    t = await startTestServer();
  });

  afterEach(async () => {
    await t.close();
  });

  it('sends security headers on every response', async () => {
    for (const path of ['/', '/health', '/api/auth/csrf', '/assets/missing.js']) {
      const res = await fetch(`${t.baseUrl}${path}`);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('reports health without internal details', async () => {
    const res = await fetch(`${t.baseUrl}/health`);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves the client', async () => {
    const res = await fetch(`${t.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('TermPilot test fixture');
  });

  describe('host and origin checks (DNS rebinding, cross-site requests)', () => {
    it('accepts loopback hostnames', async () => {
      expect(await rawRequest(t.server.port, { Host: `localhost:${t.server.port}` })).toBe(200);
      expect(await rawRequest(t.server.port, { Host: `127.0.0.1:${t.server.port}` })).toBe(200);
    });

    it('rejects foreign hostnames, even though the request reached loopback', async () => {
      expect(await rawRequest(t.server.port, { Host: 'attacker.example' })).toBe(403);
      expect(await rawRequest(t.server.port, { Host: 'attacker.example' }, '/api/auth/csrf')).toBe(403);
    });

    it('rejects requests from foreign origins', async () => {
      expect(await rawRequest(t.server.port, { Host: 'localhost', Origin: 'https://attacker.example' }, '/api/auth/csrf')).toBe(403);
    });

    it('accepts hostnames configured or added at runtime', async () => {
      await t.close();
      t = await startTestServer({ allowedHosts: ['.home.arpa'] });
      expect(await rawRequest(t.server.port, { Host: 'laptop.home.arpa' })).toBe(200);
      expect(await rawRequest(t.server.port, { Host: 'abc.trycloudflare.com' })).toBe(403);
      t.server.allowHost('abc.trycloudflare.com');
      expect(await rawRequest(t.server.port, { Host: 'abc.trycloudflare.com', Origin: 'https://abc.trycloudflare.com' })).toBe(200);
    });
  });

  describe('login', () => {
    it('returns a token for valid credentials', async () => {
      const res = await login(t, TEST_USER);
      expect(res.status).toBe(200);
      expect((await res.json()).token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects wrong credentials', async () => {
      const res = await login(t, { ...TEST_USER, password: 'nope' });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid credentials' });
    });

    it('requires the CSRF token', async () => {
      const res = await fetch(`${t.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'wrong' },
        body: JSON.stringify(TEST_USER),
      });
      expect(res.status).toBe(403);
    });

    it('validates the request body', async () => {
      expect((await login(t, { username: 'x' })).status).toBe(400);
      expect((await login(t, '{oops')).status).toBe(400);
      expect((await login(t, { username: 'x'.repeat(5000), password: 'y' })).status).toBe(413);
      expect((await login(t, TEST_USER, { 'Content-Type': 'text/plain' })).status).toBe(415);
    });

    it('never rate-limits successful logins (new tabs, app relaunches)', async () => {
      for (let i = 0; i < 10; i++) expect((await login(t, TEST_USER)).status).toBe(200);
    });

    it('limits guesses sent in parallel, not just one after another', async () => {
      const statuses = await Promise.all(Array.from({ length: 30 }, (_, i) => login(t, { ...TEST_USER, password: `p${i}` }).then((r) => r.status)));
      expect(statuses.filter((s) => s === 401)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(25);
    });

    it('rate-limits repeated failures from one address', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await login(t, { ...TEST_USER, password: `bad${i}` })).status);
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      expect((await login(t, TEST_USER)).status).toBe(429);
    });

    it('rate-limits tunnel clients by their real address, not cloudflared\'s', async () => {
      await t.close();
      t = await startTestServer({ trustTunnelProxy: true });
      for (let i = 0; i < 5; i++) await login(t, { ...TEST_USER, password: 'bad' }, { 'CF-Connecting-IP': '203.0.113.1' });
      expect((await login(t, TEST_USER, { 'CF-Connecting-IP': '203.0.113.1' })).status).toBe(429);
      expect((await login(t, TEST_USER, { 'CF-Connecting-IP': '203.0.113.2' })).status).toBe(200);
    });

    it('answers unsupported methods with 405 and Allow', async () => {
      const res = await fetch(`${t.baseUrl}/api/auth/login`);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    });
  });

  describe('logout', () => {
    it('ends only a token the caller holds', async () => {
      const token = await loginToken(t.baseUrl);
      const post = async (body: unknown) => fetch(`${t.baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken(t.baseUrl) },
        body: JSON.stringify(body),
      });
      expect((await post({ token: 'f'.repeat(64) })).status).toBe(401);
      expect((await post({})).status).toBe(400);
      expect((await post({ token })).status).toBe(200);
      expect(t.server.auth.validateSession(token)).toBeUndefined();
    });
  });
});
