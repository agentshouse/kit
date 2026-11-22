import { CONVERSATION_META_KEY } from '@agentshouse/kit-wire';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { stringify } from 'yaml';
import type { Answer, Received } from './double.ts';
import { ProtocolRefusal, type Hosted, type ToolResult } from './environment.ts';
import { accountOf, stop } from './kit.ts';
import { uploadTool, type Store } from './store.ts';

const HOUSE = fileURLToPath(new URL('../src/house-main.ts', import.meta.url));
const LOG_EPOCH = '0192f0e4-1c2d-7000-8000-000000000001';
const CHUNK_BYTES = 1024 * 1024;
const BODY_BYTES = 4 * 1024 * 1024;
const STAGED_PART_BYTES = 8;
const BATCH_FILES = 1000;
const ANSWER_BYTES = 32_000;
const RETRY_AT = '2026-11-17T00:00:00.000Z';
const DOCUMENT = /\.md$/i;
const REVISION = /^v_(\d+)\.1\.x$/;
const REFERENCE = /^(?:v_\d+\.1\.x|at_\d+\.x)$/;

export const MANIFEST = '.house';

interface Stored {
  content: string;
  revision: string;
  provenance?: string;
}

interface Binary {
  revision: string;
  bytes: Buffer;
}

interface Write {
  path: string;
  op: 'write' | 'delete' | 'move' | 'upload' | 'rewrite';
  content: string | null;
  revision: string | null;
  from?: string;
  merged?: true;
  binary?: { bytes: number; sha256: string };
}

interface Missing {
  bytes: number;
  sha256: string;
}

export interface Conflict {
  change: number;
  path: string;
  code: string;
  state: 'absent' | 'current';
  revision?: string;
  content?: string;
  cut?: Cut;
}

interface Cut {
  field: string;
  shown: number;
  total: number;
}

type Refused = { code: string; path?: string; held?: string; current_path?: string; documents?: number; conflicts?: Conflict[] };

type Edited = { writes: Write[] } | { refusal: Refused } | { missing: Missing[] } | { limited: true };

interface Stopped {
  status: number;
  code: string;
  message: string;
  detail: Record<string, unknown>;
  retryable: boolean;
}

function doorStopped(stopped: Stopped): Answer {
  const { status, code, message, detail, retryable } = stopped;
  return { status, body: { error: { code, ...detail, message, retryable } } };
}

function toolStopped({ status, code, message, retryable }: Stopped): ProtocolRefusal {
  return new ProtocolRefusal(status, { code: -32000, message, data: { code, retryable } });
}

const LIMITED: Stopped = {
  status: 429,
  code: 'limit_reached',
  message: `limit_reached: you reached today's Write limit; try again at ${RETRY_AT}`,
  detail: { limit: 'writes', retry_at: RETRY_AT, retry_after: 3600 },
  retryable: true,
};

const CAPPED: Stopped = {
  status: 429,
  code: 'cap_reached',
  message: `cap_reached: you hold the most uploads open at once; try again at ${RETRY_AT}`,
  detail: { cap: 'open_uploads', retry_at: RETRY_AT, retry_after: 3600 },
  retryable: true,
};

export function said(refusal: Refused): string {
  if (refusal.code === 'protected_path') return `protected_path: ${refusal.path} is not writable`;
  if (refusal.code === 'binary_content') return `binary_content: ${refusal.path} is a document, which holds Markdown text only; write it with update`;
  if (refusal.code === 'attachment_path') return `attachment_path: ${refusal.path} holds an attachment, since its Path does not end .md; send its bytes with upload`;
  if (refusal.code === 'handle_changed') return `handle_changed: its handle changed; use ${refusal.current_path}`;
  if (refusal.code === 'batch_too_large') {
    return `batch_too_large: this batch names ${refusal.documents} documents and attachments, over ${BATCH_FILES} per call; split it into several batches`;
  }
  if (refusal.code === 'duplicate_path') {
    return `duplicate_path: ${refusal.path} is removed or moved away in this batch; leave other changes of a removed path out, and change a moved file at its new path`;
  }
  if (refusal.code === 'invalid_base_revision') return `invalid_base_revision: base for ${refusal.path} is not a revision; pass the v_… revision your read of it printed`;
  if (refusal.code === 'invalid_authored_path') {
    return `invalid_authored_path: ${refusal.path} differs from ${refusal.held} only in letter case, and a folder holds one name in any case; write to ${refusal.held} or choose another name`;
  }
  const conflicts = stringify({ conflicts: refusal.conflicts }).trimEnd();
  return `edit_conflict: nothing was written; fix each conflict listed, then send it again\n${conflicts}`;
}

export interface EditChange {
  op: string;
  path: string;
  to?: string;
  base?: unknown;
  content?: string;
  bytes?: number;
  sha256?: string;
  media_type?: string;
}

export function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function lines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

