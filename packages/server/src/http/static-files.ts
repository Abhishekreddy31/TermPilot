import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Files that must be revalidated on every load so an upgrade reaches the PWA. */
const REVALIDATE_EXTENSIONS = new Set(['.html', '.webmanifest']);
const REVALIDATE_FILES = new Set(['sw.js', 'registerSW.js']);
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/**
 * Locate the built client. In the npm package it sits next to the bundled
 * cli.js (dist/client); in the monorepo it is packages/client/dist.
 */
export function resolveClientDist(fromFile: string = fileURLToPath(import.meta.url)): string {
  const here = dirname(fromFile);
  const candidates = [
    resolve(here, 'client'),
    resolve(here, '..', '..', '..', 'client', 'dist'),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(join(candidate, 'index.html')).isFile()) return candidate;
    } catch {
      // Try the next layout.
    }
  }
  throw new Error(`Client build not found. Looked in:\n  ${candidates.join('\n  ')}\nRun "pnpm build" first.`);
}

/** Resolve a URL path inside `root`, or null if it escapes it. */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const target = resolve(root, `.${sep}${decoded}`);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return target;
}

function cacheControlFor(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf(sep) + 1);
  return REVALIDATE_EXTENSIONS.has(extname(filePath)) || REVALIDATE_FILES.has(name) ? 'no-cache' : IMMUTABLE_CACHE;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves the single-page client. Unknown paths without an extension are app
 * routes and get index.html; unknown asset paths get a real 404 so a missing
 * script is never answered with HTML.
 */
export function createStaticHandler(root: string) {
  const indexPath = join(root, 'index.html');

  return async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    let filePath = resolveInside(root, pathname === '/' ? '/index.html' : pathname);
    if (filePath === null) {
      res.writeHead(400).end('Bad request');
      return;
    }

    if (!(await isFile(filePath))) {
      if (extname(filePath) !== '') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      filePath = indexPath;
    }

    try {
      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': cacheControlFor(filePath),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(500).end('Internal server error');
    }
  };
}

/** Stands in for the client when it has not been built (e.g. `pnpm dev`, where Vite serves it). */
export function createMissingClientHandler(reason: string) {
  return function serveMissingClient(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end(reason);
  };
}
