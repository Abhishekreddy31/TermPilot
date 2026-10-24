import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env.CI);

/**
 * End-to-end tests run the real npm package: global setup builds (or takes) the
 * tarball, installs it with npm into a temporary prefix, and each test starts the
 * installed `term-pilot` CLI and drives it from an emulated phone.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]] : 'list',
  outputDir: '../../test-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'cli', testMatch: 'cli.spec.ts' },
    { name: 'mobile-chrome', testIgnore: 'cli.spec.ts', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', testIgnore: 'cli.spec.ts', use: { ...devices['iPhone 15'] } },
  ],
});
