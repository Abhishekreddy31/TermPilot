import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import type { WsClient, ConnectionState, WsMessage } from '../services/ws-client.js';
import { TerminalInstance } from './TerminalInstance.js';
import { ExtraKeys } from './ExtraKeys.js';
import { VoiceInput } from './VoiceInput.js';

type Mode = 'independent' | 'mirror';

interface Session {
  id: string;
  label: string;
  mode: Mode;
}

interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
}

interface TerminalViewProps {
  wsClient: WsClient;
  onLogout: () => void;
}

export function TerminalView({ wsClient, onLogout }: TerminalViewProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnectionState>(wsClient.state);
  const [mode, setMode] = useState<Mode>('independent');
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSession[]>([]);
  const [showTmuxPicker, setShowTmuxPicker] = useState(false);
  const termRef = useRef<{ sendInput: (data: string) => void } | null>(null);
  const sessionCounter = useRef(0);

  useEffect(() => {
    const unsub = wsClient.onStateChange(setConnState);
    return unsub;
  }, [wsClient]);

  useEffect(() => {
    const unsub = wsClient.onMessage((msg: WsMessage) => {
      // Independent mode responses
      if (msg.type === 'session_created') {
        const id = msg.sessionId as string;
        sessionCounter.current++;
        setSessions((prev) => [
          ...prev,
          { id, label: `Shell ${sessionCounter.current}`, mode: 'independent' },
        ]);
        setActiveSessionId(id);
      }

      if (msg.type === 'session_destroyed') {
        const id = msg.sessionId as string;
        setSessions((prev) => {
          const next = prev.filter((s) => s.id !== id);
          return next;
        });
        setActiveSessionId((prev) =>
          prev === id
            ? sessions.find((s) => s.id !== id)?.id ?? null
            : prev
        );
      }

      // Mirror mode responses
      if (msg.type === 'tmux_sessions') {
        setTmuxSessions(msg.sessions as TmuxSession[]);
      }

      if (msg.type === 'tmux_attached') {
        const id = msg.sessionId as string;
        const name = msg.sessionName as string;
        setSessions((prev) => [
          ...prev,
          { id, label: `[tmux] ${name}`, mode: 'mirror' },
        ]);
        setActiveSessionId(id);
        setShowTmuxPicker(false);
      }

      if (msg.type === 'tmux_detached') {
        const id = msg.sessionId as string;
        setSessions((prev) => prev.filter((s) => s.id !== id));
        setActiveSessionId((prev) =>
          prev === id
            ? sessions.find((s) => s.id !== id)?.id ?? null
            : prev
        );
      }

      if (msg.type === 'tmux_created') {
        // Refresh session list
        wsClient.send({ type: 'tmux_list' });
      }

      if (msg.type === 'tmux_killed') {
        wsClient.send({ type: 'tmux_list' });
      }
    });
    return unsub;
  }, [wsClient, sessions]);

  const createSession = useCallback(() => {
    wsClient.send({ type: 'create', cols: 80, rows: 24 });
  }, [wsClient]);

  const destroySession = useCallback(
    (session: Session) => {
      if (session.mode === 'mirror') {
        const name = session.label.replace('[tmux] ', '');
        wsClient.send({ type: 'tmux_detach', sessionName: name });
      } else {
        wsClient.send({ type: 'destroy', sessionId: session.id });
      }
    },
    [wsClient]
  );

  const handleExtraKey = useCallback((data: string) => {
    termRef.current?.sendInput(data);
  }, []);

  const handleVoiceCommand = useCallback(
    (command: string) => {
      if (activeSessionId) {
        wsClient.send({
          type: 'input',
          sessionId: activeSessionId,
          data: command + '\n',
        });
      }
    },
    [wsClient, activeSessionId]
  );

  const openTmuxPicker = useCallback(() => {
    wsClient.send({ type: 'tmux_list' });
    setShowTmuxPicker(true);
  }, [wsClient]);

  const attachTmux = useCallback(
    (name: string) => {
      // Check if already attached
      if (sessions.some((s) => s.id === `tmux:${name}`)) {
        setActiveSessionId(`tmux:${name}`);
        setShowTmuxPicker(false);
        return;
      }
      wsClient.send({ type: 'tmux_attach', sessionName: name, cols: 80, rows: 24 });
    },
    [wsClient, sessions]
  );

  // Create first session on connect (independent mode only)
  useEffect(() => {
    if (connState === 'connected' && sessions.length === 0 && mode === 'independent') {
      createSession();
    }
  }, [connState, sessions.length, createSession, mode]);

  const statusClass =
    connState === 'connected'
      ? 'connected'
      : connState === 'connecting'
        ? 'connecting'
        : 'disconnected';

  return (
    <div class="terminal-container">
      <div class="header">
        <div class="header-brand">
          <span class={`status-dot ${statusClass}`} />
          <h1>TermPilot</h1>
        </div>
        <div class="header-actions">
          <button
            class={`mode-btn ${mode === 'independent' ? 'mode-active' : ''}`}
            onClick={() => setMode('independent')}
            title="Independent sessions"
          >
            Sessions
          </button>
          <button
            class={`mode-btn ${mode === 'mirror' ? 'mode-active' : ''}`}
            onClick={() => { setMode('mirror'); openTmuxPicker(); }}
            title="Mirror existing terminals (tmux)"
          >
            Mirror
          </button>
          <button class="btn btn-ghost btn-danger" onClick={onLogout}>
            Logout
          </button>
        </div>
      </div>

      {/* Tmux session picker overlay */}
      {showTmuxPicker && (
        <div class="tmux-picker">
          <div class="tmux-picker-header">
            <span>tmux Sessions</span>
            <button onClick={() => setShowTmuxPicker(false)} class="close-btn">x</button>
          </div>
          {tmuxSessions.length === 0 ? (
            <div class="tmux-empty">
              No tmux sessions found. Start one with:
              <code>tmux new -s myproject</code>
            </div>
          ) : (
            <div class="tmux-list">
              {tmuxSessions.map((ts) => {
                const isAttached = sessions.some((s) => s.id === `tmux:${ts.name}`);
                return (
                  <button
                    key={ts.name}
                    class={`tmux-item ${isAttached ? 'attached' : ''}`}
                    onClick={() => attachTmux(ts.name)}
                  >
                    <span class="tmux-name">{ts.name}</span>
                    <span class="tmux-meta">
                      {ts.windows} window{ts.windows !== 1 ? 's' : ''}
                      {isAttached ? ' (attached)' : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <button
            class="tmux-refresh"
            onClick={() => wsClient.send({ type: 'tmux_list' })}
          >
            Refresh
          </button>
        </div>
      )}

      <div class="session-tabs">
        {sessions.map((s) => (
          <button
            key={s.id}
            class={`session-tab ${s.id === activeSessionId ? 'active' : ''} ${s.mode === 'mirror' ? 'mirror-tab' : ''}`}
            onClick={() => setActiveSessionId(s.id)}
          >
            {s.label}
            <button
              class="close-btn"
              onClick={(e) => {
                e.stopPropagation();
                destroySession(s);
              }}
            >
              x
            </button>
          </button>
        ))}
        {mode === 'independent' && (
          <button class="new-tab-btn" onClick={createSession} title="New terminal">
            +
          </button>
        )}
        {mode === 'mirror' && (
          <button class="new-tab-btn" onClick={openTmuxPicker} title="Attach to tmux session">
            +
          </button>
        )}
      </div>

      <div class="terminal-wrapper">
        {activeSessionId && (
          <TerminalInstance
            ref={termRef}
            key={activeSessionId}
            sessionId={activeSessionId}
            wsClient={wsClient}
          />
        )}
      </div>

      <VoiceInput onCommand={handleVoiceCommand} />
      <ExtraKeys onKey={handleExtraKey} />
    </div>
  );
}
