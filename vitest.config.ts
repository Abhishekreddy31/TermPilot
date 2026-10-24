import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Tests run against the TypeScript sources, not built output.
const alias = [
  { find: /^@termpilot\/shared\/schemas$/, replacement: fromRoot('./packages/shared/src/schemas.ts') },
  { find: /^@termpilot\/shared$/, replacement: fromRoot('./packages/shared/src/index.ts') },
];

export default defineConfig({
  resolve: { alias, dedupe: ['preact'] },
  test: {
    // Every test gets its own TMUX_TMPDIR so tests never touch the developer's tmux server.
    setupFiles: [fromRoot('./tests/helpers/isolate-tmux.ts')],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['packages/*/src/**/*.d.ts', 'packages/client/src/main.tsx', 'packages/server/src/index.ts'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: fromRoot('./coverage'),
      // The CLI entry point and the xterm.js view run in real processes and browsers; the e2e suite covers them.
      thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit:node',
          environment: 'node',
          include: ['tests/unit/shared/**/*.test.ts', 'tests/unit/server/**/*.test.ts'],
        },
      },
      {
        extends: true,
        oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
        test: {
          name: 'unit:client',
          environment: 'happy-dom',
          include: ['tests/unit/client/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],
  },
});
