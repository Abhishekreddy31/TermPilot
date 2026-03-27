import { createServer } from '../app.js';
import { TunnelManager } from '../tunnel/tunnel-manager.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Fix node-pty spawn-helper permissions (npm doesn't preserve +x on prebuilds)
// Walk up from the CLI script to find node_modules/node-pty/prebuilds
try {
  let searchDir = dirname(process.argv[1] || '');
  for (let i = 0; i < 5; i++) {
    const prebuildsDir = join(searchDir, 'node_modules', 'node-pty', 'prebuilds');
    try {
      for (const platform of readdirSync(prebuildsDir)) {
        try {
          chmodSync(join(prebuildsDir, platform, 'spawn-helper'), 0o755);
        } catch {}
      }
      break; // Found and fixed
    } catch {}
    searchDir = dirname(searchDir);
  }
} catch {}

// Injected by esbuild at build time; falls back for dev mode
declare const TERMPILOT_VERSION: string | undefined;
const VERSION = typeof TERMPILOT_VERSION !== 'undefined' ? TERMPILOT_VERSION : '1.0.0-dev';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Term-Pilot — Mobile terminal management with voice control

Usage:
  term-pilot [options]

Options:
  --port <port>    Port to listen on (default: 3000, env: PORT)
  --host <host>    Host to bind to (default: 127.0.0.1, env: HOST)
  --tunnel         Enable Cloudflare Tunnel for remote access (env: TUNNEL=1)
  --help, -h       Show this help message
  --version, -v    Show version

Environment variables:
  PORT                 Server port (default: 3000)
  HOST                 Bind address (default: 127.0.0.1)
  TUNNEL               Set to "1" to enable tunnel
  TERMPILOT_PASSWORD   Set a fixed password (otherwise auto-generated)
`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(`term-pilot v${VERSION}`);
  process.exit(0);
}

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

const PORT = parseInt(getArg('--port') || process.env.PORT || '3000', 10);
const ENABLE_TUNNEL = args.includes('--tunnel') || process.env.TUNNEL === '1';
const HOST = getArg('--host') || process.env.HOST || (ENABLE_TUNNEL ? '0.0.0.0' : '127.0.0.1');

async function main() {
  const server = await createServer({ port: PORT, host: HOST });

  if (!server.auth.hasUsers()) {
    const password = process.env.TERMPILOT_PASSWORD || randomBytes(12).toString('base64url');
    await server.auth.createUser('admin', password);

    console.log('');
    console.log('=== TermPilot Server ===');
    console.log(`  Local:    http://localhost:${server.port}`);
    console.log(`  User:     admin`);

    if (!process.env.TERMPILOT_PASSWORD) {
      try {
        const credDir = join(process.env.HOME || '/tmp', '.termpilot');
        mkdirSync(credDir, { recursive: true, mode: 0o700 });
        const credFile = join(credDir, 'credentials');
        writeFileSync(credFile, `admin:${password}\n`, { mode: 0o600 });
        console.log(`  Password: written to ${credFile}`);
      } catch {
        console.warn('  Password: Could not write credentials file.');
        process.stderr.write(`  [one-time] Password: ${password}\n`);
      }
    } else {
      console.log('  Password: (set via TERMPILOT_PASSWORD env var)');
    }
    console.log('');
  } else {
    console.log(`TermPilot running on http://${HOST}:${server.port}`);
  }

  // Check tmux availability
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    const isMac = process.platform === 'darwin';
    const isWin = process.platform === 'win32';
    const installCmd = isMac ? 'brew install tmux' : isWin ? 'wsl sudo apt install tmux' : 'sudo apt install tmux';
    console.log(`  Note:     tmux not found. Mirror mode requires tmux.`);
    console.log(`            Install with: ${installCmd}`);
    console.log('');
  }

  let tunnel: TunnelManager | null = null;
  if (ENABLE_TUNNEL) {
    console.log('  !! SECURITY WARNING !!');
    console.log('  Tunnel mode exposes this server to the PUBLIC INTERNET.');
    console.log('  Use a STRONG password. Do not share the tunnel URL.');
    console.log('');

    tunnel = new TunnelManager(server.port);
    tunnel.onStateChange((state, url) => {
      if (state === 'running' && url) {
        console.log(`  Tunnel:   ${url}`);
        console.log('');
      } else if (state === 'error') {
        console.log('  Tunnel:   Failed (is cloudflared installed?)');
      }
    });
    tunnel.start();
  } else {
    console.log('  Tunnel:   disabled (use --tunnel to enable)');
    console.log('');
  }

  console.log('========================');
  console.log('');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // Prevent double shutdown
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    tunnel?.stop();
    await server.close();
    process.exitCode = 0;
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
  });
}

main().catch((err) => {
  // User-friendly port-in-use message
  if (err?.code === 'EADDRINUSE') {
    console.error(`Error: Port ${PORT} is already in use.`);
    console.error(`Try: term-pilot --port ${PORT + 1}`);
  } else {
    console.error('Failed to start server:', err);
  }
  process.exit(1);
});
