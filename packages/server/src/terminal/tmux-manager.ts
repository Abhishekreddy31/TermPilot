import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { TMUX_SESSION_NAME_PATTERN, type TmuxSessionInfo, type TmuxWindowInfo } from '@termpilot/shared';
import { buildSafeEnv } from './safe-env.js';
import type { SpawnSpec } from './pty-manager.js';

const execFileAsync = promisify(execFile);

export class TmuxError extends Error {}

/**
 * What tmux prints when there is simply no server yet: either "no server running on <socket>"
 * or, when the socket file does not exist, "error connecting to <socket> (No such file or
 * directory)". Other connection errors (permissions, path too long) are real failures.
 */
const NO_SERVER_PATTERNS = [/no server running/, /no sessions/, /error connecting to .*\(No such file or directory\)/];

const FIELD_SEPARATOR = '\t';

export interface TmuxManagerOptions {
  platform?: NodeJS.Platform;
  /** Environment for every tmux invocation. Defaults to the terminal allowlist so listing and attaching see the same server. */
  env?: Record<string, string>;
}

function assertValidName(name: string): void {
  if (!TMUX_SESSION_NAME_PATTERN.test(name)) {
    throw new TmuxError(`Invalid tmux session name ${JSON.stringify(name)}.`);
  }
}

function errorText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return `${e.stderr ?? ''}\n${e.message ?? ''}`;
}

/**
 * Talks to the user's tmux server. Every call goes through argv (never a shell).
 * On Windows tmux lives inside WSL, so commands are routed through `wsl`.
 */
export class TmuxManager {
  private readonly platform: NodeJS.Platform;
  private readonly env: Record<string, string>;

  constructor(opts: TmuxManagerOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? buildSafeEnv(process.env, this.platform);
  }

  /**
   * argv for invoking tmux on this platform. On Windows `wsl --exec` runs tmux directly;
   * plain `wsl <cmd>` would pass the arguments through the Linux shell and re-parse them.
   */
  command(args: string[]): { file: string; args: string[] } {
    return this.platform === 'win32' ? { file: 'wsl', args: ['--exec', 'tmux', ...args] } : { file: 'tmux', args };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.run(['-V']);
      return true;
    } catch {
      return false;
    }
  }

  unavailableMessage(): string {
    switch (this.platform) {
      case 'win32':
        return 'Mirror mode on Windows needs tmux inside WSL. Run: wsl --install, then: wsl sudo apt install tmux';
      case 'darwin':
        return 'Mirror mode needs tmux. Install it with: brew install tmux';
      default:
        return 'Mirror mode needs tmux. Install it with your package manager, e.g.: sudo apt install tmux';
    }
  }

  async listSessions(): Promise<TmuxSessionInfo[]> {
    const format = ['#{session_name}', '#{session_windows}', '#{session_created}', '#{session_attached}'].join(FIELD_SEPARATOR);
    let stdout: string;
    try {
      stdout = await this.run(['list-sessions', '-F', format]);
    } catch (err) {
      if (NO_SERVER_PATTERNS.some((pattern) => pattern.test(errorText(err)))) return [];
      throw err;
    }
    return parseLines(stdout).map(([name, windows, created, attached]) => ({
      name,
      windows: Number.parseInt(windows, 10),
      // session_created is a Unix timestamp in seconds on every tmux version.
      created: new Date(Number.parseInt(created, 10) * 1000).toISOString(),
      // session_attached is the number of attached clients.
      attached: Number.parseInt(attached, 10) > 0,
    }));
  }

  async hasSession(name: string): Promise<boolean> {
    assertValidName(name);
    try {
      // `=` forces an exact match instead of tmux's default prefix matching.
      await this.run(['has-session', '-t', `=${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  async createSession(name: string): Promise<void> {
    assertValidName(name);
    try {
      await this.run(['new-session', '-d', '-s', name]);
    } catch (err) {
      if (errorText(err).includes('duplicate session')) {
        throw new TmuxError(`tmux session "${name}" already exists`);
      }
      throw err;
    }
  }

  async killSession(name: string): Promise<void> {
    assertValidName(name);
    if (!(await this.hasSession(name))) {
      throw new TmuxError(`tmux session "${name}" not found`);
    }
    await this.run(['kill-session', '-t', `=${name}`]);
  }

  async listWindows(sessionName: string): Promise<TmuxWindowInfo[]> {
    assertValidName(sessionName);
    if (!(await this.hasSession(sessionName))) {
      throw new TmuxError(`tmux session "${sessionName}" not found`);
    }
    const format = ['#{window_index}', '#{window_name}', '#{window_active}'].join(FIELD_SEPARATOR);
    const stdout = await this.run(['list-windows', '-t', `=${sessionName}`, '-F', format]);
    return parseLines(stdout).map(([index, name, active]) => ({
      index: Number.parseInt(index, 10),
      name,
      active: active === '1',
    }));
  }

  /** What to spawn in a PTY to attach a new tmux client to `name`. */
  attachSpec(name: string): SpawnSpec {
    assertValidName(name);
    const { file, args } = this.command(['attach-session', '-t', `=${name}`]);
    return { file, args, cwd: homedir(), env: this.env };
  }

  private async run(args: string[]): Promise<string> {
    const { file, args: argv } = this.command(args);
    const { stdout } = await execFileAsync(file, argv, { env: this.env, windowsHide: true });
    return stdout;
  }
}

function parseLines(stdout: string): string[][] {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.split(FIELD_SEPARATOR));
}
