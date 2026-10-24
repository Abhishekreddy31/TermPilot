import { windowsSessionEnvironment, type RegistryReader } from './windows-env.js';

// Environment for spawned terminals.
// The server may have been started from a shell holding secrets (API keys, cloud
// credentials, tokens), and terminals must not inherit them. They get the environment
// a freshly opened local terminal would get:
// - macOS/Linux: a small allowlist; the user's rc files set everything else.
// - Windows: the user's session environment from the registry (see windows-env.ts),
//   because nothing rebuilds it there: PowerShell started with a stripped environment
//   loses user settings and stalls for ~30 s on its first command.

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

// Fallback on Windows when the registry cannot be read.
const WINDOWS_KEYS = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'PSModulePath',
  'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION', 'ALLUSERSPROFILE', 'PUBLIC', 'CommonProgramW6432', 'DriverData', 'WSLENV', 'WT_SESSION',
];

/** Variables passed through on Windows on top of the session environment. */
const WINDOWS_PASSTHROUGH = ['TMUX_TMPDIR', 'WT_SESSION'];

export const DEFAULT_TERM = 'xterm-256color';

export function buildSafeEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readRegistry?: RegistryReader,
): Record<string, string> {
  if (platform === 'win32') {
    const session = windowsSessionEnvironment(source, readRegistry);
    if (session) {
      const lookup = new Map(Object.entries(source).map(([key, value]) => [key.toUpperCase(), value]));
      for (const key of WINDOWS_PASSTHROUGH) {
        const value = lookup.get(key.toUpperCase());
        if (value) session[key] = value;
      }
      session.TERM = DEFAULT_TERM;
      return session;
    }
  }
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
