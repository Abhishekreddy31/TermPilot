import { z } from 'zod';
import { DEFAULT_TERMINAL_SIZE, TERMINAL_LIMITS, TMUX_SESSION_NAME_PATTERN, type ClientMessage } from './protocol.js';

const dimension = z.number().int().min(TERMINAL_LIMITS.minDimension).max(TERMINAL_LIMITS.maxDimension);
const sessionId = z.string().min(1).max(TERMINAL_LIMITS.maxIdLength);
export const TmuxSessionNameSchema = z
  .string()
  .min(1)
  .max(TERMINAL_LIMITS.maxTmuxNameLength)
  .regex(TMUX_SESSION_NAME_PATTERN, 'tmux session names cannot contain control characters, ":" or "."');

const size = {
  cols: dimension.default(DEFAULT_TERMINAL_SIZE.cols),
  rows: dimension.default(DEFAULT_TERMINAL_SIZE.rows),
};

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auth'),
    token: z.string().min(1).max(TERMINAL_LIMITS.maxTokenLength),
    protocol: z.number().int(),
  }),
  z.object({ type: z.literal('create'), ...size }),
  z.object({ type: z.literal('attach'), sessionId, size: z.object({ cols: dimension, rows: dimension }).optional() }),
  z.object({ type: z.literal('input'), sessionId, data: z.string().max(TERMINAL_LIMITS.maxInputLength) }),
  z.object({ type: z.literal('resize'), sessionId, cols: dimension, rows: dimension }),
  z.object({ type: z.literal('close'), sessionId }),
  z.object({ type: z.literal('list') }),
  z.object({ type: z.literal('tmux_list') }),
  z.object({ type: z.literal('tmux_attach'), sessionName: TmuxSessionNameSchema, ...size }),
  z.object({ type: z.literal('tmux_create'), name: TmuxSessionNameSchema }),
  z.object({ type: z.literal('tmux_kill'), name: TmuxSessionNameSchema }),
  z.object({ type: z.literal('tmux_windows'), sessionName: TmuxSessionNameSchema }),
]);

export type ParsedClientMessage = z.output<typeof ClientMessageSchema>;

export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
});

export const LogoutRequestSchema = z.object({
  token: z.string().min(1).max(TERMINAL_LIMITS.maxTokenLength),
});

// Compile-time guarantee that the schema and the protocol's ClientMessage describe the same messages:
// each must be assignable to the other, so adding a message or field to only one fails the build.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesProtocol: MutuallyAssignable<z.input<typeof ClientMessageSchema>, ClientMessage> = true;
void schemaMatchesProtocol;

/** Format Zod issues as a single readable line for error replies. */
export function describeValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}
