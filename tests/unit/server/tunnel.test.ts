import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { TunnelManager, cloudflaredInstallHint, parseTunnelUrl, type TunnelState } from '../../../packages/server/src/tunnel/tunnel-manager.js';
import { eventually } from '../../helpers/platform.js';

const FAKE = fileURLToPath(new URL('../../fixtures/fake-cloudflared.mjs', import.meta.url));

describe('parseTunnelUrl', () => {
  it('finds the quick-tunnel URL in cloudflared output', () => {
    expect(parseTunnelUrl('INF |  https://abc-def-1.trycloudflare.com  |')).toBe('https://abc-def-1.trycloudflare.com');
  });

  it('ignores cloudflared\'s own API host, which appears in its error messages', () => {
    expect(parseTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host')).toBeNull();
  });

  it('ignores other URLs', () => {
    expect(parseTunnelUrl('see https://developers.cloudflare.com/x')).toBeNull();
    expect(parseTunnelUrl('https://trycloudflare.com')).toBeNull();
  });
});

describe('cloudflaredInstallHint', () => {
  it('suggests the platform package manager', () => {
    expect(cloudflaredInstallHint('darwin')).toBe('brew install cloudflared');
    expect(cloudflaredInstallHint('win32')).toContain('winget');
    expect(cloudflaredInstallHint('linux')).toContain('developers.cloudflare.com');
  });
});

describe('TunnelManager', () => {
  let tunnel: TunnelManager | null = null;
  const states: Array<[TunnelState, string | undefined]> = [];

  afterEach(() => {
    tunnel?.stop();
    tunnel = null;
    states.length = 0;
    delete process.env.FAKE_CLOUDFLARED_MODE;
  });

  function start(mode: string, opts: { targetHost?: string } = {}) {
    process.env.FAKE_CLOUDFLARED_MODE = mode;
    tunnel = new TunnelManager(4321, { command: process.execPath, commandArgs: [FAKE], ...opts });
    tunnel.onStateChange((state, detail) => states.push([state, detail]));
    tunnel.start();
    return tunnel;
  }

  it('reports the public URL once cloudflared prints it', async () => {
    const t = start('url');
    expect(t.state).toBe('starting');
    await eventually(() => t.isRunning);
    expect(t.url).toBe('https://fake-tunnel-123.trycloudflare.com');
    expect(states).toEqual([['starting', undefined], ['running', 'https://fake-tunnel-123.trycloudflare.com']]);
  });

  it('targets the IPv4 loopback by default, never "localhost" (which may resolve to ::1)', async () => {
    const t = start('echo');
    await eventually(() => t.isRunning);
    expect(t.url).toBe('https://127-0-0-1-4321.trycloudflare.com');
  });

  it('targets a specific bind address when given one', async () => {
    const t = start('echo', { targetHost: '10.0.0.5' });
    await eventually(() => t.isRunning);
    expect(t.url).toBe('https://10-0-0-5-4321.trycloudflare.com');
  });

  it('reports an unexpected exit as an error', async () => {
    const t = start('crash');
    await eventually(() => t.state === 'error');
    expect(states.at(-1)?.[1]).toMatch(/exited unexpectedly \(code 3\)/);
  });

  it('explains how to install cloudflared when it is missing', async () => {
    tunnel = new TunnelManager(4321, { command: 'termpilot-no-such-binary' });
    tunnel.onStateChange((state, detail) => states.push([state, detail]));
    tunnel.start();
    await eventually(() => tunnel!.state === 'error');
    expect(states.at(-1)?.[1]).toContain('cloudflared is not installed');
  });

  it('stops cleanly without reporting an error', async () => {
    const t = start('url');
    await eventually(() => t.isRunning);
    t.stop();
    expect(t.state).toBe('stopped');
    expect(t.url).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(states.some(([state]) => state === 'error')).toBe(false);
  });
});
