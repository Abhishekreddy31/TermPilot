#!/usr/bin/env node

/**
 * Build script for npm publishing.
 * Uses esbuild to bundle the server (inlining @termpilot/shared)
 * while keeping native deps (node-pty, ws) as externals.
 * Copies pre-built client into dist/client/.
 */

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

console.log('Building TermPilot for npm publishing...\n');

// Clean
rmSync(join(ROOT, 'dist'), { recursive: true, force: true });

// Build shared (needed for esbuild to resolve imports)
run('pnpm --filter @termpilot/shared build');

// Build client (Vite)
run('pnpm --filter @termpilot/client build');

// Bundle server with esbuild — inlines @termpilot/shared, keeps native deps external
const dist = join(ROOT, 'dist');
mkdirSync(dist, { recursive: true });

console.log('> esbuild: bundling server...');

buildSync({
  entryPoints: [join(ROOT, 'packages/server/src/cli/cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: join(dist, 'cli.js'),
  external: ['node-pty', 'ws'],
  banner: { js: '#!/usr/bin/env node' },
  // Resolve workspace packages
  alias: {
    '@termpilot/shared': join(ROOT, 'packages/shared/src/index.ts'),
  },
  // Keep dynamic requires working
  mainFields: ['module', 'main'],
  resolveExtensions: ['.ts', '.js'],
  sourcemap: false,
  minify: false, // Keep readable for debugging
  define: {
    'TERMPILOT_VERSION': JSON.stringify(
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
    ),
  },
});

// Copy built client into dist/client
mkdirSync(join(dist, 'client'), { recursive: true });
cpSync(join(ROOT, 'packages/client/dist'), join(dist, 'client'), { recursive: true });

console.log('\nBuild complete! dist/ is ready for npm publish.');
run('ls -la dist/');
run('ls dist/client/ | head -10');
