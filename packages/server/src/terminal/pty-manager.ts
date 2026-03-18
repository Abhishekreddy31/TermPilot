import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';

export interface SessionOptions {
  cols: number;
  rows: number;
  shell?: string;
  cwd?: string;
}

export interface Session {
  id: string;
  cols: number;
  rows: number;
  alive: boolean;
  createdAt: number;
  lastActivity: number;
}

interface InternalSession extends Session {
  pty: pty.IPty;
  outputBuffer: string[];
  outputBufferSize: number;
  dataListeners: Array<(data: string) => void>;
  exitListeners: Array<(info: { exitCode: number; signal?: number }) => void>;
  disposables: Array<{ dispose(): void }>;
}

export interface PtyManagerOptions {
  maxSessions: number;
  idleTimeoutMs: number;
  maxOutputBufferBytes?: number;
  defaultShell?: string;
}

const DEFAULT_SHELL = process.env.SHELL || '/bin/zsh';
const MAX_OUTPUT_BUFFER = 100 * 1024; // 100KB

export class PtyManager {
  private sessions = new Map<string, InternalSession>();
  private opts: Required<PtyManagerOptions>;

  constructor(opts: PtyManagerOptions) {
    this.opts = {
      maxOutputBufferBytes: MAX_OUTPUT_BUFFER,
      defaultShell: DEFAULT_SHELL,
      ...opts,
    };
  }

  createSession(options: SessionOptions): Session {
    if (this.sessions.size >= this.opts.maxSessions) {
      throw new Error(
        `Maximum ${this.opts.maxSessions} sessions reached. Destroy an existing session first.`
      );
    }

    const id = randomUUID();
    const shell = options.shell || this.opts.defaultShell;

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd || process.env.HOME || '/',
      env: { ...process.env } as Record<string, string>,
    });

    const session: InternalSession = {
      id,
      cols: options.cols,
      rows: options.rows,
      alive: true,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      pty: ptyProcess,
      outputBuffer: [],
      outputBufferSize: 0,
      dataListeners: [],
      exitListeners: [],
      disposables: [],
    };

    const dataDisposable = ptyProcess.onData((data: string) => {
      session.lastActivity = Date.now();
      this.appendToBuffer(session, data);
      for (const listener of session.dataListeners) {
        listener(data);
      }
    });
    session.disposables.push(dataDisposable);

    const exitDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
      session.alive = false;
      for (const listener of session.exitListeners) {
        listener({ exitCode, signal });
      }
      this.cleanupSession(id);
    });
    session.disposables.push(exitDisposable);

    this.sessions.set(id, session);

    return this.toPublicSession(session);
  }

  getSession(id: string): Session | undefined {
    const session = this.sessions.get(id);
    return session ? this.toPublicSession(session) : undefined;
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values()).map((s) =>
      this.toPublicSession(s)
    );
  }

  writeToSession(id: string, data: string): void {
    const session = this.getInternalSession(id);
    session.lastActivity = Date.now();
    session.pty.write(data);
  }

  resizeSession(id: string, cols: number, rows: number): void {
    const session = this.getInternalSession(id);
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
  }

  destroySession(id: string): void {
    const session = this.getInternalSession(id);
    try {
      session.pty.kill();
    } catch {
      // Process may already be dead
    }
    this.cleanupSession(id);
  }

  destroyAll(): void {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      try {
        this.destroySession(id);
      } catch {
        // Ignore cleanup errors during bulk destroy
      }
    }
  }

  onData(id: string, callback: (data: string) => void): () => void {
    const session = this.getInternalSession(id);
    session.dataListeners.push(callback);
    return () => {
      const idx = session.dataListeners.indexOf(callback);
      if (idx >= 0) session.dataListeners.splice(idx, 1);
    };
  }

  onExit(
    id: string,
    callback: (info: { exitCode: number; signal?: number }) => void
  ): () => void {
    const session = this.getInternalSession(id);
    session.exitListeners.push(callback);
    return () => {
      const idx = session.exitListeners.indexOf(callback);
      if (idx >= 0) session.exitListeners.splice(idx, 1);
    };
  }

  getOutputBuffer(id: string): string[] | undefined {
    const session = this.sessions.get(id);
    return session ? [...session.outputBuffer] : undefined;
  }

  private getInternalSession(id: string): InternalSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    return session;
  }

  private appendToBuffer(session: InternalSession, data: string): void {
    session.outputBuffer.push(data);
    session.outputBufferSize += data.length;

    while (session.outputBufferSize > this.opts.maxOutputBufferBytes) {
      const removed = session.outputBuffer.shift();
      if (removed) {
        session.outputBufferSize -= removed.length;
      } else {
        break;
      }
    }
  }

  private cleanupSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    for (const disposable of session.disposables) {
      try {
        disposable.dispose();
      } catch {
        // Ignore dispose errors
      }
    }
    session.dataListeners = [];
    session.exitListeners = [];
    session.disposables = [];
    this.sessions.delete(id);
  }

  private toPublicSession(session: InternalSession): Session {
    return {
      id: session.id,
      cols: session.cols,
      rows: session.rows,
      alive: session.alive,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
    };
  }
}
