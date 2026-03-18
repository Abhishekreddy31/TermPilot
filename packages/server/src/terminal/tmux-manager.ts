import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import { buildSafeEnv } from './safe-env.js';

const exec = promisify(execFile);

export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
}

export interface AttachResult {
  pty: pty.IPty;
  cleanup: () => void;
}

const VALID_SESSION_NAME = /^[a-zA-Z0-9_-]+$/;
const IS_WINDOWS = process.platform === 'win32';

function validateSessionName(name: string): void {
  if (!name || !VALID_SESSION_NAME.test(name)) {
    throw new Error(
      `Invalid session name: "${name}". Use only alphanumeric, dash, underscore.`
    );
  }
}

/**
 * Build the command and args for running tmux.
 * On macOS/Linux: ['tmux', [...args]]
 * On Windows: ['wsl', ['tmux', ...args]]  (routes through WSL)
 */
function tmuxCmd(args: string[]): { cmd: string; args: string[] } {
  if (IS_WINDOWS) {
    return { cmd: 'wsl', args: ['tmux', ...args] };
  }
  return { cmd: 'tmux', args };
}

export class TmuxManager {
  private _wslChecked = false;
  private _wslAvailable = false;

  /**
   * List all active tmux sessions.
   */
  async listSessions(): Promise<TmuxSession[]> {
    try {
      const { cmd, args } = tmuxCmd([
        'list-sessions',
        '-F',
        '#{session_name}\t#{session_windows}\t#{session_created_string}\t#{session_attached}',
      ]);
      const { stdout } = await exec(cmd, args);

      return stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name, windows, created, attached] = line.split('\t');
          return {
            name,
            windows: parseInt(windows, 10),
            created,
            attached: attached === '1',
          };
        });
    } catch (err) {
      const message = (err as Error).message || '';
      if (
        message.includes('no server running') ||
        message.includes('no sessions') ||
        message.includes('error connecting')
      ) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Create a new detached tmux session.
   */
  async createSession(name: string): Promise<void> {
    validateSessionName(name);
    try {
      const { cmd, args } = tmuxCmd(['new-session', '-d', '-s', name]);
      await exec(cmd, args);
    } catch (err) {
      const message = (err as Error).message || '';
      if (message.includes('duplicate session')) {
        throw new Error(`tmux session "${name}" already exists`);
      }
      throw err;
    }
  }

  /**
   * Kill a tmux session.
   */
  async killSession(name: string): Promise<void> {
    validateSessionName(name);
    try {
      const { cmd, args } = tmuxCmd(['kill-session', '-t', name]);
      await exec(cmd, args);
    } catch (err) {
      const message = (err as Error).message || '';
      if (
        message.includes("can't find session") ||
        message.includes('no server running')
      ) {
        throw new Error(`tmux session "${name}" not found`);
      }
      throw err;
    }
  }

  /**
   * List windows in a tmux session.
   */
  async getSessionWindows(sessionName: string): Promise<TmuxWindow[]> {
    validateSessionName(sessionName);
    try {
      const { cmd, args } = tmuxCmd([
        'list-windows',
        '-t',
        sessionName,
        '-F',
        '#{window_index}\t#{window_name}\t#{window_active}',
      ]);
      const { stdout } = await exec(cmd, args);

      return stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
          const [index, name, active] = line.split('\t');
          return {
            index: parseInt(index, 10),
            name,
            active: active === '1',
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Attach to a tmux session via PTY.
   * On Windows, spawns through WSL for tmux access.
   */
  attachSession(
    sessionName: string,
    options: { cols: number; rows: number }
  ): AttachResult {
    validateSessionName(sessionName);

    const { cmd, args } = tmuxCmd(['attach-session', '-t', sessionName]);

    const ptyProcess = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: process.env.HOME || (IS_WINDOWS ? process.env.USERPROFILE || '/' : '/'),
      env: buildSafeEnv(),
    });

    const cleanup = () => {
      try {
        ptyProcess.kill();
      } catch {
        // Already dead
      }
    };

    return { pty: ptyProcess, cleanup };
  }

  /**
   * Check if tmux is available.
   * On Windows, checks if WSL is installed and tmux is available inside it.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const { cmd, args } = tmuxCmd(['-V']);
      await exec(cmd, args);

      if (IS_WINDOWS) {
        this._wslChecked = true;
        this._wslAvailable = true;
      }

      return true;
    } catch {
      if (IS_WINDOWS) {
        this._wslChecked = true;
        this._wslAvailable = false;
      }
      return false;
    }
  }

  /**
   * Get a user-friendly message about mirror mode availability.
   */
  getAvailabilityMessage(): string {
    if (!IS_WINDOWS) {
      return 'Install tmux: brew install tmux (macOS) or apt install tmux (Linux)';
    }
    if (this._wslChecked && !this._wslAvailable) {
      return 'Mirror mode on Windows requires WSL with tmux installed. Run: wsl --install && wsl sudo apt install tmux';
    }
    return 'Mirror mode on Windows requires WSL with tmux. Run: wsl sudo apt install tmux';
  }
}
