import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, TERMINAL_LIMITS, WS_CLOSE } from '@termpilot/shared';
import { WsClient, splitInput, webSocketUrl, type ConnectionState } from '../../../packages/client/src/services/ws-client.js';
import { FakeWebSocket } from '../../helpers/fake-websocket.js';

const policy = { initialDelayMs: 100, maxDelayMs: 400 };

function connectedClient(): { client: WsClient; states: ConnectionState[] } {
  const client = new WsClient('tok', { url: 'ws://test/ws', reconnect: policy });
  const states: ConnectionState[] = [];
  client.onStateChange((s) => states.push(s));
  client.connect();
  FakeWebSocket.latest.open();
  FakeWebSocket.latest.receive({ type: 'auth_ok', username: 'u', protocol: PROTOCOL_VERSION });
  return { client, states };
}

describe('WsClient', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('authenticates with the token and protocol version as the first message', () => {
    const client = new WsClient('secret', { url: 'ws://test/ws' });
    client.connect();
    const ws = FakeWebSocket.latest;
    expect(ws.url).toBe('ws://test/ws');
    expect(ws.url).not.toContain('secret');
    ws.open();
    expect(ws.sent[0]).toEqual({ type: 'auth', token: 'secret', protocol: PROTOCOL_VERSION });
    client.disconnect();
  });

  it('does not send anything else before auth_ok', () => {
    const client = new WsClient('t', { url: 'ws://test/ws' });
    client.connect();
    FakeWebSocket.latest.open();
    expect(client.send({ type: 'list' })).toBe(false);
    FakeWebSocket.latest.receive({ type: 'auth_ok', username: 'u', protocol: PROTOCOL_VERSION });
    expect(client.send({ type: 'list' })).toBe(true);
    expect(FakeWebSocket.latest.sentOfType('list')).toHaveLength(1);
  });

  it('moves through connecting → connected and delivers messages to handlers', () => {
    const { client, states } = connectedClient();
    const received: string[] = [];
    client.onMessage((m) => received.push(m.type));
    FakeWebSocket.latest.receive({ type: 'session_list', sessions: [] });
    expect(states).toEqual(['connecting', 'connected']);
    expect(received).toEqual(['session_list']);
  });

  it('reconnects with exponential backoff capped at the maximum', () => {
    const { client } = connectedClient();
    FakeWebSocket.latest.drop(1006);
    expect(client.state).toBe('disconnected');
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.latest.drop(1006);
    vi.advanceTimersByTime(199);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    FakeWebSocket.latest.drop(1006);
    vi.advanceTimersByTime(400);
    expect(FakeWebSocket.instances).toHaveLength(4);
    FakeWebSocket.latest.drop(1006);
    vi.advanceTimersByTime(400); // capped, not 800
    expect(FakeWebSocket.instances).toHaveLength(5);
  });

  it('resets the backoff after a successful connection', () => {
    const { client } = connectedClient();
    FakeWebSocket.latest.drop(1006);
    vi.advanceTimersByTime(100);
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.receive({ type: 'auth_ok', username: 'u', protocol: PROTOCOL_VERSION });
    FakeWebSocket.latest.drop(1006);
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(3);
    client.disconnect();
  });

  it.each([
    ['invalid_token', WS_CLOSE.unauthorized],
    ['protocol_mismatch', WS_CLOSE.protocolMismatch],
  ] as const)('stops reconnecting after auth_failed (%s)', (reason, code) => {
    const client = new WsClient('t', { url: 'ws://test/ws', reconnect: policy });
    client.connect();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.receive({ type: 'auth_failed', reason, message: 'no' });
    FakeWebSocket.latest.drop(code);
    vi.advanceTimersByTime(10_000);
    expect(client.state).toBe('auth_failed');
    expect(client.authFailure).toBe(reason);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('treats a login that expires while connected as an auth failure', () => {
    const { client } = connectedClient();
    FakeWebSocket.latest.drop(WS_CLOSE.sessionExpired);
    vi.advanceTimersByTime(10_000);
    expect(client.state).toBe('auth_failed');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('keeps retrying after being rate limited', () => {
    const client = new WsClient('t', { url: 'ws://test/ws', reconnect: policy });
    client.connect();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.receive({ type: 'auth_failed', reason: 'rate_limited', message: 'slow down' });
    FakeWebSocket.latest.drop(WS_CLOSE.rateLimited);
    expect(client.state).toBe('disconnected');
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);
    client.disconnect();
  });

  it('reconnects immediately when the network comes back', () => {
    const { client } = connectedClient();
    FakeWebSocket.latest.drop(1006);
    vi.advanceTimersByTime(100);
    FakeWebSocket.latest.drop(1006); // now waiting 200ms
    window.dispatchEvent(new Event('online'));
    expect(FakeWebSocket.instances).toHaveLength(3);
    client.disconnect();
  });

  it('does nothing on reconnectNow while connected or after disconnect()', () => {
    const { client } = connectedClient();
    client.reconnectNow();
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.disconnect();
    client.reconnectNow();
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.state).toBe('disconnected');
  });

  it('chunks large input so every frame is within the server limit', () => {
    const { client } = connectedClient();
    const data = 'x'.repeat(TERMINAL_LIMITS.maxInputLength * 2 + 5);
    expect(client.sendInput('s', data)).toBe(true);
    const frames = FakeWebSocket.latest.sentOfType('input');
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => f.data).join('')).toBe(data);
  });

  it('ignores malformed frames', () => {
    const { client } = connectedClient();
    const handler = vi.fn();
    client.onMessage(handler);
    FakeWebSocket.latest.onmessage?.({ data: 'not json' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('splitInput', () => {
  it('returns short input unchanged', () => {
    expect(splitInput('abc', 10)).toEqual(['abc']);
  });

  it('never splits a surrogate pair', () => {
    const data = 'ab😀cd😀';
    const chunks = splitInput(data, 3);
    expect(chunks.join('')).toBe(data);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3);
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    }
  });
});

describe('webSocketUrl', () => {
  it('uses wss on https pages and ws otherwise', () => {
    expect(webSocketUrl({ protocol: 'https:', host: 'a.example:1' })).toBe('wss://a.example:1/ws');
    expect(webSocketUrl({ protocol: 'http:', host: 'localhost:3000' })).toBe('ws://localhost:3000/ws');
  });
});
