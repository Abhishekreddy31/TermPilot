/**
 * WebSocket protocol shared by the server and the PWA client.
 *
 * Every frame is a JSON text message with a `type` discriminator. This module has
 * no runtime dependencies so the browser bundle stays small; the server validates
 * client messages with the Zod schemas in `@termpilot/shared/schemas`.
 *
 * Bump {@link PROTOCOL_VERSION} whenever a change is not backwards compatible, so
 * a client cached by the service worker can detect that it must reload.
 */
export const PROTOCOL_VERSION = 2;

export const TERMINAL_LIMITS = {
  minDimension: 1,
  maxDimension: 500,
  maxInputLength: 64 * 1024,
  maxIdLength: 128,
  maxTokenLength: 256,
  maxTmuxNameLength: 100,
} as const;

export const DEFAULT_TERMINAL_SIZE = { cols: 80, rows: 24 } as const;

/**
 * A tmux session name as tmux allows it: anything except control characters, and not
 * `:` or `.` (tmux reserves them for window/pane targets). Names are passed as argv,
 * never through a shell, and targeted with tmux's exact-match `=` prefix.
 */
export const TMUX_SESSION_NAME_PATTERN = /^[^\x00-\x1f\x7f:.]+$/;

export interface TerminalSize {
  cols: number;
  rows: number;
}

interface TerminalSizeFields {
  /** Defaults to {@link DEFAULT_TERMINAL_SIZE} when omitted. */
  cols?: number;
  rows?: number;
}

/** Messages the client sends. Validated on the server by `ClientMessageSchema`. */
export type ClientMessage =
  | { type: 'auth'; token: string; protocol: number }
  | ({ type: 'create' } & TerminalSizeFields)
  /** `size` is the client's real terminal size; omit it when unknown (e.g. a hidden tab) to keep the session's. */
  | { type: 'attach'; sessionId: string; size?: TerminalSize }
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'close'; sessionId: string }
  | { type: 'list' }
  | { type: 'tmux_list' }
  | ({ type: 'tmux_attach'; sessionName: string } & TerminalSizeFields)
  | { type: 'tmux_create'; name: string }
  | { type: 'tmux_kill'; name: string }
  | { type: 'tmux_windows'; sessionName: string };

export type ClientMessageType = ClientMessage['type'];

/** `shell`: a PTY owned by the logged-in user that survives reconnects. `tmux`: a client attached to an existing tmux session for one connection. */
export type SessionKind = 'shell' | 'tmux';

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  /** tmux session name, present when kind === 'tmux'. */
  tmuxName?: string;
  cols: number;
  rows: number;
  createdAt: number;
}

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  /** ISO 8601 creation time. */
  created: string;
  attached: boolean;
}

export interface TmuxWindowInfo {
  index: number;
  name: string;
  active: boolean;
}

/** Why a session tab went away. */
export type SessionCloseReason = 'exited' | 'closed' | 'expired';

export type AuthFailureReason = 'invalid_token' | 'protocol_mismatch' | 'rate_limited';

export type ServerMessage =
  | { type: 'auth_ok'; username: string; protocol: number }
  | { type: 'auth_failed'; reason: AuthFailureReason; message: string }
  | { type: 'error'; message: string; sessionId?: string; tmuxName?: string }
  | { type: 'session_created'; session: SessionInfo }
  /** `replay` is recent output, produced at `cols` × `rows`; render it at that size. */
  | { type: 'session_attached'; sessionId: string; replay: string; cols: number; rows: number }
  | { type: 'session_list'; sessions: SessionInfo[] }
  | { type: 'output'; sessionId: string; data: string }
  | { type: 'session_closed'; sessionId: string; reason: SessionCloseReason; exitCode?: number }
  | { type: 'tmux_sessions'; sessions: TmuxSessionInfo[]; unavailable?: string }
  | { type: 'tmux_created'; name: string }
  | { type: 'tmux_killed'; name: string }
  | { type: 'tmux_windows'; sessionName: string; windows: TmuxWindowInfo[] };

export type ServerMessageType = ServerMessage['type'];

/** WebSocket close codes: the standard 1013 plus application codes in the 4000–4999 range. */
export const WS_CLOSE = {
  /** Standard "Try Again Later": the server is at capacity; clients retry with backoff. */
  tryAgainLater: 1013,
  authTimeout: 4408,
  unauthorized: 4401,
  rateLimited: 4429,
  protocolMismatch: 4426,
  sessionExpired: 4440,
} as const;
