// Safe environment variable allowlist for spawned PTY processes.
// Prevents leaking server secrets (API keys, passwords, etc.) to terminal users.

const SAFE_ENV_KEYS = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'COLORTERM', 'PATH', 'EDITOR', 'VISUAL', 'PAGER',
  'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'TMPDIR', 'TZ',
];

export function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  env.TERM = env.TERM || 'xterm-256color';
  return env;
}
