#!/usr/bin/env node

/**
 * Builds the npm package into dist/:
 *   dist/cli.js     the server, bundled with esbuild (workspace code inlined;
 *                   third-party runtime dependencies stay external so npm installs
 *                   them and `npm audit` can see them)
 *   dist/client/    the built PWA
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function pnpm(...args) {
  console.log(`> pnpm ${args.join(' ')}`);
  // shell: true resolves pnpm's .cmd shim on Windows.
  execFileSync('pnpm', args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
}

rmSync(DIST, { recursive: true, force: true });
pnpm('--filter', '@termpilot/shared', 'build');
pnpm('--filter', '@termpilot/client', 'build');

console.log('> esbuild packages/server/src/cli/cli.ts');
await build({
  entryPoints: [join(ROOT, 'packages/server/src/cli/cli.ts')],
  outfile: join(DIST, 'cli.js'),
  bundle: true,
  platform: 'node',
  target: `node${pkg.engines.node.match(/\d+/)[0]}`,
  format: 'esm',
  external: Object.keys(pkg.dependencies),
  banner: { js: '#!/usr/bin/env node' },
  define: { TERMPILOT_VERSION: JSON.stringify(pkg.version) },
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
});

mkdirSync(join(DIST, 'client'), { recursive: true });
cpSync(join(ROOT, 'packages/client/dist'), join(DIST, 'client'), { recursive: true });

for (const required of ['cli.js', 'client/index.html', 'client/sw.js']) {
  if (!existsSync(join(DIST, required))) {
    console.error(`Build is incomplete: dist/${required} is missing`);
    process.exit(1);
  }
}
console.log(`\nBuilt ${pkg.name}@${pkg.version} into dist/`);
