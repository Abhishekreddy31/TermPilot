import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const IS_WINDOWS = process.platform === 'win32';

function run(command: string, args: string[], cwd: string): string {
  // shell: true resolves npm/pnpm .cmd shims on Windows.
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: IS_WINDOWS });
}

/** Use TERMPILOT_E2E_TARBALL (CI builds it once) or build and pack the working tree. */
function tarball(): string {
  const provided = process.env.TERMPILOT_E2E_TARBALL;
  if (provided) return resolve(provided);
  const out = mkdtempSync(join(tmpdir(), 'termpilot-pack-'));
  run('pnpm', ['run', 'build'], ROOT);
  run('npm', ['pack', '--pack-destination', out], ROOT);
  const file = readdirSync(out).find((name) => name.endsWith('.tgz'));
  if (!file) throw new Error('npm pack produced no tarball');
  return join(out, file);
}

export default function globalSetup(): void {
  const pkg = tarball();
  const prefix = mkdtempSync(join(tmpdir(), 'termpilot-install-'));
  run('npm', ['install', '--no-audit', '--no-fund', '--prefix', prefix, pkg], prefix);
  const cli = join(prefix, 'node_modules', '@abhishekreddy31', 'term-pilot', 'dist', 'cli.js');
  if (!existsSync(cli)) throw new Error(`Installed package has no dist/cli.js at ${cli}`);
  process.env.TERMPILOT_E2E_PREFIX = prefix;
  process.env.TERMPILOT_E2E_CLI = cli;
}
