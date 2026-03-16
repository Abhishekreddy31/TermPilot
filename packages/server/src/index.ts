import { createServer } from './app.js';
import { TunnelManager } from './tunnel/tunnel-manager.js';
import { randomBytes } from 'node:crypto';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ENABLE_TUNNEL = process.env.TUNNEL === '1' || process.argv.includes('--tunnel');

async function main() {
  const server = await createServer({
    port: PORT,
    host: HOST,
  });

  // Create default user if none exists
  if (!server.auth.hasUsers()) {
    const password = process.env.TERMPILOT_PASSWORD || randomBytes(12).toString('base64url');
    await server.auth.createUser('admin', password);
    console.log('');
    console.log('=== TermPilot Server ===');
    console.log(`  Local:    http://localhost:${server.port}`);
    console.log(`  User:     admin`);
    console.log(`  Password: ${password}`);
    console.log('');
    console.log('Set TERMPILOT_PASSWORD env var to use a custom password.');
  } else {
    console.log(`TermPilot server running on http://${HOST}:${server.port}`);
  }

  // Optional Cloudflare Tunnel for remote access
  let tunnel: TunnelManager | null = null;
  if (ENABLE_TUNNEL) {
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
    console.log('  Tunnel:   disabled (use --tunnel or TUNNEL=1 to enable)');
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
