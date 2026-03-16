import { describe, it, expect } from 'vitest';
import {
  CreateSessionSchema,
  ResizeSchema,
  InputSchema,
  DestroySessionSchema,
} from '../src/schemas.js';

describe('CreateSessionSchema', () => {
  it('should accept valid create session data', () => {
    const result = CreateSessionSchema.safeParse({ cols: 80, rows: 24 });
    expect(result.success).toBe(true);
  });

  it('should use defaults when cols/rows omitted', () => {
    const result = CreateSessionSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cols).toBe(80);
      expect(result.data.rows).toBe(24);
    }
  });

  it('should reject cols out of range', () => {
    expect(CreateSessionSchema.safeParse({ cols: 0 }).success).toBe(false);
    expect(CreateSessionSchema.safeParse({ cols: 501 }).success).toBe(false);
  });

  it('should reject rows out of range', () => {
    expect(CreateSessionSchema.safeParse({ rows: 0 }).success).toBe(false);
    expect(CreateSessionSchema.safeParse({ rows: 501 }).success).toBe(false);
  });
});

describe('ResizeSchema', () => {
  it('should accept valid resize data', () => {
    const result = ResizeSchema.safeParse({
      sessionId: 'sess-1',
      cols: 120,
      rows: 40,
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing sessionId', () => {
    const result = ResizeSchema.safeParse({ cols: 120, rows: 40 });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer dimensions', () => {
    expect(
      ResizeSchema.safeParse({ sessionId: 's', cols: 12.5, rows: 40 }).success
    ).toBe(false);
  });
});

describe('InputSchema', () => {
  it('should accept valid input data', () => {
    const result = InputSchema.safeParse({
      sessionId: 'sess-1',
      data: 'ls\n',
    });
    expect(result.success).toBe(true);
  });

  it('should reject data exceeding max length', () => {
    const result = InputSchema.safeParse({
      sessionId: 'sess-1',
      data: 'x'.repeat(65537),
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty sessionId', () => {
    const result = InputSchema.safeParse({ sessionId: '', data: 'ls' });
    expect(result.success).toBe(false);
  });
});

describe('DestroySessionSchema', () => {
  it('should accept valid destroy data', () => {
    const result = DestroySessionSchema.safeParse({ sessionId: 'sess-1' });
    expect(result.success).toBe(true);
  });

  it('should reject missing sessionId', () => {
    const result = DestroySessionSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
