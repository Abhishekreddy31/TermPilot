import { describe, it, expect } from 'vitest';
import {
  MessageType,
  encodeMessage,
  decodeMessage,
  CreateSessionMessage,
  InputMessage,
  ResizeMessage,
  DestroySessionMessage,
  OutputMessage,
  SessionCreatedMessage,
  SessionDestroyedMessage,
  ErrorMessage,
  HeartbeatMessage,
} from '../src/protocol.js';

describe('MessageType enum', () => {
  it('should define all message types with unique byte values', () => {
    expect(MessageType.Output).toBe(0x00);
    expect(MessageType.Input).toBe(0x01);
    expect(MessageType.Resize).toBe(0x02);
    expect(MessageType.Heartbeat).toBe(0x03);
    expect(MessageType.SessionCreated).toBe(0x04);
    expect(MessageType.CreateSession).toBe(0x05);
    expect(MessageType.DestroySession).toBe(0x06);
    expect(MessageType.SessionDestroyed).toBe(0x07);
    expect(MessageType.Error).toBe(0x08);
  });
});

describe('encodeMessage / decodeMessage', () => {
  it('should round-trip an Input message', () => {
    const msg: InputMessage = {
      type: MessageType.Input,
      sessionId: 'sess-1',
      data: 'ls -la\n',
    };
    const encoded = encodeMessage(msg);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded[0]).toBe(MessageType.Input);

    const decoded = decodeMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it('should round-trip an Output message with binary data', () => {
    const msg: OutputMessage = {
      type: MessageType.Output,
      sessionId: 'sess-1',
      data: 'drwxr-xr-x  2 user user 4096 Mar 16 10:00 .\n',
    };
    const encoded = encodeMessage(msg);
    expect(encoded[0]).toBe(MessageType.Output);

    const decoded = decodeMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it('should round-trip a Resize message', () => {
    const msg: ResizeMessage = {
      type: MessageType.Resize,
      sessionId: 'sess-1',
      cols: 120,
      rows: 40,
    };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it('should round-trip a CreateSession message', () => {
    const msg: CreateSessionMessage = {
      type: MessageType.CreateSession,
      cols: 80,
      rows: 24,
    };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it('should round-trip a DestroySession message', () => {
    const msg: DestroySessionMessage = {
      type: MessageType.DestroySession,
      sessionId: 'sess-1',
    };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it('should round-trip a SessionCreated message', () => {
    const msg: SessionCreatedMessage = {
      type: MessageType.SessionCreated,
      sessionId: 'sess-abc',
    };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it('should round-trip a SessionDestroyed message', () => {
    const msg: SessionDestroyedMessage = {
      type: MessageType.SessionDestroyed,
      sessionId: 'sess-1',
      exitCode: 0,
    };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it('should round-trip a Heartbeat message', () => {
    const msg: HeartbeatMessage = {
      type: MessageType.Heartbeat,
    };
    const encoded = encodeMessage(msg);
    expect(encoded.length).toBe(1 + 2); // type byte + empty JSON "{}"
    const decoded = decodeMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it('should round-trip an Error message', () => {
    const msg: ErrorMessage = {
      type: MessageType.Error,
      message: 'Session not found',
      sessionId: 'sess-1',
    };
    const encoded = encodeMessage(msg);
    const decoded = decodeMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  it('should throw on unknown message type', () => {
    const bad = new Uint8Array([0xff, 0x7b, 0x7d]); // 0xFF + "{}"
    expect(() => decodeMessage(bad)).toThrow();
  });

  it('should throw on empty buffer', () => {
    expect(() => decodeMessage(new Uint8Array(0))).toThrow();
  });
});
