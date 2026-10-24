import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyLimitError, PtyManager, PtyNotFoundError } from '../../../packages/server/src/terminal/pty-manager.js';
import { shellSpawnSpec } from '../../../packages/server/src/terminal/shell.js';
import { TEST_SHELL, eventually } from '../../helpers/platform.js';

const size = { cols: 80, rows: 24 };
const REPLAY_LIMIT = 250;

// These run real pseudo-terminals through node-pty on every platform.
describe('PtyManager', () => {
  let ptys: PtyManager;

  beforeEach(() => {
    ptys = new PtyManager({ maxProcesses: 3, maxReplayChars: 64 });
  });

  afterEach(async () => {
    ptys.killAll();
    await eventually(() => ptys.size === 0);
  });

  const spawn = () => ptys.spawn(shellSpawnSpec(TEST_SHELL), size);

  it('runs a shell and streams its output', async () => {
    const id = spawn();
    let output = '';
    ptys.onData(id, (data) => (output += data));
    ptys.write(id, 'echo pty-works\r');
    await eventually(() => output.includes('pty-works'));
  });

  it('enforces the process limit', () => {
    spawn();
    spawn();
    spawn();
    expect(() => spawn()).toThrow(PtyLimitError);
  });

  it('keeps only the most recent output for replay', async () => {
    // Room for one command round (echoed command + output + prompt, ~100 chars) but not four.
    ptys = new PtyManager({ maxProcesses: 1, maxReplayChars: REPLAY_LIMIT });
    const id = spawn();
    const early = 'a'.repeat(40);
    ptys.write(id, `echo ${early}\r`);
    await eventually(() => ptys.replay(id).includes(early));
    // Separate writes produce separate chunks; older chunks are dropped once over the limit.
    for (const marker of ['b'.repeat(40), 'c'.repeat(40), 'replay-end']) {
      ptys.write(id, `echo ${marker}\r`);
      await eventually(() => ptys.replay(id).includes(marker));
    }
    expect(ptys.replay(id)).not.toContain(early);
    expect(ptys.replay(id).length).toBeLessThan(REPLAY_LIMIT * 2);
  });

  it('reports exit, then forgets the process', async () => {
    const id = spawn();
    const exits: number[] = [];
    ptys.onExit(id, ({ exitCode }) => exits.push(exitCode));
    ptys.write(id, 'exit 7\r');
    await eventually(() => exits.length === 1);
    expect(exits[0]).toBe(7);
    expect(ptys.has(id)).toBe(false);
    expect(() => ptys.write(id, 'x')).toThrow(PtyNotFoundError);
  });

  it('kills on request and tolerates repeated kills', async () => {
    const id = spawn();
    let exited = false;
    ptys.onExit(id, () => (exited = true));
    ptys.kill(id);
    ptys.kill(id);
    await eventually(() => exited);
    expect(() => ptys.kill('unknown')).not.toThrow();
  });

  it('resizes, pauses and resumes a live process', () => {
    const id = spawn();
    expect(() => ptys.resize(id, { cols: 120, rows: 40 })).not.toThrow();
    expect(() => ptys.pause(id)).not.toThrow();
    expect(() => ptys.resume(id)).not.toThrow();
  });

  it('throws a not-found error for unknown ids', () => {
    expect(() => ptys.replay('nope')).toThrow(PtyNotFoundError);
    expect(() => ptys.onData('nope', () => {})).toThrow(PtyNotFoundError);
  });
});
