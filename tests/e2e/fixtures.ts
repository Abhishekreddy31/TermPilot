import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect, type Locator, type Page } from '@playwright/test';

export const IS_WINDOWS = process.platform === 'win32';
export const PASSWORD = 'e2e-password-not-secret';

export interface RunningCli {
  url: string;
  port: number;
  home: string;
  env: NodeJS.ProcessEnv;
  output(): string;
  process: ChildProcess;
  stop(): Promise<number | null>;
}

/** Environment for a CLI run: a throwaway home and a private tmux server. */
export function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'termpilot-home-'));
  // A real profile has these; Windows' per-user TEMP points into it.
  if (IS_WINDOWS) mkdirSync(join(home, 'AppData', 'Local', 'Temp'), { recursive: true });
  const tmuxDir = mkdtempSync(join(tmpdir(), 'termpilot-tmux-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TMUX_TMPDIR: tmuxDir, TERMPILOT_DEBUG: '1', ...extra };
  delete env.TMUX;
  delete env.PORT;
  delete env.HOST;
  delete env.TUNNEL;
  if (!IS_WINDOWS) env.SHELL = '/bin/sh';
  return env;
}

/** Start the installed CLI and wait until it prints where it is listening. */
export async function startCli(args: string[] = [], env: NodeJS.ProcessEnv = isolatedEnv({ TERMPILOT_PASSWORD: PASSWORD })): Promise<RunningCli> {
  const cli = process.env.TERMPILOT_E2E_CLI;
  if (!cli) throw new Error('TERMPILOT_E2E_CLI is not set; run through the Playwright config');
  const child = spawn(process.execPath, [cli, '--port', String(await freePort()), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI did not start:\n${output}`)), 20_000);
    const check = () => {
      const match = output.match(/Open:\s+(http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout!.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited with ${code}:\n${output}`));
    });
  });

  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return {
    url,
    port: Number(new URL(url).port),
    home: env.HOME!,
    env,
    output: () => output,
    process: child,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      const code = await exited;
      if (env.TMUX_TMPDIR) {
        try {
          execFileSync('tmux', ['kill-server'], { env, stdio: 'ignore' });
        } catch {
          // No tmux server was started.
        }
        rmSync(env.TMUX_TMPDIR, { recursive: true, force: true });
      }
      return code;
    },
  };
}

export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const MAX_LOGGED_FRAMES = 200;
const MAX_LOGGED_FRAME_CHARS = 300;

export const test = base.extend<{ app: RunningCli; wsLog: string[] }>({
  // Records the page's WebSocket traffic; attached to the report when a test fails.
  wsLog: [async ({ page }, use, testInfo) => {
    const log: string[] = [];
    const add = (line: string) => {
      log.push(`${new Date().toISOString()} ${line.slice(0, MAX_LOGGED_FRAME_CHARS)}`);
      if (log.length > MAX_LOGGED_FRAMES) log.shift();
    };
    page.on('websocket', (ws) => {
      add(`open ${ws.url()}`);
      ws.on('framesent', (f) => add(`> ${String(f.payload)}`));
      ws.on('framereceived', (f) => add(`< ${String(f.payload)}`));
      ws.on('socketerror', (e) => add(`socket error ${e}`));
      ws.on('close', () => add('close'));
    });
    page.on('console', (m) => add(`console.${m.type()} ${m.text()}`));
    page.on('pageerror', (e) => add(`pageerror ${e.message}`));
    await use(log);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('websocket log', { body: log.join('\n'), contentType: 'text/plain' });
      console.log(`--- websocket log (${testInfo.title}) ---\n${log.join('\n')}`);
    }
  }, { auto: true }],

  // Playwright requires an object pattern for the fixtures argument, even when none are used.
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, use, testInfo) => {
    const app = await startCli();
    await use(app);
    const exitCode = app.process.exitCode;
    await app.stop();
    // The server's own output is the first thing needed to understand a failure.
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('term-pilot output', { body: `${app.output()}\n[exit code before stop: ${exitCode}]`, contentType: 'text/plain' });
      console.log(`--- term-pilot output (${testInfo.title}) ---\n${app.output()}\n[exit code before stop: ${exitCode}]`);
    }
  },
});

export { expect };

export async function signIn(page: Page, url: string, password = PASSWORD): Promise<void> {
  await page.goto(url);
  await page.getByPlaceholder('Username').fill('admin');
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('tab').first()).toBeVisible();
  await expect(page.getByRole('img', { name: 'Connection: connected' })).toBeVisible();
}

/** The terminal of the selected tab. */
export function activeTerminal(page: Page): Locator {
  return page.locator('.terminal-slot:not([hidden]) .xterm');
}

/**
 * A command whose output differs from what is typed, so seeing the output proves the
 * shell ran it (typed text is echoed back by the terminal either way).
 */
export function computed(marker: string): { command: string; output: string } {
  return {
    command: IS_WINDOWS ? `echo "${marker}-$(40+2)"` : `echo ${marker}-$((40+2))`,
    output: `${marker}-42`,
  };
}

/** Type a command (or run a `computed` one) and wait for its output when it has one. */
export async function run(page: Page, spec: { command: string; output: string }): Promise<void> {
  await typeCommand(page, spec.command);
  await expectTerminalText(page, spec.output);
}

/**
 * How the cursor's row ends when a shell waits for input: PowerShell's `PS C:\path>`
 * (on a narrow screen only the tail of the path may share the cursor's row) or sh's `$`/`#`.
 */
const PROMPT_AT_CURSOR = IS_WINDOWS ? />\s*$/ : /[$#]\s*$/;

/**
 * Wait until the shell shows a prompt, as a person does before typing. Windows'
 * console discards keys typed while it is starting a shell or handling Ctrl+C, and a
 * Ctrl+C that arrives before PowerShell is up ends PowerShell itself.
 */
export async function waitForPrompt(page: Page, timeout = 15_000): Promise<void> {
  const cursorRow = page.locator('.terminal-slot:not([hidden]) .xterm-rows > div').filter({ has: page.locator('.xterm-cursor') });
  await expect(cursorRow).toHaveText(PROMPT_AT_CURSOR, { timeout });
}

export async function typeCommand(page: Page, command: string): Promise<void> {
  await waitForPrompt(page);
  await activeTerminal(page).click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

export async function expectTerminalText(page: Page, text: string | RegExp, timeout = 15_000): Promise<void> {
  await expect(page.locator('.terminal-slot:not([hidden]) .xterm-rows')).toContainText(text, { timeout });
}

export function hasTmux(): boolean {
  if (IS_WINDOWS) return false;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
