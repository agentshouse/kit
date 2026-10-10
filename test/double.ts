import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { onTestFinished } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

export interface Received {
  method: string;
  path: string;
  params: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: unknown;
  port: number;
}

export interface Answer {
  status?: number;
  body?: unknown;
  bytes?: { type: string; content: Buffer | string };
  headers?: Record<string, string>;
  drop?: boolean;
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

export interface Certificate {
  key: string;
  cert: string;
  path: string;
}

export interface Proxy {
  origin: string;
  tunnels: string[];
  carried(received: Received): boolean;
}

export interface House {
  origin: string;
  requests: Received[];
  sockets: KitSocket[];
  route(method: string, path: string, handler: Route): void;
  holdStreams(): () => void;
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

function bodyOf(chunks: Buffer[], type: string | undefined): unknown {
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) return null;
  return type?.startsWith('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes;
}

let issued: Certificate | null = null;

export function certificate(): Certificate {
  if (issued !== null) return issued;
  const directory = mkdtempSync(join(tmpdir(), 'kit-tls-'));
  const [key, cert] = [join(directory, 'key.pem'), join(directory, 'cert.pem')];
  const made = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=house', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert,
  ]);
  if (made.status !== 0) throw new Error(`openssl did not issue the test certificate: ${made.stderr}`);
  issued = { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8'), path: cert };
  return issued;
}

export async function startProxy(): Promise<Proxy> {
  const tunnels: string[] = [];
  const ports = new Set<number>();
  const open = new Set<Duplex>();
  const server = createServer((_request, response) => response.writeHead(403).end());
  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    tunnels.push(request.url!);
    const { hostname, port } = new URL(`http://${request.url}`);
    const upstream = connect(Number(port), hostname, () => {
      ports.add(upstream.localPort!);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on('close', () => open.delete(socket));
    }
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(async () => {
    for (const socket of open) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    tunnels,
    carried: (received) => ports.has(received.port),
  };
}

export async function startHouse(tls?: Certificate): Promise<House> {
  const routes: { method: string; pattern: string; handler: Route }[] = [];
  const requests: Received[] = [];
  const sockets: KitSocket[] = [];
  const serve = (request: IncomingMessage, response: ServerResponse) => {
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
        headers: request.headers,
        body: bodyOf(chunks, request.headers['content-type']),
        port: request.socket.remotePort!,
      };
      requests.push(received);
      const answer: Answer =
        route === undefined ? { status: 404, body: { error: { code: 'not_found', retryable: false } } } : await route.handler(received);
      if (answer.drop === true) {
        response.destroy();
        return;
      }
      if (answer.bytes !== undefined) {
        response.writeHead(answer.status ?? 200, { 'content-type': answer.bytes.type, ...answer.headers });
        response.end(answer.bytes.content);
        return;
      }
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      response.end(answer.body === undefined ? '{}' : JSON.stringify(answer.body));
    });
  };
  const server = tls === undefined ? createServer(serve) : createTlsServer({ key: tls.key, cert: tls.cert }, serve);
  const streams = new WebSocketServer({ noServer: true, handleProtocols: (offered) => [...offered][0] ?? false });
  let streamsHeld = Promise.resolve();
  server.on('upgrade', async (request, duplex, head) => {
    if (new URL(request.url ?? '/', 'http://house').pathname !== '/kit/stream') {
      duplex.destroy();
      return;
    }
    const received: Received = {
      method: 'UPGRADE',
      path: '/kit/stream',
      params: {},
      headers: request.headers,
      body: null,
      port: request.socket.remotePort!,
    };
    requests.push(received);
    const refusing = routes.find((candidate) => candidate.method === 'UPGRADE');
    const refusal = refusing === undefined ? undefined : await refusing.handler(received);
    if (refusal?.status !== undefined) {
      const body = JSON.stringify(refusal.body ?? {});
      duplex.end(
        [
          `HTTP/1.1 ${refusal.status} ${STATUS_CODES[refusal.status]}`,
          'Connection: close',
          ...(refusal.body === undefined ? [] : [`X-House-Refusal: ${body}`]),
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(body)}`,
          '',
          body,
        ].join('\r\n'),
      );
      return;
    }
    await streamsHeld;
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
    origin: `${tls === undefined ? 'http' : 'https'}://127.0.0.1:${port}`,
    requests,
    sockets,
    route: (method, pattern, handler) => {
      routes.unshift({ method, pattern, handler });
    },
    holdStreams: () => {
      let release!: () => void;
      streamsHeld = new Promise<void>((resolve) => {
        release = resolve;
      });
      onTestFinished(release);
      return release;
    },
  };
}

export async function until<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  // Ten seconds outlasts any one step of a real Kit process on a loaded runner and still fails a lost step inside the spec's deadline.
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    // Twenty milliseconds notices a met condition at once without starving the doubles that share this event loop.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Half a second outlasts the Kit's reaction to what a spec just did, so what it has not done by then it is not doing.
export const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
