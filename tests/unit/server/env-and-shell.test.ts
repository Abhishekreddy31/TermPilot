import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { DEFAULT_TERM, buildSafeEnv } from '../../../packages/server/src/terminal/safe-env.js';
import { resolveDefaultShell, shellSpawnSpec } from '../../../packages/server/src/terminal/shell.js';

describe('buildSafeEnv', () => {
  const source = {
    HOME: '/home/u',
    PATH: '/usr/bin',
    LANG: 'en_US.UTF-8',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    TMUX_TMPDIR: '/run/tmux',
    TERM: 'dumb',
    AWS_SECRET_ACCESS_KEY: 'leak',
    GITHUB_TOKEN: 'leak',
    TERMPILOT_PASSWORD: 'leak',
    TMUX: '/tmp/tmux-1/default,1,0',
    EMPTY: '',
  };

  it('passes what a shell needs and nothing else', () => {
    const env = buildSafeEnv(source, 'linux');
    expect(env).toEqual({
      HOME: '/home/u',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      TMUX_TMPDIR: '/run/tmux',
      TERM: DEFAULT_TERM,
    });
  });

  it('never forwards secrets or the server\'s own tmux client variable', () => {
    const env = buildSafeEnv(source, 'darwin');
    for (const key of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'TERMPILOT_PASSWORD', 'TMUX']) expect(env).not.toHaveProperty(key);
  });

  it('keeps the variables Windows programs need, matching names case-insensitively', () => {
    const env = buildSafeEnv({ Path: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', ComSpec: 'cmd.exe', API_KEY: 'leak' }, 'win32');
    expect(env).toMatchObject({ PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', ComSpec: 'cmd.exe' });
    expect(env).not.toHaveProperty('API_KEY');
  });

  it('does not add Windows variables on other platforms', () => {
    expect(buildSafeEnv({ SystemRoot: 'x' }, 'linux')).not.toHaveProperty('SystemRoot');
  });
});

describe('resolveDefaultShell', () => {
  it('uses $SHELL on POSIX systems', () => {
    expect(resolveDefaultShell({ SHELL: '/usr/bin/fish' }, 'linux')).toBe('/usr/bin/fish');
  });

  it('falls back to the account\'s shell, never a hard-coded zsh', () => {
    const shell = resolveDefaultShell({}, 'linux');
    expect(shell.startsWith('/')).toBe(true);
  });

  it('uses PowerShell on Windows even when Git Bash set $SHELL', () => {
    expect(resolveDefaultShell({ SHELL: '/usr/bin/bash' }, 'win32')).toBe('powershell.exe');
  });

  it('starts shells in the home directory with the safe environment', () => {
    const spec = shellSpawnSpec('/bin/sh');
    expect(spec).toMatchObject({ file: '/bin/sh', args: [], cwd: homedir() });
    expect(spec.env.TERM).toBe(DEFAULT_TERM);
  });
});
