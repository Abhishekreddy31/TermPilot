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

// Tmux session name: alphanumeric, dash, underscore only
const tmuxSessionName = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Only alphanumeric, dash, underscore allowed');

export const TmuxAttachSchema = z.object({
  sessionName: tmuxSessionName,
  cols: z.number().int().min(1).max(500).default(80),
  rows: z.number().int().min(1).max(500).default(24),
});

export const TmuxDetachSchema = z.object({
  sessionName: tmuxSessionName,
});

export const TmuxCreateSchema = z.object({
  name: tmuxSessionName,
});

export const TmuxKillSchema = z.object({
  name: tmuxSessionName,
});

export const TmuxWindowsSchema = z.object({
  sessionName: tmuxSessionName,
});

export type TmuxAttachData = z.infer<typeof TmuxAttachSchema>;
export type TmuxDetachData = z.infer<typeof TmuxDetachSchema>;
export type TmuxCreateData = z.infer<typeof TmuxCreateSchema>;
export type TmuxKillData = z.infer<typeof TmuxKillSchema>;
export type TmuxWindowsData = z.infer<typeof TmuxWindowsSchema>;
