import type { ParsedClientMessage } from '@termpilot/shared/schemas';
import type { SessionRegistry } from '../terminal/session-registry.js';
import type { TmuxManager } from '../terminal/tmux-manager.js';
import type { SpawnSpec } from '../terminal/pty-manager.js';
import type { ClientConnection } from './client-connection.js';

export interface MessageHandlerDependencies {
  sessions: SessionRegistry;
  tmux: TmuxManager;
  shellSpec: () => SpawnSpec;
}

type AuthenticatedMessage = Exclude<ParsedClientMessage, { type: 'auth' }>;

/**
 * Executes one validated message from an authenticated connection. Failures are
 * reported back to that connection as `error` messages; they never throw.
 */
export async function handleMessage(
  conn: ClientConnection,
  message: AuthenticatedMessage,
  deps: MessageHandlerDependencies,
): Promise<void> {
  // Messages run in order, so one may be dequeued after its connection closed (e.g. behind
  // a slow tmux call). Acting on it would create sessions nobody can receive or clean up.
  if (!conn.open) return;
  const owner = conn.username!;
  const { sessions, tmux } = deps;

  try {
    switch (message.type) {
      case 'create': {
        const session = sessions.create(
          { owner, kind: 'shell', spec: deps.shellSpec(), size: message },
          conn,
        );
        conn.send({ type: 'session_created', session });
        return;
      }
      case 'attach': {
        const { replay, size } = sessions.attach(message.sessionId, owner, conn, message.size);
        conn.send({ type: 'session_attached', sessionId: message.sessionId, replay, cols: size.cols, rows: size.rows });
        return;
      }
      case 'input':
        sessions.write(message.sessionId, owner, conn, message.data);
        return;
      case 'resize':
        sessions.resize(message.sessionId, owner, conn, message);
        return;
      case 'close':
        sessions.close(message.sessionId, owner, conn);
        return;
      case 'list':
        conn.send({ type: 'session_list', sessions: sessions.list(owner, conn) });
        return;
      case 'tmux_list': {
        if (!(await tmux.isAvailable())) {
          conn.send({ type: 'tmux_sessions', sessions: [], unavailable: tmux.unavailableMessage() });
          return;
        }
        conn.send({ type: 'tmux_sessions', sessions: await tmux.listSessions() });
        return;
      }
      case 'tmux_attach': {
        const name = message.sessionName;
        if (!(await tmux.hasSession(name))) {
          conn.send({ type: 'error', message: `tmux session "${name}" not found`, tmuxName: name });
          return;
        }
        // The connection may have closed while tmux answered; a client attached for
        // it now would never be cleaned up.
        if (!conn.open) return;
        const session = sessions.create(
          { owner, kind: 'tmux', tmuxName: name, spec: tmux.attachSpec(name), size: message },
          conn,
        );
        conn.send({ type: 'session_created', session });
        return;
      }
      case 'tmux_create':
        await tmux.createSession(message.name);
        conn.send({ type: 'tmux_created', name: message.name });
        return;
      case 'tmux_kill':
        // An authenticated user already has a full shell as this OS user and could
        // run `tmux kill-session` there, so any of their tmux sessions may be killed.
        // Attached tmux clients (here and elsewhere) exit with the session and their
        // tabs receive `session_closed`.
        await tmux.killSession(message.name);
        conn.send({ type: 'tmux_killed', name: message.name });
        return;
      case 'tmux_windows':
        conn.send({
          type: 'tmux_windows',
          sessionName: message.sessionName,
          windows: await tmux.listWindows(message.sessionName),
        });
        return;
      default: {
        const unreachable: never = message;
        throw new Error(`Unhandled message: ${JSON.stringify(unreachable)}`);
      }
    }
  } catch (err) {
    conn.send({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      ...('sessionId' in message ? { sessionId: message.sessionId } : {}),
      ...(message.type === 'tmux_attach' ? { tmuxName: message.sessionName } : {}),
    });
  }
}
