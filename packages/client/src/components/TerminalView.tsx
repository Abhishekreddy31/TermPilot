import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import type { WsClient, ConnectionState, WsMessage } from '../services/ws-client.js';
import { TerminalInstance } from './TerminalInstance.js';
import { ExtraKeys } from './ExtraKeys.js';
import { VoiceInput } from './VoiceInput.js';

interface Session {
  id: string;
  label: string;
}

interface TerminalViewProps {
  wsClient: WsClient;
  onLogout: () => void;
}

export function TerminalView({ wsClient, onLogout }: TerminalViewProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnectionState>(wsClient.state);
  const termRef = useRef<{ sendInput: (data: string) => void } | null>(null);
  const sessionCounter = useRef(0);

  useEffect(() => {
    const unsub = wsClient.onStateChange(setConnState);
    return unsub;
  }, [wsClient]);

  useEffect(() => {
    const unsub = wsClient.onMessage((msg: WsMessage) => {
      if (msg.type === 'session_created') {
        const id = msg.sessionId as string;
        sessionCounter.current++;
        setSessions((prev) => [
          ...prev,
          { id, label: `Shell ${sessionCounter.current}` },
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
          prev === (msg.sessionId as string)
            ? sessions.find((s) => s.id !== (msg.sessionId as string))?.id ?? null
            : prev
        );
      }
    });
    return unsub;
  }, [wsClient, sessions]);

  const createSession = useCallback(() => {
    wsClient.send({ type: 'create', cols: 80, rows: 24 });
  }, [wsClient]);

  const destroySession = useCallback(
    (id: string) => {
      wsClient.send({ type: 'destroy', sessionId: id });
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

  // Create first session on connect
  useEffect(() => {
    if (connState === 'connected' && sessions.length === 0) {
      createSession();
    }
  }, [connState, sessions.length, createSession]);

  const statusClass =
    connState === 'connected'
      ? 'connected'
      : connState === 'connecting'
        ? 'connecting'
        : 'disconnected';

  return (
    <div class="terminal-container">
      <div class="header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span class={`status-dot ${statusClass}`} />
          <h1>TermPilot</h1>
        </div>
        <div class="header-actions">
          <button
            onClick={onLogout}
            style={{
              background: 'none',
              border: '1px solid #555',
              color: '#969696',
              padding: '4px 10px',
              borderRadius: '4px',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Logout
          </button>
        </div>
      </div>

      <div class="session-tabs">
        {sessions.map((s) => (
          <button
            key={s.id}
            class={`session-tab ${s.id === activeSessionId ? 'active' : ''}`}
            onClick={() => setActiveSessionId(s.id)}
          >
            {s.label}
            <button
              class="close-btn"
              onClick={(e) => {
                e.stopPropagation();
                destroySession(s.id);
              }}
            >
              x
            </button>
          </button>
        ))}
        <button class="new-tab-btn" onClick={createSession} title="New terminal">
          +
        </button>
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
