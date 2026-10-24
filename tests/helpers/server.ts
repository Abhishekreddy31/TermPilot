import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@termpilot/shared';
import { createServer, type ServerOptions, type TermPilotServer } from '../../packages/server/src/app.js';
import { TEST_SHELL } from './platform.js';

export const FIXTURE_CLIENT = fileURLToPath(new URL('../fixtures/client', import.meta.url));
export const TEST_USER = { username: 'tester', password: 'correct horse battery staple' };

export interface TestServer {
  server: TermPilotServer;
  baseUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

export async function startTestServer(overrides: Partial<ServerOptions> = {}): Promise<TestServer> {
  const server = await createServer({
    port: 0,
    host: '127.0.0.1',
    shell: TEST_SHELL,
    clientDist: FIXTURE_CLIENT,
    ...overrides,
  });
  await server.auth.createUser(TEST_USER.username, TEST_USER.password);
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return { server, baseUrl, wsUrl: `ws://127.0.0.1:${server.port}/ws`, close: () => server.close() };
}

export async function csrfToken(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/csrf`);
  return ((await res.json()) as { csrfToken: string }).csrfToken;
}

export async function loginToken(baseUrl: string, credentials = TEST_USER): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken(baseUrl) },
    body: JSON.stringify(credentials),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

/**
 * A WebSocket client that records every message, so a test can wait for one
 * without racing its arrival.
 */
export class TestClient {
  readonly messages: ServerMessage[] = [];
  private waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; from: number }> = [];
  closeInfo: { code: number; reason: string } | null = null;
  private readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      this.messages.push(message);
      const index = this.messages.length - 1;
      this.waiters = this.waiters.filter((waiter) => {
        if (index >= waiter.from && waiter.match(message)) {
          waiter.resolve(message);
          return false;
        }
        return true;
      });
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        resolve(this.closeInfo);
      });
    });
  }

  static async open(url: string, headers: Record<string, string> = {}): Promise<TestClient> {
    const ws = new WebSocket(url, { headers });
    const client = new TestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }

  /** Open and authenticate. */
  static async connect(url: string, token: string): Promise<TestClient> {
    const client = await TestClient.open(url);
    client.send({ type: 'auth', token, protocol: PROTOCOL_VERSION });
    const reply = await client.next((m) => m.type === 'auth_ok' || m.type === 'auth_failed');
    if (reply.type !== 'auth_ok') throw new Error(`auth failed: ${JSON.stringify(reply)}`);
    return client;
  }

  send(message: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Resolve with the first message matching `match`, including ones already received after `from`. */
  next<T extends ServerMessage['type']>(
    match: T | ((m: ServerMessage) => boolean),
    { from = 0, timeoutMs = 10_000 }: { from?: number; timeoutMs?: number } = {},
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const predicate = typeof match === 'string' ? (m: ServerMessage) => m.type === match : match;
    const existing = this.messages.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing as Extract<ServerMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for message; got: ${this.describe()}`)), timeoutMs);
      this.waiters.push({
        match: predicate,
        from,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  /** Index to pass as `from` to only consider messages arriving after this point. */
  get mark(): number {
    return this.messages.length;
  }

  /** All output received for a session, concatenated. */
  output(sessionId: string, from = 0): string {
    return this.messages
      .slice(from)
      .map((m) => (m.type === 'output' && m.sessionId === sessionId ? m.data : ''))
      .join('');
  }

  async waitForOutput(sessionId: string, text: string, from = 0, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.output(sessionId, from).includes(text)) {
      if (Date.now() > deadline) throw new Error(`"${text}" not seen in output: ${JSON.stringify(this.output(sessionId, from).slice(-500))}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async createShell(): Promise<string> {
    const from = this.mark;
    this.send({ type: 'create', cols: 80, rows: 24 });
    const created = await this.next('session_created', { from });
    return created.session.id;
  }

  waitClosed(): Promise<{ code: number; reason: string }> {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await this.closed;
  }

  private describe(): string {
    return JSON.stringify(this.messages.map((m) => (m.type === 'output' ? { type: 'output' } : m)).slice(-10));
  }
}
