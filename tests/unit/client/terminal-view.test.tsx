import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'preact/compat';
import { PROTOCOL_VERSION, type ServerMessage, type SessionInfo } from '@termpilot/shared';
import { WsClient } from '../../../packages/client/src/services/ws-client.js';
import { FakeWebSocket } from '../../helpers/fake-websocket.js';

interface StubProps {
  sessionId: string;
  onInput: (data: string) => void;
  onReady: (size: { cols: number; rows: number } | null) => void;
}

/** Stand-in for the xterm.js terminal: records instances so tests can type into them. */
const terminals = new Map<string, StubProps>();
/** Sessions whose stub terminal behaves as if it has no layout yet (hidden tab). */
const unlaidOut = new Set<string>();

vi.mock('../../../packages/client/src/components/TerminalInstance.js', () => ({
  TerminalInstance: forwardRef<unknown, StubProps>((props, ref) => {
    terminals.set(props.sessionId, props);
    const laidOut = !unlaidOut.has(props.sessionId);
    useImperativeHandle(ref, () => ({ size: () => (laidOut ? { cols: 100, rows: 30 } : null), scrollPages: vi.fn(), focus: vi.fn() }));
    // Like the real terminal: report readiness once, after mounting.
    const ready = useRef(() => props.onReady(laidOut ? { cols: 100, rows: 30 } : null));
    useEffect(() => ready.current(), []);
    return <div data-testid={`terminal-${props.sessionId}`} />;
  }),
}));

const { TerminalView } = await import('../../../packages/client/src/components/TerminalView.js');

const shell = (id: string, createdAt = 1): SessionInfo => ({ id, kind: 'shell', cols: 80, rows: 24, createdAt });
const tmuxSession = (id: string, name: string): SessionInfo => ({ id, kind: 'tmux', tmuxName: name, cols: 80, rows: 24, createdAt: 2 });

function setup() {
  const client = new WsClient('tok', { url: 'ws://test/ws', reconnect: { initialDelayMs: 10, maxDelayMs: 10 } });
  client.connect();
  render(<TerminalView wsClient={client} onLogout={vi.fn()} />);
  const connect = () => {
    const ws = FakeWebSocket.latest;
    act(() => {
      ws.open();
      ws.receive({ type: 'auth_ok', username: 'u', protocol: PROTOCOL_VERSION });
    });
    return ws;
  };
  const receive = (ws: FakeWebSocket, message: ServerMessage) => act(() => ws.receive(message));
  return { client, connect, receive };
}

