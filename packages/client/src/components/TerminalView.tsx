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
  tmuxName?: string;
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
  const termRef = useRef<{ sendInput: (data: string) => void; scrollUp: () => void; scrollDown: () => void } | null>(null);
  const sessionCounter = useRef(0);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    const unsub = wsClient.onStateChange((state) => {
      setConnState(state);
      // On reconnect, clear stale sessions and create fresh one
      if (state === 'connected') {
        setSessions([]);
        setActiveSessionId(null);
        sessionCounter.current = 0;
        wsClient.send({ type: 'create', cols: 80, rows: 24 });
      }
    });
    return unsub;
  }, [wsClient]);

  // Message handler — no sessions dependency to avoid listener churn
  useEffect(() => {
    const unsub = wsClient.onMessage((msg: WsMessage) => {
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
          // Fix active session using the filtered list, not stale closure
          setActiveSessionId((prevActive) =>
            prevActive === id ? (next[0]?.id ?? null) : prevActive
          );
          return next;
        });
      }

      if (msg.type === 'tmux_sessions') {
        setTmuxSessions(msg.sessions as TmuxSession[]);
      }

      if (msg.type === 'tmux_attached') {
        const id = msg.sessionId as string;
        const name = msg.sessionName as string;
        setSessions((prev) => [
          ...prev,
          { id, label: `[tmux] ${name}`, mode: 'mirror', tmuxName: name },
        ]);
        setActiveSessionId(id);
        setShowTmuxPicker(false);
      }

      if (msg.type === 'tmux_detached') {
        const id = msg.sessionId as string;
        setSessions((prev) => {
          const next = prev.filter((s) => s.id !== id);
          setActiveSessionId((prevActive) =>
            prevActive === id ? (next[0]?.id ?? null) : prevActive
          );
          return next;
        });
      }

      if (msg.type === 'tmux_created' || msg.type === 'tmux_killed') {
        wsClient.send({ type: 'tmux_list' });
      }
    });
    return unsub;
  }, [wsClient]);

  const createSession = useCallback(() => {
    wsClient.send({ type: 'create', cols: 80, rows: 24 });
  }, [wsClient]);

  const destroySession = useCallback(
    (session: Session) => {
      if (session.mode === 'mirror' && session.tmuxName) {
        wsClient.send({ type: 'tmux_detach', sessionName: session.tmuxName });
      } else {
        wsClient.send({ type: 'destroy', sessionId: session.id });
      }
    },
    [wsClient]
  );

  const handleExtraKey = useCallback((data: string) => {
    termRef.current?.sendInput(data);
  }, []);

  const handleScrollUp = useCallback(() => {
    termRef.current?.scrollUp();
  }, []);

  const handleScrollDown = useCallback(() => {
    termRef.current?.scrollDown();
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
      const current = sessionsRef.current;
      if (current.some((s) => s.id === `tmux:${name}`)) {
        setActiveSessionId(`tmux:${name}`);
        setShowTmuxPicker(false);
        return;
      }
      wsClient.send({ type: 'tmux_attach', sessionName: name, cols: 80, rows: 24 });
    },
    [wsClient]
  );

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

      {/* Disconnect banner */}
      {connState !== 'connected' && (
        <div style={{
          padding: '8px 16px',
          background: connState === 'connecting' ? '#2d2a1b' : '#2d1b1b',
          color: connState === 'connecting' ? '#d29922' : '#f85149',
          fontSize: '13px',
          textAlign: 'center',
          flexShrink: 0,
          borderBottom: '1px solid var(--border-default)',
        }}>
          {connState === 'connecting' ? 'Reconnecting...' : 'Disconnected from server'}
        </div>
      )}

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
      <ExtraKeys onKey={handleExtraKey} onScrollUp={handleScrollUp} onScrollDown={handleScrollDown} />
    </div>
  );
}
