import { apply, parse, serialize, type Change } from '@agentshouse/mdmodel';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { stringify } from 'yaml';
import type { Answer, Received } from './double.ts';
import { GIT_IDENTITY, type Hosted, type ToolResult } from './environment.ts';
import { stop } from './kit.ts';
import type { Store } from './store.ts';

const HOUSE = fileURLToPath(new URL('../src/house-main.ts', import.meta.url));
export const COPIES = '/agents/house/local-copies';
const LOG_EPOCH = '0192f0e4-1c2d-7000-8000-000000000001';
const CHUNK_BYTES = 1024 * 1024;
const BODY_BYTES = 4 * 1024 * 1024;

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
  op: string;
  content: string | null;
  revision: string | null;
  from?: string;
  rewrite?: true;
}

type Refused = { code: string; path?: string; conflicts?: Record<string, unknown>[] };

type Edited = { writes: Write[] } | { refusal: Refused };

function said(refusal: Refused): string {
  if (refusal.code === 'protected_path') return `protected_path: ${refusal.path} is not writable`;
  const conflicts = stringify({ conflicts: refusal.conflicts }).trimEnd();
  return `edit_conflict: nothing was written; fix each conflict listed, then send the edit again\n${conflicts}`;
}

interface EditChange {
  op: string;
  path: string;
  to?: string;
  base?: unknown;
  content?: string;
  field?: string;
  section?: string;
  value?: unknown;
}

