import type { ServerMessage, SessionCloseReason, SessionInfo, SessionKind } from '@termpilot/shared';
import type { PtyHost, SpawnSpec, TerminalSize } from './pty-manager.js';

/** A destination for session output: one WebSocket connection. */
export interface SessionSubscriber {
  send(message: ServerMessage): void;
  /** True while the subscriber has more unsent output buffered than it should. */
  readonly congested: boolean;
  /** Call `listener` once, as soon as the subscriber is no longer congested. */
  onDrain(listener: () => void): void;
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session not found: ${id}`);
  }
}

interface Entry {
  info: SessionInfo;
  owner: string;
  /** Connection-scoped sessions die with the connection that created them. */
  scope: SessionSubscriber | null;
  subscribers: Set<SessionSubscriber>;
  paused: boolean;
}

/**
 * Who may use which terminal, and who receives its output.
 *
 * - `shell` sessions belong to the logged-in user and survive disconnects, so a
 *   phone that drops off Wi-Fi or reloads the page gets its terminals back. They
 *   end when the process exits, the user closes them, or the user has no valid
 *   login left (see {@link reapInactiveOwners}).
 * - `tmux` sessions are a tmux client attached for one connection. The tmux
 *   session itself lives on in tmux; keeping an orphaned client attached would
 *   pin the tmux window to the phone's size, so the client ends with the connection.
 *
 * Output is flow-controlled: when any subscriber falls behind, the PTY is paused
 * until it drains, so a fast producer (`cat` of a large file, `yes`) cannot grow
 * server memory without bound over a slow mobile link.
 */
export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ptys: PtyHost) {}

  create(
    params: { owner: string; kind: SessionKind; spec: SpawnSpec; size: TerminalSize; tmuxName?: string },
    subscriber: SessionSubscriber,
  ): SessionInfo {
    const id = this.ptys.spawn(params.spec, params.size);
    const info: SessionInfo = {
      id,
      kind: params.kind,
      ...(params.tmuxName ? { tmuxName: params.tmuxName } : {}),
      cols: params.size.cols,
      rows: params.size.rows,
      createdAt: Date.now(),
    };
    const entry: Entry = {
      info,
      owner: params.owner,
      scope: params.kind === 'tmux' ? subscriber : null,
      subscribers: new Set([subscriber]),
      paused: false,
    };
    this.entries.set(id, entry);

    this.ptys.onData(id, (data) => this.deliver(entry, data));
    this.ptys.onExit(id, ({ exitCode }) => this.finish(entry, 'exited', exitCode));
    return { ...info };
  }

  /**
   * Subscribe to a session and return its recent output so the client can redraw,
   * together with the terminal size that output was produced at (the client must render
   * it at that size: it contains cursor movement computed for it). If the client knows
   * its size, the session is then resized to it and the program redraws for it.
   */
  attach(id: string, owner: string, subscriber: SessionSubscriber, size?: TerminalSize): { replay: string; size: TerminalSize } {
    const entry = this.owned(id, owner, subscriber);
    entry.subscribers.add(subscriber);
    const replay = { replay: this.ptys.replay(id), size: { cols: entry.info.cols, rows: entry.info.rows } };
    if (size) this.resize(id, owner, subscriber, size);
    return replay;
  }

  write(id: string, owner: string, subscriber: SessionSubscriber, data: string): void {
    this.owned(id, owner, subscriber);
    this.ptys.write(id, data);
  }

  resize(id: string, owner: string, subscriber: SessionSubscriber, size: TerminalSize): void {
    const entry = this.owned(id, owner, subscriber);
    if (entry.info.cols === size.cols && entry.info.rows === size.rows) return;
    this.ptys.resize(id, size);
    entry.info.cols = size.cols;
    entry.info.rows = size.rows;
  }

  /** End a session at the user's request: kills a shell, or detaches the tmux client. */
  close(id: string, owner: string, subscriber: SessionSubscriber): void {
    const entry = this.owned(id, owner, subscriber);
    this.finish(entry, 'closed');
    this.ptys.kill(id);
  }

  /** Sessions this subscriber may see: the owner's shells plus its own tmux clients. */
  list(owner: string, subscriber: SessionSubscriber): SessionInfo[] {
    return [...this.entries.values()]
      .filter((entry) => this.visible(entry, owner, subscriber))
      .sort((a, b) => a.info.createdAt - b.info.createdAt)
      .map((entry) => ({ ...entry.info }));
  }

  /** A connection went away: drop its subscriptions and end its connection-scoped sessions. */
  disconnect(subscriber: SessionSubscriber): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.scope === subscriber) {
        entry.subscribers.delete(subscriber);
        this.finish(entry, 'closed');
        this.ptys.kill(entry.info.id);
      } else if (entry.subscribers.delete(subscriber)) {
        this.resumeIfDrained(entry);
      }
    }
  }

  /** End every session whose owner no longer has a valid login. */
  reapInactiveOwners(isActive: (owner: string) => boolean): void {
    for (const entry of [...this.entries.values()]) {
      if (!isActive(entry.owner)) {
        this.finish(entry, 'expired');
        this.ptys.kill(entry.info.id);
      }
    }
  }

  closeAll(): void {
    for (const entry of [...this.entries.values()]) {
      this.finish(entry, 'closed');
      this.ptys.kill(entry.info.id);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private visible(entry: Entry, owner: string, subscriber: SessionSubscriber): boolean {
    return entry.owner === owner && (entry.scope === null || entry.scope === subscriber);
  }

  /** Look up a session the caller may use. Unknown and foreign sessions are indistinguishable. */
  private owned(id: string, owner: string, subscriber: SessionSubscriber): Entry {
    const entry = this.entries.get(id);
    if (!entry || !this.visible(entry, owner, subscriber)) throw new SessionNotFoundError(id);
    return entry;
  }

  private deliver(entry: Entry, data: string): void {
    const message: ServerMessage = { type: 'output', sessionId: entry.info.id, data };
    let congested = false;
    for (const subscriber of entry.subscribers) {
      subscriber.send(message);
      if (subscriber.congested) congested = true;
    }
    if (congested && !entry.paused && this.entries.has(entry.info.id)) {
      entry.paused = true;
      this.ptys.pause(entry.info.id);
      this.awaitDrain(entry);
    }
  }

  private awaitDrain(entry: Entry): void {
    for (const subscriber of entry.subscribers) {
      if (subscriber.congested) subscriber.onDrain(() => this.resumeIfDrained(entry));
    }
  }

  private resumeIfDrained(entry: Entry): void {
    if (!entry.paused || !this.entries.has(entry.info.id)) return;
    if ([...entry.subscribers].some((subscriber) => subscriber.congested)) {
      // Another subscriber is still behind (or fell behind while paused): wait for it too.
      this.awaitDrain(entry);
      return;
    }
    entry.paused = false;
    this.ptys.resume(entry.info.id);
  }

  /** Remove a session once and tell its subscribers why. Safe to call repeatedly. */
  private finish(entry: Entry, reason: SessionCloseReason, exitCode?: number): void {
    if (this.entries.get(entry.info.id) !== entry) return;
    this.entries.delete(entry.info.id);
    const message: ServerMessage = {
      type: 'session_closed',
      sessionId: entry.info.id,
      reason,
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
    for (const subscriber of entry.subscribers) subscriber.send(message);
    entry.subscribers.clear();
  }
}
