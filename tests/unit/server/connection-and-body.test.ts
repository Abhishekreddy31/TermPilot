import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { ClientConnection } from '../../../packages/server/src/ws/client-connection.js';
import { HttpError, readJsonBody } from '../../../packages/server/src/http/api.js';

/** Just enough of a ws WebSocket: a send queue the test flushes by hand. */
class FakeSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  private callbacks: Array<() => void> = [];
  sent: string[] = [];
  send(data: string, cb: () => void) {
    this.sent.push(data);
    this.bufferedAmount += data.length;
    this.callbacks.push(cb);
  }
  flush(bytes: number) {
    this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
    const callbacks = this.callbacks;
    this.callbacks = [];
    for (const cb of callbacks) cb();
  }
  close() {}
}

const flow = { highWaterMark: 100, lowWaterMark: 20 };

describe('ClientConnection', () => {
  it('reports congestion above the high-water mark', () => {
    const socket = new FakeSocket();
    const conn = new ClientConnection(socket as unknown as WebSocket, flow);
    conn.send({ type: 'output', sessionId: 's', data: 'x'.repeat(150) });
    expect(conn.congested).toBe(true);
  });

  it('signals drain only once below the low-water mark', async () => {
    const socket = new FakeSocket();
    const conn = new ClientConnection(socket as unknown as WebSocket, flow);
    conn.send({ type: 'output', sessionId: 's', data: 'x'.repeat(150) });
    let drained = 0;
    conn.onDrain(() => drained++);
    socket.flush(100); // still above low water
    expect(drained).toBe(0);
    conn.send({ type: 'output', sessionId: 's', data: '' });
    socket.flush(1000);
    expect(drained).toBe(1);
  });

  it('calls a drain listener right away when nothing is queued', async () => {
    const conn = new ClientConnection(new FakeSocket() as unknown as WebSocket, flow);
    let drained = false;
    conn.onDrain(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(true);
  });

  it('drops messages once the socket is closed and releases waiters on dispose', () => {
    const socket = new FakeSocket();
    const conn = new ClientConnection(socket as unknown as WebSocket, flow);
    conn.send({ type: 'output', sessionId: 's', data: 'x'.repeat(150) });
    let drained = false;
    conn.onDrain(() => (drained = true));
    socket.readyState = WebSocket.CLOSED;
    conn.send({ type: 'list' } as never);
    expect(socket.sent).toHaveLength(1);
    expect(conn.open).toBe(false);
    conn.dispose();
    expect(drained).toBe(true);
  });
});

function body(chunks: string[], contentType = 'application/json'): IncomingMessage {
  const stream = Readable.from(chunks.map((c) => Buffer.from(c))) as unknown as IncomingMessage;
  (stream as { headers: Record<string, string> }).headers = { 'content-type': contentType };
  return stream;
}

describe('readJsonBody', () => {
  it('parses JSON split across chunks', async () => {
    await expect(readJsonBody(body(['{"a":', '1}']))).resolves.toEqual({ a: 1 });
  });

  it('accepts a charset parameter', async () => {
    await expect(readJsonBody(body(['{}'], 'application/json; charset=utf-8'))).resolves.toEqual({});
  });

  it('rejects a non-JSON content type with 415', async () => {
    const error = await readJsonBody(body(['{}'], 'text/plain')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(415);
  });

  it('rejects a body over the size limit with 413', async () => {
    const error = await readJsonBody(body(['{"a":"', 'x'.repeat(10), '"}']), 8).catch((e: unknown) => e);
    expect((error as HttpError).status).toBe(413);
  });

  it('rejects malformed JSON with 400', async () => {
    const error = await readJsonBody(body(['{bad'])).catch((e: unknown) => e);
    expect((error as HttpError).status).toBe(400);
  });

  it('times out a body that never finishes', async () => {
    const stream = new Readable({ read() {} }) as unknown as IncomingMessage;
    (stream as { headers: Record<string, string> }).headers = { 'content-type': 'application/json' };
    const error = await readJsonBody(stream, 1024, 20).catch((e: unknown) => e);
    expect((error as HttpError).status).toBe(408);
  });
});
