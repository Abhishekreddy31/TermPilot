import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { PROTOCOL_VERSION } from '@termpilot/shared';
import { VoiceInput } from '../../../packages/client/src/components/VoiceInput.js';
import { ExtraKeys } from '../../../packages/client/src/components/ExtraKeys.js';
import { FakeWebSocket } from '../../helpers/fake-websocket.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// The api module caches the CSRF token, so every test loads fresh modules.
beforeEach(() => {
  vi.resetModules();
});

const loadLogin = async () => (await import('../../../packages/client/src/components/Login.js')).Login;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Login', () => {
  it('signs in with the CSRF token and hands the session token over', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { csrfToken: 'csrf-1' }))
      .mockResolvedValueOnce(jsonResponse(200, { token: 'tok' }));
    vi.stubGlobal('fetch', fetchMock);
    const onLogin = vi.fn();
    const Login = await loadLogin();
    render(<Login onLogin={onLogin} />);

    fireEvent.input(screen.getByPlaceholderText('Username'), { target: { value: 'admin' } });
    fireEvent.input(screen.getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Sign in' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('tok'));
    const [, init] = fetchMock.mock.calls[1];
    expect(init.headers['X-CSRF-Token']).toBe('csrf-1');
    expect(JSON.parse(init.body)).toEqual({ username: 'admin', password: 'pw' });
  });

  it('shows the server error for bad credentials', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { csrfToken: 'c' }))
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Invalid credentials' })));
    const Login = await loadLogin();
    render(<Login onLogin={vi.fn()} />);
    fireEvent.input(screen.getByPlaceholderText('Username'), { target: { value: 'a' } });
    fireEvent.input(screen.getByPlaceholderText('Password'), { target: { value: 'b' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Invalid credentials');
  });

  it('shows why the user was signed out', async () => {
    const Login = await loadLogin();
    render(<Login onLogin={vi.fn()} message="Your login expired. Please sign in again." />);
    expect(screen.getByRole('status').textContent).toContain('expired');
  });
});

describe('api service', () => {
  it('refreshes a stale CSRF token once (server restarted) and retries', async () => {
    const { login } = await import('../../../packages/client/src/services/api.js');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { csrfToken: 'old' }))
      .mockResolvedValueOnce(jsonResponse(403, { error: 'Invalid CSRF token' }))
      .mockResolvedValueOnce(jsonResponse(200, { csrfToken: 'new' }))
      .mockResolvedValueOnce(jsonResponse(200, { token: 't2' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(login('a', 'b')).resolves.toBe('t2');
    expect(fetchMock.mock.calls[3][1].headers['X-CSRF-Token']).toBe('new');
  });

  it('reports an unreachable server clearly', async () => {
    const { login } = await import('../../../packages/client/src/services/api.js');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(login('a', 'b')).rejects.toThrow('Cannot reach server');
  });

  it('keeps the token in sessionStorage only', async () => {
    const { storeToken, getStoredToken, clearToken } = await import('../../../packages/client/src/services/api.js');
    storeToken('abc');
    expect(getStoredToken()).toBe('abc');
    expect(localStorage.length).toBe(0);
    clearToken();
    expect(getStoredToken()).toBeNull();
  });
});

describe('VoiceInput', () => {
  it('explains that voice needs HTTPS on an insecure page', () => {
    vi.stubGlobal('isSecureContext', false);
    render(<VoiceInput onCommand={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Voice unavailable' });
    fireEvent.click(button);
    expect(screen.getByRole('note').textContent).toContain('HTTPS');
  });

  it('renders nothing when the browser has no speech recognition', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    const { container } = render(<VoiceInput onCommand={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('turns speech into a reviewed command and sends it', () => {
    let recognizer: { onresult: (e: unknown) => void; onend: () => void } | null = null;
    class Recognition {
      continuous = false; interimResults = false; lang = ''; maxAlternatives = 1;
      onresult = null; onend = null; onerror = null;
      constructor() { recognizer = this as never; }
      start() {}
      stop() { recognizer?.onend(); }
    }
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('webkitSpeechRecognition', Recognition);
    const onCommand = vi.fn();
    render(<VoiceInput onCommand={onCommand} />);

    fireEvent.click(screen.getByRole('button', { name: 'Speak a command' }));
    act(() => recognizer!.onresult({ results: [{ isFinal: true, 0: { transcript: 'git commit dash m fix' } }] }));
    expect(screen.getByText('git commit -m fix')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onCommand).toHaveBeenCalledWith('git commit -m fix');
  });
});

describe('ExtraKeys', () => {
  it('reports keys, modifiers and paging separately', () => {
    const onKey = vi.fn();
    const onToggleModifier = vi.fn();
    const onPage = vi.fn();
    render(<ExtraKeys modifiers={{ ctrl: true, alt: false }} onKey={onKey} onToggleModifier={onToggleModifier} onPage={onPage} />);
    expect(screen.getByRole('button', { name: 'Ctrl modifier' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Alt modifier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Page down' }));
    expect(onToggleModifier).toHaveBeenCalledWith('alt');
    expect(onKey).toHaveBeenCalledWith('\t');
    expect(onPage).toHaveBeenCalledWith(1);
  });
});

describe('App', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('isSecureContext', false);
  });

  it('returns to the login screen with a reason when the login expires', async () => {
    sessionStorage.setItem('termpilot_token', 'tok');
    const { App } = await import('../../../packages/client/src/components/App.js');
    render(<App />);
    act(() => {
      FakeWebSocket.latest.open();
      FakeWebSocket.latest.receive({ type: 'auth_failed', reason: 'invalid_token', message: 'expired' });
    });
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('expired');
    expect(sessionStorage.getItem('termpilot_token')).toBeNull();
  });

  it('reloads once when the server speaks a newer protocol', async () => {
    sessionStorage.setItem('termpilot_token', 'tok');
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload, protocol: 'http:', host: 'localhost' });
    const { App } = await import('../../../packages/client/src/components/App.js');
    render(<App />);
    act(() => {
      FakeWebSocket.latest.open();
      FakeWebSocket.latest.receive({ type: 'auth_failed', reason: 'protocol_mismatch', message: 'reload' });
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(FakeWebSocket.latest.sent[0]).toEqual({ type: 'auth', token: 'tok', protocol: PROTOCOL_VERSION });
  });
});
