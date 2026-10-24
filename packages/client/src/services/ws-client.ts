import {
  PROTOCOL_VERSION,
  TERMINAL_LIMITS,
  WS_CLOSE,
  type AuthFailureReason,
  type ClientMessage,
  type ServerMessage,
} from '@termpilot/shared';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'auth_failed';

type MessageHandler = (message: ServerMessage) => void;
type StateHandler = (state: ConnectionState) => void;

export interface ReconnectPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RECONNECT: ReconnectPolicy = { initialDelayMs: 1_000, maxDelayMs: 30_000 };

/** Close codes after which retrying with the same token cannot succeed. */
const TERMINAL_CLOSE_CODES = new Map<number, AuthFailureReason>([
  [WS_CLOSE.unauthorized, 'invalid_token'],
  [WS_CLOSE.sessionExpired, 'invalid_token'],
  [WS_CLOSE.protocolMismatch, 'protocol_mismatch'],
]);

/**
 * Split text into pieces the server accepts, never between the two halves of a
 * surrogate pair, so pasting a large block of text (or emoji) arrives intact.
 */
export function splitInput(data: string, maxLength: number = TERMINAL_LIMITS.maxInputLength): string[] {
  if (data.length <= maxLength) return [data];
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + maxLength, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

export function webSocketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

export interface WsClientOptions {
  url?: string;
  reconnect?: ReconnectPolicy;
}

/**
 * Authenticated WebSocket with automatic reconnection. The token is sent as the
 * first message rather than in the URL, so it never lands in proxy or server logs.
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly policy: ReconnectPolicy;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private _state: ConnectionState = 'disconnected';
  private _authFailure: AuthFailureReason | null = null;
  private readonly wake = () => this.reconnectNow();

  constructor(private readonly token: string, opts: WsClientOptions = {}) {
    this.url = opts.url ?? webSocketUrl(globalThis.location);
    this.policy = opts.reconnect ?? DEFAULT_RECONNECT;
    this.reconnectDelay = this.policy.initialDelayMs;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /** Why authentication failed, once the state is `auth_failed`. */
  get authFailure(): AuthFailureReason | null {
    return this._authFailure;
  }

  connect(): void {
    this.shouldReconnect = true;
    // A phone that wakes up or regains signal should not wait out the backoff.
    globalThis.addEventListener?.('online', this.wake);
    globalThis.document?.addEventListener('visibilitychange', this.wake);
    this.open();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    globalThis.removeEventListener?.('online', this.wake);
    globalThis.document?.removeEventListener('visibilitychange', this.wake);
    this.clearReconnectTimer();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
    if (this._state !== 'auth_failed') this.setState('disconnected');
  }

  /** Retry immediately if the connection is down (no-op while connected or after an auth failure). */
  reconnectNow(): void {
    if (!this.shouldReconnect || this.ws || globalThis.document?.visibilityState === 'hidden') return;
    this.clearReconnectTimer();
    this.reconnectDelay = this.policy.initialDelayMs;
    this.open();
  }

  send(message: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || this._state !== 'connected') return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  sendInput(sessionId: string, data: string): boolean {
    return splitInput(data).every((chunk) => this.send({ type: 'input', sessionId, data: chunk }));
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  private open(): void {
    if (this.ws) return;
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.token, protocol: PROTOCOL_VERSION } satisfies ClientMessage));
    };

    ws.onmessage = (event: MessageEvent) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'auth_ok') {
        this.reconnectDelay = this.policy.initialDelayMs;
        this.setState('connected');
        return;
      }
      if (message.type === 'auth_failed') {
        // Rate limiting is temporary; the close handler retries with backoff.
        if (message.reason !== 'rate_limited') this.failAuth(message.reason);
        return;
      }
      for (const handler of this.messageHandlers) handler(message);
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const fatal = TERMINAL_CLOSE_CODES.get(event.code);
      if (fatal) this.failAuth(fatal);
      if (this._state === 'auth_failed') return;
      this.setState('disconnected');
      this.scheduleReconnect();
    };
  }

  private failAuth(reason: AuthFailureReason): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this._authFailure = reason;
    this.setState('auth_failed');
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.policy.maxDelayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const handler of this.stateHandlers) handler(state);
  }
}
