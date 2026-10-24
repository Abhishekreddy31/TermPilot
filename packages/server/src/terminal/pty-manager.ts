import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';

/** What to run inside a pseudo-terminal. */
export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface ExitInfo {
  exitCode: number;
  signal?: number;
}

export interface PtyManagerOptions {
  maxProcesses: number;
  /** Recent output kept per process (in UTF-16 code units) so a reconnecting client can redraw. */
  maxReplayChars: number;
}

interface PtyProcess {
  pty: pty.IPty;
  replay: string[];
  replayChars: number;
  dataListeners: Set<(data: string) => void>;
  exitListeners: Set<(info: ExitInfo) => void>;
  disposables: Array<{ dispose(): void }>;
}

/** The PTY operations the session registry relies on. */
export interface PtyHost {
  spawn(spec: SpawnSpec, size: TerminalSize): string;
  write(id: string, data: string): void;
  resize(id: string, size: TerminalSize): void;
  pause(id: string): void;
  resume(id: string): void;
  replay(id: string): string;
  onData(id: string, listener: (data: string) => void): () => void;
  onExit(id: string, listener: (info: ExitInfo) => void): () => void;
  kill(id: string): void;
}

export class PtyLimitError extends Error {}
export class PtyNotFoundError extends Error {}

/**
 * Owns pseudo-terminal processes. Knows nothing about users or connections; the
 * session registry layers ownership and delivery on top of it.
 */
export class PtyManager implements PtyHost {
  private readonly processes = new Map<string, PtyProcess>();

  constructor(private readonly opts: PtyManagerOptions) {}

  get size(): number {
    return this.processes.size;
  }

  has(id: string): boolean {
    return this.processes.has(id);
  }

  spawn(spec: SpawnSpec, size: TerminalSize): string {
    if (this.processes.size >= this.opts.maxProcesses) {
      throw new PtyLimitError(`Maximum of ${this.opts.maxProcesses} terminals reached. Close one first.`);
    }

    const id = randomUUID();
    const child = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: spec.cwd,
      env: spec.env,
    });

    const proc: PtyProcess = {
      pty: child,
      replay: [],
      replayChars: 0,
      dataListeners: new Set(),
      exitListeners: new Set(),
      disposables: [],
    };

    proc.disposables.push(
      child.onData((data) => {
        this.appendReplay(proc, data);
        for (const listener of proc.dataListeners) listener(data);
      }),
      child.onExit(({ exitCode, signal }) => {
        // Drop the entry before notifying so listeners observe a consistent manager.
        this.release(id);
        for (const listener of proc.exitListeners) listener({ exitCode, signal });
        proc.exitListeners.clear();
      }),
    );

    this.processes.set(id, proc);
    return id;
  }

  write(id: string, data: string): void {
    this.get(id).pty.write(data);
  }

  resize(id: string, size: TerminalSize): void {
    this.get(id).pty.resize(size.cols, size.rows);
  }

  pause(id: string): void {
    this.get(id).pty.pause();
  }

  resume(id: string): void {
    this.get(id).pty.resume();
  }

  /** Recent output, oldest first. */
  replay(id: string): string {
    return this.get(id).replay.join('');
  }

  onData(id: string, listener: (data: string) => void): () => void {
    const proc = this.get(id);
    proc.dataListeners.add(listener);
    return () => proc.dataListeners.delete(listener);
  }

  onExit(id: string, listener: (info: ExitInfo) => void): () => void {
    const proc = this.get(id);
    proc.exitListeners.add(listener);
    return () => proc.exitListeners.delete(listener);
  }

  /** Terminate a process. Exit listeners still fire once node-pty reports the exit. */
  kill(id: string): void {
    const proc = this.processes.get(id);
    if (!proc) return;
    try {
      proc.pty.kill();
    } catch {
      // The process has already gone; onExit will clean up.
    }
  }

  killAll(): void {
    for (const id of [...this.processes.keys()]) this.kill(id);
  }

  private get(id: string): PtyProcess {
    const proc = this.processes.get(id);
    if (!proc) throw new PtyNotFoundError(`Terminal not found: ${id}`);
    return proc;
  }

  private appendReplay(proc: PtyProcess, data: string): void {
    proc.replay.push(data);
    proc.replayChars += data.length;
    while (proc.replayChars > this.opts.maxReplayChars && proc.replay.length > 1) {
      proc.replayChars -= proc.replay.shift()!.length;
    }
  }

  private release(id: string): void {
    const proc = this.processes.get(id);
    if (!proc) return;
    for (const disposable of proc.disposables) {
      try {
        disposable.dispose();
      } catch {
        // Disposing an already-disposed listener is harmless.
      }
    }
    proc.dataListeners.clear();
    this.processes.delete(id);
  }
}
