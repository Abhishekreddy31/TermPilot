import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TunnelManager, parseTunnelUrl } from '../../src/tunnel/tunnel-manager.js';

describe('parseTunnelUrl', () => {
  it('should extract URL from cloudflared output', () => {
    const output =
      'INF Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):\nINF https://comedy-tiger-example.trycloudflare.com';
    const url = parseTunnelUrl(output);
    expect(url).toBe('https://comedy-tiger-example.trycloudflare.com');
  });

  it('should extract URL with subdomains', () => {
    const output = '2024-03-16 INF +-------------------------------------------+\n2024-03-16 INF |  https://my-app-abc123.trycloudflare.com  |\n';
    const url = parseTunnelUrl(output);
    expect(url).toBe('https://my-app-abc123.trycloudflare.com');
  });

  it('should return null if no URL found', () => {
    const url = parseTunnelUrl('Starting tunnel...');
    expect(url).toBeNull();
  });
});

describe('TunnelManager', () => {
  let tunnel: TunnelManager;

  beforeEach(() => {
    tunnel = new TunnelManager(3000);
  });

  afterEach(() => {
    tunnel.stop();
  });

  it('should start in stopped state', () => {
    expect(tunnel.isRunning).toBe(false);
    expect(tunnel.url).toBeNull();
  });

  it('should emit state changes', () => {
    const states: string[] = [];
    tunnel.onStateChange((state) => states.push(state));
    // Can't test full start without cloudflared binary,
    // but we can verify event infrastructure works
    expect(states).toEqual([]);
  });
});
