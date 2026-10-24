import { parseArgs } from 'node:util';
import { SERVER_DEFAULTS } from '../app.js';

export const CLI_DEFAULTS = {
  port: 3000,
  /** How many following ports to try when the requested one is busy. */
  portRetries: 10,
} as const;

export interface CliConfig {
  port: number;
  host: string;
  tunnel: boolean;
  allowedHosts: string[];
  password: string | undefined;
  help: boolean;
  version: boolean;
}

export class ConfigError extends Error {}

const TRUE_VALUES = new Set(['1', 'true', 'yes']);

function parsePort(value: string, source: string): number {
  if (!/^\d+$/.test(value)) throw new ConfigError(`Invalid port from ${source}: "${value}"`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new ConfigError(`Port from ${source} must be between 1 and 65535, got ${port}`);
  return port;
}

function parseList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

/** Merge command-line flags over environment variables over defaults. */
export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): CliConfig {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        tunnel: { type: 'boolean' },
        'allowed-hosts': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }

  const port = values.port !== undefined
    ? parsePort(values.port, '--port')
    : env.PORT
      ? parsePort(env.PORT, 'PORT')
      : CLI_DEFAULTS.port;

  return {
    port,
    // The tunnel reaches the server over loopback, so tunnel mode does not need a wider bind.
    host: values.host ?? env.HOST ?? SERVER_DEFAULTS.host,
    tunnel: values.tunnel ?? TRUE_VALUES.has((env.TUNNEL ?? '').toLowerCase()),
    allowedHosts: [...parseList(env.TERMPILOT_ALLOWED_HOSTS), ...parseList(values['allowed-hosts'])],
    password: env.TERMPILOT_PASSWORD || undefined,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

export const HELP_TEXT = `
TermPilot — control this computer's terminal from your phone

Usage:
  term-pilot [options]

Options:
  -p, --port <port>          Port to listen on (default: ${CLI_DEFAULTS.port}; the next ${CLI_DEFAULTS.portRetries} are tried if busy)
      --host <address>       Address to bind (default: ${SERVER_DEFAULTS.host}).
                             Use 0.0.0.0 to allow phones on the same network.
      --tunnel               Expose a public HTTPS URL through Cloudflare Tunnel
      --allowed-hosts <list> Extra hostnames the server may be reached by, comma separated
                             (a leading dot allows subdomains, e.g. .example.com)
  -h, --help                 Show this help
  -v, --version              Show the version

Environment variables:
  PORT, HOST                 Same as --port and --host
  TUNNEL=1                   Same as --tunnel
  TERMPILOT_ALLOWED_HOSTS    Same as --allowed-hosts
  TERMPILOT_PASSWORD         Use this password instead of generating one
`;
