// Environment allowlist for spawned terminals.
// The server may have been started from a shell holding secrets (API keys, cloud
// credentials, tokens). Terminals only receive the variables a shell needs to work;
// the user's own rc files set everything else, exactly as in a fresh local terminal.

const COMMON_KEYS = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TZ',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_NUMERIC', 'LC_TIME',
  'TERM', 'COLORTERM', 'EDITOR', 'VISUAL', 'PAGER',
  'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  // Socket to the user's ssh-agent (a path, not a secret) so `git push` over SSH works.
  'SSH_AUTH_SOCK',
  // Where tmux keeps its server socket; must match between listing and attaching.
  'TMUX_TMPDIR',
];

// Without these, PowerShell, cmd and WSL fail to start or cannot find system binaries.
const WINDOWS_KEYS = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'PSModulePath',
  'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'WSLENV', 'WT_SESSION',
];

export const DEFAULT_TERM = 'xterm-256color';

export function buildSafeEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const keys = platform === 'win32' ? [...COMMON_KEYS, ...WINDOWS_KEYS] : COMMON_KEYS;
  // On Windows variable names are case-insensitive (e.g. `Path`); match accordingly.
  const lookup = platform === 'win32'
    ? new Map(Object.entries(source).map(([key, value]) => [key.toUpperCase(), value]))
    : null;

  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = lookup ? lookup.get(key.toUpperCase()) : source[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  env.TERM = DEFAULT_TERM;
  return env;
}
