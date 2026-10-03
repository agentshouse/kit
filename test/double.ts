import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { onTestFinished } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

export interface Received {
  method: string;
  path: string;
  params: Record<string, string>;
  body: unknown;
}

export interface Answer {
  status?: number;
  body?: unknown;
}

export type Route = (request: Received) => Answer | Promise<Answer>;

export interface KitSocket {
  headers: IncomingHttpHeaders;
  protocol: string;
  frames: Record<string, unknown>[];
  socket: WebSocket;
  send(frame: Record<string, unknown>): void;
  close(code: number, reason: string): void;
}

export interface House {
  origin: string;
  requests: Received[];
  sockets: KitSocket[];
  route(method: string, path: string, handler: Route): void;
}

function matched(pattern: string, path: string): Record<string, string> | null {
  const expected = pattern.split('/');
  const actual = path.split('/');
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(actual[index]!);
    else if (segment !== actual[index]) return null;
  }
  return params;
}

function bodyOf(chunks: Buffer[]): unknown {
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length === 0 ? null : JSON.parse(text);
}

export async function startHouse(): Promise<House> {
  const routes: { method: string; pattern: string; handler: Route }[] = [];
  const requests: Received[] = [];
  const sockets: KitSocket[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      const path = new URL(request.url ?? '/', 'http://house').pathname;
      const method = request.method ?? 'GET';
      const route = routes.find((candidate) => candidate.method === method && matched(candidate.pattern, path) !== null);
      const received: Received = {
        method,
        path,
        params: route === undefined ? {} : matched(route.pattern, path)!,
        body: bodyOf(chunks),
      };
      requests.push(received);
      const answer =
        route === undefined ? { status: 404, body: { error: { code: 'not_found' } } } : await route.handler(received);
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      response.end(answer.body === undefined ? '{}' : JSON.stringify(answer.body));
    });
  });
  const streams = new WebSocketServer({ noServer: true, handleProtocols: (offered) => [...offered][0] ?? false });
  server.on('upgrade', (request, duplex, head) => {
    if (new URL(request.url ?? '/', 'http://house').pathname !== '/kit/stream') {
      duplex.destroy();
      return;
    }
    requests.push({ method: 'UPGRADE', path: '/kit/stream', params: {}, body: null });
    streams.handleUpgrade(request, duplex, head, (socket) => {
      const held: KitSocket = {
        headers: request.headers,
        protocol: socket.protocol,
        frames: [],
        socket,
        send: (frame) => socket.send(JSON.stringify(frame)),
        close: (code, reason) => socket.close(code, reason),
      };
      socket.on('message', (data) => held.frames.push(JSON.parse(String(data)) as Record<string, unknown>));
      sockets.push(held);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  onTestFinished(async () => {
    for (const held of sockets) held.socket.terminate();
    streams.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    sockets,
    route: (method, pattern, handler) => {
      routes.unshift({ method, pattern, handler });
    },
  };
}

export async function until<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