function ended(chunk: string[]): string[] {
  const last = chunk.at(-1);
  return last === undefined || last.endsWith('\n') ? chunk : [...chunk.slice(0, -1), `${last}\n`];
}

function matched(left: string[], right: string[]): Map<number, number> {
  const table = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs = new Map<number, number>();
  for (let i = 0, j = 0; i < left.length && j < right.length; ) {
    if (left[i] === right[j]) pairs.set(i++, j++);
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

export function merged3(base: string, current: string, yours: string): { merged: string } | { conflicted: string } {
  const [o, a, b] = [lines(base), lines(current), lines(yours)];
  const [toA, toB] = [matched(o, a), matched(o, b)];
  const out: string[] = [];
  let conflicted = false;
  let [io, ia, ib] = [0, 0, 0];
  const syncs = [...o.keys()].filter((index) => toA.has(index) && toB.has(index));
  for (const sync of [...syncs, o.length]) {
    const [ea, eb] = sync === o.length ? [a.length, b.length] : [toA.get(sync)!, toB.get(sync)!];
    const [co, ca, cb] = [o.slice(io, sync).join(''), a.slice(ia, ea), b.slice(ib, eb)];
    if (ca.join('') === co) out.push(...cb);
    else if (cb.join('') === co || ca.join('') === cb.join('')) out.push(...ca);
    else {
      conflicted = true;
      out.push('<<<<<<< current\n', ...ended(ca), '=======\n', ...ended(cb), '>>>>>>> yours\n');
    }
    if (sync < o.length) {
      out.push(o[sync]!);
      [io, ia, ib] = [sync + 1, ea + 1, eb + 1];
    }
  }
  return conflicted ? { conflicted: out.join('') } : { merged: out.join('') };
}

let revisions = 0;

function minted(): string {
  revisions++;
  return `v_${revisions}.1.x`;
}

function cutOf(text: string, bound: number, field: string): { text: string; cut: Cut } | null {
  const bytes = Buffer.from(text);
  if (bytes.length <= bound) return null;
  let shown = bound;
  while ((bytes[shown]! & 0xc0) === 0x80) shown--;
  return { text: bytes.subarray(0, shown).toString(), cut: { field, shown, total: bytes.length } };
}

function covers(path: string, prefix: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
}

function packed(entries: readonly object[]): Buffer[] {
  const chunks: Buffer[] = [];
  let held: Buffer[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const line = Buffer.from(`${JSON.stringify(entry)}\n`);
    if (bytes > 0 && bytes + line.length > CHUNK_BYTES) {
      chunks.push(Buffer.concat(held));
      held = [];
      bytes = 0;
    }
    held.push(line);
    bytes += line.length;
  }
  if (held.length > 0) chunks.push(Buffer.concat(held));
  return chunks;
}

export class Room {
  readonly ref = `r_${randomBytes(5).toString('hex')}.x`;
  handle: string;
  readonly former = new Set<string>();
  position = 1;
  logEpoch = LOG_EPOCH;
  write = [''];
  protected = ['capture', 'collaboration'];
  files = new Map<string, Stored>();
  binaries = new Map<string, Binary>();
  readonly history = new Map<string, string>();
  readonly binaryHistory = new Map<string, Binary & { path: string }>();
  readonly folders = new Set<string>();
  readonly log: { position: number; paths: string[] }[] = [];
  readonly batches: EditChange[][] = [];
  models: Record<string, unknown>[] = [];
  instructions = '';
  bound = ANSWER_BYTES;
  cutWith: 'notice' | 'cut' = 'notice';
  private built: { position: number; entries: object[] } | null = null;

  readonly workspace: string;

  constructor(handle: string, workspace: string) {
    this.handle = handle;
    this.workspace = workspace;
  }

  get root(): string {
    return `/rooms/${this.handle}`;
  }

  get repository(): string {
    return join(this.workspace, 'rooms', this.handle);
  }

  rehandle(handle: string): void {
    this.former.add(this.handle);
    this.handle = handle;
  }

  names(path: string): boolean {
    return [this.handle, ...this.former].some((handle) => path === `/rooms/${handle}` || path.startsWith(`/rooms/${handle}/`));
  }

  writable(path: string): boolean {
    const deepest = (scopes: string[]) =>
      Math.max(-1, ...scopes.filter((scope) => covers(path, scope)).map((scope) => scope.length));
    return deepest(this.write) > deepest(this.protected);
  }

  stored(content: string, provenance?: string): Stored {
    const revision = minted();
    this.history.set(revision, content);
    return { content, revision, ...(provenance === undefined ? {} : { provenance }) };
  }

  put(path: string, content: string, provenance?: string): string {
    const stored = this.stored(content, provenance);
    this.files.set(path, stored);
    this.binaries.delete(path);
    this.advance([path]);
    return stored.revision;
  }

  upload(path: string, bytes: Buffer): string {
    const binary = { revision: minted(), bytes };
    this.binaries.set(path, binary);
    this.binaryHistory.set(binary.revision, { ...binary, path });
    this.files.delete(path);
    this.advance([path]);
    return binary.revision;
  }

  remove(path: string): void {
    this.files.delete(path);
    this.binaries.delete(path);
    this.advance([path]);
  }

  move(from: string, to: string): void {
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from)!);
      this.files.delete(from);
    } else {
      this.binaries.set(to, this.binaries.get(from)!);
      this.binaries.delete(from);
    }
    this.advance([from, to]);
  }

  revision(path: string): string {
    return (this.files.get(path) ?? this.binaries.get(path))!.revision;
  }

  merged(content: string): Record<string, unknown> {
    const part = cutOf(content, this.bound, 'content');
    if (part === null) return { content };
    return this.cutWith === 'cut' ? { content: part.text, cut: part.cut } : { content: `${part.text}\noutput_cut ${part.cut.shown} of ${part.cut.total} bytes` };
  }

  conflicted(content: string): Partial<Conflict> {
    const part = cutOf(content, this.bound, 'content');
    if (part === null) return { content };
    return this.cutWith === 'cut' ? { content: part.text, cut: part.cut } : {};
  }

  instructionsFrom(start: number): Record<string, unknown> {
    if (this.instructions === '') return {};
    const held = { version: 1, approved_version: 1 };
    const rest = Buffer.from(this.instructions).subarray(start).toString();
    const part = cutOf(rest, this.bound, 'text');
    if (part === null) return { instructions: { ...held, text: rest } };
    const cut = { ...part.cut, total: Buffer.byteLength(this.instructions) };
    return { instructions: { ...held, text: part.text, cut }, next_cursor: String(start + cut.shown) };
  }

  advance(paths: string[]): void {
    this.position++;
    this.log.push({ position: this.position, paths });
  }

  authority(): Record<string, unknown> {
    return {
      kind: 'room',
      room_ref: this.ref,
      room_handle: this.handle,
      managed_replication: 'admitted',
      protected_paths: this.protected,
      operations: { read: [''], sync: [''], write: this.write, delete: this.write },
      position: String(this.position),
      log_epoch: this.logEpoch,
    };
  }

  entries(): object[] {
    const text = [...this.files].map(([path, file]) => ({
      path,
      revision: file.revision,
      sha256: 'unused',
      bytes: Buffer.byteLength(file.content),
      lines: file.content.split('\n').length - 1,
      ...(file.provenance === undefined ? {} : { provenance: file.provenance }),
      content: file.content,
    }));
    const binary = [...this.binaries].map(([path, file]) => ({
      path,
      revision: file.revision,
      sha256: digest(file.bytes),
      bytes: file.bytes.length,
      media_type: 'image/jpeg',
    }));
    const folders = [...this.folders].map((folder) => ({ folder }));
    const key = (entry: object) => ('folder' in entry ? `${String(entry.folder)}/` : (entry as { path: string }).path);
    return [...text, ...binary, ...folders].sort((left, right) => (key(left) < key(right) ? -1 : 1));
  }

  build(): void {
    this.built = { position: this.position, entries: this.entries() };
  }

  chunkList(store: Store, expires: () => boolean, shape: { damagesChunks: boolean; unparsedChunks: boolean }): Record<string, unknown> {
    const { position, entries } = this.built ?? { position: this.position, entries: this.entries() };
    return {
      room_ref: this.ref,
      ready: true,
      position: String(position),
      log_epoch: this.logEpoch,
      chunks: packed(entries).map((body) => {
        const served = shape.unparsedChunks ? Buffer.concat([body, Buffer.from('{not a line\n')]) : body;
        const hash = digest(served);
        const key = `room-chunks/${this.ref}/${hash}`;
        store.objects.set(key, shape.damagesChunks ? Buffer.concat([served, Buffer.from([0])]) : served);
        return { hash, bytes: body.length, download: store.address('GET', key, {}, expires()) };
      }),
      authors: [],
      models: this.models,
    };
  }

  changedSince(after: number): number {
    return new Set(this.log.filter((entry) => entry.position > after).flatMap((entry) => entry.paths)).size;
  }

  enumerated(after: number, pass: number, bodyBytes: number): Record<string, unknown> {
    const entries = this.log.filter((entry) => entry.position > after).slice(0, pass);
    const paths = [...new Set(entries.flatMap((entry) => entry.paths))].sort();
    const position = String(entries.at(-1)?.position ?? this.position);
    const changes: Record<string, unknown>[] = [];
    let spent = 0;
    for (const path of paths) {
      if (spent >= bodyBytes) break;
      const file = this.files.get(path);
      const binary = this.binaries.get(path);
      spent += Buffer.byteLength(file?.content ?? '');
      changes.push(
        file !== undefined
          ? {
              path,
              content: file.content,
              revision: file.revision,
              sha256: 'unused',
              ...(file.provenance === undefined ? {} : { provenance: file.provenance }),
            }
          : binary !== undefined
            ? { path, revision: binary.revision, bytes: binary.bytes.length, media_type: 'image/jpeg', sha256: digest(binary.bytes) }
            : { path, removed: true },
      );
    }
    return {
      authority: this.ref,
      position,
      log_epoch: this.logEpoch,
      changes,
      ...(changes.length < paths.length ? { next: { after: String(after), through: position, read: changes.length } } : {}),
      originals: [],
    };
  }

  edit(changes: EditChange[], staged: (sha256: string) => Buffer | undefined = () => undefined, admitted: () => boolean = () => true): Edited {
    for (const named of changes.flatMap((change) => [change.path, ...(change.to === undefined ? [] : [change.to])])) {
      const handle = /^\/rooms\/([^/]+)/.exec(named)![1]!;
      if (handle !== this.handle && this.former.has(handle)) {
        return { refusal: { code: 'handle_changed', path: named, current_path: `${this.root}${named.slice(`/rooms/${handle}`.length)}` } };
      }
    }
    const distinct = new Set(changes.flatMap((change) => [change.path, ...(change.to === undefined ? [] : [change.to])]));
    if (distinct.size > BATCH_FILES) return { refusal: { code: 'batch_too_large', documents: distinct.size } };
    const local = (path: string) => path.slice(this.root.length + 1);
    const next = new Map(this.files);
    const binaries = new Map(this.binaries);
    const writes = new Map<string, Write>();
    const conflicts: Conflict[] = [];
    const missing: Missing[] = [];
    const removed = new Set<string>();
    const set = (path: string, content: string, extra: Partial<Write> = {}) => {
      const stored = this.stored(content);
      next.set(path, stored);
      writes.set(path, { path, op: 'write', content, revision: stored.revision, ...extra });
    };
    for (const [index, change] of changes.entries()) {
      const path = local(change.path);
      const to = change.to === undefined ? undefined : local(change.to);
      if (!this.writable(path) || (to !== undefined && !this.writable(to))) return { refusal: { code: 'protected_path', path: change.path } };
      if (change.op === 'upload' && DOCUMENT.test(path)) return { refusal: { code: 'binary_content', path: change.path } };
      if (change.op === 'write' && !DOCUMENT.test(path)) return { refusal: { code: 'attachment_path', path: change.path } };
      if (typeof change.base === 'string' && !REVISION.test(change.base)) return { refusal: { code: 'invalid_base_revision', path: change.path } };
      if (removed.has(path)) return { refusal: { code: 'duplicate_path', path: change.path } };
      const named = to ?? path;
      const twin = [...next.keys(), ...binaries.keys()].find((held) => held !== named && held !== path && held.toLowerCase() === named.toLowerCase());
      if (twin !== undefined && ((change.op === 'write' && change.base === undefined) || change.op === 'move' || (change.op === 'upload' && change.base === undefined))) {
        return { refusal: { code: 'invalid_authored_path', path: change.to ?? change.path, held: `${this.root}/${twin}` } };
      }
      const current = next.get(path);
      const binary = binaries.get(path);
      const held = current ?? binary;
      const conflict = (code: string, extra: Partial<Conflict> = {}) =>
        conflicts.push({ change: index, path: change.path, code, state: held === undefined ? 'absent' : 'current', ...(held === undefined ? {} : { revision: held.revision }), ...extra });
      if (change.op === 'write') {
        if (binary !== undefined) conflict('binary_file');
        else if (change.base === undefined) {
          if (current === undefined) set(path, change.content!);
          else if (current.content === change.content) writes.set(path, { path, op: 'write', content: current.content, revision: current.revision });
          else conflict('path_exists');
        } else if (current === undefined) conflict('path_absent');
        else if (current.revision === change.base) set(path, change.content!);
        else {
          const text = this.history.get(change.base as string);
          const result = text === undefined ? null : merged3(text, current.content, change.content!);
          if (result === null) conflict('base_revision_stale');
          else if ('conflicted' in result) conflict('merge_conflict', this.conflicted(result.conflicted));
          else set(path, result.merged, { merged: true });
        }
      } else if (change.op === 'delete') {
        if (held === undefined) conflict('path_absent');
        else if (held.revision !== change.base) conflict('base_revision_stale');
        else {
          next.delete(path);
          binaries.delete(path);
          removed.add(path);
          writes.set(path, { path, op: 'delete', content: null, revision: null });
        }
      } else if (change.op === 'move') {
        if (held === undefined) conflict('path_absent');
        else if (change.base !== undefined && held.revision !== change.base) conflict('base_revision_stale');
        else if (next.has(to!) || binaries.has(to!)) {
          const there = (next.get(to!) ?? binaries.get(to!))!;
          conflicts.push({ change: index, path: change.to!, code: 'path_exists', state: 'current', revision: there.revision });
        } else {
          removed.add(path);
          if (current !== undefined) {
            next.delete(path);
            next.set(to!, current);
            writes.set(to!, { path: to!, op: 'move', content: current.content, revision: current.revision, from: path });
          } else {
            binaries.delete(path);
            binaries.set(to!, binary!);
            writes.set(to!, { path: to!, op: 'move', content: null, revision: binary!.revision, from: path, binary: { bytes: binary!.bytes.length, sha256: digest(binary!.bytes) } });
          }
          const destination = (name: string) => (name.includes(' ') ? `(<${name}>)` : `(${name})`);
          for (const [other, file] of next) {
            const link = destination(basename(path));
            if (other !== to && dirname(other) === dirname(path) && file.content.includes(link)) {
              set(other, file.content.replaceAll(link, destination(relative(dirname(path), to!))), { op: 'rewrite' });
            }
          }
        }
      } else if (change.op === 'upload') {
        if (current !== undefined) conflict('text_file');
        else if (binary !== undefined && change.base !== binary.revision) conflict(change.base === undefined ? 'base_required' : 'base_revision_stale');
        else if (binary === undefined && change.base !== undefined) conflict('path_absent');
        else {
          const bytes = staged(change.sha256!) ?? (binary !== undefined && digest(binary.bytes) === change.sha256 ? binary.bytes : undefined);
          if (bytes === undefined) missing.push({ bytes: change.bytes!, sha256: change.sha256! });
          else {
            const stored = { revision: minted(), bytes };
            binaries.set(path, stored);
            this.binaryHistory.set(stored.revision, { ...stored, path });
            writes.set(path, { path, op: 'upload', content: null, revision: stored.revision, binary: { bytes: bytes.length, sha256: digest(bytes) } });
          }
        }
      }
    }
    if (conflicts.length > 0) return { refusal: { code: 'edit_conflict', conflicts } };
    if (missing.length > 0) return { missing };
    if (!admitted()) return { limited: true };
    this.files = next;
    this.binaries = binaries;
    this.batches.push(changes);
    this.advance([...new Set([...[...writes.values()].flatMap((write) => [write.path, ...(write.from === undefined ? [] : [write.from])]), ...removed])]);
    return { writes: [...writes.values()] };
  }
}

