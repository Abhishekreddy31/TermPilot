import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

function scryptAsync(password: string, salt: string, keylen: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export interface AuthResult {
  success: boolean;
  token?: string;
  error?: string;
}

export interface SessionInfo {
  username: string;
  createdAt: number;
  lastActivity: number;
}

interface StoredUser {
  username: string;
  passwordHash: string;
  salt: string;
}

interface InternalSession extends SessionInfo {
  token: string;
}

export interface AuthServiceOptions {
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export const DEFAULT_LOGIN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_LOGIN_ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // N=2^14
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;

export class AuthService {
  private users = new Map<string, StoredUser>();
  private sessions = new Map<string, InternalSession>();
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts?: AuthServiceOptions) {
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_LOGIN_IDLE_TIMEOUT_MS;
    this.absoluteTimeoutMs = opts?.absoluteTimeoutMs ?? DEFAULT_LOGIN_ABSOLUTE_TIMEOUT_MS;
    this.now = opts?.now ?? Date.now;
  }

  async createUser(username: string, password: string): Promise<void> {
    if (this.users.has(username)) {
      throw new Error(`User already exists: ${username}`);
    }

    const salt = randomBytes(32).toString('hex');
    const hash = await this.hashPassword(password, salt);

    this.users.set(username, {
      username,
      passwordHash: hash,
      salt,
    });
  }

  async authenticate(username: string, password: string): Promise<AuthResult> {
    const user = this.users.get(username);
    if (!user) {
      // Constant-time: hash anyway to prevent timing attacks
      await this.hashPassword(password, randomBytes(32).toString('hex'));
      return { success: false, error: 'Invalid credentials' };
    }

    const hash = await this.hashPassword(password, user.salt);
    const hashBuffer = Buffer.from(hash, 'hex');
    const storedBuffer = Buffer.from(user.passwordHash, 'hex');

    if (!timingSafeEqual(hashBuffer, storedBuffer)) {
      return { success: false, error: 'Invalid credentials' };
    }

    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, {
      token,
      username,
      createdAt: this.now(),
      lastActivity: this.now(),
    });

    return { success: true, token };
  }

  validateSession(token: string): SessionInfo | undefined {
    const session = this.sessions.get(token);
    if (!session) return undefined;

    if (this.isExpired(session, this.now())) {
      this.sessions.delete(token);
      return undefined;
    }

    return {
      username: session.username,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
    };
  }

  touchSession(token: string): void {
    const session = this.sessions.get(token);
    if (session && !this.isExpired(session, this.now())) {
      session.lastActivity = this.now();
    }
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  cleanExpiredSessions(): void {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (this.isExpired(session, now)) this.sessions.delete(token);
    }
  }

  /** Whether `username` has at least one login that has not expired. */
  hasActiveSession(username: string): boolean {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (session.username === username && !this.isExpired(session, now)) return true;
    }
    return false;
  }

  private isExpired(session: InternalSession, now: number): boolean {
    return now - session.lastActivity > this.idleTimeoutMs || now - session.createdAt > this.absoluteTimeoutMs;
  }

  hasUsers(): boolean {
    return this.users.size > 0;
  }

  private async hashPassword(password: string, salt: string): Promise<string> {
    const buf = (await scryptAsync(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELISM,
    })) as Buffer;
    return buf.toString('hex');
  }
}

/** Expired entries are swept once this many keys are tracked. */
const MAX_TRACKED_KEYS = 1000;

export interface RateLimiterOptions {
  maxFailures: number;
  windowMs: number;
  now?: () => number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Limits failed attempts per key (client address) within a window. An attempt is
 * reserved before it is checked and refunded if it succeeds, so concurrent guesses
 * cannot all slip past the limit while the (deliberately slow) password check runs,
 * and a user who signs in or reconnects successfully is never locked out.
 */
export class RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly opts: RateLimiterOptions;
  private readonly now: () => number;

  constructor(opts: RateLimiterOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  /** Reserve an attempt for `key`. Returns false (reserving nothing) when the key is blocked. */
  tryBegin(key: string): boolean {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.opts.windowMs };
      this.entries.set(key, entry);
    }
    if (entry.count >= this.opts.maxFailures) return false;
    entry.count++;
    if (this.entries.size > MAX_TRACKED_KEYS) this.cleanExpired(now);
    return true;
  }

  /** The reserved attempt succeeded: give it back. A failure keeps it counted. */
  succeeded(key: string): void {
    const entry = this.entries.get(key);
    if (entry && entry.count > 0) entry.count--;
  }

  private cleanExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) this.entries.delete(key);
    }
  }
}
