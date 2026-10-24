import { describe, expect, it } from 'vitest';
import { CLI_DEFAULTS, ConfigError, HELP_TEXT, parseConfig } from '../../../packages/server/src/cli/config.js';
import { SERVER_DEFAULTS } from '../../../packages/server/src/app.js';

describe('parseConfig', () => {
  it('uses safe defaults', () => {
    expect(parseConfig([], {})).toEqual({
      port: CLI_DEFAULTS.port,
      host: SERVER_DEFAULTS.host,
      tunnel: false,
      allowedHosts: [],
      password: undefined,
      help: false,
      version: false,
    });
  });

  it('keeps the loopback bind in tunnel mode (cloudflared connects locally)', () => {
    const config = parseConfig(['--tunnel'], {});
    expect(config.tunnel).toBe(true);
    expect(config.host).toBe('127.0.0.1');
  });

  it('prefers flags over environment variables', () => {
    const env = { PORT: '4000', HOST: '0.0.0.0', TUNNEL: '1' };
    expect(parseConfig([], env)).toMatchObject({ port: 4000, host: '0.0.0.0', tunnel: true });
    expect(parseConfig(['--port', '5000', '--host', '::1'], env)).toMatchObject({ port: 5000, host: '::1' });
    expect(parseConfig(['-p', '6000'], {}).port).toBe(6000);
  });

  it('accepts the usual truthy spellings for TUNNEL', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes']) expect(parseConfig([], { TUNNEL: value }).tunnel).toBe(true);
    for (const value of ['0', 'false', '']) expect(parseConfig([], { TUNNEL: value }).tunnel).toBe(false);
  });

  it('merges allowed hosts from the environment and the flag', () => {
    const config = parseConfig(['--allowed-hosts', 'b.example, .lan'], { TERMPILOT_ALLOWED_HOSTS: 'a.example' });
    expect(config.allowedHosts).toEqual(['a.example', 'b.example', '.lan']);
  });

  it('reads the password from the environment only', () => {
    expect(parseConfig([], { TERMPILOT_PASSWORD: 'pw' }).password).toBe('pw');
    expect(parseConfig([], { TERMPILOT_PASSWORD: '' }).password).toBeUndefined();
  });

  it.each(['0', '65536', 'abc', '80.5', '-1', ''])('rejects port %j', (port) => {
    expect(() => parseConfig(['--port', port], {})).toThrow(ConfigError);
  });

  it('rejects an invalid PORT environment variable', () => {
    expect(() => parseConfig([], { PORT: 'http' })).toThrow(/PORT/);
  });

  it('rejects unknown flags and stray arguments instead of ignoring them', () => {
    expect(() => parseConfig(['--tunel'], {})).toThrow(ConfigError);
    expect(() => parseConfig(['3000'], {})).toThrow(ConfigError);
  });

  it('parses help and version', () => {
    expect(parseConfig(['-h'], {}).help).toBe(true);
    expect(parseConfig(['--version'], {}).version).toBe(true);
  });

  it('documents every option in the help text', () => {
    for (const flag of ['--port', '--host', '--tunnel', '--allowed-hosts', '--help', '--version', 'TERMPILOT_PASSWORD', 'TERMPILOT_ALLOWED_HOSTS']) {
      expect(HELP_TEXT).toContain(flag);
    }
  });
});
