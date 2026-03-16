import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PtyManager, Session } from '../../src/terminal/pty-manager.js';

describe('PtyManager', () => {
  let manager: PtyManager;

  beforeEach(() => {
    manager = new PtyManager({ maxSessions: 5, idleTimeoutMs: 60_000, defaultShell: '/bin/bash' });
  });

  afterEach(() => {
    manager.destroyAll();
  });

  describe('createSession', () => {
    it('should create a session and return a valid session object', () => {
      const session = manager.createSession({ cols: 80, rows: 24 });
      expect(session).toBeDefined();
      expect(session.id).toBeTruthy();
      expect(typeof session.id).toBe('string');
      expect(session.alive).toBe(true);
    });

    it('should create sessions with unique IDs', () => {
      const s1 = manager.createSession({ cols: 80, rows: 24 });
      const s2 = manager.createSession({ cols: 80, rows: 24 });
      expect(s1.id).not.toBe(s2.id);
    });

    it('should reject when max sessions reached', () => {
      for (let i = 0; i < 5; i++) {
        manager.createSession({ cols: 80, rows: 24 });
      }
      expect(() => manager.createSession({ cols: 80, rows: 24 })).toThrow(
        /maximum.*sessions/i
      );
    });

    it('should use provided cols and rows', () => {
      const session = manager.createSession({ cols: 120, rows: 40 });
      expect(session.cols).toBe(120);
      expect(session.rows).toBe(40);
    });
  });

  describe('getSession', () => {
    it('should retrieve an existing session by ID', () => {
      const created = manager.createSession({ cols: 80, rows: 24 });
      const retrieved = manager.getSession(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
    });

    it('should return undefined for non-existent session', () => {
      expect(manager.getSession('nonexistent')).toBeUndefined();
    });
  });

  describe('listSessions', () => {
    it('should list all active sessions', () => {
      manager.createSession({ cols: 80, rows: 24 });
      manager.createSession({ cols: 80, rows: 24 });
      const list = manager.listSessions();
      expect(list).toHaveLength(2);
    });

    it('should return empty array when no sessions', () => {
      expect(manager.listSessions()).toHaveLength(0);
    });
  });

  describe('writeToSession', () => {
    it('should write data to an existing session', () => {
      const session = manager.createSession({ cols: 80, rows: 24 });
      expect(() => manager.writeToSession(session.id, 'echo hi\n')).not.toThrow();
    });

    it('should throw when writing to non-existent session', () => {
      expect(() => manager.writeToSession('bad-id', 'test')).toThrow(
        /session not found/i
      );
    });
  });

  describe('resizeSession', () => {
    it('should resize an existing session', () => {
      const session = manager.createSession({ cols: 80, rows: 24 });
      manager.resizeSession(session.id, 120, 40);
      const updated = manager.getSession(session.id);
      expect(updated!.cols).toBe(120);
      expect(updated!.rows).toBe(40);
    });

    it('should throw when resizing non-existent session', () => {
      expect(() => manager.resizeSession('bad-id', 80, 24)).toThrow(
        /session not found/i
      );
    });
  });

  describe('destroySession', () => {
    it('should destroy an existing session', () => {
      const session = manager.createSession({ cols: 80, rows: 24 });
      manager.destroySession(session.id);
      expect(manager.getSession(session.id)).toBeUndefined();
    });

    it('should throw when destroying non-existent session', () => {
      expect(() => manager.destroySession('bad-id')).toThrow(
        /session not found/i
      );
    });

    it('should allow creating new sessions after destroying old ones', () => {
      for (let i = 0; i < 5; i++) {
        manager.createSession({ cols: 80, rows: 24 });
      }
      const sessions = manager.listSessions();
      manager.destroySession(sessions[0].id);
      expect(() => manager.createSession({ cols: 80, rows: 24 })).not.toThrow();
    });
  });

  describe('destroyAll', () => {
    it('should destroy all sessions', () => {
      manager.createSession({ cols: 80, rows: 24 });
      manager.createSession({ cols: 80, rows: 24 });
      manager.destroyAll();
      expect(manager.listSessions()).toHaveLength(0);
    });
  });

  describe('onData callback', () => {
    it('should receive output data from PTY', async () => {
      const session = manager.createSession({ cols: 80, rows: 24 });
      const output = await new Promise<string>((resolve) => {
        manager.onData(session.id, (data) => {
          resolve(data);
        });
        manager.writeToSession(session.id, 'echo hello\n');
      });
      expect(output).toBeTruthy();
    });
  });

  describe('onExit callback', () => {
    it('should fire when PTY process exits', async () => {
      const session = manager.createSession({ cols: 80, rows: 24 });
      const exitInfo = await new Promise<{ exitCode: number; signal?: number }>(
        (resolve) => {
          manager.onExit(session.id, (info) => {
            resolve(info);
          });
          manager.writeToSession(session.id, 'exit\n');
        }
      );
      expect(typeof exitInfo.exitCode).toBe('number');
    });
  });

  describe('output buffer', () => {
    it('should buffer recent output for reconnection replay', async () => {
      const session = manager.createSession({ cols: 80, rows: 24 });

      await new Promise<void>((resolve) => {
        manager.onData(session.id, () => {
          resolve();
        });
        manager.writeToSession(session.id, 'echo buffered\n');
      });

      const buffer = manager.getOutputBuffer(session.id);
      expect(buffer).toBeDefined();
      expect(buffer!.length).toBeGreaterThan(0);
    });
  });
});
