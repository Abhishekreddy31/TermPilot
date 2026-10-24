/**
 * Diagnostic logging, off by default. Enable with TERMPILOT_DEBUG=1 to see connection
 * lifecycle events on stderr. Never logs tokens, passwords or terminal contents.
 */
const enabled = ['1', 'true', 'yes'].includes((process.env.TERMPILOT_DEBUG ?? '').toLowerCase());

export function debug(message: string): void {
  if (enabled) process.stderr.write(`[termpilot ${new Date().toISOString()}] ${message}\n`);
}
