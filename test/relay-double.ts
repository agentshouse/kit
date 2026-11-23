import { STATUS_CODES, createServer as createHttpServer, request, type RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { onTestFinished } from 'vitest';
import type { Certificate } from './double.ts';
import { RELAYED } from './store.ts';

export interface Limit {
  status: number;
  headers?: Record<string, string>;
}

export interface Relayed {
  method: string;
  host: string;
  path: string;
  limited: boolean;
}

export interface Relay {
  origin: string;
  requests: Relayed[];
  limit(limit: Limit | null, answers?: number): void;
}

const LIMIT_PAGE = '<!DOCTYPE html><html><head><title>Error 1027</title></head><body>This website has been temporarily rate limited</body></html>';

function addressed(url: string): { host: string; path: string } {
  const [, host, path] = /^\/([^/]+)(\/.*)$/u.exec(url)!;
  return { host: host!, path: path! };
}

export async function startRelay(tls?: Certificate): Promise<Relay> {
  let limit: Limit | null = null;
  let left = Infinity;
  const requests: Relayed[] = [];
  const tunnels = new Set<Duplex>();
  const limited = (method: string, host: string, path: string): Limit | null => {
    const held = left > 0 ? limit : null;
    if (held !== null && --left === 0) limit = null;
    requests.push({ method, host, path, limited: held !== null });
    return held;
  };
  const relayed: RequestListener = (inbound, response) => {
    const { host, path } = addressed(inbound.url ?? '/');
    const held = limited(inbound.method!, host, path);
    if (held !== null) {
      inbound.resume();
      response.writeHead(held.status, { 'content-type': 'text/html', ...held.headers }).end(LIMIT_PAGE);
      return;
    }
    const outbound = request(`http://${host}${path}`, { method: inbound.method, headers: { ...inbound.headers, host, [RELAYED]: 'true' } }, (answer) => {
      response.writeHead(answer.statusCode!, answer.headers);
      answer.pipe(response);
    });
    outbound.on('error', () => response.destroy());
    inbound.pipe(outbound);
  };
  const server = tls === undefined ? createHttpServer(relayed) : createHttpsServer({ key: tls.key, cert: tls.cert }, relayed);
  server.on('upgrade', (inbound, socket: Duplex, head: Buffer) => {
    const { host, path } = addressed(inbound.url ?? '/');
    const held = limited('UPGRADE', host, path);
    if (held !== null) {
      const headers = Object.entries({ 'Content-Type': 'text/html', ...held.headers }).map(([name, value]) => `${name}: ${value}`);
      socket.end(
        [`HTTP/1.1 ${held.status} ${STATUS_CODES[held.status]}`, 'Connection: close', ...headers, `Content-Length: ${Buffer.byteLength(LIMIT_PAGE)}`, '', LIMIT_PAGE].join('\r\n'),
      );
      return;
    }
    const [hostname, port] = host.split(':');
    const upstream: Socket = connect(Number(port), hostname!, () => {
      const lines = [`${inbound.method} ${path} HTTP/1.1`];
      for (let index = 0; index < inbound.rawHeaders.length; index += 2) {
        const name = inbound.rawHeaders[index]!;
        lines.push(`${name}: ${name.toLowerCase() === 'host' ? host : inbound.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    tunnels.add(socket).add(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(async () => {
    for (const tunnel of tunnels) tunnel.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    origin: `${tls === undefined ? 'http' : 'https'}://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    limit: (next, answers = Infinity) => {
      limit = next;
      left = answers;
    },
  };
}
