import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A server on 127.0.0.1 that answers every request and writes down what it was asked. A locked-down page must never
 * reach it: `hits` has to stay empty.
 */
export async function startProbeServer() {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    response.end('reached');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
