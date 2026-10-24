import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  DEFAULT_TERMINAL_SIZE,
  type ServerMessage,
  type SessionInfo,
  type SessionKind,
  type TmuxSessionInfo,
} from '@termpilot/shared';
import type { ConnectionState, WsClient } from '../services/ws-client.js';
import { NO_MODIFIERS, applyModifiers, hasModifiers, type Modifiers } from '../services/keys.js';
import { TerminalInstance, type TerminalHandle, type TerminalSize } from './TerminalInstance.js';
import { ExtraKeys } from './ExtraKeys.js';
import { VoiceInput } from './VoiceInput.js';

export interface Tab {
  /** Stable identity for the rendered terminal; survives a tmux re-attach that changes sessionId. */
  key: string;
  sessionId: string;
  kind: SessionKind;
  tmuxName?: string;
  label: string;
  /** A tmux tab whose client ended with the previous connection and is being re-attached. */
  reattaching?: boolean;
}

type Mode = 'shell' | 'tmux';

const NOTICE_DURATION_MS = 6_000;
/** tmux's own key for scrolling (enters copy mode with the default bindings). */
const PAGE_KEYS = { [-1]: '\x1b[5~', [1]: '\x1b[6~' } as const;

interface TerminalViewProps {
  wsClient: WsClient;
  onLogout: () => void;
}

/** The real size of a tab's terminal, if it has been laid out. */
function sizeOf(handles: Map<string, TerminalHandle>, tab: Tab): TerminalSize | undefined {
  return handles.get(tab.key)?.size() ?? undefined;
}

function tabFor(session: SessionInfo, shellNumber: number): Tab {
  return {
    key: session.id,
    sessionId: session.id,
    kind: session.kind,
    tmuxName: session.tmuxName,
    label: session.kind === 'tmux' ? `[tmux] ${session.tmuxName}` : `Shell ${shellNumber}`,
  };
}

