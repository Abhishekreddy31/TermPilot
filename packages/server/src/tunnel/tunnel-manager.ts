import { spawn, type ChildProcess } from 'node:child_process';

export type TunnelState = 'stopped' | 'starting' | 'running' | 'error';

type StateHandler = (state: TunnelState, url?: string) => void;

export function parseTunnelUrl(output: string): string | null {
  const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  return match ? match[0] : null;
}

export class TunnelManager {
  private process: ChildProcess | null = null;
  private _state: TunnelState = 'stopped';
  private _url: string | null = null;
  private port: number;
  private stateHandlers: StateHandler[] = [];

  constructor(port: number) {
    this.port = port;
  }

  get isRunning(): boolean {
    return this._state === 'running';
  }

  get url(): string | null {
    return this._url;
  }

  get state(): TunnelState {
    return this._state;
  }

  start(): void {
    if (this.process) {
      return;
    }

    this.setState('starting');

    this.process = spawn('cloudflared', [
      'tunnel',
      '--url',
      `http://localhost:${this.port}`,
      '--no-autoupdate',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const output = data.toString();
      const url = parseTunnelUrl(output);
      if (url) {
        this._url = url;
        this.setState('running', url);
      }
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      const url = parseTunnelUrl(output);
      if (url) {
        this._url = url;
        this.setState('running', url);
      }
    });

    this.process.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.error(
          'cloudflared not found. Install it with: brew install cloudflared'
        );
      }
      this._url = null;
      this.process = null;
      this.setState('error');
    });

    this.process.on('close', () => {
      this._url = null;
      this.process = null;
      if (this._state !== 'error') {
        this.setState('stopped');
      }
    });
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this._url = null;
    this.setState('stopped');
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.push(handler);
    return () => {
      const idx = this.stateHandlers.indexOf(handler);
      if (idx >= 0) this.stateHandlers.splice(idx, 1);
    };
  }

  private setState(state: TunnelState, url?: string): void {
    this._state = state;
    for (const handler of this.stateHandlers) {
      handler(state, url);
    }
  }
}
