import { spawn, type ChildProcess } from 'node:child_process';

export type TunnelState = 'stopped' | 'starting' | 'running' | 'error';

type StateHandler = (state: TunnelState, detail?: string) => void;

// A quick-tunnel hostname. `api.trycloudflare.com` is cloudflared's own endpoint and
// appears in its error messages (e.g. when offline), so it must not count as a tunnel URL.
const QUICK_TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com(?![a-z0-9.-])/;

export function parseTunnelUrl(output: string): string | null {
  const match = output.match(QUICK_TUNNEL_URL);
  return match ? match[0] : null;
}

export function cloudflaredInstallHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'brew install cloudflared';
    case 'win32':
      return 'winget install --id Cloudflare.cloudflared';
    default:
      return 'see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
  }
}

export interface TunnelManagerOptions {
  /** Address cloudflared connects to. Use the address the server listens on, not `localhost`,
   * which may resolve to ::1 while the server only listens on 127.0.0.1. */
  targetHost?: string;
  /** Executable to run (default `cloudflared`), and arguments placed before cloudflared's own. */
  command?: string;
  commandArgs?: string[];
}

/**
 * Runs a Cloudflare quick tunnel (`cloudflared tunnel --url`) to the local server
 * and reports its public URL. The `running` state carries the URL; `error` carries a reason.
 */
export class TunnelManager {
  private child: ChildProcess | null = null;
  private _state: TunnelState = 'stopped';
  private _url: string | null = null;
  private readonly handlers = new Set<StateHandler>();
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly targetUrl: string;

  constructor(port: number, opts: TunnelManagerOptions = {}) {
    const host = opts.targetHost ?? '127.0.0.1';
    this.targetUrl = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    this.command = opts.command ?? 'cloudflared';
    this.commandArgs = opts.commandArgs ?? [];
  }

  get state(): TunnelState {
    return this._state;
  }

  get url(): string | null {
    return this._url;
  }

  get isRunning(): boolean {
    return this._state === 'running';
  }

  start(): void {
    if (this.child) return;
    this.setState('starting');

    const args = [...this.commandArgs, 'tunnel', '--url', this.targetUrl, '--no-autoupdate'];
    const child = spawn(this.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    const scan = (data: Buffer) => {
      if (this._url) return;
      const url = parseTunnelUrl(data.toString());
      if (url) {
        this._url = url;
        this.setState('running', url);
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);

    child.on('error', (err: NodeJS.ErrnoException) => {
      this.child = null;
      this._url = null;
      const reason = err.code === 'ENOENT'
        ? `cloudflared is not installed. Install it with: ${cloudflaredInstallHint()}`
        : `cloudflared failed to start: ${err.message}`;
      this.setState('error', reason);
    });

    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this._url = null;
      if (this._state === 'stopped' || this._state === 'error') return;
      this.setState('error', `cloudflared exited unexpectedly (code ${code ?? 'unknown'})`);
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this._url = null;
    this.setState('stopped');
    child?.kill();
  }

  onStateChange(handler: StateHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private setState(state: TunnelState, detail?: string): void {
    this._state = state;
    for (const handler of this.handlers) handler(state, detail);
  }
}
