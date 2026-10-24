import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { listen } from '../../../packages/server/src/app.js';

function occupy(port: number): Promise<Server | null> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

describe('listen', () => {
  it('moves to the next free port', async () => {
    const blocker = (await occupy(0))!;
    const busy = (blocker.address() as { port: number }).port;
    const server = createServer();
    const port = await listen(server, busy, '127.0.0.1', 5);
    expect(port).toBeGreaterThan(busy);
    server.close();
    blocker.close();
  });

  it('fails cleanly with EADDRINUSE instead of trying a port above 65535', async () => {
    const blocker = await occupy(65535);
    if (!blocker) return; // the top port is taken by something else on this machine; nothing to test
    const error = await listen(createServer(), 65535, '127.0.0.1', 5).catch((e: NodeJS.ErrnoException) => e);
    expect((error as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
    blocker.close();
  });
});
