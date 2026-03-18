const API_BASE = '';

export async function login(username: string, password: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new Error('Cannot reach server. Check your connection.');
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Login failed');
  }

  const data = await res.json();
  return data.token;
}

export function getStoredToken(): string | null {
  return sessionStorage.getItem('termpilot_token');
}

export function storeToken(token: string): void {
  sessionStorage.setItem('termpilot_token', token);
}

export function clearToken(): void {
  sessionStorage.removeItem('termpilot_token');
}

export async function logout(token: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    // Ignore — best-effort server-side invalidation
  }
}