type Receipt = { authority: string; position: string; log_epoch: string; writes: Write[] };

export interface Rooms {
  answered: Room[];
  open: Room[];
  room(handle: string): Room;
  download(rooms: Room[], ...flags: string[]): Promise<HouseRun>;
  unreadable: Set<string>;
  denied: Set<string>;
  expired: Set<string>;
  omitted: Set<string>;
  dropping: number;
  dropsEdits: number;
  refusesBatches: Answer[];
  refusesUploads: Answer[];
  refusesReads: Answer[];
  reads: boolean[];
  pass: number;
  prepared: unknown[];
  uploaded: Buffer[];
  damages: boolean;
  expiring: number;
  authoredFileBytes: number;
  maxPrefixes: number;
  carriedDocuments: number;
  notReady: Map<string, number>;
  expiringChunks: number;
  damagesChunks: boolean;
  unparsedChunks: boolean;
  openUploads: number;
  writeUnits: number;
  partBytes: number;
  beforeEdit: ((changes: EditChange[]) => void) | null;
  edits(): Received[];
}

function prefixed(rooms: Room[], prefixes: string[]): Room[] {
  return rooms.filter((room) => prefixes.includes(room.root));
}

const INVALID = { status: 400, body: { error: { code: 'invalid_request', retryable: false } } };

