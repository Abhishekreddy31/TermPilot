import { useState } from 'preact/hooks';
import { login } from '../services/api.js';

interface LoginProps {
  onLogin: (token: string) => void;
  /** Why the user is seeing the login screen again, if not for the first time. */
  message?: string | null;
}

export function Login({ onLogin, message }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      onLogin(await login(username, password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form class="login-screen" onSubmit={handleSubmit} aria-label="Sign in">
      <div class="login-brand">
        <div class="logo" aria-hidden="true">&gt;_</div>
        <h1>TermPilot</h1>
        <p>Remote terminal management</p>
      </div>
      {message && <p class="login-message" role="status">{message}</p>}
      <label for="tp-username" class="sr-only">Username</label>
      <input
        id="tp-username"
        type="text"
        placeholder="Username"
        value={username}
        onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
        autoComplete="username"
        autoCapitalize="none"
        spellcheck={false}
        required
      />
      <label for="tp-password" class="sr-only">Password</label>
      <input
        id="tp-password"
        type="password"
        placeholder="Password"
        value={password}
        onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
        autoComplete="current-password"
        required
      />
      <button class="login-btn" type="submit" disabled={loading}>
        {loading ? 'Signing in…' : 'Sign in'}
      </button>
      {error && <p class="error" role="alert">{error}</p>}
      <p class="login-hint">
        The password is in <code>~/.termpilot/credentials</code> on the computer running TermPilot.
      </p>
    </form>
  );
}
