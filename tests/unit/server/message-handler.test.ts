import { describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../../../packages/server/src/ws/message-handler.js';
import type { ClientConnection } from '../../../packages/server/src/ws/client-connection.js';
import type { SessionRegistry } from '../../../packages/server/src/terminal/session-registry.js';
import type { TmuxManager } from '../../../packages/server/src/terminal/tmux-manager.js';

function deps() {
  const sessions = { create: vi.fn(() => ({ id: 's', kind: 'shell', cols: 80, rows: 24, createdAt: 0 })), attach: vi.fn(() => '') };
  const tmux = { hasSession: vi.fn(async () => true), attachSpec: vi.fn() };
  return {
    sessions,
    tmux,
    deps: {
      sessions: sessions as unknown as SessionRegistry,
      tmux: tmux as unknown as TmuxManager,
      shellSpec: () => ({ file: 'sh', args: [], cwd: '/', env: {} }),
    },
  };
}

function connection(open: boolean) {
  return { open, username: 'alice', send: vi.fn() } as unknown as ClientConnection & { send: ReturnType<typeof vi.fn> };
}

describe('handleMessage', () => {
  it('creates a shell for an open connection', async () => {
    const { sessions, deps: d } = deps();
    const conn = connection(true);
    await handleMessage(conn, { type: 'create', cols: 80, rows: 24 }, d);
    expect(sessions.create).toHaveBeenCalledOnce();
    expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session_created' }));
  });

  it('ignores messages dequeued after the connection closed', async () => {
    const { sessions, tmux, deps: d } = deps();
    const conn = connection(false);
    await handleMessage(conn, { type: 'create', cols: 80, rows: 24 }, d);
    await handleMessage(conn, { type: 'attach', sessionId: 's', size: { cols: 80, rows: 24 } }, d);
    await handleMessage(conn, { type: 'tmux_attach', sessionName: 'dev', cols: 80, rows: 24 }, d);
    expect(sessions.create).not.toHaveBeenCalled();
    expect(sessions.attach).not.toHaveBeenCalled();
    expect(tmux.hasSession).not.toHaveBeenCalled();
  });

  it('does not attach tmux when the connection closes while tmux answers', async () => {
    const { sessions, tmux, deps: d } = deps();
    const conn = { open: true, username: 'alice', send: vi.fn() };
    tmux.hasSession.mockImplementation(async () => {
      conn.open = false;
      return true;
    });
    await handleMessage(conn as unknown as ClientConnection, { type: 'tmux_attach', sessionName: 'dev', cols: 80, rows: 24 }, d);
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('reports failures as error messages tagged with the session', async () => {
    const { sessions, deps: d } = deps();
    sessions.attach.mockImplementation(() => {
      throw new Error('Session not found: s');
    });
    const conn = connection(true);
    await handleMessage(conn, { type: 'attach', sessionId: 's', size: { cols: 80, rows: 24 } }, d);
    expect(conn.send).toHaveBeenCalledWith({ type: 'error', message: 'Session not found: s', sessionId: 's' });
  });
});
