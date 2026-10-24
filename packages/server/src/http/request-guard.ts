import type { IncomingMessage } from 'node:http';
import { hostname as osHostname, networkInterfaces } from 'node:os';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '']);

export function isWildcardHost(host: string): boolean {
  return WILDCARD_BIND_HOSTS.has(host);
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

/** Hostname part of a Host header (`example.com:3000`, `[::1]:3000`), or null if malformed. */
export function hostnameFromHostHeader(header: string | undefined): string | null {
  if (!header) return null;
  try {
    const { hostname } = new URL(`http://${header}`);
    return hostname ? normalizeHostname(hostname) : null;
  } catch {
    return null;
  }
}

/** Non-internal IPv4/IPv6 addresses of this machine. */
export function localInterfaceAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal) addresses.push(normalizeHostname(entry.address));
    }
  }
  return addresses;
}

/** This machine's current addresses and names (they change when it joins another network). */
export function machineHostnames(): string[] {
  const machine = normalizeHostname(osHostname());
  // mDNS name: macOS and most Linux desktops answer to <hostname>.local.
  const names = machine.endsWith('.local') ? [machine] : [machine, `${machine}.local`];
  return [...localInterfaceAddresses(), ...names];
}

/** Fixed hostnames for a server bound to `bindHost`; wildcard binds add {@link machineHostnames} at check time. */
export function defaultAllowedHosts(bindHost: string): string[] {
  return isWildcardHost(bindHost) ? [...LOOPBACK_HOSTS] : [...new Set([...LOOPBACK_HOSTS, normalizeHostname(bindHost)])];
}

/**
 * Accepts requests only for hostnames this server is meant to be reached by.
 *
 * Binding to localhost is not enough on its own: with DNS rebinding a web page on
 * attacker.example can make its own hostname resolve to 127.0.0.1 and then talk to
 * the server as if same-origin. Its requests still carry `Host: attacker.example`,
 * which this guard rejects. Entries starting with `.` match a domain and its subdomains.
 */
export class HostGuard {
  private readonly exact = new Set<string>();
  private readonly suffixes = new Set<string>();

  /**
   * @param dynamic hostnames re-read on every check, e.g. {@link machineHostnames} for a
   *   wildcard bind, so a laptop that changes network keeps accepting its new address.
   */
  constructor(entries: Iterable<string> = [], private readonly dynamic: () => string[] = () => []) {
    for (const entry of entries) this.allow(entry);
  }

  allow(entry: string): void {
    const value = normalizeHostname(entry);
    if (!value) return;
    if (value.startsWith('.')) this.suffixes.add(value);
    else this.exact.add(value);
  }

  isAllowedHostname(hostname: string): boolean {
    const value = normalizeHostname(hostname);
    if (this.exact.has(value)) return true;
    for (const suffix of this.suffixes) {
      if (value === suffix.slice(1) || value.endsWith(suffix)) return true;
    }
    return this.dynamic().some((entry) => normalizeHostname(entry) === value);
  }

  isAllowedHost(hostHeader: string | undefined): boolean {
    const hostname = hostnameFromHostHeader(hostHeader);
    return hostname !== null && this.isAllowedHostname(hostname);
  }

  /** Requests without an Origin header (same-origin GETs, non-browser clients) are allowed. */
  isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      return this.isAllowedHostname(url.hostname);
    } catch {
      return false;
    }
  }

  check(req: IncomingMessage): boolean {
    return this.isAllowedHost(req.headers.host) && this.isAllowedOrigin(req.headers.origin);
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * The address to rate-limit by. Behind Cloudflare Tunnel every request arrives
 * from the local cloudflared process, so the real client is taken from
 * CF-Connecting-IP, but only when the peer is loopback: a remote client cannot
 * reach a loopback peer address, so it cannot forge that header.
 */
export function clientAddress(req: IncomingMessage, trustTunnelHeader: boolean): string {
  const peer = req.socket.remoteAddress;
  if (trustTunnelHeader && isLoopbackAddress(peer)) {
    const forwarded = req.headers['cf-connecting-ip'];
    if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded;
  }
  return peer ?? 'unknown';
}
