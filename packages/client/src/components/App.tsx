import { useCallback, useEffect, useState } from 'preact/hooks';
import { Login } from './Login.js';
import { TerminalView } from './TerminalView.js';
import { clearToken, getStoredToken, logout as apiLogout, storeToken } from '../services/api.js';
import { WsClient } from '../services/ws-client.js';

/** Set before reloading for a protocol upgrade, so a still-mismatched page does not reload in a loop. */
const RELOAD_FLAG = 'termpilot_reloaded_for_update';

function reloadOnceForUpdate(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch {
    return false;
  }
  location.reload();
  return true;
}

export function App() {
  const [token, setToken] = useState<string | null>(getStoredToken);
  const [wsClient, setWsClient] = useState<WsClient | null>(null);
  const [loginMessage, setLoginMessage] = useState<string | null>(null);

  const handleLogin = useCallback((newToken: string) => {
    storeToken(newToken);
    setLoginMessage(null);
    setToken(newToken);
  }, []);

  const handleLogout = useCallback(() => {
    const current = getStoredToken();
    if (current) void apiLogout(current);
    clearToken();
    setToken(null);
  }, []);

  useEffect(() => {
    if (!token) {
      setWsClient(null);
      return;
    }
    const client = new WsClient(token);
    const unsubscribe = client.onStateChange((state) => {
      if (state === 'connected') {
        try {
          sessionStorage.removeItem(RELOAD_FLAG);
        } catch {
          // Storage unavailable; nothing to clear.
        }
      }
      if (state !== 'auth_failed') return;
      if (client.authFailure === 'protocol_mismatch' && reloadOnceForUpdate()) return;
      clearToken();
      setLoginMessage(client.authFailure === 'protocol_mismatch'
        ? 'TermPilot was updated. Reload this page to continue.'
        : 'Your login expired. Please sign in again.');
      setToken(null);
    });
    setWsClient(client);
    client.connect();
    return () => {
      unsubscribe();
      client.disconnect();
    };
  }, [token]);

  if (!token) return <Login onLogin={handleLogin} message={loginMessage} />;
  if (!wsClient) return <div class="login-screen" role="status">Connecting…</div>;
  return <TerminalView wsClient={wsClient} onLogout={handleLogout} />;
}
