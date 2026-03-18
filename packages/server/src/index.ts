import { createServer } from './app.js';
import { TunnelManager } from './tunnel/tunnel-manager.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ENABLE_TUNNEL = process.env.TUNNEL === '1' || process.argv.includes('--tunnel');

async function main() {
  // When tunnel is enabled, bind to all interfaces
  const bindHost = ENABLE_TUNNEL ? '0.0.0.0' : (process.env.HOST || '127.0.0.1');

  const server = await createServer({
    port: PORT,
    host: bindHost,
  });

  // Create default user if none exists
  if (!server.auth.hasUsers()) {
    const password = process.env.TERMPILOT_PASSWORD || randomBytes(12).toString('base64url');
    await server.auth.createUser('admin', password);

    console.log('');
    console.log('=== TermPilot Server ===');
    console.log(`  Local:    http://localhost:${server.port}`);
    console.log(`  User:     admin`);

    // Write password to a temp file instead of logging to stdout
    // (prevents credential leakage via log aggregation systems)
    if (!process.env.TERMPILOT_PASSWORD) {
      try {
        const credDir = join(process.env.HOME || '/tmp', '.termpilot');
        mkdirSync(credDir, { recursive: true, mode: 0o700 });
        const credFile = join(credDir, 'credentials');
        writeFileSync(credFile, `admin:${password}\n`, { mode: 0o600 });
        console.log(`  Password: written to ${credFile}`);
      } catch {
        // Fallback: log warning, never print password to stdout
        console.warn('  Password: Could not write credentials file.');
        console.warn(`             Set TERMPILOT_PASSWORD env var or create ~/.termpilot/credentials manually.`);
        // Write to stderr as last resort (less likely to be captured by log aggregators)
        process.stderr.write(`  [one-time] Password: ${password}\n`);
      }
    } else {
      console.log('  Password: (set via TERMPILOT_PASSWORD env var)');
    }

    console.log('');
    console.log('Tip: Set TERMPILOT_PASSWORD env var to use a fixed password.');
  } else {
    console.log(`TermPilot server running on http://${bindHost}:${server.port}`);
  }

  // Optional Cloudflare Tunnel for remote access
  let tunnel: TunnelManager | null = null;
  if (ENABLE_TUNNEL) {
    console.log('');
    console.log('  !! SECURITY WARNING !!');
    console.log('  Tunnel mode exposes this server to the PUBLIC INTERNET.');
    console.log('  Anyone with the URL can attempt to log in.');
    console.log('  Use a STRONG password. Do not share the tunnel URL.');
    console.log('  For production use, set up a named Cloudflare Tunnel');
    console.log('  with Cloudflare Access policies for additional protection.');
    console.log('');

    tunnel = new TunnelManager(server.port);
    tunnel.onStateChange((state, url) => {
      if (state === 'running' && url) {
        console.log(`  Tunnel:   ${url}`);
        console.log('');
      } else if (state === 'error') {
        console.log('  Tunnel:   Failed (is cloudflared installed?)');
        console.log('');
      }
    });
    tunnel.start();
  } else {
    console.log(`  Tunnel:   disabled (use --tunnel or TUNNEL=1 to enable)`);
    console.log('');
  }

  console.log('========================');
  console.log('');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    tunnel?.stop();
    await server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
