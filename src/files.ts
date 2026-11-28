import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { request, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { destinationText, isRoomHandle, linkSpans, parseRoomPath, relativePath, retarget, roomPathLink, writeRoomPath, type LinkSpan } from '@agentshouse/mdmodel';
import { parseDocument } from 'yaml';
import { resendDelay, retryDelay } from './api.ts';
import { workspaceRoot } from './home.ts';
import { answerDocument, Unsettled } from './mcp.ts';
import { operationId } from './operation.ts';
import { proxyUnlessRelayed, relayed } from './relay.ts';

export interface UploadParts {
  id: string;
  part_bytes: number;
  parts?: { part: number; url: string }[];
}

export type Finished<T> = { upload: UploadParts } | T;

export interface Uploading<T> {
  name: string;
  bytes: number;
  sha256: string;
  read(start: number, end: number): Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  send(url: string, start: number, end: number, headers: Record<string, string>): Promise<void>;
  finish(upload: string, partSha256: string[], operation: string): Promise<Finished<T>>;
}

export interface Address {
  download: string;
  sha256: string;
}

export interface FileInfo extends Address {
  revision: string;
  bytes: number;
  media_type: string | null;
}

export interface Way {
  socketPath?: string;
  unreached(error: NodeJS.ErrnoException): Error;
  refused(status: number): Error;
}

export interface Answered {
  status: number;
  body: AsyncIterable<Uint8Array>;
}

const STALLED_ROUNDS = 8;

const PART_CHECKSUM = 'x-amz-checksum-sha256';

const MEDIA_TYPES = new Map([
  ['avif', 'image/avif'],
  ['csv', 'text/csv'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['gif', 'image/gif'],
  ['heic', 'image/heic'],
  ['html', 'text/html'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['json', 'application/json'],
  ['m4a', 'audio/mp4'],
  ['md', 'text/markdown'],
  ['mov', 'video/quicktime'],
  ['mp3', 'audio/mpeg'],
  ['mp4', 'video/mp4'],
  ['ogg', 'audio/ogg'],
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['svg', 'image/svg+xml'],
  ['txt', 'text/plain'],
  ['wav', 'audio/wav'],
  ['webm', 'video/webm'],
  ['webp', 'image/webp'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['zip', 'application/zip'],
]);

export function mediaTypeOf(path: string): string | undefined {
  return MEDIA_TYPES.get(extname(path).slice(1).toLowerCase());
}

function destinations(text: string): LinkSpan[] {
  const spans = new Map(linkSpans(text).map((span) => [span.destination.start, span]));
  return [...spans.values()].sort((left, right) => left.destination.start - right.destination.start);
}

export function linkedPaths(text: string): string[] {
  return [
    ...new Set(
      destinations(text).flatMap(({ href }) => {
        const named = roomPathLink(href);
        return named === null || named.path === '' ? [] : [href.trim()];
      }),
    ),
  ];
}

export function linkedFrom(file: string, folder: string, text: string): string {
  const from = parseRoomPath(file)!;
  let written = '';
  let cursor = 0;
  for (const span of destinations(text)) {
    const to = roomPathLink(span.href);
    if (to === null || !isRoomHandle(to.handle)) continue;
    const path = to.handle === from.handle ? relativePath(from, to) || '.' : relative(folder, join(workspaceRoot(), writeRoomPath(to))).split(sep).join('/');
    const destination = destinationText(retarget(span.href, path), span.bracketed);
    if (destination === null) continue;
    written += text.slice(cursor, span.destination.start) + destination;
    cursor = span.destination.end;
  }
  return written + text.slice(cursor);
}

export function fileInfo(answer: string): FileInfo | null {
  const document = parseDocument(answer);
  if (document.errors.length > 0) return null;
  const details = document.toJS() as { download?: unknown; sha256?: unknown; revision?: unknown; bytes?: unknown; media_type?: unknown } | null;
  if (typeof details?.download !== 'string') return null;
  return {
    download: details.download,
    sha256: String(details.sha256),
    revision: String(details.revision),
    bytes: Number(details.bytes),
    media_type: typeof details.media_type === 'string' ? details.media_type : null,
  };
}

interface InstructionsPart {
  instructions?: { text?: unknown; cut?: unknown; approved_version?: unknown };
  next_cursor?: string;
}

export interface RoomInstructions {
  text: string;
  approved: number | null;
}

function instructionsPart(answer: string): InstructionsPart {
  return answerDocument<InstructionsPart | null>(answer) ?? {};
}

export async function roomInstructions(info: (args: Record<string, unknown>) => Promise<string>, path: string): Promise<RoomInstructions> {
  let text = '';
  let approved: number | null = null;
  for (let args: Record<string, unknown> | null = { path }; args !== null; ) {
    const { instructions, next_cursor: cursor } = instructionsPart(await info(args));
    if (typeof instructions?.text === 'string') text += instructions.text;
    if (typeof instructions?.approved_version === 'number') approved = instructions.approved_version;
    args = instructions?.cut === undefined ? null : { path, cursor };
  }
  return { text, approved };
}

export function paused(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function storeRefusal(act: 'upload' | 'download', status: number): Error {
  return new Error(`the ${act} answered ${status}; ${act} the file again`);
}

export function opened(url: string, method: string, headers: Record<string, string>, way: Way, body?: Readable): Promise<IncomingMessage> {
  return new Promise((answered, failed) => {
    const target = way.socketPath === undefined ? relayed(url) : null;
    if (target !== null) proxyUnlessRelayed();
    const sent =
      target === null
        ? request({ socketPath: way.socketPath, path: url, method, headers }, answered)
        : (target.protocol === 'https:' ? httpsRequest : request)(target, { method, headers }, answered);
    sent.on('error', (error: NodeJS.ErrnoException) => failed(way.unreached(error)));
    if (body === undefined) sent.end();
    else pipeline(body, sent).catch(() => undefined);
  });
}

function ranged(file: string, start: number, end: number): Readable | undefined {
  return end === start ? undefined : createReadStream(file, { start, end: end - 1 });
}

export async function* fileRange(file: string, start: number, end: number, unreadable: (error: unknown) => Error): AsyncIterable<Buffer> {
  try {
    yield* ranged(file, start, end) ?? [];
  } catch (error) {
    throw unreadable(error);
  }
}

export async function sentPart(url: string, file: string, start: number, end: number, headers: Record<string, string>, way: Way): Promise<void> {
  const answer = await opened(url, 'PUT', { ...headers, 'content-length': String(end - start) }, way, ranged(file, start, end));
  await answer.toArray();
  if (answer.statusCode !== 200) throw way.refused(answer.statusCode!);
}

async function partDigests<T extends object>(uploading: Uploading<T>, partBytes: number): Promise<Buffer[]> {
  const whole = createHash('sha256');
  const digests: Buffer[] = [];
  for (let start = 0; digests.length === 0 || start < uploading.bytes; start += partBytes) {
    const end = Math.min(start + partBytes, uploading.bytes);
    const digest = createHash('sha256');
    for await (const chunk of uploading.read(start, end)) {
      digest.update(chunk);
      whole.update(chunk);
    }
    digests.push(digest.digest());
  }
  if (whole.digest('hex') !== uploading.sha256) throw new Error(`${uploading.name} changed while it was uploaded; upload it again`);
  return digests;
}

export async function uploaded<T extends object>(declared: UploadParts, uploading: Uploading<T>): Promise<T> {
  const partBytes = declared.part_bytes;
  const digests = await partDigests(uploading, partBytes);
  const partSha256 = digests.map((digest) => digest.toString('hex'));
  let answer = await finishing(uploading, declared.id, partSha256);
  let idle = 0;
  let stalled = 0;
  while ('upload' in answer) {
    const { id, parts } = answer.upload;
    let sent = 0;
    let failure: unknown = null;
    for (const { part, url } of parts ?? []) {
      const start = (part - 1) * partBytes;
      try {
        await uploading.send(url, start, Math.min(start + partBytes, uploading.bytes), {
          [PART_CHECKSUM]: digests[part - 1]!.toString('base64'),
        });
        sent++;
      } catch (error) {
        failure = error;
        break;
      }
    }
    if (sent > 0) {
      idle = 0;
      stalled = 0;
    } else {
      if (failure !== null && ++stalled >= STALLED_ROUNDS) throw failure;
      // A round that sent no part, its store unreachable, is followed by the next finishing call on the jittered curve.
      await paused(retryDelay(idle++));
    }
    answer = await finishing(uploading, id, partSha256);
  }
  return answer;
}

async function finishing<T extends object>(uploading: Uploading<T>, upload: string, partSha256: string[]): Promise<Finished<T>> {
  const operation = operationId();
  for (let unsettled = 1; ; unsettled++) {
    let settling: Unsettled;
    try {
      return await uploading.finish(upload, partSha256, operation);
    } catch (error) {
      if (!(error instanceof Unsettled) || unsettled === STALLED_ROUNDS) throw error;
      settling = error;
    }
    // A finishing call House did not settle, unreached or refused short of final, is sent again after the wait House names, else on the jittered curve as a conversation resends it, so a dropped connection or a House restart resumes the upload instead of ending it.
    await paused(settling.after ?? resendDelay(null, unsettled - 1));
  }
}

async function drained(body: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _chunk of body);
}

export async function downloaded(
  address: () => Promise<Address>,
  fetching: (url: string) => Promise<Answered>,
  destination: string,
  name: string,
): Promise<void> {
  for (let asked = 1; ; asked++) {
    const { download, sha256 } = await address();
    const answer = await fetching(download);
    if (answer.status === 403 && asked === 1) {
      await drained(answer.body);
      continue;
    }
    if (answer.status !== 200) {
      await drained(answer.body);
      throw storeRefusal('download', answer.status);
    }
    await mkdir(dirname(destination), { recursive: true });
    const partial = join(dirname(destination), `.${basename(destination)}.${randomUUID()}`);
    const digest = createHash('sha256');
    const hashed = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        digest.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(answer.body, hashed, createWriteStream(partial, { flags: 'wx' }));
      if (digest.digest('hex') !== sha256) throw new Error(`${name} did not arrive whole; download it again`);
      await rename(partial, destination);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    return;
  }
}

export async function fetched(url: string, signal?: AbortSignal): Promise<Answered> {
  const answer = await fetch(relayed(url), { signal });
  return { status: answer.status, body: answer.body === null ? Readable.from([]) : Readable.fromWeb(answer.body) };
}
