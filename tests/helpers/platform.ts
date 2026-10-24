import { execFileSync } from 'node:child_process';

export const IS_WINDOWS = process.platform === 'win32';

/** A shell that exists on every CI platform and understands `echo`. */
export const TEST_SHELL = IS_WINDOWS ? 'cmd.exe' : '/bin/sh';

/** Native tmux (not via WSL), used by mirror-mode tests. */
export function hasNativeTmux(): boolean {
  if (IS_WINDOWS) return false;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { env: process.env, encoding: 'utf8' });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `check` until it returns a truthy value or the deadline passes. */
export async function eventually<T>(check: () => T | Promise<T>, timeoutMs = 5_000, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ''}`);
}
