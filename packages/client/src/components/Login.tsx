import { useState } from 'preact/hooks';
import { login } from '../services/api.js';

interface LoginProps {
  onLogin: (token: string) => void;
}

export function Login({ onLogin }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const token = await login(username, password);
      onLogin(token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form class="login-screen" onSubmit={handleSubmit}>
      <div class="login-brand">
        <div class="logo">&gt;_</div>
        <h1>TermPilot</h1>
        <p>Remote terminal management</p>
      </div>
      <input
        type="text"
        placeholder="Username"
        value={username}
        onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
        autoComplete="username"
        required
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
        autoComplete="current-password"
        required
      />
      <button class="login-btn" type="submit" disabled={loading}>
        {loading ? 'Signing in...' : 'Sign In'}
      </button>
      {error && <p class="error">{error}</p>}
    </form>
  );
}
