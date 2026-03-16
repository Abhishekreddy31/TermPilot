import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pty from 'node-pty';

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

export class TmuxManager {
  /**
   * List all active tmux sessions on this machine.
   */
  async listSessions(): Promise<TmuxSession[]> {
    try {
      const { stdout } = await exec('tmux', [
        'list-sessions',
        '-F',
        '#{session_name}\t#{session_windows}\t#{session_created_string}\t#{session_attached}',
      ]);

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
      // "no server running" or "no sessions" means tmux has no sessions
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
    // Validate session name (alphanumeric, dash, underscore only)
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(
        `Invalid session name: "${name}". Use only alphanumeric, dash, underscore.`
      );
    }

    try {
      await exec('tmux', ['new-session', '-d', '-s', name]);
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
    try {
      await exec('tmux', ['kill-session', '-t', name]);
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
    try {
      const { stdout } = await exec('tmux', [
        'list-windows',
        '-t',
        sessionName,
        '-F',
        '#{window_index}\t#{window_name}\t#{window_active}',
      ]);

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
   * Attach to a tmux session by spawning a PTY running `tmux attach`.
   * This creates a real-time mirror — anything shown in the tmux session
   * appears here, and anything typed here appears in the tmux session.
   */
  attachSession(
    sessionName: string,
    options: { cols: number; rows: number }
  ): AttachResult {
    const ptyProcess = pty.spawn(
      'tmux',
      ['attach-session', '-t', sessionName],
      {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: process.env.HOME || '/',
        env: { ...process.env } as Record<string, string>,
      }
    );

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
   * Check if tmux is available on this system.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await exec('tmux', ['-V']);
      return true;
    } catch {
      return false;
    }
  }
}
