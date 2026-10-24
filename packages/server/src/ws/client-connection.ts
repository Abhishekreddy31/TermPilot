import { WebSocket } from 'ws';
import type { ServerMessage } from '@termpilot/shared';
import type { SessionSubscriber } from '../terminal/session-registry.js';

export interface FlowControlOptions {
  /** Pause producers once this many bytes are queued for the socket. */
  highWaterMark: number;
  /** Resume them once the queue is back below this. */
  lowWaterMark: number;
}

export const DEFAULT_FLOW_CONTROL: FlowControlOptions = {
  highWaterMark: 1024 * 1024,
  lowWaterMark: 256 * 1024,
};

/** One browser connection: serializes messages and reports when it is falling behind. */
export class ClientConnection implements SessionSubscriber {
  /** Login token, set once the connection authenticates. */
  token: string | null = null;
  username: string | null = null;
  private drainListeners: Array<() => void> = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly flow: FlowControlOptions = DEFAULT_FLOW_CONTROL,
  ) {}

  get authenticated(): boolean {
    return this.token !== null;
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  get congested(): boolean {
    return this.ws.bufferedAmount > this.flow.highWaterMark;
  }

  send(message: ServerMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message), () => this.checkDrained());
  }

  onDrain(listener: () => void): void {
    if (this.ws.bufferedAmount <= this.flow.lowWaterMark) {
      queueMicrotask(listener);
      return;
    }
    this.drainListeners.push(listener);
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }

  /** Release anyone waiting for a drain; the socket is gone so nothing is queued any more. */
  dispose(): void {
    this.flushDrainListeners();
  }

  private checkDrained(): void {
    if (this.drainListeners.length > 0 && this.ws.bufferedAmount <= this.flow.lowWaterMark) {
      this.flushDrainListeners();
    }
  }

  private flushDrainListeners(): void {
    const listeners = this.drainListeners;
    this.drainListeners = [];
    for (const listener of listeners) listener();
  }
}
