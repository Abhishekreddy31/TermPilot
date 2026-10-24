import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { IS_WINDOWS, PASSWORD, expect, isolatedEnv, startCli, test } from './fixtures.js';

const ROOT_PACKAGE = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

function runCli(args: string[], env = isolatedEnv()) {
  return spawnSync(process.execPath, [process.env.TERMPILOT_E2E_CLI!, ...args], { env, encoding: 'utf8' });
}

async function api(url: string, path: string, body: unknown): Promise<Response> {
  const { csrfToken } = (await (await fetch(`${url}/api/auth/csrf`)).json()) as { csrfToken: string };
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(body),
  });
}

test.describe('installed CLI', () => {
  test('prints the packaged version', () => {
    const result = runCli(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`term-pilot v${ROOT_PACKAGE.version}`);
  });

  test('works through the npm bin shim', () => {
    const prefix = process.env.TERMPILOT_E2E_PREFIX!;
    const bin = join(prefix, 'node_modules', '.bin', IS_WINDOWS ? 'term-pilot.cmd' : 'term-pilot');
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', shell: IS_WINDOWS });
    expect(out.trim()).toBe(`term-pilot v${ROOT_PACKAGE.version}`);
  });

  test('prints help', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--allowed-hosts');
  });

  test('rejects unknown options with usage exit code 2', () => {
    const result = runCli(['--tunel']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown option '--tunel'");
  });

  test('generates a password, stores it privately, and it works', async () => {
    const app = await startCli([], isolatedEnv());
    try {
      const file = join(app.home, '.termpilot', 'credentials');
      const [user, password] = readFileSync(file, 'utf8').trim().split(':');
      expect(user).toBe('admin');
      expect(password.length).toBeGreaterThanOrEqual(16);
      if (!IS_WINDOWS) expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(app.output()).not.toContain(password);
      expect((await api(app.url, '/api/auth/login', { username: 'admin', password })).status).toBe(200);
      expect((await api(app.url, '/api/auth/login', { username: 'admin', password: 'guess' })).status).toBe(401);
    } finally {
      await app.stop();
    }
  });

  test('tightens permissions of an existing credentials file before writing to it', async () => {
    test.skip(IS_WINDOWS, 'POSIX permissions');
    const env = isolatedEnv();
    const dir = join(env.HOME!, '.termpilot');
    mkdirSync(dir, { mode: 0o755 });
    writeFileSync(join(dir, 'credentials'), 'old\n', { mode: 0o644 });
    chmodSync(dir, 0o755);
    const app = await startCli([], env);
    try {
      expect(statSync(join(dir, 'credentials')).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      await app.stop();
    }
  });

  test('uses TERMPILOT_PASSWORD without writing a credentials file', async () => {
    const app = await startCli();
    try {
      expect(app.output()).toContain('from TERMPILOT_PASSWORD');
      expect(() => statSync(join(app.home, '.termpilot', 'credentials'))).toThrow();
      expect((await api(app.url, '/api/auth/login', { username: 'admin', password: PASSWORD })).status).toBe(200);
    } finally {
      await app.stop();
    }
  });

  test('moves to the next port when the requested one is busy', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busy = (blocker.address() as { port: number }).port;
    const app = await startCli(['--port', String(busy)]);
    try {
      expect(app.port).not.toBe(busy);
      expect(app.output()).toContain(`port ${busy} was busy`);
      expect((await fetch(`${app.url}/health`)).status).toBe(200);
    } finally {
      await app.stop();
      blocker.close();
    }
  });

  test('lists network addresses and the HTTPS caveat when bound to all interfaces', async () => {
    const app = await startCli(['--host', '0.0.0.0']);
    try {
      expect(app.output()).toContain('plain HTTP');
      expect(app.url).toContain('localhost');
    } finally {
      await app.stop();
    }
  });

  test('shuts down cleanly on SIGTERM', async () => {
    test.skip(IS_WINDOWS, 'Windows has no SIGTERM; the process is terminated');
    const app = await startCli();
    expect(await app.stop()).toBe(0);
    expect(app.output()).toContain('shutting down');
  });
});
