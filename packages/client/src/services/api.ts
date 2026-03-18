const API_BASE = '';

let _csrfToken: string | null = null;

async function getCsrfToken(): Promise<string> {
  if (_csrfToken) return _csrfToken;
  try {
    const res = await fetch(`${API_BASE}/api/auth/csrf`);
    const data = await res.json();
    _csrfToken = data.csrfToken;
    return _csrfToken!;
  } catch {
    return '';
  }
}

export async function login(username: string, password: string): Promise<string> {
  const csrf = await getCsrfToken();

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
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
  const csrf = await getCsrfToken();
  try {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      body: JSON.stringify({ token }),
    });
  } catch {
    // Best-effort server-side invalidation
  }
}
