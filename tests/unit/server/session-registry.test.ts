import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@termpilot/shared';
import type { ExitInfo, PtyHost, SpawnSpec, TerminalSize } from '../../../packages/server/src/terminal/pty-manager.js';
import { SessionNotFoundError, SessionRegistry, type SessionSubscriber } from '../../../packages/server/src/terminal/session-registry.js';

/** In-memory PTYs: records calls and lets the test emit output or exits. */
class FakePtys implements PtyHost {
  private next = 0;
  readonly procs = new Map<string, { data: Set<(d: string) => void>; exit: Set<(i: ExitInfo) => void>; written: string[]; size: TerminalSize; paused: boolean; replay: string }>();
  readonly killed: string[] = [];

  spawn(_spec: SpawnSpec, size: TerminalSize): string {
    const id = `p${++this.next}`;
    this.procs.set(id, { data: new Set(), exit: new Set(), written: [], size, paused: false, replay: '' });
    return id;
  }
  private get(id: string) {
    const proc = this.procs.get(id);
    if (!proc) throw new Error(`no pty ${id}`);
    return proc;
  }
  write(id: string, data: string) { this.get(id).written.push(data); }
  resize(id: string, size: TerminalSize) { this.get(id).size = size; }
  pause(id: string) { this.get(id).paused = true; }
  resume(id: string) { this.get(id).paused = false; }
  replay(id: string) { return this.get(id).replay; }
  onData(id: string, l: (d: string) => void) { this.get(id).data.add(l); return () => this.get(id).data.delete(l); }
  onExit(id: string, l: (i: ExitInfo) => void) { this.get(id).exit.add(l); return () => this.get(id).exit.delete(l); }
  kill(id: string) {
    this.killed.push(id);
    const proc = this.procs.get(id);
    if (!proc) return;
    this.procs.delete(id);
    for (const l of proc.exit) l({ exitCode: 0, signal: 15 });
  }
  emit(id: string, data: string) {
    const proc = this.get(id);
    proc.replay += data;
    for (const l of proc.data) l(data);
  }
  exit(id: string, exitCode: number) {
    const proc = this.get(id);
    this.procs.delete(id);
    for (const l of proc.exit) l({ exitCode });
  }
}

