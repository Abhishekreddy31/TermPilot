import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// The server the developer's own `tmux ls` talks to (their TMUX_TMPDIR, if they set one).
const developerTmuxDir = process.env.TMUX_TMPDIR;

function defaultServerSessions(): Set<string> {
  const env = { ...process.env };
  if (developerTmuxDir === undefined) delete env.TMUX_TMPDIR;
  else env.TMUX_TMPDIR = developerTmuxDir;
  delete env.TMUX;
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name} #{session_created}'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return new Set(); // no server, or no tmux
  }
}

// A private tmux server per test file: tests create and kill sessions freely
// without touching sessions on the developer's or CI machine's default server.
const before = defaultServerSessions();
const dir = mkdtempSync(join(tmpdir(), 'termpilot-tmux-'));
process.env.TMUX_TMPDIR = dir;
delete process.env.TMUX;

afterAll(() => {
  try {
    execFileSync('tmux', ['kill-server'], { env: process.env, stdio: 'ignore' });
  } catch {
    // No server was started, or tmux is not installed.
  }
  rmSync(dir, { recursive: true, force: true });

  // Safety net: if code under test ever ignored TMUX_TMPDIR, sessions would land on the
  // user's own tmux server. Fail loudly (without killing anything that might be theirs).
  const leaked = [...defaultServerSessions()].filter((session) => !before.has(session));
  if (leaked.length > 0) {
    throw new Error(
      `New sessions appeared on your own tmux server during this test file: ${leaked.join(', ')}. ` +
      'If you did not create them yourself while tests ran, code under test ignored TMUX_TMPDIR.',
    );
  }
});
