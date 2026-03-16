import { z } from 'zod';

export const CreateSessionSchema = z.object({
  cols: z.number().int().min(1).max(500).default(80),
  rows: z.number().int().min(1).max(500).default(24),
});

export const ResizeSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(500),
});

export const InputSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string().max(65536),
});

export const DestroySessionSchema = z.object({
  sessionId: z.string().min(1),
});

export type CreateSessionData = z.infer<typeof CreateSessionSchema>;
export type ResizeData = z.infer<typeof ResizeSchema>;
export type InputData = z.infer<typeof InputSchema>;
export type DestroySessionData = z.infer<typeof DestroySessionSchema>;
