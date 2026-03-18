#!/usr/bin/env node

/**
 * Build script for npm publishing.
 * Assembles a flat dist/ directory with:
 *   dist/cli/cli.js         — CLI entry point (with shebang)
 *   dist/app.js             — HTTP + WebSocket server
 *   dist/terminal/           — PTY and tmux managers
 *   dist/auth/               — Auth service
 *   dist/tunnel/             — Tunnel manager
 *   dist/shared/             — Protocol types and Zod schemas
 *   dist/client/             — Pre-built Vite PWA output
 */

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

console.log('Building TermPilot for npm publishing...\n');

// Clean
rmSync(join(ROOT, 'dist'), { recursive: true, force: true });

// Build shared (TypeScript)
run('pnpm --filter @termpilot/shared build');

// Build client (Vite)
run('pnpm --filter @termpilot/client build');

// Build server (TypeScript)
run('pnpm --filter @termpilot/server build');

// Assemble dist/
const dist = join(ROOT, 'dist');
mkdirSync(dist, { recursive: true });

// Copy compiled server
cpSync(join(ROOT, 'packages/server/dist'), dist, { recursive: true });

// Copy compiled shared into dist/shared (for server imports)
mkdirSync(join(dist, 'shared'), { recursive: true });
cpSync(join(ROOT, 'packages/shared/dist'), join(dist, 'shared'), { recursive: true });

// Copy built client into dist/client
mkdirSync(join(dist, 'client'), { recursive: true });
cpSync(join(ROOT, 'packages/client/dist'), join(dist, 'client'), { recursive: true });

// Fix the CLI shebang
const cliPath = join(dist, 'cli', 'cli.js');
let cliContent = readFileSync(cliPath, 'utf8');
if (!cliContent.startsWith('#!')) {
  cliContent = '#!/usr/bin/env node\n' + cliContent;
  writeFileSync(cliPath, cliContent);
}

// Fix CLIENT_DIST path in app.js to point to dist/client (sibling directory)
const appPath = join(dist, 'app.js');
let appContent = readFileSync(appPath, 'utf8');
// The compiled path resolution points to ../../client/dist — fix it to ./client
appContent = appContent.replace(
  /resolve\(.*'\.\.', '\.\.', 'client', 'dist'\)/,
  `resolve(new URL('.', import.meta.url).pathname, 'client')`
);
writeFileSync(appPath, appContent);

console.log('\nBuild complete! dist/ is ready for npm publish.');
console.log('Files:');
run('find dist -type f | head -30');
