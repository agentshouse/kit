import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { onTestFinished } from 'vitest';
import { stringify } from 'yaml';
import type { Certificate } from './double.ts';
import type { ToolResult } from './environment.ts';

export interface StoreRequest {
  method: string;
  key: string;
  part: number | null;
  status: number;
  bytes: number;
  relayed: boolean;
  port: number;
}

interface Upload {
  key: string;
  bytes: number;
  sha256: string;
  partBytes: number;
  parts: Map<number, number>;
  path: string;
  checks: number;
}

export interface Store {
  origin: string;
  requests: StoreRequest[];
  objects: Map<string, Buffer>;
  address(method: 'GET' | 'PUT', key: string, fields?: Record<string, string>, expired?: boolean): string;
  cut(part: number): void;
  declare(declared: { bytes: number; sha256: string; path: string }, partBytes: number, checks?: number): UploadAnswer;
  finish(id: string): Promise<UploadAnswer | { checking: true } | { path: string; revision: string } | { mismatch: true }>;
}

export interface UploadAnswer {
  upload: { id: string; part_bytes: number; parts: { part: number; url: string }[] };
}

export const RELAYED = 'x-test-relayed';

function partCount(bytes: number, partBytes: number): number {
  return Math.max(1, Math.ceil(bytes / partBytes));
}

function partSize(bytes: number, partBytes: number, part: number): number {
  return part < partCount(bytes, partBytes) ? partBytes : bytes - (part - 1) * partBytes;
}

export async function startStore(tls?: Certificate): Promise<Store> {
  const directory = await mkdtemp(join(tmpdir(), 'kit-store-'));
  const secret = randomBytes(32);
  const uploads = new Map<string, Upload>();
  const objects = new Map<string, Buffer>();
  const requests: StoreRequest[] = [];
  const cuts = new Set<number>();
  let revisions = 0;
  const signature = (method: string, address: URL) =>
    createHmac('sha256', secret)
      .update(JSON.stringify([method, address.pathname, [...address.searchParams].filter(([name]) => name !== 'signature').sort()]))
      .digest('hex');
  const partFile = (upload: string, part: number) => join(directory, `${upload}-${part}`);
  const served = async (request: IncomingMessage, response: ServerResponse) => {
    const address = new URL(request.url ?? '/', 'http://store');
    const key = address.pathname.slice(1);
    const part = address.searchParams.has('part') ? Number(address.searchParams.get('part')) : null;
    const relayed = request.headers[RELAYED] === 'true';
    const port = request.socket.remotePort!;
    const answer = (status: number, bytes = 0, body?: Buffer) => {
      requests.push({ method: request.method!, key, part, status, bytes, relayed, port });
      response.writeHead(status, body === undefined ? {} : { 'content-length': body.length }).end(body);
    };
    if (address.searchParams.get('signature') !== signature(request.method!, address)) return answer(403);
    if (Number(address.searchParams.get('expires')) < Date.now()) return answer(403);
    if (request.method === 'GET') {
      const object = objects.get(key);
      if (object === undefined) return answer(404);
      return answer(200, object.length, object);
    }
    const upload = uploads.get(address.searchParams.get('upload') ?? '');
    if (upload === undefined || part === null) return answer(404);
    const into = partFile(address.searchParams.get('upload')!, part);
    if (cuts.delete(part)) {
      requests.push({ method: 'PUT', key, part, status: 0, bytes: 0, relayed, port });
      request.once('data', () => request.socket.destroy());
      return;
    }
    await pipeline(request, createWriteStream(into));
    const { size } = await stat(into);
    upload.parts.set(part, size);
    answer(200, size);
  };
  const serve = (request: IncomingMessage, response: ServerResponse) => {
    served(request, response).catch(() => response.destroy());
  };
  const server = tls === undefined ? createServer(serve) : createTlsServer({ key: tls.key, cert: tls.cert }, serve);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `${tls === undefined ? 'http' : 'https'}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const address = (method: 'GET' | 'PUT', key: string, fields: Record<string, string> = {}, expired = false) => {
    const signed = new URL(`/${key}`, origin);
    for (const [name, value] of Object.entries(fields)) signed.searchParams.set(name, value);
    signed.searchParams.set('expires', String(Date.now() + (expired ? -1000 : 600_000)));
    signed.searchParams.set('signature', signature(method, signed));
    return signed.href;
  };
  const addresses = (id: string, upload: Upload, parts: number[]): UploadAnswer => ({
    upload: {
      id,
      part_bytes: upload.partBytes,
      parts: parts.map((part) => ({ part, url: address('PUT', upload.key, { upload: id, part: String(part) }) })),
    },
  });
  return {
    origin,
    requests,
    objects,
    address,
    cut: (part) => cuts.add(part),
    declare: (declared, partBytes, checks = 0) => {
      const id = randomUUID();
      const upload: Upload = { key: `binary/${randomUUID()}`, ...declared, partBytes, parts: new Map(), checks };
      uploads.set(id, upload);
      return addresses(id, upload, Array.from({ length: partCount(upload.bytes, partBytes) }, (_part, index) => index + 1));
    },
    finish: async (id) => {
      const upload = uploads.get(id)!;
      const all = Array.from({ length: partCount(upload.bytes, upload.partBytes) }, (_part, index) => index + 1);
      const missing = all.filter((part) => upload.parts.get(part) !== partSize(upload.bytes, upload.partBytes, part));
      if (missing.length > 0) return addresses(id, upload, missing);
      if (upload.checks-- > 0) return { checking: true };
      const digest = createHash('sha256');
      for (const part of all) for await (const chunk of createReadStream(partFile(id, part))) digest.update(chunk as Buffer);
      uploads.delete(id);
      if (digest.digest('hex') !== upload.sha256) return { mismatch: true };
      return { path: upload.path, revision: `fr_${++revisions}` };
    },
  };
}

export interface UploadTool {
  declared: Record<string, unknown>[];
  finished: Record<string, unknown>[];
}

export const MISMATCH = 'upload_mismatch: the stored bytes differ from the file declared; run the same command again';

const ARGUMENTS = ['file', 'room_ref', 'path', 'base', 'bytes', 'sha256', 'media_type', 'upload'];

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

export function uploadTool(
  store: Store,
  partBytes: number,
  options: { checks?: number } = {},
): { answer: (args: Record<string, unknown>) => Promise<ToolResult>; calls: UploadTool } {
  const calls: UploadTool = { declared: [], finished: [] };
  return {
    calls,
    answer: async (args) => {
      const unknown = Object.keys(args).filter((name) => !ARGUMENTS.includes(name));
      if (unknown.length > 0) return { isError: true, content: [{ type: 'text', text: `invalid_arguments: ${unknown.join(', ')} is not an argument here\n` }] };
      if (args.upload !== undefined) {
        calls.finished.push(args);
        const finished = await store.finish(String(args.upload));
        if ('mismatch' in finished) return { isError: true, content: [{ type: 'text', text: `${MISMATCH}\n` }] };
        return text(stringify(finished).trimEnd());
      }
      calls.declared.push(args);
      return text(stringify(store.declare({ bytes: Number(args.bytes), sha256: String(args.sha256), path: String(args.path) }, partBytes, options.checks)).trimEnd());
    },
  };
}
