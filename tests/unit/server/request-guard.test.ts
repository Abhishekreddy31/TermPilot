import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { hostname } from 'node:os';
import {
  HostGuard,
  clientAddress,
  defaultAllowedHosts,
  hostnameFromHostHeader,
  isWildcardHost,
  localInterfaceAddresses,
  machineHostnames,
} from '../../../packages/server/src/http/request-guard.js';

function request(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

describe('hostnameFromHostHeader', () => {
  it.each([
    ['localhost:3000', 'localhost'],
    ['Example.COM', 'example.com'],
    ['[::1]:3000', '::1'],
    ['192.168.1.5:80', '192.168.1.5'],
    ['example.com.:3000', 'example.com'],
  ])('%s → %s', (header, expected) => {
    expect(hostnameFromHostHeader(header)).toBe(expected);
  });

  it('rejects missing or malformed headers', () => {
    expect(hostnameFromHostHeader(undefined)).toBeNull();
    expect(hostnameFromHostHeader('')).toBeNull();
    expect(hostnameFromHostHeader('a b')).toBeNull();
  });
});

describe('HostGuard', () => {
  const guard = new HostGuard(['localhost', '127.0.0.1', '::1', '.trycloudflare.com']);

  it('accepts configured hosts with any port', () => {
    expect(guard.isAllowedHost('localhost:3000')).toBe(true);
    expect(guard.isAllowedHost('127.0.0.1:1')).toBe(true);
    expect(guard.isAllowedHost('[::1]:3000')).toBe(true);
  });

  it('rejects DNS-rebinding hostnames that resolve to loopback', () => {
    expect(guard.isAllowedHost('attacker.example:3000')).toBe(false);
    expect(guard.isAllowedHost('localhost.attacker.example')).toBe(false);
    expect(guard.isAllowedHost(undefined)).toBe(false);
  });

  it('matches suffix entries against the domain and its subdomains only', () => {
    expect(guard.isAllowedHost('abc-def.trycloudflare.com')).toBe(true);
    expect(guard.isAllowedHost('trycloudflare.com')).toBe(true);
    expect(guard.isAllowedHost('eviltrycloudflare.com')).toBe(false);
  });

  it('allows hostnames added later (the tunnel URL)', () => {
    const g = new HostGuard(['localhost']);
    expect(g.isAllowedHost('x.trycloudflare.com')).toBe(false);
    g.allow('X.trycloudflare.com');
    expect(g.isAllowedHost('x.trycloudflare.com')).toBe(true);
  });

  it('re-reads dynamic hostnames on every check, so a new network address is accepted', () => {
    let current = ['192.168.1.10'];
    const g = new HostGuard(['localhost'], () => current);
    expect(g.isAllowedHost('192.168.1.10:3000')).toBe(true);
    current = ['10.0.0.7'];
    expect(g.isAllowedHost('10.0.0.7:3000')).toBe(true);
    expect(g.isAllowedHost('192.168.1.10:3000')).toBe(false);
  });

  it('checks browser origins against the same list', () => {
    expect(guard.isAllowedOrigin(undefined)).toBe(true);
    expect(guard.isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(guard.isAllowedOrigin('https://a.trycloudflare.com')).toBe(true);
    expect(guard.isAllowedOrigin('https://attacker.example')).toBe(false);
    expect(guard.isAllowedOrigin('null')).toBe(false);
    expect(guard.isAllowedOrigin('file://localhost')).toBe(false);
  });

  it('requires both the host and the origin to pass', () => {
    expect(guard.check(request('127.0.0.1', { host: 'localhost:3000' }))).toBe(true);
    expect(guard.check(request('127.0.0.1', { host: 'localhost:3000', origin: 'https://attacker.example' }))).toBe(false);
  });
});

describe('defaultAllowedHosts', () => {
  it('always includes loopback names', () => {
    expect(defaultAllowedHosts('127.0.0.1')).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1']));
  });

  it('adds a specific bind address', () => {
    expect(defaultAllowedHosts('10.1.2.3')).toContain('10.1.2.3');
  });

  it('describes this machine by its current addresses and names', () => {
    const names = machineHostnames();
    for (const address of localInterfaceAddresses()) expect(names).toContain(address);
    expect(names).toContain(hostname().toLowerCase().replace(/\.$/, ''));
    expect(names.some((h) => h.endsWith('.local'))).toBe(true);
  });

  it('keeps only loopback names fixed for a wildcard bind (the rest is checked live)', () => {
    expect(defaultAllowedHosts('0.0.0.0')).toEqual(['localhost', '127.0.0.1', '::1']);
    expect(defaultAllowedHosts('::')).toEqual(defaultAllowedHosts('0.0.0.0'));
  });

  it('recognises wildcard binds', () => {
    expect(isWildcardHost('0.0.0.0')).toBe(true);
    expect(isWildcardHost('::')).toBe(true);
    expect(isWildcardHost('127.0.0.1')).toBe(false);
  });
});

describe('clientAddress', () => {
  it('uses the peer address by default, ignoring forwarded headers', () => {
    expect(clientAddress(request('10.0.0.9', { 'cf-connecting-ip': '1.2.3.4' }), false)).toBe('10.0.0.9');
  });

  it('trusts CF-Connecting-IP only from a loopback peer in tunnel mode', () => {
    expect(clientAddress(request('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' }), true)).toBe('1.2.3.4');
    expect(clientAddress(request('::ffff:127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' }), true)).toBe('1.2.3.4');
    expect(clientAddress(request('192.168.1.20', { 'cf-connecting-ip': '1.2.3.4' }), true)).toBe('192.168.1.20');
    expect(clientAddress(request('127.0.0.1'), true)).toBe('127.0.0.1');
  });
});
