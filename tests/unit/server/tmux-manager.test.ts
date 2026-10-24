import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildSafeEnv } from '../../../packages/server/src/terminal/safe-env.js';
import { TmuxError, TmuxManager } from '../../../packages/server/src/terminal/tmux-manager.js';
import { PtyManager } from '../../../packages/server/src/terminal/pty-manager.js';
import { eventually, hasNativeTmux, tmux } from '../../helpers/platform.js';

describe('TmuxManager (platform routing)', () => {
  it('runs tmux directly on macOS and Linux', () => {
    expect(new TmuxManager({ platform: 'darwin', env: {} }).command(['ls'])).toEqual({ file: 'tmux', args: ['ls'] });
    expect(new TmuxManager({ platform: 'linux', env: {} }).command(['ls'])).toEqual({ file: 'tmux', args: ['ls'] });
  });

  it('routes through WSL on Windows without a shell re-parsing the arguments', () => {
    expect(new TmuxManager({ platform: 'win32', env: {} }).command(['attach-session', '-t', '=x$(id)']))
      .toEqual({ file: 'wsl', args: ['--exec', 'tmux', 'attach-session', '-t', '=x$(id)'] });
  });

  it('gives a platform-specific install hint', () => {
    expect(new TmuxManager({ platform: 'darwin', env: {} }).unavailableMessage()).toContain('brew install tmux');
    expect(new TmuxManager({ platform: 'win32', env: {} }).unavailableMessage()).toContain('wsl');
    expect(new TmuxManager({ platform: 'linux', env: {} }).unavailableMessage()).toContain('apt install tmux');
  });

  it('builds an exact-match attach command with the shared environment', () => {
    const env = { PATH: '/bin' };
    const spec = new TmuxManager({ platform: 'linux', env }).attachSpec('dev');
    expect(spec).toEqual({ file: 'tmux', args: ['attach-session', '-t', '=dev'], cwd: homedir(), env });
  });

  it.each(['', 'a:b', 'a.b', 'new\nline'])('rejects invalid session name %j before running tmux', async (name) => {
    const manager = new TmuxManager({ platform: 'linux', env: {} });
    expect(() => manager.attachSpec(name)).toThrow(TmuxError);
    await expect(manager.createSession(name)).rejects.toThrow(TmuxError);
  });

  it('reports unavailable when the tmux binary is missing', async () => {
    const manager = new TmuxManager({ platform: 'linux', env: { PATH: '/nonexistent' } });
    expect(await manager.isAvailable()).toBe(false);
  });
});

// Runs against a private tmux server (see tests/helpers/isolate-tmux.ts).
describe.skipIf(!hasNativeTmux())('TmuxManager (real tmux)', () => {
  const manager = new TmuxManager();

  afterEach(async () => {
    for (const session of await manager.listSessions()) await manager.killSession(session.name);
  });

  it('is available', async () => {
    expect(await manager.isAvailable()).toBe(true);
  });

  it('returns no sessions when no tmux server is running', async () => {
    expect(await manager.listSessions()).toEqual([]);
  });

  it('creates, lists and kills sessions', async () => {
    await manager.createSession('tp-one');
    const [session] = await manager.listSessions();
    expect(session).toMatchObject({ name: 'tp-one', windows: 1, attached: false });
    // A real timestamp, not an empty string.
    expect(Math.abs(Date.parse(session.created) - Date.now())).toBeLessThan(60_000);
    await manager.killSession('tp-one');
    expect(await manager.listSessions()).toEqual([]);
  });

  it('rejects a duplicate session', async () => {
    await manager.createSession('tp-dup');
    await expect(manager.createSession('tp-dup')).rejects.toThrow(/already exists/);
  });

  it('matches session names exactly, not by prefix', async () => {
    await manager.createSession('devops');
    expect(await manager.hasSession('dev')).toBe(false);
    await expect(manager.killSession('dev')).rejects.toThrow(/not found/);
    expect((await manager.listSessions()).map((s) => s.name)).toEqual(['devops']);
  });

  it('handles session names with spaces and shell characters safely', async () => {
    await manager.createSession('my project; $(id)');
    expect(await manager.hasSession('my project; $(id)')).toBe(true);
    expect((await manager.listSessions()).map((s) => s.name)).toEqual(['my project; $(id)']);
  });

  it('reports a real connection error instead of pretending there are no sessions', async () => {
    // Unix socket paths are limited to ~104 bytes, so an existing but very deep TMUX_TMPDIR
    // makes tmux fail with "error connecting to … (File name too long)".
    const deep = join(process.env.TMUX_TMPDIR!, 'd'.repeat(120));
    mkdirSync(deep);
    const broken = new TmuxManager({ env: { ...buildSafeEnv(), TMUX_TMPDIR: deep } });
    await expect(broken.listSessions()).rejects.toThrow(/File name too long/);
  });

  it('lists windows', async () => {
    await manager.createSession('tp-win');
    tmux('new-window', '-t', '=tp-win', '-n', 'second');
    const windows = await manager.listWindows('tp-win');
    expect(windows.map((w) => w.name)).toContain('second');
    expect(windows.filter((w) => w.active)).toHaveLength(1);
    await expect(manager.listWindows('tp-missing')).rejects.toThrow(/not found/);
  });

  it('attaches a client through a PTY and reports it as attached', async () => {
    await manager.createSession('tp-attach');
    const ptys = new PtyManager({ maxProcesses: 1, maxReplayChars: 10_000 });
    const id = ptys.spawn(manager.attachSpec('tp-attach'), { cols: 80, rows: 24 });
    await eventually(async () => (await manager.listSessions())[0]?.attached);
    ptys.write(id, 'echo tmux-attached-ok\r');
    await eventually(() => ptys.replay(id).includes('tmux-attached-ok'));
    ptys.kill(id);
    await eventually(async () => !(await manager.listSessions())[0]?.attached);
  });
});