class FakeSubscriber implements SessionSubscriber {
  readonly received: ServerMessage[] = [];
  congested = false;
  private drains: Array<() => void> = [];
  send(message: ServerMessage) { this.received.push(message); }
  onDrain(listener: () => void) { this.drains.push(listener); }
  drain() {
    this.congested = false;
    const drains = this.drains;
    this.drains = [];
    for (const l of drains) l();
  }
  ofType<T extends ServerMessage['type']>(type: T) {
    return this.received.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

const spec: SpawnSpec = { file: 'sh', args: [], cwd: '/', env: {} };
const size = { cols: 80, rows: 24 };

describe('SessionRegistry', () => {
  let ptys: FakePtys;
  let registry: SessionRegistry;
  let phone: FakeSubscriber;

  beforeEach(() => {
    ptys = new FakePtys();
    registry = new SessionRegistry(ptys);
    phone = new FakeSubscriber();
  });

  const createShell = (owner = 'alice', subscriber = phone) =>
    registry.create({ owner, kind: 'shell', spec, size }, subscriber);

  it('creates a shell and streams its output to the creator', () => {
    const info = createShell();
    expect(info).toMatchObject({ id: 'p1', kind: 'shell', cols: 80, rows: 24 });
    ptys.emit(info.id, 'hello');
    expect(phone.ofType('output')).toEqual([{ type: 'output', sessionId: 'p1', data: 'hello' }]);
  });

  it('keeps a shell running after its connection goes away, and replays it on attach', () => {
    const info = createShell();
    registry.disconnect(phone);
    ptys.emit(info.id, 'build done');
    expect(ptys.killed).toEqual([]);

    const laptop = new FakeSubscriber();
    expect(registry.list('alice', laptop).map((s) => s.id)).toEqual([info.id]);
    // The replay comes with the size it was produced at; then the session takes the new size.
    expect(registry.attach(info.id, 'alice', laptop, { cols: 100, rows: 40 })).toEqual({ replay: 'build done', size: { cols: 80, rows: 24 } });
    expect(ptys.procs.get(info.id)!.size).toEqual({ cols: 100, rows: 40 });
    ptys.emit(info.id, '$ ');
    expect(laptop.ofType('output').map((m) => m.data)).toEqual(['$ ']);
    expect(phone.ofType('output').map((m) => m.data)).toEqual([]);
  });

  it('delivers output to every attached connection', () => {
    const info = createShell();
    const second = new FakeSubscriber();
    registry.attach(info.id, 'alice', second, size);
    ptys.emit(info.id, 'x');
    expect(phone.ofType('output')).toHaveLength(1);
    expect(second.ofType('output')).toHaveLength(1);
  });

  it('hides other users\' sessions and treats them as not found', () => {
    const info = createShell('alice');
    const mallory = new FakeSubscriber();
    expect(registry.list('mallory', mallory)).toEqual([]);
    expect(() => registry.write(info.id, 'mallory', mallory, 'rm -rf ~\r')).toThrow(SessionNotFoundError);
    expect(() => registry.attach(info.id, 'mallory', mallory, size)).toThrow(SessionNotFoundError);
    expect(() => registry.close(info.id, 'mallory', mallory)).toThrow(SessionNotFoundError);
    expect(() => registry.write('nope', 'alice', phone, 'x')).toThrow(SessionNotFoundError);
    expect(ptys.procs.get(info.id)!.written).toEqual([]);
  });

  it('scopes tmux clients to the connection that attached them', () => {
    const tmux = registry.create({ owner: 'alice', kind: 'tmux', tmuxName: 'dev', spec, size }, phone);
    expect(tmux).toMatchObject({ kind: 'tmux', tmuxName: 'dev' });
    const laptop = new FakeSubscriber();
    expect(registry.list('alice', laptop)).toEqual([]);
    expect(() => registry.write(tmux.id, 'alice', laptop, 'x')).toThrow(SessionNotFoundError);

    registry.disconnect(phone);
    // The tmux client is killed so it no longer pins the tmux window size; the tmux session lives on.
    expect(ptys.killed).toEqual([tmux.id]);
    expect(registry.size).toBe(0);
  });

  it('lists shells oldest first', () => {
    const a = createShell();
    const b = createShell();
    expect(registry.list('alice', phone).map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it('reports exits with the exit code and forgets the session', () => {
    const info = createShell();
    ptys.exit(info.id, 3);
    expect(phone.ofType('session_closed')).toEqual([{ type: 'session_closed', sessionId: info.id, reason: 'exited', exitCode: 3 }]);
    expect(registry.list('alice', phone)).toEqual([]);
  });

  it('closes on request exactly once', () => {
    const info = createShell();
    registry.close(info.id, 'alice', phone);
    expect(ptys.killed).toEqual([info.id]);
    expect(phone.ofType('session_closed')).toEqual([{ type: 'session_closed', sessionId: info.id, reason: 'closed' }]);
  });

  it('ends sessions of owners with no valid login left', () => {
    const alice = createShell('alice');
    const bob = createShell('bob', new FakeSubscriber());
    registry.reapInactiveOwners((owner) => owner === 'bob');
    expect(ptys.killed).toEqual([alice.id]);
    expect(phone.ofType('session_closed')[0]).toMatchObject({ sessionId: alice.id, reason: 'expired' });
    expect(registry.list('bob', new FakeSubscriber()).map((s) => s.id)).toEqual([bob.id]);
  });

  it('keeps the session size when the attaching client does not know its own', () => {
    const info = createShell();
    const laptop = new FakeSubscriber();
    expect(registry.attach(info.id, 'alice', laptop).size).toEqual({ cols: 80, rows: 24 });
    expect(ptys.procs.get(info.id)!.size).toEqual({ cols: 80, rows: 24 });
  });

  it('skips no-op resizes', () => {
    const info = createShell();
    const before = ptys.procs.get(info.id)!.size;
    registry.resize(info.id, 'alice', phone, { cols: 80, rows: 24 });
    expect(ptys.procs.get(info.id)!.size).toBe(before);
  });

  describe('flow control', () => {
    it('pauses the PTY while a subscriber is behind and resumes once it drains', () => {
      const info = createShell();
      phone.congested = true;
      ptys.emit(info.id, 'lots');
      expect(ptys.procs.get(info.id)!.paused).toBe(true);
      phone.drain();
      expect(ptys.procs.get(info.id)!.paused).toBe(false);
    });

    it('waits for every slow subscriber, including one that fell behind while paused', () => {
      const info = createShell();
      const second = new FakeSubscriber();
      registry.attach(info.id, 'alice', second, size);
      phone.congested = true;
      ptys.emit(info.id, 'x');
      second.congested = true;
      phone.drain();
      expect(ptys.procs.get(info.id)!.paused).toBe(true);
      second.drain();
      expect(ptys.procs.get(info.id)!.paused).toBe(false);
    });

    it('resumes when the slow subscriber disconnects', () => {
      const info = createShell();
      phone.congested = true;
      ptys.emit(info.id, 'x');
      registry.disconnect(phone);
      expect(ptys.procs.get(info.id)!.paused).toBe(false);
    });

    it('keeps a detached shell running (no subscriber can be behind)', () => {
      const info = createShell();
      registry.disconnect(phone);
      ptys.emit(info.id, 'x');
      expect(ptys.procs.get(info.id)!.paused).toBe(false);
    });
  });
});
