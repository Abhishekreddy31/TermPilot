import { useState, useEffect, useCallback } from 'preact/hooks';
import { Login } from './Login.js';
import { TerminalView } from './TerminalView.js';
import { getStoredToken, storeToken, clearToken } from '../services/api.js';
import { WsClient } from '../services/ws-client.js';

export function App() {
  const [token, setToken] = useState<string | null>(getStoredToken());
  const [wsClient, setWsClient] = useState<WsClient | null>(null);

  const handleLogin = useCallback((newToken: string) => {
    storeToken(newToken);
    setToken(newToken);
  }, []);

  const handleLogout = useCallback(() => {
    wsClient?.disconnect();
    clearToken();
    setToken(null);
    setWsClient(null);
  }, [wsClient]);

  useEffect(() => {
    if (!token) return;

    const client = new WsClient(token);
    setWsClient(client);
    client.connect();

    return () => {
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
