import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createStaticHandler, resolveClientDist, resolveInside } from '../../../packages/server/src/http/static-files.js';
import { FIXTURE_CLIENT } from '../../helpers/server.js';

describe('resolveInside', () => {
  const root = join(tmpdir(), 'site');

  it('resolves ordinary paths inside the root', () => {
    expect(resolveInside(root, '/index.html')).toBe(join(root, 'index.html'));
    expect(resolveInside(root, '/assets/a%20b.js')).toBe(join(root, 'assets', 'a b.js'));
  });

  it.each([
    '/../secret',
    '/%2e%2e/secret',
    '/assets/../../secret',
    '/..%2fsecret',
    `/..${sep}secret`,
    '/a%00.js',
    '/%E0%A4%A',
  ])('refuses %s', (path) => {
    expect(resolveInside(root, path)).toBeNull();
  });

  it('does not confuse a sibling directory sharing the prefix with the root', () => {
    expect(resolveInside(root, '/../site-other/file')).toBeNull();
  });
});

describe('resolveClientDist', () => {
  it('finds the packaged layout next to the bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-dist-'));
    mkdirSync(join(dir, 'client'));
    writeFileSync(join(dir, 'client', 'index.html'), '<html></html>');
    expect(resolveClientDist(join(dir, 'cli.js'))).toBe(join(dir, 'client'));
  });

  it('explains where it looked when the client is not built', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-empty-'));
    expect(() => resolveClientDist(join(dir, 'cli.js'))).toThrow(/Client build not found[\s\S]*pnpm build/);
  });
});

async function withStatic<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const handler = createStaticHandler(FIXTURE_CLIENT);
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('createStaticHandler', () => {
  it('serves files with their type and long-lived caching for hashed assets', () =>
    withStatic(async (base) => {
      const res = await fetch(`${base}/assets/app.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      expect(res.headers.get('cache-control')).toContain('immutable');
    }));

  it('revalidates HTML and the manifest so updates reach the PWA', () =>
    withStatic(async (base) => {
      expect((await fetch(`${base}/`)).headers.get('cache-control')).toBe('no-cache');
      const manifest = await fetch(`${base}/manifest.webmanifest`);
      expect(manifest.headers.get('content-type')).toContain('application/manifest+json');
      expect(manifest.headers.get('cache-control')).toBe('no-cache');
    }));

  it('answers app routes with index.html', () =>
    withStatic(async (base) => {
      const res = await fetch(`${base}/some/route`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('TermPilot test fixture');
    }));

  it('answers missing assets with 404, not HTML', () =>
    withStatic(async (base) => {
      const res = await fetch(`${base}/assets/missing.js`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/plain');
    }));

  it('supports HEAD and rejects other methods', () =>
    withStatic(async (base) => {
      const head = await fetch(`${base}/assets/app.js`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      const post = await fetch(`${base}/`, { method: 'POST' });
      expect(post.status).toBe(405);
      expect(post.headers.get('allow')).toBe('GET, HEAD');
    }));
});

describe('createMissingClientHandler', () => {
  it('explains that the client is not built instead of failing to start', async () => {
    const { createMissingClientHandler } = await import('../../../packages/server/src/http/static-files.js');
    const server: Server = createServer((req, res) => createMissingClientHandler('Client build not found')(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('Client build not found');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
