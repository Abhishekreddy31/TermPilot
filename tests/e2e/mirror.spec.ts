import { execFileSync } from 'node:child_process';
import { computed, expect, expectTerminalText, hasTmux, run, signIn, test } from './fixtures.js';

test.describe('mirror mode', () => {
  test.skip(!hasTmux(), 'tmux is not installed');

  test('mirrors a tmux session running on the computer', async ({ page, app }) => {
    const tmux = (...args: string[]) => execFileSync('tmux', args, { env: app.env, encoding: 'utf8' });
    tmux('new-session', '-d', '-s', 'laptop', '-x', '100', '-y', '30');

    await signIn(page, app.url);
    await page.getByRole('button', { name: 'Mirror' }).click();
    await page.getByRole('dialog', { name: 'tmux sessions' }).getByRole('button', { name: /laptop/ }).click();
    await expect(page.getByRole('tab', { name: '[tmux] laptop' })).toHaveAttribute('aria-selected', 'true');

    const phone = computed('from-the-phone');
    await run(page, phone);
    // The laptop's tmux session really ran it.
    await expect.poll(() => tmux('capture-pane', '-p', '-t', '=laptop:')).toContain(phone.output);

    // And output produced on the laptop shows up on the phone.
    const laptop = computed('from-the-laptop');
    tmux('send-keys', '-t', '=laptop:', laptop.command, 'Enter');
    await expectTerminalText(page, laptop.output);
  });

  test('a page reload leaves the tmux session itself untouched', async ({ page, app }) => {
    const tmux = (...args: string[]) => execFileSync('tmux', args, { env: app.env, encoding: 'utf8' });
    tmux('new-session', '-d', '-s', 'persist');
    await signIn(page, app.url);
    await page.getByRole('button', { name: 'Mirror' }).click();
    await page.getByRole('dialog', { name: 'tmux sessions' }).getByRole('button', { name: /persist/ }).click();
    await expect(page.getByRole('tab', { name: '[tmux] persist' })).toBeVisible();

    // A reload starts a fresh page: the shell tab is restored by the server and tmux tabs are not
    // remembered by the page, but the tmux session itself must be untouched.
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Shell 1' })).toBeVisible();
    expect(tmux('list-sessions', '-F', '#{session_name}')).toContain('persist');
  });

  test('shows the empty state with a hint', async ({ page, app }) => {
    await signIn(page, app.url);
    await page.getByRole('button', { name: 'Mirror' }).click();
    await expect(page.getByRole('dialog', { name: 'tmux sessions' })).toContainText('tmux new -s');
  });
});
