import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../app.js';
import { TunnelManager } from '../tunnel/tunnel-manager.js';
import { TmuxManager } from '../terminal/tmux-manager.js';
import { isWildcardHost, localInterfaceAddresses } from '../http/request-guard.js';
import { CLI_DEFAULTS, ConfigError, HELP_TEXT, parseConfig } from './config.js';

// Injected by esbuild for the published bundle.
declare const TERMPILOT_VERSION: string | undefined;
const VERSION = typeof TERMPILOT_VERSION !== 'undefined' ? TERMPILOT_VERSION : '0.0.0-dev';

const ADMIN_USER = 'admin';
const GENERATED_PASSWORD_BYTES = 12;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function urlFor(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** Addresses a person can actually type into a browser for this bind address. */
function reachableUrls(bindHost: string, port: number): string[] {
  if (!isWildcardHost(bindHost)) return [urlFor(bindHost, port)];
  const lan = localInterfaceAddresses().filter((address) => !address.includes(':'));
  return [urlFor('localhost', port), ...lan.map((address) => urlFor(address, port))];
}

/** Store the generated password where only this user can read it. */
function writeCredentials(password: string): string {
  const dir = join(homedir(), '.termpilot');
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const file = join(dir, 'credentials');
  // `mode` only applies when creating; tighten an existing file before the new password goes in.
  try {
    chmodSync(file, PRIVATE_FILE_MODE);
  } catch {
    // Not there yet.
  }
  writeFileSync(file, `${ADMIN_USER}:${password}\n`, { mode: PRIVATE_FILE_MODE });
  chmodSync(dir, PRIVATE_DIR_MODE);
  return file;
}

async function main(): Promise<void> {
  let config;
  try {
    config = parseConfig(process.argv.slice(2), process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}\nRun "term-pilot --help" for usage.`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  if (config.help) {
    console.log(HELP_TEXT);
    return;
  }
  if (config.version) {
    console.log(`term-pilot v${VERSION}`);
    return;
  }

  let server;
  try {
    server = await createServer({
      port: config.port,
      host: config.host,
      portRetries: CLI_DEFAULTS.portRetries,
      allowedHosts: config.allowedHosts,
      trustTunnelProxy: config.tunnel,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      console.error(`Error: ports ${config.port}-${config.port + CLI_DEFAULTS.portRetries} are all in use. Pick another with --port.`);
    } else if (code === 'EADDRNOTAVAIL') {
      console.error(`Error: ${config.host} is not an address of this machine.`);
    } else {
      throw err;
    }
    process.exitCode = 1;
    return;
  }

  // Handle signals as soon as the server exists, so a Ctrl+C during startup still shuts down cleanly.
  let tunnel: TunnelManager | null = null;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    tunnel?.stop();
    await server.close();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const password = config.password ?? randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');
  await server.auth.createUser(ADMIN_USER, password);

  const lines = ['', `=== TermPilot v${VERSION} ===`];
  if (server.port !== config.port) lines.push(`  Note:     port ${config.port} was busy, using ${server.port}`);
  for (const [index, url] of reachableUrls(server.host, server.port).entries()) {
    lines.push(`  ${index === 0 ? 'Open:    ' : '         '} ${url}`);
  }
  lines.push(`  User:     ${ADMIN_USER}`);
  if (config.password) {
    lines.push('  Password: (from TERMPILOT_PASSWORD)');
  } else {
    try {
      lines.push(`  Password: written to ${writeCredentials(password)}`);
    } catch (err) {
      lines.push(`  Password: ${password}   (could not write credentials file: ${(err as Error).message})`);
    }
  }
  if (isWildcardHost(server.host)) {
    lines.push(
      '',
      '  Network access is plain HTTP: anyone on this network can see the traffic.',
      '  Browsers also only allow voice input over HTTPS or on localhost; use --tunnel for both.',
    );
  }
  console.log(lines.join('\n'));

  const tmux = new TmuxManager();
  if (!(await tmux.isAvailable())) console.log(`\n  Mirror:   unavailable. ${tmux.unavailableMessage()}`);

  if (config.tunnel) {
    console.log('\n  Tunnel:   starting... (this exposes the server to the internet; keep the password private)');
    tunnel = new TunnelManager(server.port, {
      targetHost: isWildcardHost(server.host) ? '127.0.0.1' : server.host,
    });
    tunnel.onStateChange((state, detail) => {
      if (state === 'running' && detail) {
        server.allowHost(new URL(detail).hostname);
        console.log(`  Tunnel:   ${detail}`);
      } else if (state === 'error') {
        console.log(`  Tunnel:   failed. ${detail ?? ''}`);
      }
    });
    tunnel.start();
  } else {
    console.log('\n  Tunnel:   off (use --tunnel for access from anywhere)');
  }
  console.log('');

}

main().catch((err: unknown) => {
  console.error('Failed to start TermPilot:', err);
  process.exitCode = 1;
});
