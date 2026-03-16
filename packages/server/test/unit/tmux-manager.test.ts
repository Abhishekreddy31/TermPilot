import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TmuxManager } from '../../src/terminal/tmux-manager.js';

describe('TmuxManager', () => {
  let tmux: TmuxManager;

  beforeEach(() => {
    tmux = new TmuxManager();
  });

  afterEach(async () => {
    // Clean up any test sessions
    const sessions = await tmux.listSessions();
    for (const s of sessions) {
      if (s.name.startsWith('termpilot-test-')) {
        await tmux.killSession(s.name);
      }
    }
  });

  describe('listSessions', () => {
    it('should return an array', async () => {
      const sessions = await tmux.listSessions();
      expect(Array.isArray(sessions)).toBe(true);
    });

    it('should include session name, windows, and created time', async () => {
      // Create a test session
      await tmux.createSession('termpilot-test-list');
      const sessions = await tmux.listSessions();
      const testSession = sessions.find((s) => s.name === 'termpilot-test-list');

      expect(testSession).toBeDefined();
      expect(testSession!.name).toBe('termpilot-test-list');
      expect(typeof testSession!.windows).toBe('number');
      expect(typeof testSession!.created).toBe('string');

      await tmux.killSession('termpilot-test-list');
    });
  });

  describe('createSession', () => {
    it('should create a new tmux session', async () => {
      await tmux.createSession('termpilot-test-create');
      const sessions = await tmux.listSessions();
      const found = sessions.find((s) => s.name === 'termpilot-test-create');
      expect(found).toBeDefined();

      await tmux.killSession('termpilot-test-create');
    });

    it('should reject duplicate session names', async () => {
      await tmux.createSession('termpilot-test-dup');
      await expect(tmux.createSession('termpilot-test-dup')).rejects.toThrow();
      await tmux.killSession('termpilot-test-dup');
    });
  });

  describe('killSession', () => {
    it('should kill an existing session', async () => {
      await tmux.createSession('termpilot-test-kill');
      await tmux.killSession('termpilot-test-kill');
      const sessions = await tmux.listSessions();
      const found = sessions.find((s) => s.name === 'termpilot-test-kill');
      expect(found).toBeUndefined();
    });

    it('should throw for non-existent session', async () => {
      await expect(tmux.killSession('nonexistent-xyz')).rejects.toThrow();
    });
  });

  describe('attach (via PTY)', () => {
    it('should attach to a tmux session and receive output', async () => {
      await tmux.createSession('termpilot-test-attach');

      const { pty, cleanup } = tmux.attachSession('termpilot-test-attach', {
        cols: 80,
        rows: 24,
      });

      const output = await new Promise<string>((resolve) => {
        pty.onData((data: string) => {
          resolve(data);
        });
      });

      expect(output).toBeTruthy();

      cleanup();
      await tmux.killSession('termpilot-test-attach');
    });

    it('should send input to the tmux session', async () => {
      await tmux.createSession('termpilot-test-input');

      const { pty, cleanup } = tmux.attachSession('termpilot-test-input', {
        cols: 80,
        rows: 24,
      });

      // Wait for initial prompt
      await new Promise<void>((resolve) => {
        pty.onData(() => resolve());
      });

      // Send a command
      pty.write('echo mirror-test\n');

      const output = await new Promise<string>((resolve) => {
        let buffer = '';
        pty.onData((data: string) => {
          buffer += data;
          if (buffer.includes('mirror-test')) {
            resolve(buffer);
          }
        });
      });

      expect(output).toContain('mirror-test');

      cleanup();
      await tmux.killSession('termpilot-test-input');
    });
  });

  describe('getSessionWindows', () => {
    it('should list windows in a session', async () => {
      await tmux.createSession('termpilot-test-windows');
      const windows = await tmux.getSessionWindows('termpilot-test-windows');
      expect(windows.length).toBeGreaterThanOrEqual(1);
      expect(windows[0]).toHaveProperty('index');
      expect(windows[0]).toHaveProperty('name');

      await tmux.killSession('termpilot-test-windows');
    });
  });
});
