export enum MessageType {
  Output = 0x00,
  Input = 0x01,
  Resize = 0x02,
  Heartbeat = 0x03,
  SessionCreated = 0x04,
  CreateSession = 0x05,
  DestroySession = 0x06,
  SessionDestroyed = 0x07,
  Error = 0x08,
}

const VALID_TYPES = new Set(Object.values(MessageType));

export interface OutputMessage {
  type: MessageType.Output;
  sessionId: string;
  data: string;
}

export interface InputMessage {
  type: MessageType.Input;
  sessionId: string;
  data: string;
}

export interface ResizeMessage {
  type: MessageType.Resize;
  sessionId: string;
  cols: number;
  rows: number;
}

export interface HeartbeatMessage {
  type: MessageType.Heartbeat;
}

export interface SessionCreatedMessage {
  type: MessageType.SessionCreated;
  sessionId: string;
}

export interface CreateSessionMessage {
  type: MessageType.CreateSession;
  cols: number;
  rows: number;
}

export interface DestroySessionMessage {
  type: MessageType.DestroySession;
  sessionId: string;
}

export interface SessionDestroyedMessage {
  type: MessageType.SessionDestroyed;
  sessionId: string;
  exitCode?: number;
  signal?: number;
}

export interface ErrorMessage {
  type: MessageType.Error;
  message: string;
  sessionId?: string;
}

export type ProtocolMessage =
  | OutputMessage
  | InputMessage
  | ResizeMessage
  | HeartbeatMessage
  | SessionCreatedMessage
  | CreateSessionMessage
  | DestroySessionMessage
  | SessionDestroyedMessage
  | ErrorMessage;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeMessage(msg: ProtocolMessage): Uint8Array {
  const { type, ...payload } = msg;
  const json = JSON.stringify(payload);
  const jsonBytes = encoder.encode(json);
  const frame = new Uint8Array(1 + jsonBytes.length);
  frame[0] = type;
  frame.set(jsonBytes, 1);
  return frame;
}

export function decodeMessage(data: Uint8Array): ProtocolMessage {
  if (data.length < 1) {
    throw new Error('Empty message buffer');
  }

  const type = data[0] as MessageType;
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Unknown message type: 0x${type.toString(16)}`);
  }

  const jsonStr = decoder.decode(data.slice(1));
  const payload = JSON.parse(jsonStr) as Record<string, unknown>;

  return { type, ...payload } as ProtocolMessage;
}
