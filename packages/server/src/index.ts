import { createServer } from './app.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const server = await createServer({
    port: PORT,
    host: HOST,
  });

  // Create default user if none exists
  if (!server.auth.hasUsers()) {
    const password = process.env.TERMPILOT_PASSWORD || generatePassword();
    await server.auth.createUser('admin', password);
    console.log('');
    console.log('=== TermPilot Server ===');
    console.log(`  URL:      http://localhost:${server.port}`);
    console.log(`  User:     admin`);
    console.log(`  Password: ${password}`);
    console.log('');
    console.log('Set TERMPILOT_PASSWORD env var to use a custom password.');
    console.log('========================');
    console.log('');
  } else {
    console.log(`TermPilot server running on http://${HOST}:${server.port}`);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function generatePassword(): string {
  const { randomBytes } = require('node:crypto');
  return randomBytes(12).toString('base64url');
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
