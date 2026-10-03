import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { onTestFinished } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

export interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
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

function bodyOf(chunks: Buffer[]): unknown {
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startHouse(): Promise<House> {
  const routes = new Map<string, Route>();
  const requests: Received[] = [];
  const sockets: KitSocket[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      const path = new URL(request.url ?? '/', 'http://house').pathname;
      const received: Received = {
        method: request.method ?? 'GET',
        path,
        headers: request.headers,
        body: bodyOf(chunks),
      };
      requests.push(received);
      const handler = routes.get(`${received.method} ${path}`);
      const answer = handler === undefined ? { status: 404, body: { error: { code: 'not_found' } } } : await handler(received);
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
    route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
  };
}

export async function until<T>(read: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
