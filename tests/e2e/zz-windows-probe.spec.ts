import { computed, expect, signIn, test, typeCommand, IS_WINDOWS } from './fixtures.js';
// TEMPORARY diagnostic, removed before merge.
test('probe: shell timing', async ({ page, app }) => {
  test.skip(!IS_WINDOWS);
  test.setTimeout(240_000);
  const rows = page.locator('.terminal-slot:not([hidden]) .xterm-rows');
  const t0 = Date.now();
  await signIn(page, app.url);
  await expect(rows).toContainText(/PS .*>/, { timeout: 90_000 });
  console.log(`PROBE prompt after ${Date.now() - t0}ms`);
  for (const marker of ['first', 'second', 'third']) {
    const spec = computed(marker);
    const t1 = Date.now();
    await typeCommand(page, spec.command);
    try {
      await expect(rows).toContainText(spec.output, { timeout: 90_000 });
      console.log(`PROBE ${marker} output after ${Date.now() - t1}ms`);
    } catch {
      console.log(`PROBE ${marker} NO OUTPUT after ${Date.now() - t1}ms; screen: ${await rows.innerText()}`);
    }
  }
});
