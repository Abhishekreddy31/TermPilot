export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

type MessageHandler = (msg: WsMessage) => void;
type StateHandler = (state: ConnectionState) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private token: string;
  private messageHandlers: MessageHandler[] = [];
  private stateHandlers: StateHandler[] = [];
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
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

  send(msg: WsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
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

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws?token=${this.token}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.setState('connected');
      this.reconnectDelay = 1000;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        for (const handler of this.messageHandlers) {
          handler(msg);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.setState('disconnected');

      if (this.shouldReconnect) {
        setTimeout(() => this.doConnect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          this.maxReconnectDelay
        );
      }
    };

    this.ws.onerror = () => {
      // Will trigger onclose
    };
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }
}
