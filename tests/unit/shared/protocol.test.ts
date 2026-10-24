import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_SIZE, PROTOCOL_VERSION, TERMINAL_LIMITS, TMUX_SESSION_NAME_PATTERN, WS_CLOSE } from '@termpilot/shared';
import {
  ClientMessageSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  describeValidationError,
} from '@termpilot/shared/schemas';

const parse = (value: unknown) => ClientMessageSchema.safeParse(value);

describe('ClientMessageSchema', () => {
  it('accepts every message type the client sends', () => {
    const valid = [
      { type: 'auth', token: 't', protocol: PROTOCOL_VERSION },
      { type: 'create', cols: 100, rows: 30 },
      { type: 'attach', sessionId: 's', size: { cols: 100, rows: 30 } },
      { type: 'attach', sessionId: 's' },
      { type: 'input', sessionId: 's', data: 'ls\r' },
      { type: 'resize', sessionId: 's', cols: 1, rows: 500 },
      { type: 'close', sessionId: 's' },
      { type: 'list' },
      { type: 'tmux_list' },
      { type: 'tmux_attach', sessionName: 'dev_1-a' },
      { type: 'tmux_create', name: 'dev' },
      { type: 'tmux_kill', name: 'dev' },
      { type: 'tmux_windows', sessionName: 'dev' },
    ];
    for (const message of valid) expect(parse(message).success, JSON.stringify(message)).toBe(true);
  });

  it('fills in the default terminal size', () => {
    const create = parse({ type: 'create' });
    expect(create.success && create.data).toEqual({ type: 'create', ...DEFAULT_TERMINAL_SIZE });
    const attach = parse({ type: 'tmux_attach', sessionName: 'x' });
    expect(attach.success && attach.data).toMatchObject(DEFAULT_TERMINAL_SIZE);
  });

  it('rejects unknown types and missing discriminators', () => {
    expect(parse({ type: 'bogus' }).success).toBe(false);
    expect(parse({}).success).toBe(false);
    expect(parse(null).success).toBe(false);
  });

  it('enforces terminal dimension limits', () => {
    for (const cols of [0, TERMINAL_LIMITS.maxDimension + 1, 1.5, '80']) {
      expect(parse({ type: 'resize', sessionId: 's', cols, rows: 24 }).success, String(cols)).toBe(false);
    }
  });

  it('caps input size and requires a session id', () => {
    const max = 'a'.repeat(TERMINAL_LIMITS.maxInputLength);
    expect(parse({ type: 'input', sessionId: 's', data: max }).success).toBe(true);
    expect(parse({ type: 'input', sessionId: 's', data: `${max}a` }).success).toBe(false);
    expect(parse({ type: 'input', sessionId: '', data: 'x' }).success).toBe(false);
  });

  it('requires a numeric protocol version on auth', () => {
    expect(parse({ type: 'auth', token: 't' }).success).toBe(false);
    expect(parse({ type: 'auth', token: '', protocol: 1 }).success).toBe(false);
  });

  it('accepts any session name tmux itself allows', () => {
    for (const name of ['dev', 'my project', 'a;b', '$(id)', 'ünïcode', '-x', '=x']) {
      expect(parse({ type: 'tmux_attach', sessionName: name }).success, name).toBe(true);
    }
  });

  it('rejects names tmux cannot have or that would change the target', () => {
    for (const name of ['', 'a:b', 'a.b', 'line\nbreak', 'tab\t', 'x'.repeat(TERMINAL_LIMITS.maxTmuxNameLength + 1)]) {
      expect(parse({ type: 'tmux_attach', sessionName: name }).success, JSON.stringify(name)).toBe(false);
      expect(TMUX_SESSION_NAME_PATTERN.test(name) && name.length <= TERMINAL_LIMITS.maxTmuxNameLength).toBe(false);
    }
  });
});

describe('login and logout request schemas', () => {
  it('require non-empty string credentials', () => {
    expect(LoginRequestSchema.safeParse({ username: 'a', password: 'b' }).success).toBe(true);
    expect(LoginRequestSchema.safeParse({ username: 'a' }).success).toBe(false);
    expect(LoginRequestSchema.safeParse({ username: 1, password: 'b' }).success).toBe(false);
    expect(LogoutRequestSchema.safeParse({ token: '' }).success).toBe(false);
  });
});

describe('describeValidationError', () => {
  it('names the offending fields', () => {
    const result = parse({ type: 'resize', sessionId: 's', cols: 0, rows: 24 });
    expect(result.success).toBe(false);
    if (!result.success) expect(describeValidationError(result.error)).toMatch(/^cols: /);
  });
});

describe('WS_CLOSE', () => {
  it('uses distinct codes: the standard retry code plus the application range', () => {
    const { tryAgainLater, ...application } = WS_CLOSE;
    const codes = Object.values(WS_CLOSE);
    expect(new Set(codes).size).toBe(codes.length);
    expect(tryAgainLater).toBe(1013);
    for (const code of Object.values(application)) expect(code).toBeGreaterThanOrEqual(4000);
  });
});
