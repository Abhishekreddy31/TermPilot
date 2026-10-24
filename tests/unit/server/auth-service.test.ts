import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService, RateLimiter } from '../../../packages/server/src/auth/auth-service.js';

const MINUTE = 60_000;

describe('AuthService', () => {
  let now: number;
  let auth: AuthService;

  beforeEach(async () => {
    now = 1_000_000;
    auth = new AuthService({ idleTimeoutMs: 30 * MINUTE, absoluteTimeoutMs: 8 * 60 * MINUTE, now: () => now });
    await auth.createUser('alice', 'secret-pass');
  });

  it('rejects duplicate users', async () => {
    await expect(auth.createUser('alice', 'x')).rejects.toThrow(/already exists/);
    expect(auth.hasUsers()).toBe(true);
  });

  it('issues a 256-bit token for valid credentials', async () => {
    const result = await auth.authenticate('alice', 'secret-pass');
    expect(result.success).toBe(true);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.validateSession(result.token!)).toMatchObject({ username: 'alice' });
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    expect(await auth.authenticate('alice', 'wrong')).toEqual({ success: false, error: 'Invalid credentials' });
    expect(await auth.authenticate('mallory', 'secret-pass')).toEqual({ success: false, error: 'Invalid credentials' });
  });

  it('issues distinct tokens per login', async () => {
    const a = await auth.authenticate('alice', 'secret-pass');
    const b = await auth.authenticate('alice', 'secret-pass');
    expect(a.token).not.toBe(b.token);
  });

  it('expires idle logins and keeps active ones alive', async () => {
    const { token } = await auth.authenticate('alice', 'secret-pass');
    now += 29 * MINUTE;
    auth.touchSession(token!);
    now += 29 * MINUTE;
    expect(auth.validateSession(token!)).toBeDefined();
    now += 31 * MINUTE;
    expect(auth.validateSession(token!)).toBeUndefined();
  });

  it('enforces the absolute lifetime even with activity', async () => {
    const { token } = await auth.authenticate('alice', 'secret-pass');
    for (let i = 0; i < 17; i++) {
      now += 29 * MINUTE;
      auth.touchSession(token!);
    }
    expect(auth.validateSession(token!)).toBeUndefined();
  });

  it('does not revive an expired login when touched', async () => {
    const { token } = await auth.authenticate('alice', 'secret-pass');
    now += 31 * MINUTE;
    auth.touchSession(token!);
    expect(auth.validateSession(token!)).toBeUndefined();
  });

  it('ends a login on logout', async () => {
    const { token } = await auth.authenticate('alice', 'secret-pass');
    auth.logout(token!);
    expect(auth.validateSession(token!)).toBeUndefined();
  });

  it('knows whether a user has any valid login left', async () => {
    expect(auth.hasActiveSession('alice')).toBe(false);
    const first = await auth.authenticate('alice', 'secret-pass');
    now += 20 * MINUTE;
    const second = await auth.authenticate('alice', 'secret-pass');
    expect(auth.hasActiveSession('alice')).toBe(true);
    auth.logout(second.token!);
    expect(auth.hasActiveSession('alice')).toBe(true);
    now += 11 * MINUTE; // first is now idle for 31 minutes
    expect(auth.hasActiveSession('alice')).toBe(false);
    expect(auth.validateSession(first.token!)).toBeUndefined();
  });

  it('removes expired logins in bulk', async () => {
    const { token } = await auth.authenticate('alice', 'secret-pass');
    now += 31 * MINUTE;
    auth.cleanExpiredSessions();
    now -= 31 * MINUTE; // even if the clock went back, the entry is gone
    expect(auth.validateSession(token!)).toBeUndefined();
  });
});

describe('RateLimiter', () => {
  it('blocks a key after the allowed number of failures within the window', () => {
    let now = 0;
    const limiter = new RateLimiter({ maxFailures: 3, windowMs: 1000, now: () => now });
    expect([1, 2, 3, 4].map(() => limiter.tryBegin('a'))).toEqual([true, true, true, false]);
    expect(limiter.tryBegin('b')).toBe(true);
    now = 1000;
    expect(limiter.tryBegin('a')).toBe(true);
  });

  it('counts attempts still in progress, so concurrent guesses cannot exceed the limit', () => {
    const limiter = new RateLimiter({ maxFailures: 5, windowMs: 1000 });
    const started = Array.from({ length: 50 }, () => limiter.tryBegin('attacker'));
    expect(started.filter(Boolean)).toHaveLength(5);
  });

  it('refunds successful attempts, so valid sign-ins never lock a user out', () => {
    const limiter = new RateLimiter({ maxFailures: 1, windowMs: 1000 });
    for (let i = 0; i < 100; i++) {
      expect(limiter.tryBegin('phone')).toBe(true);
      limiter.succeeded('phone');
    }
  });
});
