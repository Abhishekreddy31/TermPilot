import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { IS_WINDOWS, PASSWORD, activeTerminal, computed, expect, expectTerminalText, run, signIn, startCli, test, typeCommand, waitForPrompt } from './fixtures.js';

/** Generous for a loaded CI runner, far below the ~35 s stall this guards against. */
const FIRST_COMMAND_BUDGET_MS = 8_000;

// A command that runs long enough to be interrupted, on each platform's default shell.
const LONG_COMMAND = IS_WINDOWS ? 'Start-Sleep -Seconds 60' : 'sleep 60';

function lanAddress(): string | undefined {
  return Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
}

test.describe('phone UI', () => {
  test('rejects a wrong password and signs in with the right one', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByPlaceholder('Username').fill('admin');
    await page.getByPlaceholder('Password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Invalid credentials');
    await signIn(page, app.url);
    await expect(page.getByRole('tab', { name: 'Shell 1' })).toHaveAttribute('aria-selected', 'true');
  });

  test('runs commands in a real shell', async ({ page, app }) => {
    await signIn(page, app.url);
    await run(page, computed('e2e-hello'));
  });

  test('answers the first command in a new shell promptly', async ({ page, app }) => {
    // With a stripped environment, Windows PowerShell stalled ~35 s on its first command.
    await signIn(page, app.url);
    await waitForPrompt(page);
    const first = computed('first-command');
    await typeCommand(page, first.command);
    await expectTerminalText(page, first.output, FIRST_COMMAND_BUDGET_MS);
  });

  test('opens, switches and closes tabs', async ({ page, app }) => {
    await signIn(page, app.url);
    await run(page, computed('first-tab'));
    await page.getByRole('button', { name: 'New terminal' }).click();
    await expect(page.getByRole('tab', { name: 'Shell 2' })).toHaveAttribute('aria-selected', 'true');
    await run(page, computed('second-tab'));

    await page.getByRole('tab', { name: 'Shell 1' }).click();
    await expectTerminalText(page, computed('first-tab').output);

    await page.getByRole('button', { name: 'Close Shell 2' }).click();
    await expect(page.getByRole('tab')).toHaveCount(1);
  });

  test('Ctrl from the extra-keys bar interrupts a running command (Ctrl+C)', async ({ page, app }) => {
    await signIn(page, app.url);
    await typeCommand(page, LONG_COMMAND);
    // Echoed, so the prompt it was typed at can no longer pass for a fresh one.
    await expectTerminalText(page, LONG_COMMAND);
    await page.getByRole('button', { name: 'Ctrl modifier' }).click();
    await expect(page.getByRole('button', { name: 'Ctrl modifier' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.type('c');
    await expect(page.getByRole('button', { name: 'Ctrl modifier' })).toHaveAttribute('aria-pressed', 'false');
    // Back at a prompt well before the 60s command would have finished on its own.
    await waitForPrompt(page, 10_000);
    await run(page, computed('interrupted'));
  });

  test('keeps shells across a page reload', async ({ page, app }) => {
    await signIn(page, app.url);
    await run(page, computed('before-reload'));
    await page.getByRole('button', { name: 'New terminal' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);

    await page.reload();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await page.getByRole('tab', { name: 'Shell 1' }).click();
    await expectTerminalText(page, computed('before-reload').output);
    await run(page, computed('after-reload'));
  });

  test('logs out and invalidates the token', async ({ page, app }) => {
    await signIn(page, app.url);
    const token = await page.evaluate(() => sessionStorage.getItem('termpilot_token'));
    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect.poll(async () => {
      const { csrfToken } = (await (await fetch(`${app.url}/api/auth/csrf`)).json()) as { csrfToken: string };
      const res = await fetch(`${app.url}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ token }),
      });
      return res.status;
    }).toBe(401);
  });

  test('does not offer voice as broken on a secure origin', async ({ page, app }) => {
    await signIn(page, app.url);
    await expect(page.getByRole('button', { name: 'Voice unavailable' })).toHaveCount(0);
  });

  test('serves the PWA manifest and service worker', async ({ page, app }) => {
    await page.goto(app.url);
    const manifest = await (await fetch(`${app.url}/manifest.webmanifest`)).json();
    expect(manifest).toMatchObject({ name: 'TermPilot', display: 'standalone' });
    const sw = await fetch(`${app.url}/sw.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
  });

  test('loads with no console errors and no CSP violations', async ({ page, app }) => {
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));
    await signIn(page, app.url);
    await run(page, computed('clean-console'));
    expect(problems).toEqual([]);
  });

  test('rejects requests whose Host is not this server (DNS rebinding)', async ({ app }) => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: app.port, path: '/', headers: { Host: 'rebind.attacker.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

test.describe('network access', () => {
  test('is reachable on the LAN address and explains that voice needs HTTPS there', async ({ page }) => {
    const address = lanAddress();
    test.skip(!address, 'no LAN interface on this machine');
    const app = await startCli(['--host', '0.0.0.0']);
    try {
      const url = `http://${address}:${app.port}`;
      await signIn(page, url, PASSWORD);
      await run(page, computed('over-lan'));
      await page.getByRole('button', { name: 'Voice unavailable' }).click();
      await expect(page.getByRole('note')).toContainText('HTTPS');
      await expect(activeTerminal(page)).toBeVisible();
    } finally {
      await app.stop();
    }
  });
});