let revisions = 0;

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
  position = 1;
  logEpoch = LOG_EPOCH;
  write = [''];
  protected = ['capture', 'collaboration'];
  files = new Map<string, Stored>();
  readonly binaries = new Map<string, Binary>();
  readonly history = new Map<string, string>();
  readonly binaryHistory = new Map<string, Binary & { path: string }>();
  readonly folders = new Set<string>();
  readonly log: { position: number; paths: string[] }[] = [];
  readonly batches: EditChange[][] = [];
  models: Record<string, unknown>[] = [];
  private built: { position: number; entries: object[] } | null = null;

  constructor(handle: string) {
    this.handle = handle;
  }

  get root(): string {
    return `/rooms/${this.handle}`;
  }

  get repository(): string {
    return join(COPIES, 'rooms', this.ref);
  }

  writable(path: string): boolean {
    const deepest = (scopes: string[]) =>
      Math.max(-1, ...scopes.filter((scope) => covers(path, scope)).map((scope) => scope.length));
    return deepest(this.write) > deepest(this.protected);
  }

  stored(content: string, provenance?: string): Stored {
    revisions++;
    const revision = `rev-${revisions}`;
    this.history.set(revision, content);
    return { content, revision, ...(provenance === undefined ? {} : { provenance }) };
  }

  put(path: string, content: string, provenance?: string): string {
    const stored = this.stored(content, provenance);
    this.files.set(path, stored);
    this.advance([path]);
    return stored.revision;
  }

  upload(path: string, bytes: Buffer): string {
    revisions++;
    const binary = { revision: `rev-${revisions}`, bytes };
    this.binaries.set(path, binary);
    this.binaryHistory.set(binary.revision, { ...binary, path });
    this.advance([path]);
    return binary.revision;
  }

  remove(path: string): void {
    this.files.delete(path);
    this.advance([path]);
  }

  revision(path: string): string {
    return this.files.get(path)!.revision;
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
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
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
        const hash = createHash('sha256').update(served).digest('hex');
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
      spent += Buffer.byteLength(file?.content ?? '');
      changes.push(
        file === undefined
          ? { path, removed: true }
          : {
              path,
              content: file.content,
              revision: file.revision,
              sha256: 'unused',
              ...(file.provenance === undefined ? {} : { provenance: file.provenance }),
            },
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

  edit(changes: EditChange[]): Edited {
    const next = new Map(this.files);
    const writes = new Map<string, Write>();
    const conflicts: Record<string, unknown>[] = [];
    const set = (path: string, op: string, content: string, rewrite = false) => {
      const stored = this.stored(content);
      next.set(path, stored);
      writes.set(path, { path, op, content, revision: stored.revision, ...(rewrite ? { rewrite: true as const } : {}) });
    };
    for (const change of changes) {
      const path = change.path.slice(this.root.length + 1);
      const to = change.to?.slice(this.root.length + 1);
      if (!this.writable(path) || (to !== undefined && !this.writable(to))) {
        return { refusal: { code: 'protected_path', path: change.path } };
      }
      const current = next.get(path);
      const stale = (code: string) =>
        conflicts.push({ path: change.path, code, ...(current === undefined ? {} : { revision: current.revision }) });
      const binary = this.binaries.get(to ?? path);
      if (binary !== undefined) {
        conflicts.push({ path: change.to ?? change.path, code: 'binary_file', revision: binary.revision });
        continue;
      }
      if (change.op === 'create') {
        if (current !== undefined) stale('path_exists');
        else set(path, 'create', change.content!);
      } else if (change.op === 'replace') {
        if (current?.revision !== change.base) stale('base_revision_stale');
        else set(path, 'replace', change.content!);
      } else if (change.op === 'remove') {
        if (current?.revision !== change.base) stale('base_revision_stale');
        else {
          next.delete(path);
          writes.set(path, { path, op: 'remove', content: null, revision: null });
        }
      } else if (change.op === 'rename') {
        if (current?.revision !== change.base || next.has(to!)) stale('base_revision_stale');
        else {
          next.delete(path);
          next.set(to!, current!);
          writes.set(to!, { path: to!, op: 'rename', content: current!.content, revision: current!.revision, from: path });
          for (const [other, file] of next) {
            const link = `(${basename(path)})`;
            if (other !== to && dirname(other) === dirname(path) && file.content.includes(link)) {
              set(other, 'replace', file.content.replaceAll(link, `(${basename(to!)})`), true);
            }
          }
        }
      } else {
        const parsed = current === undefined ? null : parse(current.content, path);
        if (parsed === null || !parsed.ok) {
          stale('base_revision_stale');
          continue;
        }
        const structured: Change =
          change.op === 'set_field'
            ? { kind: 'field', name: change.field!, value: change.value, prior: change.base }
            : change.op === 'replace_preamble'
              ? { kind: 'preamble', value: change.content!, prior: String(change.base) }
              : { kind: 'section', name: change.section!, value: change.content!, prior: String(change.base) };
        const result = apply(parsed.document, [structured]);
        if (result.outcome !== 'applied') stale(`${structured.kind}_base_stale`);
        else set(path, 'replace', serialize(result.document));
      }
    }
    if (conflicts.length > 0) return { refusal: { code: 'edit_conflict', conflicts } };
    this.files = next;
    this.batches.push(changes);
    this.advance([...writes.values()].flatMap((write) => (write.from === undefined ? [write.path] : [write.path, write.from])));
    return { writes: [...writes.values()] };
  }
}

function answered(writes: Write[]): Write[] {
  return writes.filter((write) => write.rewrite === undefined);
}

export interface Rooms {
  answered: Room[];
  room(handle: string): Room;
  fetch(rooms: Room[]): Promise<HouseRun>;
  unreadable: Set<string>;
  denied: Set<string>;
  expired: Set<string>;
  omitted: Set<string>;
  dropping: number;
  dropsEdits: number;
  refusesBatches: Answer[];
  refusesUploads: Answer[];
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
  edits(): Received[];
}

function prefixed(rooms: Room[], prefixes: string[]): Room[] {
  return rooms.filter((room) => prefixes.includes(room.root));
}

const INVALID = { status: 400, body: { error: { code: 'invalid_request', retryable: false } } };

export const OVERLOADED = {
  error: { code: 'house_overloaded', message: 'house_overloaded: House is busy; call again in 5 s', retry_after: 5, retryable: true },
};

export function serveRooms(hosted: Hosted): Rooms {
  const rooms: Room[] = [];
  const receipts = new Map<string, unknown>();
  const state: Rooms = {
    answered: [],
    unreadable: new Set(),
    denied: new Set(),
    expired: new Set(),
    omitted: new Set(),
    dropping: 0,
    dropsEdits: 0,
    refusesBatches: [],
    refusesUploads: [],
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
    room: (handle) => {
      const room = new Room(handle);
      rooms.push(room);
      onTestFinished(async () => {
        stop(hosted.kit.pid);
        await hosted.kit.exited;
        await rm(room.repository, { recursive: true, force: true });
      });
      return room;
    },
    fetch: (answer) => {
      state.answered = answer;
      return house(hosted, '/', 'fetch');
    },
    edits: () => hosted.mcp.filter((received) => (received.body as { params: { name?: string } }).params.name === 'edit'),
  };
  const roomOf = (path: string) => rooms.find((room) => path === room.root || path.startsWith(`${room.root}/`))!;
  const edited = (room: Room, changes: EditChange[]) => {
    const outcome = room.edit(changes);
    if ('refusal' in outcome) return outcome;
    return {
      authority: room.ref,
      position: String(room.position),
      log_epoch: room.logEpoch,
      writes: outcome.writes.map((write) => ({
        ...write,
        path: `${room.root}/${write.path}`,
        ...(write.from === undefined ? {} : { from: `${room.root}/${write.from}` }),
      })),
    };
  };
  hosted.house.route('POST', '/kit/local-copy/selection', (request) => {
    const { rooms: named } = request.body as { rooms?: string[] };
    const answered = state.answered.filter((room) => named === undefined || named.includes(room.ref));
    return { body: { local_copy: { rooms: answered.map((room) => ({ room_ref: room.ref, room_handle: room.handle })) } } };
  });
  hosted.house.route('POST', '/kit/door/discover', (request) => {
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
  hosted.house.route('POST', '/kit/door/enumerate', (request) => {
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
  hosted.house.route('POST', '/kit/door/revisions', (request) => {
    const { path, revision } = request.body as { path: string; revision: string };
    const room = roomOf(path);
    return { body: { path, revisions: [{ revision, content: room.history.get(revision) }], next_before: null } };
  });
  hosted.house.route('POST', '/kit/door/batch', (request) => {
    const refused = state.refusesBatches.shift();
    if (refused !== undefined) return refused;
    const { operation_id: operation, changes } = request.body as { operation_id: string; changes: EditChange[] };
    if (!receipts.has(operation)) {
      const outcome = edited(roomOf(changes[0]!.path), changes);
      receipts.set(operation, outcome);
    }
    const outcome = receipts.get(operation) as ReturnType<typeof edited>;
    if (state.dropping > 0) {
      state.dropping--;
      return { drop: true };
    }
    if ('refusal' in outcome) return { status: 409, body: { error: { ...outcome.refusal, message: said(outcome.refusal), retryable: false } } };
    const { writes, ...rest } = outcome;
    return {
      body: { ...rest, contents: answered(writes).map((write) => ({ path: write.path, content: write.content, revision: write.revision })) },
    };
  });
  hosted.tools.inspect = (args) => {
    const path = String(args.path);
    const room = roomOf(path);
    const relative = path.slice(room.root.length + 1);
    const ref = args.ref as string | undefined;
    const binary = ref === undefined ? room.binaries.get(relative) : room.binaryHistory.get(ref);
    if (binary !== undefined) {
      const key = `binary/${room.ref}/${binary.revision}`;
      hosted.store.objects.set(key, state.damages ? Buffer.concat([binary.bytes, Buffer.from([0])]) : binary.bytes);
      const expired = state.expiring > 0;
      if (expired) state.expiring--;
      const text = stringify({
        path,
        revision: binary.revision,
        file: `bf_${binary.revision}`,
        bytes: binary.bytes.length,
        media_type: 'image/jpeg',
        sha256: createHash('sha256').update(binary.bytes).digest('hex'),
        download: hosted.store.address('GET', key, {}, expired),
      });
      return { content: [{ type: 'text', text }] };
    }
    const file = room.files.get(relative);
    if (file === undefined) return { isError: true, content: [{ type: 'text', text: `path_not_found: ${path} does not exist\n` }] };
    return { content: [{ type: 'text', text: stringify({ path, revision: file.revision }) }] };
  };
  const grants = new Map<string, { operation: string; staged?: string }>();
  const staged = new Map<string, Buffer>();
  hosted.tools.run_command = (args) => {
    state.prepared.push(args.arguments);
    const grant = `edit-${grants.size + 1}`;
    const operation = randomUUID();
    grants.set(grant, { operation });
    return { content: [{ type: 'text', text: stringify({ transfer: { method: 'POST', url: `${hosted.house.origin}/uploads/${grant}`, operation } }) }] };
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
  hosted.tools.edit = (args, request) => {
    const bearer = request.headers.authorization!;
    if (state.denied.has(bearer)) {
      return { isError: true, content: [{ type: 'text', text: 'operation_denied: you may not write here; the Room owner grants Room access, your User widens an Agent at /agents\n' }] };
    }
    const upload = args.upload as { url: string } | undefined;
    const changes = (
      upload === undefined ? args.changes : (JSON.parse(staged.get(upload.url)!.toString('utf8')) as { changes: unknown }).changes
    ) as EditChange[];
    const meta = (request.body as { params: { _meta: Record<string, string> } }).params._meta;
    const operation = meta['agents.house/agent-operation']!;
    if (!receipts.has(operation)) receipts.set(operation, edited(roomOf(changes[0]!.path), changes));
    if (state.dropsEdits > 0) {
      state.dropsEdits--;
      return null;
    }
    const outcome = receipts.get(operation) as ReturnType<typeof edited>;
    if ('refusal' in outcome) {
      return { isError: true, content: [{ type: 'text', text: `${said(outcome.refusal)}\n` }] } satisfies ToolResult;
    }
    return {
      content: [
        {
          type: 'text',
          text: stringify({
            results: answered(outcome.writes).map((write) => ({
              path: write.path,
              ...(write.op === 'remove' || write.revision === null ? {} : { revision: write.revision }),
              ...(write.from === undefined ? {} : { from: write.from }),
            })),
          }),
        },
      ],
    };
  };
  return state;
}

export function tryGit(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_IDENTITY, GIT_EDITOR: 'true' } });
}

export function git(cwd: string, ...args: string[]): string {
  const ran = tryGit(cwd, ...args);
  if (ran.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${ran.stderr}`);
  return ran.stdout;
}

export function commitAll(cwd: string, message: string): string {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

export interface HouseRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function house(hosted: Hosted, cwd: string, ...args: string[]): Promise<HouseRun> {
  return new Promise((resolve) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, HOUSE_KIT_HOME: hosted.home };
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