export const OVERLOADED = {
  error: { code: 'house_overloaded', message: 'house_overloaded: House is busy; call again in 5 s', retry_after: 5, retryable: true },
};

function doorContents(writes: Write[]): Record<string, unknown>[] {
  return writes.flatMap((write) => [
    ...(write.from === undefined ? [] : [{ path: write.from, content: null, revision: null }]),
    {
      path: write.path,
      content: write.content,
      revision: write.revision,
      ...(write.binary === undefined ? {} : { ...write.binary, media_type: 'image/jpeg' }),
    },
  ]);
}

function toolResults(room: Room, writes: Write[]): Record<string, unknown>[] {
  return writes.map((write) => ({
    path: write.path,
    ...(write.revision === null ? {} : { revision: write.revision }),
    ...(write.from === undefined ? {} : { from: write.from }),
    ...(write.merged === true ? room.merged(write.content!) : {}),
  }));
}

export function serveRooms(hosted: Hosted): Rooms {
  const rooms: Room[] = [];
  const receipts = new Map<string, Receipt>();
  const state: Rooms = {
    answered: [],
    open: [],
    unreadable: new Set(),
    denied: new Set(),
    expired: new Set(),
    omitted: new Set(),
    dropping: 0,
    dropsEdits: 0,
    refusesBatches: [],
    refusesUploads: [],
    refusesReads: [],
    reads: [],
    pass: Infinity,
    prepared: [],
    uploaded: [],
    damages: false,
    expiring: 0,
    authoredFileBytes: 1_000_000,
    maxPrefixes: 256,
    carriedDocuments: 1_000,
    notReady: new Map(),
    expiringChunks: 0,
    damagesChunks: false,
    unparsedChunks: false,
    openUploads: 10,
    writeUnits: Infinity,
    partBytes: STAGED_PART_BYTES,
    beforeEdit: null,
    room: (handle) => {
      const room = new Room(handle, hosted.workspace);
      rooms.push(room);
      onTestFinished(async () => {
        stop(hosted.kit.pid);
        await hosted.kit.exited;
        await rm(room.repository, { recursive: true, force: true });
      });
      return room;
    },
    download: (answer, ...flags) => {
      state.answered = answer;
      return house(hosted, '/', 'download', ...flags);
    },
    edits: () =>
      hosted.mcp.filter((received) => {
        const { name, arguments: args } = (received.body as { params: { name?: string; arguments?: { op?: unknown } } }).params;
        return name === 'update' && args?.op !== 'stage';
      }),
  };
  const roomOf = (path: string) => rooms.find((room) => room.names(path))!;
  const opened = new Map<string, { operation: string; sha256: string }>();
  const open = (id: string) => !hosted.store.objects.has(`staged/${id}`);
  const stagedBytes = (operation: string, sha256: string) => {
    const id = [...opened].find(([held, upload]) => upload.operation === operation && upload.sha256 === sha256 && !open(held))?.[0];
    return id === undefined ? undefined : hosted.store.objects.get(`staged/${id}`);
  };
  const unstaged = (operation: string, missing: Missing[]): Stopped => {
    const files = [...new Map(missing.map((file) => [file.sha256, file])).values()];
    const opening = [...opened].filter(([id]) => open(id));
    const kept = new Map(opening.filter(([, upload]) => upload.operation === operation).map(([id, upload]) => [upload.sha256, id]));
    const places = Math.max(0, state.openUploads - opening.length);
    if (kept.size === 0 && places === 0) return CAPPED;
    const fitting = files.filter((file) => !kept.has(file.sha256)).slice(0, places);
    if (fitting.length > 0 && state.writeUnits <= 0) return LIMITED;
    for (const file of fitting.slice(0, state.writeUnits)) {
      const { upload } = hosted.store.declare({ bytes: file.bytes, sha256: file.sha256, staged: true }, state.partBytes);
      opened.set(upload.id, { operation, sha256: file.sha256 });
      kept.set(file.sha256, upload.id);
      state.writeUnits--;
    }
    const upload = files.flatMap((file) => {
      const id = kept.get(file.sha256);
      return id === undefined ? [] : [{ sha256: file.sha256, id, part_bytes: state.partBytes, parts: [] }];
    });
    const waiting = files.filter((file) => !kept.has(file.sha256)).map((file) => ({ sha256: file.sha256 }));
    return {
      status: 409,
      code: 'files_unstaged',
      message: `files_unstaged: nothing was written; finish each upload named, then send this batch again under the same operation\n${stringify({ upload, waiting }).trimEnd()}`,
      detail: { upload, waiting },
      retryable: false,
    };
  };
  const admitted = () => {
    if (state.writeUnits <= 0) return false;
    state.writeUnits--;
    return true;
  };
  const edited = (changes: EditChange[], operation: string): Receipt | { refusal: Refused } | { stopped: Stopped } => {
    const receipt = receipts.get(operation);
    if (receipt !== undefined) return receipt;
    state.beforeEdit?.(changes);
    const room = roomOf(changes[0]!.path);
    const outcome = room.edit(changes, (sha256) => stagedBytes(operation, sha256), admitted);
    if ('missing' in outcome) return { stopped: unstaged(operation, outcome.missing) };
    if ('limited' in outcome) return { stopped: LIMITED };
    if ('refusal' in outcome) return outcome;
    const kept: Receipt = {
      authority: room.ref,
      position: String(room.position),
      log_epoch: room.logEpoch,
      writes: outcome.writes.map((write) => ({
        ...write,
        path: `${room.root}/${write.path}`,
        ...(write.from === undefined ? {} : { from: `${room.root}/${write.from}` }),
      })),
    };
    receipts.set(operation, kept);
    return kept;
  };
  const refusalStatus = (refusal: Refused) => (refusal.code === 'batch_too_large' ? 413 : refusal.code === 'protected_path' ? 403 : 409);
  hosted.house.route('POST', '/kit/local-copies/selection/read', () => ({
    body: {
      local_copy: {
        rooms: [
          ...state.answered.map((room) => ({ room_ref: room.ref, room_handle: room.handle, level: 'keep' })),
          ...state.open.map((room) => ({ room_ref: room.ref, room_handle: room.handle, level: 'open' })),
        ],
      },
    },
  }));
  hosted.house.route('POST', '/kit/door/rooms/discover', (request) => {
    const { prefixes } = request.body as { prefixes: string[] };
    if (prefixes.length > state.maxPrefixes) return INVALID;
    return {
      body: {
        bounds: { max_authored_file_bytes: state.authoredFileBytes, max_prefixes: state.maxPrefixes },
        authorities: prefixed(rooms, prefixes).map((room) => room.authority()),
      },
    };
  });
  hosted.house.route('POST', '/kit/door/room-chunks/list', (request) => {
    const { prefixes } = request.body as { prefixes: string[] };
    if (prefixes.length > state.maxPrefixes) return INVALID;
    const read = prefixed(rooms, prefixes);
    if (read.some((room) => state.unreadable.has(room.ref))) {
      return { status: 503, body: { error: { code: 'house_unavailable', retryable: true } } };
    }
    const expires = () => {
      if (state.expiringChunks === 0) return false;
      state.expiringChunks--;
      return true;
    };
    return {
      body: {
        rooms: read.map((room) => {
          const waits = state.notReady.get(room.ref) ?? 0;
          if (waits === 0) return room.chunkList(hosted.store, expires, state);
          state.notReady.set(room.ref, waits - 1);
          return { room_ref: room.ref, ready: false };
        }),
      },
    };
  });
  hosted.house.route('POST', '/kit/door/changes/enumerate', (request) => {
    const { prefixes, positions } = request.body as {
      prefixes: string[];
      positions: { authority: string; position: string; log_epoch: string; page?: { through: string; read: number } }[];
    };
    if (prefixes.length > state.maxPrefixes || positions.length > state.maxPrefixes) return INVALID;
    if (state.reads.shift() === false) return { status: 503, body: { error: { code: 'house_unavailable', retryable: true } } };
    const known = positions.map((position) => ({ ...position, room: rooms.find((candidate) => candidate.ref === position.authority)! }));
    if (known.some(({ room }) => state.unreadable.has(room.ref))) {
      return { status: 503, body: { error: { code: 'house_unavailable', retryable: true } } };
    }
    const expired = known.find(
      ({ room, position, log_epoch }) =>
        state.expired.has(room.ref) || log_epoch !== room.logEpoch || room.changedSince(Number(position)) > state.carriedDocuments,
    );
    if (expired !== undefined) {
      state.expired.delete(expired.room.ref);
      const { authority, position } = expired;
      return { status: 409, body: { error: { code: 'expired', authority, position, retryable: false } } };
    }
    const answered = known.filter(({ room }) => !state.omitted.has(room.ref));
    const bound = answered.some(({ page }) => page !== undefined) ? BODY_BYTES : Infinity;
    return { body: { authorities: answered.map(({ room, position }) => room.enumerated(Number(position), state.pass, bound)) } };
  });
  hosted.house.route('POST', '/kit/door/files/revisions/list', (request) => {
    const { path, revision } = request.body as { path: string; revision: string };
    if (!REVISION.test(revision)) return INVALID;
    const refused = state.refusesReads.shift();
    if (refused !== undefined) return refused;
    const content = roomOf(path).history.get(revision);
    return { body: { path, revisions: content === undefined ? [] : [{ revision, content }], next_before: null } };
  });
  hosted.house.route('POST', '/kit/door/update', (request) => {
    const refused = state.refusesBatches.shift();
    if (refused !== undefined) return refused;
    const { operation_id: operation, changes } = request.body as { operation_id: string; changes: EditChange[] };
    const outcome = edited(changes, operation);
    if ('stopped' in outcome) return doorStopped(outcome.stopped);
    if ('refusal' in outcome) {
      return { status: refusalStatus(outcome.refusal), body: { error: { ...outcome.refusal, message: said(outcome.refusal), retryable: false } } };
    }
    if (state.dropping > 0) {
      state.dropping--;
      return { drop: true };
    }
    const { writes, ...rest } = outcome;
    return { body: { ...rest, contents: doorContents(writes) } };
  });
  hosted.tools.upload = uploadTool(hosted.store, STAGED_PART_BYTES).answer;
  hosted.tools.info = (args) => {
    const path = String(args.path);
    const room = roomOf(path);
    if (!path.slice('/rooms/'.length).includes('/')) {
      if (room.cutWith === 'cut') return { content: [{ type: 'text', text: stringify({ ref: room.ref, path, ...room.instructionsFrom(Number(args.cursor ?? 0)) }) }] };
      const instructions = room.instructions === '' ? {} : { instructions: { version: 1, approved_version: 1, text: room.instructions } };
      const answer = Buffer.from(stringify({ ref: room.ref, path, ...instructions }));
      const text = answer.length <= room.bound ? answer.toString() : `${answer.subarray(0, room.bound).toString()}\ninfo: output_cut at ${room.bound} bytes`;
      return { content: [{ type: 'text', text }] };
    }
    const local = path.slice(room.root.length + 1);
    const ref = args.ref as string | undefined;
    if (ref !== undefined && !REFERENCE.test(ref)) {
      return { isError: true, content: [{ type: 'text', text: 'not_found: nothing you can reach is there; check what you passed\n' }] };
    }
    const binary = ref === undefined ? room.binaries.get(local) : room.binaryHistory.get(ref);
    if (binary !== undefined) {
      const key = `binary/${room.ref}/${binary.revision}`;
      hosted.store.objects.set(key, state.damages ? Buffer.concat([binary.bytes, Buffer.from([0])]) : binary.bytes);
      const expired = state.expiring > 0;
      if (expired) state.expiring--;
      const text = stringify({
        path,
        revision: binary.revision,
        file: binary.revision.replace(REVISION, 'at_$1.x'),
        bytes: binary.bytes.length,
        media_type: 'image/jpeg',
        sha256: digest(binary.bytes),
        download: hosted.store.address('GET', key, {}, expired),
      });
      return { content: [{ type: 'text', text }] };
    }
    const file = room.files.get(local);
    if (file === undefined) return { isError: true, content: [{ type: 'text', text: `path_not_found: ${path} does not exist\n` }] };
    return { content: [{ type: 'text', text: stringify({ path, revision: file.revision }) }] };
  };
  const grants = new Map<string, { operation: string }>();
  const staged = new Map<string, Buffer>();
  const stage = ({ op: _stage, ...declared }: Record<string, unknown>): ToolResult => {
    state.prepared.push(declared);
    const grant = `edit-${grants.size + 1}`;
    const operation = randomUUID();
    grants.set(grant, { operation });
    return { content: [{ type: 'text', text: stringify({ transfer: { url: `${hosted.house.origin}/uploads/${grant}`, operation } }) }] };
  };
  hosted.house.route('POST', '/uploads/:grant', (request) => {
    const refused = state.refusesUploads.shift();
    if (refused !== undefined) return refused;
    const framed = request.body as Buffer;
    const line = framed.indexOf(10);
    const grant = grants.get(request.params.grant!)!;
    if (framed.subarray(0, line).toString('utf8') !== grant.operation) return { status: 404 };
    const bytes = framed.subarray(line + 1);
    state.uploaded.push(bytes);
    const url = `${hosted.house.origin}/staged/${request.params.grant}`;
    staged.set(url, bytes);
    return { body: { transfer: { method: 'POST', url, operation: randomUUID() } } };
  });
  hosted.tools.update = (args, request) => {
    if (args.op === 'stage') return stage(args);
    const meta = (request.body as { params: { _meta: Record<string, string> } }).params._meta;
    if (state.denied.has(meta[CONVERSATION_META_KEY] ?? '')) {
      return { isError: true, content: [{ type: 'text', text: 'operation_denied: you may not write here; the Room owner grants Room access, your User widens an Agent at /agents\n' }] };
    }
    const upload = args.upload as { url: string } | undefined;
    const changes = (
      upload === undefined ? args.changes : (JSON.parse(staged.get(upload.url)!.toString('utf8')) as { changes: unknown }).changes
    ) as EditChange[];
    const operation = meta['agents.house/agent-operation']!;
    const outcome = edited(changes, operation);
    if ('stopped' in outcome) throw toolStopped(outcome.stopped);
    if ('refusal' in outcome) return { isError: true, content: [{ type: 'text', text: `${said(outcome.refusal)}\n` }] } satisfies ToolResult;
    if (state.dropsEdits > 0) {
      state.dropsEdits--;
      return null;
    }
    return { content: [{ type: 'text', text: stringify({ results: toolResults(roomOf(changes[0]!.path), outcome.writes) }) }] };
  };
  return state;
}

