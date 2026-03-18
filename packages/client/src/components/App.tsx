import { useState, useEffect, useCallback } from 'preact/hooks';
import { Login } from './Login.js';
import { TerminalView } from './TerminalView.js';
import { getStoredToken, storeToken, clearToken, logout as apiLogout } from '../services/api.js';
import { WsClient } from '../services/ws-client.js';

export function App() {
  const [token, setToken] = useState<string | null>(getStoredToken());
  const [wsClient, setWsClient] = useState<WsClient | null>(null);

  const handleLogin = useCallback((newToken: string) => {
    storeToken(newToken);
    setToken(newToken);
  }, []);

  const handleLogout = useCallback(() => {
    const currentToken = getStoredToken();
    wsClient?.disconnect();
    // Invalidate session server-side
    if (currentToken) apiLogout(currentToken).catch(() => {});
    clearToken();
    setToken(null);
    setWsClient(null);
  }, [wsClient]);

  useEffect(() => {
    if (!token) return;

    const client = new WsClient(token);
    setWsClient(client);
    client.connect();

    // If auth fails (token expired), auto-logout
    const unsub = client.onStateChange((state) => {
      if (state === 'auth_failed') {
        clearToken();
        setToken(null);
        setWsClient(null);
      }
    });

    return () => {
      unsub();
      client.disconnect();
    };
  }, [token]);

  if (!token) {
    return <Login onLogin={handleLogin} />;
  }

  if (!wsClient) {
    return <div class="login-screen">Connecting...</div>;
  }

  return <TerminalView wsClient={wsClient} onLogout={handleLogout} />;
}
