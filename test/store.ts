import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { onTestFinished } from 'vitest';
import { stringify } from 'yaml';
import type { Certificate } from './double.ts';
import type { ToolResult } from './environment.ts';

export interface StoreRequest {
  method: string;
  key: string;
  part: number | null;
  checksum: string | null;
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
  parts: Map<number, { bytes: number; sha256: string }>;
  path: string;
}

export interface Store {
  origin: string;
  requests: StoreRequest[];
  objects: Map<string, Buffer>;
  address(method: 'GET' | 'PUT', key: string, fields?: Record<string, string>, expired?: boolean): string;
  cut(part: number): void;
  declare(declared: { bytes: number; sha256: string; path: string }, partBytes: number): UploadAnswer;
  finish(id: string, partSha256: unknown): Promise<UploadAnswer | { path: string; revision: string } | { mismatch: true }>;
}

export interface UploadAnswer {
  upload: { id: string; part_bytes: number; parts: { part: number; url: string }[] };
}

export const RELAYED = 'x-test-relayed';

const CHECKSUM = 'x-amz-checksum-sha256';

function partCount(bytes: number, partBytes: number): number {
  return Math.max(1, Math.ceil(bytes / partBytes));
}

function partSize(bytes: number, partBytes: number, part: number): number {
  return part < partCount(bytes, partBytes) ? partBytes : bytes - (part - 1) * partBytes;
}

export async function startStore(tls?: Certificate): Promise<Store> {
  const secret = randomBytes(32);
  const uploads = new Map<string, Upload>();
  const objects = new Map<string, Buffer>();
  const requests: StoreRequest[] = [];
  const cuts = new Set<number>();
  let revisions = 0;
  const signature = (method: string, address: URL, checksum: string) =>
    createHmac('sha256', secret)
      .update(JSON.stringify([method, address.pathname, [...address.searchParams].filter(([name]) => name !== 'signature').sort(), checksum]))
      .digest('hex');
  const served = async (request: IncomingMessage, response: ServerResponse) => {
    const address = new URL(request.url ?? '/', 'http://store');
    const key = address.pathname.slice(1);
    const part = address.searchParams.has('part') ? Number(address.searchParams.get('part')) : null;
    const checksum = typeof request.headers[CHECKSUM] === 'string' ? request.headers[CHECKSUM] : null;
    const relayed = request.headers[RELAYED] === 'true';
    const port = request.socket.remotePort!;
    const answer = (status: number, bytes = 0, body?: Buffer) => {
      requests.push({ method: request.method!, key, part, checksum, status, bytes, relayed, port });
      response.writeHead(status, body === undefined ? {} : { 'content-length': body.length }).end(body);
    };
    if (address.searchParams.get('signature') !== signature(request.method!, address, checksum ?? '')) return answer(403);
    if (Number(address.searchParams.get('expires')) < Date.now()) return answer(403);
    if (request.method === 'GET') {
      const object = objects.get(key);
      if (object === undefined) return answer(404);
      return answer(200, object.length, object);
    }
    const upload = uploads.get(address.searchParams.get('upload') ?? '');
    if (upload === undefined || part === null) return answer(404);
    if (cuts.delete(part)) {
      requests.push({ method: 'PUT', key, part, checksum, status: 0, bytes: 0, relayed, port });
      request.once('data', () => request.socket.destroy());
      return;
    }
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    const sha256 = digest.digest();
    if (sha256.toString('base64') !== checksum) return answer(400, bytes);
    upload.parts.set(part, { bytes, sha256: sha256.toString('hex') });
    answer(200, bytes);
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
  });
  const signed = (method: 'GET' | 'PUT', key: string, fields: Record<string, string>, expired: boolean, checksum: string) => {
    const address = new URL(`/${key}`, origin);
    for (const [name, value] of Object.entries(fields)) address.searchParams.set(name, value);
    address.searchParams.set('expires', String(Date.now() + (expired ? -1000 : 600_000)));
    address.searchParams.set('signature', signature(method, address, checksum));
    return address.href;
  };
  const addresses = (id: string, upload: Upload, parts: number[], partSha256: string[]): UploadAnswer => ({
    upload: {
      id,
      part_bytes: upload.partBytes,
      parts: parts.map((part) => ({
        part,
        url: signed('PUT', upload.key, { upload: id, part: String(part) }, false, Buffer.from(partSha256[part - 1]!, 'hex').toString('base64')),
      })),
    },
  });
  return {
    origin,
    requests,
    objects,
    address: (method, key, fields = {}, expired = false) => signed(method, key, fields, expired, ''),
    cut: (part) => cuts.add(part),
    declare: (declared, partBytes) => {
      const id = randomUUID();
      uploads.set(id, { key: `binary/${randomUUID()}`, ...declared, partBytes, parts: new Map() });
      return { upload: { id, part_bytes: partBytes, parts: [] } };
    },
    finish: async (id, partSha256) => {
      const upload = uploads.get(id)!;
      const all = Array.from({ length: partCount(upload.bytes, upload.partBytes) }, (_part, index) => index + 1);
      const listed = Array.isArray(partSha256) && partSha256.every((sha256) => /^[0-9a-f]{64}$/.test(String(sha256))) ? (partSha256 as string[]) : [];
      if (listed.length !== all.length) {
        uploads.delete(id);
        return { mismatch: true };
      }
      const missing = all.filter((part) => {
        const stored = upload.parts.get(part);
        return stored?.bytes !== partSize(upload.bytes, upload.partBytes, part) || stored.sha256 !== listed[part - 1];
      });
      if (missing.length > 0) return addresses(id, upload, missing, listed);
      uploads.delete(id);
      return { path: upload.path, revision: `fr_${++revisions}` };
    },
  };
}

export interface UploadTool {
  declared: Record<string, unknown>[];
  finished: Record<string, unknown>[];
}

export const MISMATCH = 'upload_mismatch: the stored bytes differ from the file declared; run the same command again';

const ARGUMENTS = ['file', 'room_ref', 'path', 'base', 'bytes', 'sha256', 'media_type', 'upload', 'part_sha256'];

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

export function uploadTool(
  store: Store,
  partBytes: number,
): { answer: (args: Record<string, unknown>) => Promise<ToolResult>; calls: UploadTool } {
  const calls: UploadTool = { declared: [], finished: [] };
  return {
    calls,
    answer: async (args) => {
      const unknown = Object.keys(args).filter((name) => !ARGUMENTS.includes(name));
      if (unknown.length > 0) return { isError: true, content: [{ type: 'text', text: `invalid_arguments: ${unknown.join(', ')} is not an argument here\n` }] };
      if (args.upload !== undefined) {
        calls.finished.push(args);
        const finished = await store.finish(String(args.upload), args.part_sha256);
        if ('mismatch' in finished) return { isError: true, content: [{ type: 'text', text: `${MISMATCH}\n` }] };
        return text(stringify(finished).trimEnd());
      }
      calls.declared.push(args);
      const { id, part_bytes } = store.declare({ bytes: Number(args.bytes), sha256: String(args.sha256), path: String(args.path) }, partBytes).upload;
      return text(stringify({ upload: { id, part_bytes } }).trimEnd());
    },
  };
}
