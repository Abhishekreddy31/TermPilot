import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

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
}

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // N=2^14
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;

export class AuthService {
  private users = new Map<string, StoredUser>();
  private sessions = new Map<string, InternalSession>();
  private idleTimeoutMs: number;
  private absoluteTimeoutMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: AuthServiceOptions) {
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? 30 * 60 * 1000; // 30 min
    this.absoluteTimeoutMs = opts?.absoluteTimeoutMs ?? 8 * 60 * 60 * 1000; // 8 hours

    // Periodically clean expired sessions
    this.cleanupTimer = setInterval(() => this.cleanExpiredSessions(), 5 * 60 * 1000);
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
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
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });

    return { success: true, token };
  }

  validateSession(token: string): SessionInfo | undefined {
    const session = this.sessions.get(token);
    if (!session) return undefined;

    const now = Date.now();
    if (
      now - session.lastActivity > this.idleTimeoutMs ||
      now - session.createdAt > this.absoluteTimeoutMs
    ) {
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
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  cleanExpiredSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (
        now - session.lastActivity > this.idleTimeoutMs ||
        now - session.createdAt > this.absoluteTimeoutMs
      ) {
        this.sessions.delete(token);
      }
    }
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

export interface RateLimiterOptions {
  maxAttempts: number;
  windowMs: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  private opts: RateLimiterOptions;

  constructor(opts: RateLimiterOptions) {
    this.opts = opts;
  }

  isAllowed(key: string): boolean {
    const now = Date.now();
    const entry = this.entries.get(key);

    if (!entry || now >= entry.resetAt) {
      this.entries.set(key, { count: 1, resetAt: now + this.opts.windowMs });
      return true;
    }

    entry.count++;

    // Clean expired entries opportunistically
    if (this.entries.size > 1000) {
      this.cleanExpired();
    }

    return entry.count <= this.opts.maxAttempts;
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) {
        this.entries.delete(key);
      }
    }
  }
}