describe('TerminalView', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    terminals.clear();
    unlaidOut.clear();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('isSecureContext', false);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('asks for existing sessions on connect and creates a shell when there are none', () => {
    const { connect, receive } = setup();
    const ws = connect();
    expect(ws.sentOfType('list')).toHaveLength(1);
    receive(ws, { type: 'session_list', sessions: [] });
    expect(ws.sentOfType('create')).toHaveLength(1);
  });

  it('opens a tab for a created shell and attaches with the fitted size', () => {
    const { connect, receive } = setup();
    const ws = connect();
    receive(ws, { type: 'session_list', sessions: [] });
    receive(ws, { type: 'session_created', session: shell('s1') });
    expect(screen.getByRole('tab', { name: 'Shell 1' }).getAttribute('aria-selected')).toBe('true');
    expect(ws.sentOfType('attach')).toEqual([{ type: 'attach', sessionId: 's1', size: { cols: 100, rows: 30 } }]);
  });

  it('restores shells that survived a reload instead of creating new ones', () => {
    const { connect, receive } = setup();
    const ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('a', 1), shell('b', 2)] });
    expect(ws.sentOfType('create')).toHaveLength(0);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Shell 1', 'Shell 2']);
    expect(ws.sentOfType('attach').map((m) => m.sessionId)).toEqual(['a', 'b']);
  });

  it('keeps tabs across a reconnect and re-attaches them for a redraw', async () => {
    const { connect, receive } = setup();
    let ws = connect();
    receive(ws, { type: 'session_list', sessions: [] });
    receive(ws, { type: 'session_created', session: shell('s1') });

    act(() => ws.drop(1006));
    expect(screen.getByRole('status').textContent).toContain('Disconnected');
    await act(() => new Promise((r) => setTimeout(r, 20)));
    ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('s1')] });

    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(ws.sentOfType('attach')).toEqual([{ type: 'attach', sessionId: 's1', size: { cols: 100, rows: 30 } }]);
    expect(ws.sentOfType('create')).toHaveLength(0);
  });

  it('drops tabs whose shells are gone after a reconnect', async () => {
    const { connect, receive } = setup();
    let ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('a', 1), shell('b', 2)] });
    act(() => ws.drop(1006));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('b', 2)] });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Shell 2']);
  });

  it('re-attaches tmux tabs after a reconnect and keeps the same tab', async () => {
    const { connect, receive } = setup();
    let ws = connect();
    receive(ws, { type: 'session_list', sessions: [] });
    receive(ws, { type: 'session_created', session: tmuxSession('m1', 'dev') });
    act(() => ws.drop(1006));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    ws = connect();
    receive(ws, { type: 'session_list', sessions: [] });

    expect(ws.sentOfType('tmux_attach')).toEqual([{ type: 'tmux_attach', sessionName: 'dev', cols: 100, rows: 30 }]);
    expect(ws.sentOfType('create')).toHaveLength(0);
    receive(ws, { type: 'session_created', session: tmuxSession('m2', 'dev') });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['[tmux] dev']);
    expect(ws.sentOfType('attach')).toEqual([{ type: 'attach', sessionId: 'm2', size: { cols: 100, rows: 30 } }]);
  });

  it('drops a tmux tab whose session no longer exists', async () => {
    const { connect, receive } = setup();
    let ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('s')] });
    receive(ws, { type: 'session_created', session: tmuxSession('m1', 'gone') });
    act(() => ws.drop(1006));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('s')] });
    receive(ws, { type: 'error', message: 'tmux session "gone" not found', tmuxName: 'gone' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Shell 1']);
    expect(screen.getByRole('alert').textContent).toContain('not found');
  });

  it('applies an armed Ctrl to the next key typed on the phone keyboard (Ctrl+C)', () => {
    const { connect, receive } = setup();
    const ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('s1')] });

    fireEvent.click(screen.getByRole('button', { name: 'Ctrl modifier' }));
    expect(screen.getByRole('button', { name: 'Ctrl modifier' }).getAttribute('aria-pressed')).toBe('true');
    act(() => terminals.get('s1')!.onInput('c'));
    act(() => terminals.get('s1')!.onInput('c'));

    expect(ws.sentOfType('input').map((m) => m.data)).toEqual(['\x03', 'c']);
    expect(screen.getByRole('button', { name: 'Ctrl modifier' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('applies armed modifiers to extra-bar keys too', () => {
    const { connect, receive } = setup();
    const ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('s1')] });
    fireEvent.click(screen.getByRole('button', { name: 'Alt modifier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Left arrow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Escape' }));
    expect(ws.sentOfType('input').map((m) => m.data)).toEqual(['\x1b[1;3D', '\x1b']);
  });

  it('closes a tab through the server and removes it when the server confirms', () => {
    const { connect, receive } = setup();
    const ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('a', 1), shell('b', 2)] });
    fireEvent.click(screen.getByRole('button', { name: 'Close Shell 1' }));
    expect(ws.sentOfType('close')).toEqual([{ type: 'close', sessionId: 'a' }]);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    receive(ws, { type: 'session_closed', sessionId: 'a', reason: 'closed' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Shell 2']);
    expect(screen.getByRole('tab', { name: 'Shell 2' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows server errors to the user', () => {
    const { connect, receive } = setup();
    const ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('s')] });
    receive(ws, { type: 'error', message: 'Maximum of 20 terminals reached. Close one first.' });
    expect(screen.getByRole('alert').textContent).toContain('Maximum of 20 terminals');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists tmux sessions in mirror mode and attaches on selection', () => {
    const { connect, receive } = setup();
    const ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('s')] });
    fireEvent.click(screen.getByRole('button', { name: 'Mirror' }));
    expect(ws.sentOfType('tmux_list')).toHaveLength(1);
    receive(ws, { type: 'tmux_sessions', sessions: [{ name: 'dev', windows: 2, created: 'now', attached: true }] });
    fireEvent.click(screen.getByRole('button', { name: /dev/ }));
    // New terminals are created at the size of the visible one.
    expect(ws.sentOfType('tmux_attach')).toEqual([{ type: 'tmux_attach', sessionName: 'dev', cols: 100, rows: 30 }]);
  });

  it('creates new shells at the visible terminal\'s size', () => {
    const { connect, receive } = setup();
    const ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('s1')] });
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(ws.sentOfType('create')).toEqual([{ type: 'create', cols: 100, rows: 30 }]);
  });

  it('attaches without a size when the terminal is not laid out yet (keeps the session\'s size)', () => {
    unlaidOut.add('hidden');
    const { connect, receive } = setup();
    const ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('hidden')] });
    expect(ws.sentOfType('attach')).toEqual([{ type: 'attach', sessionId: 'hidden' }]);
  });

  it('explains when tmux is unavailable', () => {
    const { connect, receive } = setup();
    const ws = connect();
    receive(ws, { type: 'session_list', sessions: [shell('s')] });
    fireEvent.click(screen.getByRole('button', { name: 'Mirror' }));
    receive(ws, { type: 'tmux_sessions', sessions: [], unavailable: 'Mirror mode needs tmux.' });
    expect(screen.getByRole('dialog').textContent).toContain('Mirror mode needs tmux.');
  });

  it('pages tmux with PgUp/PgDn keys and scrolls shells locally', () => {
    const { connect, receive } = setup();
    const ws = connect();
    receive(ws, { type: 'session_list', sessions: [tmuxSession('m', 'dev')] });
    fireEvent.click(screen.getByRole('button', { name: 'Page up' }));
    expect(ws.sentOfType('input').map((m) => m.data)).toEqual(['\x1b[5~']);
  });
});