export interface HouseRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function house(hosted: Hosted, cwd: string, ...args: string[]): Promise<HouseRun> {
  return new Promise((resolve) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: accountOf(hosted.home) };
    delete environment.HOUSE_BRIDGE;
    const child = spawn(process.execPath, [HOUSE, ...args], { cwd, env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function readsRoomRoot(received: Received): boolean {
  const { name, arguments: args } = (received.body as { params: { name?: string; arguments?: { path?: unknown } } }).params;
  return name === 'info' && typeof args?.path === 'string' && /^\/rooms\/[^/]+$/.test(args.path);
}

export function roomRootReads(hosted: Hosted): string[] {
  return hosted.mcp.filter(readsRoomRoot).map((received) => (received.body as { params: { arguments: { path: string } } }).params.arguments.path);
}

export function fileCalls(hosted: Hosted): Received[] {
  return hosted.mcp.filter((received) => !readsRoomRoot(received));
}

export function upload(hosted: Hosted, room: Room, ...flags: string[]): Promise<HouseRun> {
  return house(hosted, room.repository, 'upload', ...flags);
}

export interface ManifestEntry {
  revision: string;
  sha256: string;
  bytes: number;
  read_only?: true;
  skipped?: true;
  conflicted?: true;
}

export async function manifestOf(room: Room): Promise<{ room_ref: string; files: Record<string, ManifestEntry> }> {
  return JSON.parse(await readFile(join(room.repository, MANIFEST), 'utf8')) as { room_ref: string; files: Record<string, ManifestEntry> };
}
