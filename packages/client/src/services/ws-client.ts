export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'auth_failed';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

type MessageHandler = (msg: WsMessage) => void;
type StateHandler = (state: ConnectionState) => void;

const MAX_RECONNECT_ATTEMPTS = 30;

export class WsClient {
  private ws: WebSocket | null = null;
  private token: string;
  private messageHandlers: MessageHandler[] = [];
  private stateHandlers: StateHandler[] = [];
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectAttempts = 0;
  private shouldReconnect = true;
  private _state: ConnectionState = 'disconnected';

  constructor(token: string) {
    this.token = token;
  }

  get state(): ConnectionState {
    return this._state;
  }

  connect(): void {
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    this.setState('disconnected');
  }

  send(msg: WsMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      const idx = this.messageHandlers.indexOf(handler);
      if (idx >= 0) this.messageHandlers.splice(idx, 1);
    };
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.push(handler);
    return () => {
      const idx = this.stateHandlers.indexOf(handler);
      if (idx >= 0) this.stateHandlers.splice(idx, 1);
    };
  }

  private doConnect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.setState('connecting');

    // Token is NOT in the URL — sent as first message after connection
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      // Send auth token as first message (not in URL to prevent log leakage)
      this.ws?.send(JSON.stringify({ type: 'auth', token: this.token }));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;

        // Handle auth response
        if (msg.type === 'auth_ok') {
          this.setState('connected');
          this.reconnectDelay = 1000;
          this.reconnectAttempts = 0;
          return;
        }

        if (msg.type === 'auth_failed') {
          this.shouldReconnect = false;
          this.setState('auth_failed');
          this.ws?.close();
          return;
        }

        for (const handler of this.messageHandlers) {
          handler(msg);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this._state !== 'auth_failed') {
        this.setState('disconnected');
      }

      if (this.shouldReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts++;
        setTimeout(() => this.doConnect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    };

    this.ws.onerror = () => {};
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }
}
