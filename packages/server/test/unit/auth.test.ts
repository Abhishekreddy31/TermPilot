import { describe, it, expect, beforeEach } from 'vitest';
import {
  AuthService,
  RateLimiter,
} from '../../src/auth/auth-service.js';

describe('AuthService', () => {
  let auth: AuthService;

  beforeEach(async () => {
    auth = new AuthService();
    await auth.createUser('admin', 'StrongP@ss123');
  });

  describe('createUser', () => {
    it('should create a user successfully', async () => {
      await auth.createUser('newuser', 'P@ssword1');
      const result = await auth.authenticate('newuser', 'P@ssword1');
      expect(result.success).toBe(true);
    });

    it('should reject duplicate usernames', async () => {
      await expect(auth.createUser('admin', 'other')).rejects.toThrow(
        /already exists/i
      );
    });
  });

  describe('authenticate', () => {
    it('should accept valid credentials', async () => {
      const result = await auth.authenticate('admin', 'StrongP@ss123');
      expect(result.success).toBe(true);
      expect(result.token).toBeTruthy();
    });

    it('should reject invalid password', async () => {
      const result = await auth.authenticate('admin', 'wrong');
      expect(result.success).toBe(false);
      expect(result.token).toBeUndefined();
    });

    it('should reject non-existent user', async () => {
      const result = await auth.authenticate('nobody', 'pass');
      expect(result.success).toBe(false);
    });
  });

  describe('session management', () => {
    it('should validate a valid session token', async () => {
      const { token } = await auth.authenticate('admin', 'StrongP@ss123');
      const session = auth.validateSession(token!);
      expect(session).toBeDefined();
      expect(session!.username).toBe('admin');
    });

    it('should reject an invalid session token', () => {
      const session = auth.validateSession('bogus-token');
      expect(session).toBeUndefined();
    });

    it('should invalidate a session on logout', async () => {
      const { token } = await auth.authenticate('admin', 'StrongP@ss123');
      auth.logout(token!);
      const session = auth.validateSession(token!);
      expect(session).toBeUndefined();
    });

    it('should expire idle sessions', async () => {
      const shortAuth = new AuthService({ idleTimeoutMs: 50, absoluteTimeoutMs: 60_000 });
      await shortAuth.createUser('test', 'pass');
      const { token } = await shortAuth.authenticate('test', 'pass');

      // Wait for idle timeout
      await new Promise((r) => setTimeout(r, 100));
      shortAuth.cleanExpiredSessions();

      const session = shortAuth.validateSession(token!);
      expect(session).toBeUndefined();
    });

    it('should touch session on activity', async () => {
      const { token } = await auth.authenticate('admin', 'StrongP@ss123');
      auth.touchSession(token!);
      const session = auth.validateSession(token!);
      expect(session).toBeDefined();
    });
  });
});

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxAttempts: 3, windowMs: 1000 });
  });

  it('should allow requests under the limit', () => {
    expect(limiter.isAllowed('key1')).toBe(true);
    expect(limiter.isAllowed('key1')).toBe(true);
    expect(limiter.isAllowed('key1')).toBe(true);
  });

  it('should block requests over the limit', () => {
    limiter.isAllowed('key1');
    limiter.isAllowed('key1');
    limiter.isAllowed('key1');
    expect(limiter.isAllowed('key1')).toBe(false);
  });

  it('should track keys independently', () => {
    limiter.isAllowed('key1');
    limiter.isAllowed('key1');
    limiter.isAllowed('key1');
    expect(limiter.isAllowed('key1')).toBe(false);
    expect(limiter.isAllowed('key2')).toBe(true);
  });

  it('should reset after window expires', async () => {
    const shortLimiter = new RateLimiter({ maxAttempts: 1, windowMs: 50 });
    shortLimiter.isAllowed('key1');
    expect(shortLimiter.isAllowed('key1')).toBe(false);

    await new Promise((r) => setTimeout(r, 100));
    expect(shortLimiter.isAllowed('key1')).toBe(true);
  });
});
