import { homedir, userInfo } from 'node:os';
import { buildSafeEnv } from './safe-env.js';
import type { SpawnSpec } from './pty-manager.js';

const WINDOWS_SHELL = 'powershell.exe';
const POSIX_FALLBACK_SHELL = '/bin/sh';

/**
 * The user's login shell. On POSIX this is $SHELL, else the passwd entry, else
 * /bin/sh. On Windows $SHELL is ignored: Git Bash sets it to a POSIX path that
 * cannot be spawned natively.
 */
export function resolveDefaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') return WINDOWS_SHELL;
  if (env.SHELL) return env.SHELL;
  try {
    const shell = userInfo().shell;
    if (shell) return shell;
  } catch {
    // No passwd entry (some containers); fall through.
  }
  return POSIX_FALLBACK_SHELL;
}

export function shellSpawnSpec(shell: string = resolveDefaultShell()): SpawnSpec {
  return { file: shell, args: [], cwd: homedir(), env: buildSafeEnv() };
}