export function TerminalView({ wsClient, onLogout }: TerminalViewProps) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnectionState>(wsClient.state);
  const [mode, setMode] = useState<Mode>('shell');
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionInfo[]>([]);
  const [tmuxUnavailable, setTmuxUnavailable] = useState<string | null>(null);
  const [showTmuxPicker, setShowTmuxPicker] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [modifiers, setModifiers] = useState<Modifiers>(NO_MODIFIERS);

  // Message handlers need the current tabs synchronously, so the ref is the source of truth.
  const tabsRef = useRef<Tab[]>([]);
  const activeKeyRef = useRef<string | null>(null);
  const handles = useRef(new Map<string, TerminalHandle>());
  const shellCounter = useRef(0);
  const modifiersRef = useRef(modifiers);
  modifiersRef.current = modifiers;

  const commitTabs = useCallback((next: Tab[]) => {
    tabsRef.current = next;
    setTabs(next);
    const active = activeKeyRef.current;
    if (active === null || !next.some((tab) => tab.key === active)) {
      activeKeyRef.current = next[0]?.key ?? null;
      setActiveKey(activeKeyRef.current);
    }
  }, []);

  const activate = useCallback((key: string) => {
    activeKeyRef.current = key;
    setActiveKey(key);
  }, []);

  const attach = useCallback((tab: Tab, size = sizeOf(handles.current, tab)) => {
    wsClient.send({ type: 'attach', sessionId: tab.sessionId, ...(size ? { size } : {}) });
  }, [wsClient]);

  /** Size for a new terminal: what the visible terminal has, since new tabs fill the same area. */
  const newTerminalSize = useCallback((): TerminalSize => {
    const active = tabsRef.current.find((tab) => tab.key === activeKeyRef.current);
    return (active && sizeOf(handles.current, active)) ?? DEFAULT_TERMINAL_SIZE;
  }, []);

  useEffect(() => {
    const nextShellLabel = () => ++shellCounter.current;

    /** After (re)connecting: keep tabs whose sessions survived, add ones we did not know, re-attach tmux. */
    const reconcile = (sessions: SessionInfo[]) => {
      const live = new Map(sessions.map((session) => [session.id, session]));
      const known = new Set(tabsRef.current.map((tab) => tab.sessionId));
      const kept: Tab[] = [];
      const reattach: Tab[] = [];
      for (const tab of tabsRef.current) {
        if (live.has(tab.sessionId)) kept.push(tab);
        else if (tab.kind === 'tmux' && tab.tmuxName) {
          const pending = { ...tab, reattaching: true };
          kept.push(pending);
          reattach.push(pending);
        }
      }
      const added = sessions.filter((session) => !known.has(session.id)).map((session) => tabFor(session, nextShellLabel()));
      const next = [...kept, ...added];
      commitTabs(next);

      // Newly added tabs attach when their terminal mounts (onReady); existing ones attach now.
      for (const tab of kept) if (!tab.reattaching) attach(tab);
      for (const tab of reattach) {
        wsClient.send({ type: 'tmux_attach', sessionName: tab.tmuxName!, ...(sizeOf(handles.current, tab) ?? newTerminalSize()) });
      }
      if (next.length === 0) wsClient.send({ type: 'create', ...newTerminalSize() });
    };

    const onCreated = (session: SessionInfo) => {
      const pending = session.kind === 'tmux'
        ? tabsRef.current.find((tab) => tab.reattaching && tab.tmuxName === session.tmuxName)
        : undefined;
      if (pending) {
        const updated: Tab = { ...pending, sessionId: session.id, reattaching: false };
        commitTabs(tabsRef.current.map((tab) => (tab.key === pending.key ? updated : tab)));
        attach(updated);
        return;
      }
      const tab = tabFor(session, session.kind === 'shell' ? nextShellLabel() : 0);
      commitTabs([...tabsRef.current, tab]);
      activate(tab.key);
      setShowTmuxPicker(false);
    };

    const removeTabs = (predicate: (tab: Tab) => boolean) => {
      const next = tabsRef.current.filter((tab) => !predicate(tab));
      if (next.length !== tabsRef.current.length) commitTabs(next);
    };

    const unsubscribeMessages = wsClient.onMessage((message: ServerMessage) => {
      switch (message.type) {
        case 'session_list':
          reconcile(message.sessions);
          break;
        case 'session_created':
          onCreated(message.session);
          break;
        case 'session_closed':
          removeTabs((tab) => tab.sessionId === message.sessionId);
          break;
        case 'tmux_sessions':
          setTmuxSessions(message.sessions);
          setTmuxUnavailable(message.unavailable ?? null);
          break;
        case 'tmux_created':
        case 'tmux_killed':
          wsClient.send({ type: 'tmux_list' });
          break;
        case 'error': {
          const { tmuxName } = message;
          if (tmuxName) removeTabs((tab) => Boolean(tab.reattaching) && tab.tmuxName === tmuxName);
          // A stale tab racing a reconnect is not worth interrupting the user for.
          const staleSession = message.sessionId !== undefined
            && !tabsRef.current.some((tab) => tab.sessionId === message.sessionId);
          if (!staleSession) setNotice(message.message);
          break;
        }
        default:
          break;
      }
    });

    const onState = (state: ConnectionState) => {
      setConnState(state);
      if (state === 'connected') wsClient.send({ type: 'list' });
    };
    const unsubscribeState = wsClient.onStateChange(onState);
    if (wsClient.state === 'connected') onState('connected');

    return () => {
      unsubscribeMessages();
      unsubscribeState();
    };
  }, [wsClient, commitTabs, activate, attach, newTerminalSize]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null;

  /** Every keystroke, typed or tapped, goes through the armed modifiers exactly once. */
  const sendKeystroke = useCallback((tab: Tab, data: string) => {
    const mods = modifiersRef.current;
    if (hasModifiers(mods)) setModifiers(NO_MODIFIERS);
    wsClient.sendInput(tab.sessionId, applyModifiers(data, mods));
  }, [wsClient]);

  const onExtraKey = useCallback((data: string) => {
    const tab = tabsRef.current.find((t) => t.key === activeKeyRef.current);
    if (tab) sendKeystroke(tab, data);
    if (tab) handles.current.get(tab.key)?.focus();
  }, [sendKeystroke]);

  const onPage = useCallback((direction: -1 | 1) => {
    const tab = tabsRef.current.find((t) => t.key === activeKeyRef.current);
    if (!tab) return;
    if (tab.kind === 'tmux') wsClient.sendInput(tab.sessionId, PAGE_KEYS[direction]);
    else handles.current.get(tab.key)?.scrollPages(direction);
  }, [wsClient]);

  const onVoiceCommand = useCallback((command: string) => {
    const tab = tabsRef.current.find((t) => t.key === activeKeyRef.current);
    if (tab) wsClient.sendInput(tab.sessionId, `${command}\r`);
  }, [wsClient]);

  const openTmuxPicker = useCallback(() => {
    wsClient.send({ type: 'tmux_list' });
    setShowTmuxPicker(true);
  }, [wsClient]);

  const attachTmux = useCallback((name: string) => {
    const existing = tabsRef.current.find((tab) => tab.kind === 'tmux' && tab.tmuxName === name);
    if (existing) {
      activate(existing.key);
      setShowTmuxPicker(false);
      return;
    }
    wsClient.send({ type: 'tmux_attach', sessionName: name, ...newTerminalSize() });
  }, [wsClient, activate, newTerminalSize]);

  const statusClass = connState === 'connected' ? 'connected' : connState === 'connecting' ? 'connecting' : 'disconnected';

  return (
    <div class="terminal-container">
      <div class="header">
        <div class="header-brand">
          <span class={`status-dot ${statusClass}`} role="img" aria-label={`Connection: ${connState}`} />
          <h1>TermPilot</h1>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class={`mode-btn ${mode === 'shell' ? 'mode-active' : ''}`}
            aria-pressed={mode === 'shell'}
            onClick={() => setMode('shell')}
            title="New terminals on this computer"
          >
            Sessions
          </button>
          <button
            type="button"
            class={`mode-btn ${mode === 'tmux' ? 'mode-active' : ''}`}
            aria-pressed={mode === 'tmux'}
            onClick={() => { setMode('tmux'); openTmuxPicker(); }}
            title="Mirror tmux sessions running on this computer"
          >
            Mirror
          </button>
          <button type="button" class="btn btn-ghost btn-danger" onClick={onLogout}>
            Logout
          </button>
        </div>
      </div>

      {connState !== 'connected' && (
        <div class={`connection-banner ${connState === 'connecting' ? 'is-connecting' : 'is-disconnected'}`} role="status">
          {connState === 'connecting' ? 'Reconnecting…' : 'Disconnected from server.'}
          {connState === 'disconnected' && (
            <button type="button" class="banner-action" onClick={() => wsClient.reconnectNow()}>
              Retry now
            </button>
          )}
        </div>
      )}

      {notice && (
        <div class="notice" role="alert">
          <span>{notice}</span>
          <button type="button" class="close-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      {showTmuxPicker && (
        <div class="tmux-picker" role="dialog" aria-label="tmux sessions">
          <div class="tmux-picker-header">
            <span>tmux sessions</span>
            <button type="button" onClick={() => setShowTmuxPicker(false)} class="close-btn" aria-label="Close">×</button>
          </div>
          {tmuxUnavailable ? (
            <div class="tmux-empty">{tmuxUnavailable}</div>
          ) : tmuxSessions.length === 0 ? (
            <div class="tmux-empty">
              No tmux sessions found. Start one on the computer with:
              <code>tmux new -s myproject</code>
            </div>
          ) : (
            <div class="tmux-list">
              {tmuxSessions.map((session) => {
                const open = tabs.some((tab) => tab.kind === 'tmux' && tab.tmuxName === session.name);
                return (
                  <button
                    type="button"
                    key={session.name}
                    class={`tmux-item ${open ? 'attached' : ''}`}
                    onClick={() => attachTmux(session.name)}
                  >
                    <span class="tmux-name">{session.name}</span>
                    <span class="tmux-meta">
                      {session.windows} window{session.windows === 1 ? '' : 's'}
                      {open ? ' (open)' : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <button type="button" class="tmux-refresh" onClick={() => wsClient.send({ type: 'tmux_list' })}>
            Refresh
          </button>
        </div>
      )}

      <div class="session-tabs" role="tablist" aria-label="Terminals">
        {tabs.map((tab) => (
          <div key={tab.key} class={`session-tab ${tab.key === activeKey ? 'active' : ''} ${tab.kind === 'tmux' ? 'mirror-tab' : ''}`}>
            <button
              type="button"
              role="tab"
              class="session-tab-label"
              aria-selected={tab.key === activeKey}
              onClick={() => activate(tab.key)}
            >
              {tab.label}
            </button>
            <button
              type="button"
              class="close-btn"
              aria-label={`Close ${tab.label}`}
              onClick={() => wsClient.send({ type: 'close', sessionId: tab.sessionId })}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          class="new-tab-btn"
          onClick={mode === 'shell' ? () => wsClient.send({ type: 'create', ...newTerminalSize() }) : openTmuxPicker}
          aria-label={mode === 'shell' ? 'New terminal' : 'Attach to a tmux session'}
          title={mode === 'shell' ? 'New terminal' : 'Attach to a tmux session'}
        >
          +
        </button>
      </div>

      <div class="terminal-wrapper">
        {tabs.map((tab) => (
          <div key={tab.key} class="terminal-slot" hidden={tab.key !== activeKey}>
            <TerminalInstance
              ref={(handle: TerminalHandle | null) => {
                if (handle) handles.current.set(tab.key, handle);
                else handles.current.delete(tab.key);
              }}
              sessionId={tab.sessionId}
              wsClient={wsClient}
              visible={tab.key === activeKey}
              onInput={(data) => sendKeystroke(tab, data)}
              onResize={(size) => wsClient.send({ type: 'resize', sessionId: tab.sessionId, ...size })}
              onReady={(size) => {
                const current = tabsRef.current.find((t) => t.key === tab.key);
                if (current && !current.reattaching) attach(current, size ?? undefined);
              }}
            />
          </div>
        ))}
      </div>

      {activeTab && <VoiceInput onCommand={onVoiceCommand} />}
      <ExtraKeys
        modifiers={modifiers}
        onToggleModifier={(name) => setModifiers((current) => ({ ...current, [name]: !current[name] }))}
        onKey={onExtraKey}
        onPage={onPage}
      />
    </div>
  );
}
