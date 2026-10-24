import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestClient, loginToken, startTestServer, type TestServer } from '../helpers/server.js';
import { eventually, hasNativeTmux, tmux } from '../helpers/platform.js';

function tmuxSessions(): string[] {
  try {
    return tmux('list-sessions', '-F', '#{session_name}').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function clientCount(name: string): number {
  return tmux('list-clients', '-t', `=${name}`).trim().split('\n').filter(Boolean).length;
}

// Each test file gets a private tmux server (tests/helpers/isolate-tmux.ts).
describe.skipIf(!hasNativeTmux())('mirror mode (tmux)', () => {
  let t: TestServer;
  let client: TestClient;

  beforeEach(async () => {
    tmux('new-session', '-d', '-s', 'work', '-x', '80', '-y', '24');
    t = await startTestServer();
    client = await TestClient.connect(t.wsUrl, await loginToken(t.baseUrl));
  });

  afterEach(async () => {
    await client.close();
    await t.close();
    for (const name of tmuxSessions()) tmux('kill-session', '-t', `=${name}`);
  });

  const attach = async (name: string, c = client) => {
    const from = c.mark;
    c.send({ type: 'tmux_attach', sessionName: name, cols: 80, rows: 24 });
    const created = await c.next('session_created', { from });
    return created.session;
  };

  it('lists the user\'s tmux sessions', async () => {
    client.send({ type: 'tmux_list' });
    const reply = await client.next('tmux_sessions');
    expect(reply.unavailable).toBeUndefined();
    expect(reply.sessions).toEqual([expect.objectContaining({ name: 'work', windows: 1, attached: false })]);
  });

  it('attaches, mirrors input and output, and replays the screen', async () => {
    const session = await attach('work');
    expect(session).toMatchObject({ kind: 'tmux', tmuxName: 'work' });
    await eventually(() => clientCount('work') === 1);

    client.send({ type: 'input', sessionId: session.id, data: 'echo mirrored-ok\r' });
    await client.waitForOutput(session.id, 'mirrored-ok');
    // What the phone typed is really in the tmux session the laptop sees.
    await eventually(() => tmux('capture-pane', '-p', '-t', '=work:').includes('mirrored-ok'));

    const from = client.mark;
    client.send({ type: 'attach', sessionId: session.id, size: { cols: 80, rows: 24 } });
    expect((await client.next('session_attached', { from })).replay).toContain('mirrored-ok');
  });

  it('attaches to sessions whose names contain spaces and shell characters', async () => {
    tmux('new-session', '-d', '-s', 'my project; $(id)');
    client.send({ type: 'tmux_list' });
    const listed = await client.next('tmux_sessions');
    expect(listed.sessions.map((s) => s.name)).toContain('my project; $(id)');
    const session = await attach('my project; $(id)');
    expect(session.tmuxName).toBe('my project; $(id)');
    await eventually(() => clientCount('my project; $(id)') === 1);
  });

  it('matches the session name exactly', async () => {
    tmux('new-session', '-d', '-s', 'workshop');
    tmux('kill-session', '-t', '=work');
    client.send({ type: 'tmux_attach', sessionName: 'work' });
    expect(await client.next('error')).toMatchObject({ tmuxName: 'work', message: expect.stringMatching(/not found/) });
    expect(clientCount('workshop')).toBe(0);
  });

  it('detaches on close without killing the tmux session', async () => {
    const session = await attach('work');
    client.send({ type: 'close', sessionId: session.id });
    await client.next((m) => m.type === 'session_closed' && m.sessionId === session.id);
    await eventually(() => clientCount('work') === 0);
    expect(tmuxSessions()).toContain('work');
  });

  it('detaches the tmux client when the connection drops (so it cannot pin the window size)', async () => {
    await attach('work');
    await client.close();
    await eventually(() => clientCount('work') === 0);
    expect(tmuxSessions()).toContain('work');
  });

  it('does not show one connection\'s tmux clients to another', async () => {
    await attach('work');
    const other = await TestClient.connect(t.wsUrl, await loginToken(t.baseUrl));
    other.send({ type: 'list' });
    expect((await other.next('session_list')).sessions).toEqual([]);
    await other.close();
  });

  it('lets two devices mirror the same tmux session', async () => {
    const first = await attach('work');
    const other = await TestClient.connect(t.wsUrl, await loginToken(t.baseUrl));
    const second = await attach('work', other);
    expect(second.id).not.toBe(first.id);
    await eventually(() => clientCount('work') === 2);
    await other.close();
  });

  it('creates and kills tmux sessions; attached tabs close with the session', async () => {
    client.send({ type: 'tmux_create', name: 'fresh' });
    await client.next('tmux_created');
    expect(tmuxSessions()).toContain('fresh');

    const session = await attach('fresh');
    client.send({ type: 'tmux_kill', name: 'fresh' });
    await client.next('tmux_killed');
    expect(await client.next((m) => m.type === 'session_closed' && m.sessionId === session.id)).toMatchObject({ reason: 'exited' });
    expect(tmuxSessions()).not.toContain('fresh');
  });

  it('reports errors for duplicate or missing sessions', async () => {
    client.send({ type: 'tmux_create', name: 'work' });
    expect((await client.next('error')).message).toMatch(/already exists/);
    const from = client.mark;
    client.send({ type: 'tmux_kill', name: 'missing' });
    expect((await client.next('error', { from })).message).toMatch(/not found/);
  });

  it('lists windows', async () => {
    tmux('new-window', '-t', '=work', '-n', 'logs');
    client.send({ type: 'tmux_windows', sessionName: 'work' });
    const reply = await client.next('tmux_windows');
    expect(reply.windows.map((w) => w.name)).toContain('logs');
  });
});
