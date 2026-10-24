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

  it('falls back to an allowlist on Windows when the registry cannot be read, matching names case-insensitively', () => {
    const env = buildSafeEnv({ Path: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', ComSpec: 'cmd.exe', API_KEY: 'leak' }, 'win32', () => null);
    expect(env).toMatchObject({ PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', ComSpec: 'cmd.exe' });
    expect(env).not.toHaveProperty('API_KEY');
  });

  it('uses the Windows session environment from the registry when available', () => {
    const registry = (key: string) => (key.startsWith('HKLM')
      ? '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32\r\n    ComSpec    REG_EXPAND_SZ    %SystemRoot%\\system32\\cmd.exe\r\n'
      : key === 'HKCU\\Environment' ? '    JAVA_HOME    REG_SZ    C:\\jdk\r\n' : null);
    const env = buildSafeEnv({ SystemRoot: 'C:\\Windows', TMUX_TMPDIR: 'C:\\t', API_KEY: 'leak', TERM: 'dumb' }, 'win32', registry);
    expect(env).toMatchObject({ Path: 'C:\\Windows\\system32', ComSpec: 'C:\\Windows\\system32\\cmd.exe', JAVA_HOME: 'C:\\jdk', TMUX_TMPDIR: 'C:\\t', TERM: DEFAULT_TERM });
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
