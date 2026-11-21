import type { KitBinaryChange } from '@agentshouse/kit-wire';
import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { finalRefusal, HouseRefusal, retrying, type House } from './api.ts';
import { Changed, eachAtOnce, isDocument, mediaType, receivedBinary, sentBinary, type Staged, type StagedUpload } from './binaries.ts';
import { chunkEntries, stagedChunks, type Chunk, type Text } from './chunks.ts';
import { fileInfo, paused, type FileInfo, type Finished } from './files.ts';
import { kitHome, roomsFolder } from './home.ts';
import {
  digest,
  hashed,
  holding,
  marked,
  placed,
  readManifest,
  removed,
  scanned,
  writeManifest,
  type Entry,
  type Manifest,
  type Present,
} from './manifest.ts';
import { ownAgentCall, rpc, toolAnswer, Unsettled } from './mcp.ts';
import { operationId } from './operation.ts';
import { firstLine, refusalOf, retryable, stopsPush, type Refusal } from './refusals.ts';
import { keptName, present as found, rerooted, within } from './workspace.ts';

const ROOMS = 'rooms/';
const NOT_READY = 'not ready yet; Kit copies it once House has built it';
const PROVENANCE = '_provenance';
const BATCH_FILES = 1000;
const BATCH_BYTES = 15_000_000;
const MEGABYTE = 1_000_000;
const CUT = /\noutput_cut \d+ of \d+ bytes$/;
const KIT_IGNORES = ['.gitignore', '.ignore'];
const KIT_GIT = ['.git/refs/house/received', '.git/house-chunks', '.git/house-uploads', '.git/house-downloads'];
const KIT_NAMES = ['agents.md', 'claude.md'];

export const DEFAULT_MAX_SIZE = 10;
export const UPLOAD_NEEDS_OWNER = 'outside an Agent conversation, house upload needs --owner';

// A Room answered not ready is asked again on this schedule: its chunk build usually catches up within seconds, so the first asks come soon and the last repeats until it does.
const ASKED_AGAIN_MS = [1000, 2000, 3000, 5000, 8000, 11_000, 15_000];

export type Change =
  | { op: 'write'; path: string; content: string; base?: string }
  | { op: 'move'; path: string; to: string; base: string }
  | { op: 'delete'; path: string; base: string }
  | { op: 'upload'; path: string; base?: string; bytes: number; sha256: string; media_type: string };

type Part = Extract<Change, { op: 'upload' }>;

export interface Written {
  path: string;
  revision: string | null;
  content?: string | null;
}

export interface Upload {
  url: string;
  operation: string;
  bytes: number;
  sha256: string;
}

interface Read {
  name: string;
  sha256: string;
}

interface Pending {
  operation_id: string;
  caller: string;
  changes: Change[];
  read: Record<string, Read>;
  upload?: Upload;
  staged?: string[];
}

interface Copied {
  key: string;
  room_ref: string;
  room_handle: string;
  repository: string;
  position: string;
  log_epoch: string;
  write: string[];
  protected: string[];
  unfollowed?: 'unsaid' | 'said';
}

interface Copy extends Copied {
  pending?: Pending;
}

interface Recorded {
  parent: string | null;
  files: Record<string, string | null>;
  binary?: Record<string, { bytes: number; sha256: string }>;
}

interface EarlierCopy extends Copied {
  house: string;
  read_only: string[];
  manifests: Record<string, Recorded>;
}

type Held = Copy | EarlierCopy;

interface Authority {
  room_ref: string;
  protected_paths: string[];
  operations: { write: string[] };
  position: string;
  log_epoch: string;
}

interface Discovery {
  bounds: { max_authored_file_bytes: number; max_prefixes: number };
  authorities: Authority[];
}

type Entered = Text | KitBinaryChange;

type Delta = Entered | { path: string; removed: true };

interface Enumerated {
  authority: string;
  position: string;
  log_epoch: string;
  changes: Delta[];
  next?: unknown;
}

type Listed =
  | { room_ref: string; ready: false }
  | { room_ref: string; ready: true; position: string; log_epoch: string; chunks: Chunk[]; models: Text[] };

interface Whole {
  position: string;
  log_epoch: string;
  entries: Iterable<Entered> | AsyncIterable<Entered>;
}

interface Wanted {
  key: string;
  handle: string;
  authority: Authority;
}

interface Scope {
  write: string[];
  protected: string[];
}

interface Report {
  touched: Map<string, string | null>;
  kept: Set<string>;
}

export interface Fetching {
  attachments: boolean;
  maxSize: number;
}

class NotReady extends Error {
  readonly rooms: readonly string[];

  constructor(rooms: readonly string[]) {
    super(NOT_READY);
    this.rooms = rooms;
  }
}

export type Submitted = { accepted: Written[] } | { refused: Refusal };

export interface Caller {
  key: string;
  submit(
    operation: string,
    changes: Change[],
    upload: Upload | undefined,
    retain: (upload: Upload) => Promise<void>,
  ): Promise<Submitted>;
  finish(upload: string, path: string, partSha256: string[]): Promise<Finished<Staged>>;
  info(path: string, revision?: string): Promise<FileInfo | null>;
}

export interface Answered {
  refused: boolean;
  text: string;
}

type Settled = { refused: true; text: string } | { refused: false; files: number; lines: string[] };

type Built = { changes: Change[]; read: Record<string, Read> } | Answered;

const HELD: Fetching = { attachments: false, maxSize: DEFAULT_MAX_SIZE };

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function houseCause(error: unknown): string {
  return error instanceof HouseRefusal ? (refusalOf(error.text)?.text ?? causeOf(error)) : causeOf(error);
}

function logged(error: unknown): void {
  process.stderr.write(`kit: ${causeOf(error)}\n`);
}

function markdownOnly(paths: string[], maxBytes: number): string {
  const [named, them] = paths.length === 1 ? [`${paths[0]} is`, 'it'] : [`${paths.join(', ')} are`, 'them'];
  return `${named} Markdown, which holds text only: UTF-8 without NUL, at most ${maxBytes} bytes; save ${them} as text and run house upload again`;
}

async function stopping<T>(sent: Promise<T>): Promise<T | { refused: Refusal }> {
  try {
    return await sent;
  } catch (error) {
    const refusal = error instanceof HouseRefusal ? refusalOf(error.text) : null;
    if (refusal === null || !stopsPush(refusal)) throw error;
    return { refused: refusal };
  }
}

function unstagedUploads(refusal: Refusal): StagedUpload[] {
  const named = refusal.detail.upload;
  return Array.isArray(named) ? (named as StagedUpload[]) : [];
}

function currentHandle(refusal: Refusal): string | null {
  const path = typeof refusal.detail.current_path === 'string' ? refusal.detail.current_path : /use (\/rooms\/\S+)/.exec(refusal.text)?.[1];
  return path === undefined ? null : (/^\/rooms\/([^/]+)/.exec(path)?.[1] ?? null);
}

function outside(path: string): Answered {
  return { refused: true, text: `${path} is not in a House Local copy; run house upload inside one` };
}

function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function expiredAuthority(error: unknown): string | undefined {
  if (!(error instanceof HouseRefusal)) return undefined;
  try {
    const { error: refused } = JSON.parse(error.text) as { error?: { code?: unknown; authority?: unknown } };
    return refused?.code === 'expired' && typeof refused.authority === 'string' ? refused.authority : undefined;
  } catch {
    return undefined;
  }
}

function grouped<T>(items: readonly T[], size: number): T[][] {
  return items.flatMap((_, index) => (index % size === 0 ? [items.slice(index, index + size)] : []));
}

function covers(path: string, prefix: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
}

function sidecar(path: string): string {
  const segments = path.split('/');
  segments.splice(-1, 0, PROVENANCE);
  return segments.join('/');
}

function recordOf(key: string): string {
  return join(kitHome(), 'local-copies', `${key}.json`);
}

export function stagingPrefix(): string {
  return `.${createHash('sha256').update(kitHome()).digest('hex').slice(0, 16)}-`;
}

async function staging(): Promise<string> {
  const folder = join(roomsFolder(), `${stagingPrefix()}work`);
  await mkdir(folder, { recursive: true });
  return `${folder}/`;
}

function rootOf(handle: string): string {
  return `/rooms/${handle}`;
}

function relative(path: string): string {
  return path.replace(/^\/rooms\/[^/]+\//, '');
}

function kitsOwn(path: string): boolean {
  return !path.includes('/') && KIT_NAMES.includes(path.toLowerCase());
}

function declaredWritable(path: string, copy: Scope): boolean {
  const deepest = (scopes: string[]) =>
    Math.max(-1, ...scopes.filter((scope) => covers(path, scope)).map((scope) => scope.length));
  return deepest(copy.write) > deepest(copy.protected);
}

function differing(left: string, right: string): number {
  const counts = new Map<string, number>();
  for (const line of left.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  let unmatched = 0;
  for (const line of right.split('\n')) {
    const held = counts.get(line) ?? 0;
    if (held > 0) counts.set(line, held - 1);
    else unmatched++;
  }
  return unmatched + [...counts.values()].reduce((sum, count) => sum + count, 0);
}

function whole(theirs: string, mine: string): string {
  return `<<<<<<< current\n${ended(theirs)}=======\n${ended(mine)}>>>>>>> yours\n`;
}

function ended(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

function sameBytes(file: { sha256: string; bytes: number }): string {
  return `${file.sha256}:${file.bytes}`;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function without(copy: Copy): Copy {
  const { pending, ...settled } = copy;
  return settled;
}

function earlier(copy: Held): copy is EarlierCopy {
  return 'manifests' in copy;
}

function rehandled(copy: Copy, handle: string): Copy {
  const from = `${rootOf(copy.room_handle)}/`;
  const to = `${rootOf(handle)}/`;
  const moved = (path: string) => (path.startsWith(from) ? `${to}${path.slice(from.length)}` : path);
  const { upload, ...pending } = copy.pending!;
  return {
    ...copy,
    room_handle: handle,
    pending: {
      ...pending,
      changes: pending.changes.map((change) => (change.op === 'move' ? { ...change, path: moved(change.path), to: moved(change.to) } : { ...change, path: moved(change.path) })),
    },
  };
}

export function changedPaths(changes: readonly Change[]): string[] {
  return [...new Set(changes.flatMap((change) => (change.op === 'move' ? [change.path, change.to] : [change.path])))].sort();
}

function batched(changes: readonly Change[]): Change[][] {
  const batches: Change[][] = [];
  let batch: Change[] = [];
  let files = 0;
  let bytes = 0;
  for (const change of changes) {
    const named = change.op === 'move' ? 2 : 1;
    const size = Buffer.byteLength(JSON.stringify(change));
    if (batch.length > 0 && (files + named > BATCH_FILES || bytes + size > BATCH_BYTES)) {
      batches.push(batch);
      batch = [];
      files = 0;
      bytes = 0;
    }
    batch.push(change);
    files += named;
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function recordedFiles(copy: EarlierCopy): Map<string, { revision: string; held?: { bytes: number; sha256: string } }> {
  const found = new Map<string, { revision: string; held?: { bytes: number; sha256: string } }>();
  const seen = new Set<string>();
  for (let manifest: Recorded | undefined = copy.manifests[copy.house]; manifest !== undefined; manifest = manifest.parent === null ? undefined : copy.manifests[manifest.parent]) {
    for (const [path, revision] of Object.entries(manifest.files)) {
      if (seen.has(path)) continue;
      seen.add(path);
      const held = manifest.binary?.[path];
      if (revision !== null) found.set(path, held === undefined ? { revision } : { revision, held });
    }
  }
  return found;
}

function recordedRevisions(copy: EarlierCopy, path: string): string[] {
  return [...new Set(Object.values(copy.manifests).flatMap((manifest) => (typeof manifest.files[path] === 'string' ? [manifest.files[path]] : [])))];
}

class Applying {
  private present = new Map<string, Present>();
  private readonly binaries: KitBinaryChange[] = [];
  private readonly gone: string[] = [];

  private readonly repository: string;
  private readonly manifest: Manifest;
  private readonly scope: Scope;
  private readonly staging: string;
  private readonly report: Report;
  private readonly fetching: Fetching;
  private readonly bytesOf: (change: KitBinaryChange) => Promise<string>;

  constructor(
    repository: string,
    manifest: Manifest,
    scope: Scope,
    staging: string,
    report: Report,
    fetching: Fetching,
    bytesOf: (change: KitBinaryChange) => Promise<string>,
  ) {
    this.repository = repository;
    this.manifest = manifest;
    this.scope = scope;
    this.staging = staging;
    this.report = report;
    this.fetching = fetching;
    this.bytesOf = bytesOf;
  }

  async start(): Promise<void> {
    this.present = await scanned(this.repository);
  }

  private nameOf(path: string): string {
    return this.present.get(path)?.name ?? path;
  }

  private touch(path: string): void {
    if (!this.report.touched.has(path)) this.report.touched.set(path, this.present.get(path)?.sha256 ?? null);
  }

  private async put(path: string, content: Buffer | string): Promise<void> {
    this.touch(path);
    await placed(this.staging, join(this.repository, this.nameOf(path)), content);
    this.present.set(path, { name: this.nameOf(path), sha256: digest(content), bytes: Buffer.byteLength(content) });
  }

  private async drop(path: string): Promise<void> {
    this.touch(path);
    await removed(this.repository, this.nameOf(path));
    this.present.delete(path);
  }

  private async readOnly(path: string, content: string, revision: string): Promise<void> {
    const sha256 = digest(content);
    if (this.present.get(path)?.sha256 !== sha256) await this.put(path, content);
    this.manifest.files[path] = { revision, sha256, bytes: Buffer.byteLength(content), read_only: true };
  }

  async text({ path, content, revision, provenance }: Text): Promise<void> {
    if (provenance !== undefined) await this.readOnly(sidecar(path), provenance, revision);
    if (!declaredWritable(path, this.scope)) {
      await this.readOnly(path, content, revision);
      return;
    }
    const entry = this.manifest.files[path];
    if (entry !== undefined && !entry.read_only && entry.revision === revision) return;
    const sha256 = digest(content);
    const kept = { revision, sha256, bytes: Buffer.byteLength(content) };
    const local = this.present.get(path);
    if (local?.sha256 === sha256) {
      this.manifest.files[path] = kept;
      return;
    }
    const unchanged = entry === undefined ? local === undefined : entry.read_only === true || (entry.conflicted === undefined && local?.sha256 === entry.sha256);
    if (!unchanged || (local !== undefined && !(await holding(this.repository, local.name, local.sha256)))) {
      this.report.kept.add(path);
      return;
    }
    await this.put(path, content);
    this.manifest.files[path] = kept;
  }

  binary(change: KitBinaryChange): void {
    this.binaries.push(change);
  }

  removal(path: string): void {
    this.gone.push(path);
  }

  async finish(): Promise<void> {
    const leaving = new Map<string, string | null>();
    for (const path of this.gone) {
      const entry = this.manifest.files[path];
      if (entry === undefined || entry.skipped || isDocument(path) || this.present.get(path)?.sha256 !== entry.sha256) continue;
      leaving.set(sameBytes(entry), leaving.has(sameBytes(entry)) ? null : path);
    }
    const taken = new Set<string>();
    const movedFrom = (change: KitBinaryChange): string | undefined => {
      const from = leaving.get(sameBytes(change));
      if (from === undefined || from === null || taken.has(from)) return undefined;
      taken.add(from);
      return from;
    };
    for (const change of this.binaries) await this.attachment(change, movedFrom);
    for (const path of this.gone) {
      if (taken.has(path)) continue;
      await this.removedHere(path);
      if (this.manifest.files[sidecar(path)]?.read_only) await this.removedHere(sidecar(path));
    }
  }

  private async attachment(change: KitBinaryChange, movedFrom: (change: KitBinaryChange) => string | undefined): Promise<void> {
    const { path, revision, bytes, sha256 } = change;
    const entry = this.manifest.files[path];
    if (entry !== undefined && entry.revision === revision) return;
    const held: Entry = { revision, sha256, bytes, ...(declaredWritable(path, this.scope) ? {} : { read_only: true as const }) };
    const local = this.present.get(path);
    if (local?.sha256 === sha256) {
      this.manifest.files[path] = held;
      return;
    }
    const holds = entry !== undefined && !entry.skipped;
    if (holds && !entry.read_only && local?.sha256 !== entry.sha256) {
      this.report.kept.add(path);
      return;
    }
    if (!holds && local !== undefined) {
      this.report.kept.add(path);
      return;
    }
    const from = movedFrom(change);
    if (from !== undefined) {
      const target = join(this.repository, this.nameOf(path));
      this.touch(path);
      await mkdir(dirname(target), { recursive: true });
      await rename(join(this.repository, this.nameOf(from)), target);
      await removed(this.repository, this.nameOf(from));
      this.present.set(path, { name: this.nameOf(path), sha256, bytes });
      this.present.delete(from);
      delete this.manifest.files[from];
      this.manifest.files[path] = held;
      return;
    }
    if (!holds && !(this.fetching.attachments && bytes <= this.fetching.maxSize * MEGABYTE)) {
      this.manifest.files[path] = { ...held, skipped: true };
      return;
    }
    const file = await this.bytesOf(change);
    const target = join(this.repository, this.nameOf(path));
    this.touch(path);
    await mkdir(dirname(target), { recursive: true });
    await rename(file, target);
    this.present.set(path, { name: this.nameOf(path), sha256, bytes });
    this.manifest.files[path] = held;
  }

  private async removedHere(path: string): Promise<void> {
    const entry = this.manifest.files[path];
    if (entry === undefined) return;
    const local = this.present.get(path);
    if (entry.skipped || local === undefined) {
      delete this.manifest.files[path];
      return;
    }
    if (!entry.read_only && (local.sha256 !== entry.sha256 || !(await holding(this.repository, local.name, entry.sha256)))) {
      this.report.kept.add(path);
      return;
    }
    await this.drop(path);
    delete this.manifest.files[path];
  }
}

export class LocalCopies {
  readonly owner: Caller;
  private readonly house: House;
  private readonly copies = new Map<string, Held>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly waiting = new Set<string>();
  private answering: Promise<unknown> = Promise.resolve();

  constructor(house: House) {
    this.house = house;
    this.owner = {
      key: 'owner',
      submit: async (operation, changes) => {
        try {
          const outcome = await retrying(() =>
            stopping(house.door<{ contents: Written[] }>('update', { operation_id: operation, changes })),
          );
          return 'refused' in outcome ? outcome : { accepted: outcome.contents };
        } catch (error) {
          if (!finalRefusal(error)) throw error;
          return {
            refused: refusalOf(error.text) ?? { code: '', text: `House refused it with ${error.status}`, conflicts: [], detail: {} },
          };
        }
      },
      finish: async (upload, _path, partSha256) => {
        try {
          return (await house.act('uploads/finish', { upload, part_sha256: partSha256 })) as Finished<Staged>;
        } catch (error) {
          if (!(error instanceof HouseRefusal)) throw new Unsettled(causeOf(error));
          throw retryable(error.text) === false ? new Error(houseCause(error)) : new Unsettled(houseCause(error));
        }
      },
      info: async (path, revision) => {
        const read = toolAnswer({
          status: 200,
          text: await ownAgentCall(
            rpc('tools/call', { name: 'info', arguments: { path, ...(revision === undefined ? {} : { ref: revision }) } }),
          ),
        });
        if ('refused' in read) throw new Error(read.refused.text);
        return fileInfo(read.text);
      },
    };
  }

  async load(): Promise<void> {
    const home = join(kitHome(), 'local-copies');
    const names = (await readdir(join(home, 'rooms')).catch(() => [])).filter((name) => name.endsWith('.json'));
    for (const path of names.map((name) => join(home, 'rooms', name))) {
      const text = await readFile(path, 'utf8').catch(() => null);
      if (text === null) continue;
      const copy = JSON.parse(text) as Held;
      this.copies.set(copy.key, copy);
    }
  }

  async swept(): Promise<void> {
    const rooms = roomsFolder();
    for (const name of await readdir(rooms).catch(() => [])) {
      if (name.startsWith(stagingPrefix())) await rm(join(rooms, name), { recursive: true, force: true });
    }
  }

  connected(): Promise<void> {
    return this.selected();
  }

  download(caller: Caller, fetching: Fetching): Promise<Answered> {
    return this.answered(() => this.fetched(true, caller, fetching));
  }

  private async selected(): Promise<void> {
    const copied = await this.answered(() => this.fetched(false, this.owner, HELD));
    if (copied.refused) logged(copied.text);
  }

  private answered<T>(work: () => Promise<T>): Promise<T> {
    const answered = this.answering.then(work);
    this.answering = answered.catch(() => undefined);
    return answered;
  }

  private async fetched(refreshing: boolean, caller: Caller, fetching: Fetching): Promise<Answered> {
    const { local_copy: answer } = await this.house.act('local-copies/selection/read', {});
    const synced = new Map(answer.rooms.map((room) => [`${ROOMS}${room.room_ref}`, room.room_handle]));
    return this.holding([...new Set([...this.copies.keys(), ...synced.keys()])].sort(), async () => {
      const said: string[] = [];
      let refused = false;
      const mark = refreshing ? 'said' : 'unsaid';
      for (const copy of [...this.copies.values()]) {
        if (synced.has(copy.key) || copy.unfollowed === 'said' || copy.unfollowed === mark) continue;
        await this.save({ ...copy, unfollowed: mark });
        if (refreshing) said.push(`${rootOf(copy.room_handle)}: no longer followed; kept as it is`);
      }
      const current: Held[] = [];
      const wanted = new Map<string, string>();
      for (const [key, handle] of synced) {
        try {
          const held = this.copies.get(key);
          if (held === undefined || !(await exists(held.repository))) {
            wanted.set(key, handle);
            continue;
          }
          const { unfollowed, ...followed } = held;
          const named = unfollowed === undefined && held.room_handle === handle ? held : await this.save({ ...followed, room_handle: handle });
          current.push(await this.renamed(named));
        } catch (error) {
          refused = true;
          said.push(`${rootOf(handle)}: ${causeOf(error)}`);
        }
      }
      const unready: string[] = [];
      const unsettled: string[] = [];
      if (wanted.size > 0) {
        const { authorities } = await this.discovered([...wanted.values()]);
        for (const [key, handle] of wanted) {
          const authority = authorities.find((entry) => `${ROOMS}${entry.room_ref}` === key);
          try {
            if (authority === undefined) throw new Error('House serves nothing of it to copy');
            said.push(await this.copied({ key, handle, authority }, fetching));
          } catch (error) {
            if (error instanceof NotReady) {
              unready.push(...error.rooms);
              said.push(`${rootOf(handle)}: ${NOT_READY}`);
            } else {
              refused = true;
              unsettled.push(key.slice(ROOMS.length));
              said.push(`${rootOf(handle)}: ${causeOf(error)}`);
            }
          }
        }
      }
      const reading = refreshing ? current : current.filter((copy) => this.waiting.has(copy.room_ref));
      if (reading.length > 0) {
        const reports = new Map<string, Report>(reading.map((copy) => [copy.key, { touched: new Map<string, string | null>(), kept: new Set<string>() }]));
        const unconverted = new Map<string, string>();
        const failed = await this.refreshed(reading, unready, unconverted, caller, fetching, reports).then(() => null, houseCause);
        for (const copy of reading) {
          const cause = unconverted.get(copy.key);
          if (cause !== undefined) {
            refused = true;
            unsettled.push(copy.room_ref);
            said.push(cause);
          } else if (unready.includes(copy.room_ref)) said.push(`${rootOf(copy.room_handle)}: ${NOT_READY}`);
          else said.push(...(await this.reported(this.copies.get(copy.key)!, reports.get(copy.key)!)));
        }
        if (failed !== null) {
          refused = true;
          unsettled.push(...reading.map((copy) => copy.room_ref));
          said.push(failed);
        }
      }
      for (const room of [...this.waiting]) {
        if (!unready.includes(room) && !unsettled.includes(room)) this.waiting.delete(room);
      }
      const due = unready.filter((room) => !this.waiting.has(room));
      for (const room of due) this.waiting.add(room);
      if (due.length > 0) void this.askedAgain(due);
      return { refused, text: said.length === 0 ? 'Nothing new from House.' : said.join('\n') };
    });
  }

  private async reported(copy: Held, report: Report): Promise<string[]> {
    const root = rootOf(copy.room_handle);
    let updated = 0;
    for (const [path, before] of report.touched) if (((await hashed(join(copy.repository, path)))?.sha256 ?? null) !== before) updated++;
    return [
      ...(updated === 0 ? [] : [`${root}: ${counted(updated, 'file')} updated from House`]),
      ...[...report.kept].sort().map((path) => `${root}/${path}: changed here, so House's change was not brought; the next house upload merges it`),
    ];
  }

  private async askedAgain(rooms: readonly string[]): Promise<void> {
    let asking = rooms;
    for (let step = 0; asking.length > 0; step++) {
      await paused(ASKED_AGAIN_MS[Math.min(step, ASKED_AGAIN_MS.length - 1)]!);
      await this.selected().catch(logged);
      asking = asking.filter((room) => this.waiting.has(room));
    }
  }

  upload(cwd: string, caller: Caller): Promise<Answered> {
    return this.keyAt(cwd).then((key) => (key === undefined ? outside(cwd) : this.exclusive(key, () => this.uploaded(key, caller))));
  }

  private async keyAt(cwd: string): Promise<string | undefined> {
    const held = new Map<string, string>();
    for (const copy of this.copies.values()) held.set(await realpath(copy.repository).catch(() => copy.repository), copy.key);
    for (let folder = await realpath(cwd).catch(() => cwd); ; folder = dirname(folder)) {
      const key = held.get(folder);
      if (key !== undefined) return key;
      if (dirname(folder) === folder) return undefined;
    }
  }

  private exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const queued = (this.queues.get(key) ?? Promise.resolve()).then(work);
    this.queues.set(
      key,
      queued.catch(() => undefined),
    );
    return queued;
  }

  private holding<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const [key, ...rest] = keys;
    return key === undefined ? work() : this.exclusive(key, () => this.holding(rest, work));
  }

  private async save<T extends Held>(copy: T): Promise<T> {
    const path = recordOf(copy.key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}`;
    await writeFile(temporary, JSON.stringify(copy), { mode: 0o600 });
    await rename(temporary, path);
    this.copies.set(copy.key, copy);
    return copy;
  }

  private async discovered(handles: readonly string[]): Promise<Discovery> {
    const discover = (group: readonly string[]) =>
      this.house.door<Discovery>('rooms/discover', { prefixes: group.map(rootOf) });
    const [first, ...rest] = handles;
    const { bounds, authorities } = await discover([first!]);
    for (const group of grouped(rest, bounds.max_prefixes)) authorities.push(...(await discover(group)).authorities);
    return { bounds, authorities };
  }

  private async chunked(root: string, room: string, directory: string): Promise<Whole> {
    await mkdir(directory, { recursive: true });
    for (let renewed = false; ; renewed = true) {
      const { rooms } = await this.house.door<{ rooms: Listed[] }>('room-chunks/list', { prefixes: [root] });
      const list = rooms.find((entry) => entry.room_ref === room);
      if (list === undefined) throw new Error('House serves nothing of it to copy');
      if (!list.ready) throw new NotReady([room]);
      const held = new Set(await readdir(directory));
      const failure = await stagedChunks(directory, list.chunks.filter(({ hash }) => !held.has(hash)));
      if (failure === undefined) {
        return { position: list.position, log_epoch: list.log_epoch, entries: chunkEntries(directory, list.chunks, list.models) };
      }
      if (renewed && (await readdir(directory)).length === held.size) throw failure;
    }
  }

  private chunksFolder(): string {
    return join(roomsFolder(), `${stagingPrefix()}${randomUUID()}`);
  }

  private async setAside(path: string): Promise<void> {
    if ((await found(path)) === null) return;
    const kept = await keptName(path);
    await rename(path, kept);
    for (const copy of [...this.copies.values()]) if (within(copy.repository, path)) await this.save(rerooted(copy, path, kept));
  }

  private async renamed<T extends Held>(copy: T): Promise<T> {
    const folder = join(roomsFolder(), copy.room_handle);
    if (dirname(copy.repository) !== roomsFolder() || basename(copy.repository) === copy.room_handle) return copy;
    await this.setAside(folder);
    await rename(copy.repository, folder);
    return this.save(rerooted(copy, copy.repository, folder));
  }

  private async materialized({ key, handle, authority }: Wanted, whole: (directory: string) => Promise<Whole>): Promise<Copy> {
    const repository = join(roomsFolder(), handle);
    await this.setAside(repository);
    const folder = join(dirname(repository), `${stagingPrefix()}${randomUUID()}`);
    const chunks = this.chunksFolder();
    const scope = { write: authority.operations.write, protected: authority.protected_paths };
    const manifest: Manifest = { room_ref: authority.room_ref, files: {} };
    await mkdir(folder, { recursive: true });
    let copy: Copy;
    try {
      const read = await whole(chunks);
      const work = await staging();
      for await (const entry of read.entries) {
        if (!('content' in entry)) {
          manifest.files[entry.path] = {
            revision: entry.revision,
            sha256: entry.sha256,
            bytes: entry.bytes,
            skipped: true,
            ...(declaredWritable(entry.path, scope) ? {} : { read_only: true as const }),
          };
          continue;
        }
        const { path, content, revision, provenance } = entry;
        await placed(work, join(folder, path), content);
        manifest.files[path] = {
          revision,
          sha256: digest(content),
          bytes: Buffer.byteLength(content),
          ...(declaredWritable(path, scope) ? {} : { read_only: true as const }),
        };
        if (provenance !== undefined) {
          await placed(work, join(folder, sidecar(path)), provenance);
          manifest.files[sidecar(path)] = { revision, sha256: digest(provenance), bytes: Buffer.byteLength(provenance), read_only: true };
        }
      }
      await writeManifest(folder, work, manifest);
      await rename(folder, repository);
      copy = { key, room_ref: authority.room_ref, room_handle: handle, repository, position: read.position, log_epoch: read.log_epoch, ...scope };
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(chunks, { recursive: true, force: true });
    }
    return this.save(copy);
  }

  private async copied(wanted: Wanted, fetching: Fetching): Promise<string> {
    const { handle, authority } = wanted;
    const root = rootOf(handle);
    let answer: { authorities: Enumerated[] } | null = null;
    try {
      if (!this.waiting.has(authority.room_ref)) {
        answer = await this.house.door('changes/enumerate', {
          prefixes: [root],
          positions: [
            { authority: authority.room_ref, position: '0', log_epoch: authority.log_epoch, page: { through: authority.position, read: 0 } },
          ],
        });
      }
    } catch (error) {
      if (expiredAuthority(error) !== authority.room_ref) throw error;
    }
    const view = answer?.authorities.find((entry) => entry.authority === authority.room_ref);
    if (answer !== null && view === undefined) throw new Error('House serves nothing of it to copy');
    if (view !== undefined && view.next === undefined) {
      const entries = view.changes.filter((change): change is Entered => !('removed' in change));
      const copy = await this.materialized(wanted, async () => ({ position: view.position, log_epoch: view.log_epoch, entries }));
      await this.attached(copy, this.owner, fetching, { touched: new Map<string, string | null>(), kept: new Set<string>() });
      return `${root}: copied to ${copy.repository}`;
    }
    const copy = await this.materialized(wanted, (directory) => this.chunked(root, authority.room_ref, directory));
    const report = { touched: new Map<string, string | null>(), kept: new Set<string>() };
    const [caught] = await this.caughtUp([copy], true, this.owner, fetching, new Map([[copy.key, report]]));
    await this.attached(caught!, this.owner, fetching, report);
    return `${root}: copied to ${copy.repository}`;
  }

  private applying(copy: Copy, manifest: Manifest, scope: Scope, work: string, report: Report, fetching: Fetching, caller: Caller): Applying {
    const root = rootOf(copy.room_handle);
    return new Applying(copy.repository, manifest, scope, work, report, fetching, (change) =>
      receivedBinary(work, `${root}/${change.path}`, async () => {
        const file = await caller.info(`${root}/${change.path}`, change.revision);
        if (file === null) throw new Error(`House holds no attachment at ${root}/${change.path}`);
        return file;
      }),
    );
  }

  private async received(copy: Copy, authority: Authority, caller: Caller, fetching: Fetching, report: Report): Promise<Copy> {
    const root = rootOf(copy.room_handle);
    const directory = this.chunksFolder();
    const scope = { write: authority.operations.write, protected: authority.protected_paths };
    try {
      const read = await this.chunked(root, copy.room_ref, directory);
      const manifest = await readManifest(copy.repository);
      const work = await staging();
      const applying = this.applying(copy, manifest, scope, work, report, fetching, caller);
      await applying.start();
      try {
        const whole = new Set<string>();
        for await (const entry of read.entries) {
          whole.add(entry.path);
          if (!('content' in entry)) {
            applying.binary(entry);
            continue;
          }
          if (entry.provenance !== undefined) whole.add(sidecar(entry.path));
          await applying.text(entry);
        }
        for (const path of Object.keys(manifest.files)) if (!whole.has(path)) applying.removal(path);
        await applying.finish();
      } finally {
        await writeManifest(copy.repository, work, manifest);
      }
      return { ...copy, ...scope, position: read.position, log_epoch: read.log_epoch };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async reread(copy: Copy, caller: Caller, fetching: Fetching, report: Report): Promise<Copy> {
    const { authorities } = await this.discovered([copy.room_handle]);
    const authority = authorities.find((entry) => entry.room_ref === copy.room_ref);
    if (authority === undefined) throw new NotReady([copy.room_ref]);
    return this.received(copy, authority, caller, fetching, report);
  }

  private async refreshed(
    held: readonly Held[],
    unready: string[],
    unconverted: Map<string, string>,
    caller: Caller,
    fetching: Fetching,
    reports: Map<string, Report>,
  ): Promise<void> {
    const copies: Copy[] = [];
    for (const copy of held) {
      try {
        copies.push(await this.converted(copy));
      } catch (error) {
        if (error instanceof NotReady) unready.push(...error.rooms);
        else unconverted.set(copy.key, causeOf(error));
      }
    }
    if (copies.length === 0) return;
    const { bounds, authorities } = await this.discovered(copies.map((copy) => copy.room_handle));
    const read: Copy[] = [];
    const unchanged: Copy[] = [];
    for (const copy of copies) {
      const authority = authorities.find((entry) => entry.room_ref === copy.room_ref);
      if (
        authority !== undefined &&
        JSON.stringify([authority.operations.write, authority.protected_paths]) !== JSON.stringify([copy.write, copy.protected])
      ) {
        try {
          read.push(await this.save(await this.received(copy, authority, caller, fetching, reports.get(copy.key)!)));
        } catch (error) {
          if (!(error instanceof NotReady)) throw error;
          unready.push(...error.rooms);
        }
      } else {
        unchanged.push(copy);
      }
    }
    for (const group of grouped(unchanged, bounds.max_prefixes)) await this.caughtUp(group, false, caller, fetching, reports, unready);
    for (const group of grouped(read, bounds.max_prefixes)) await this.caughtUp(group, true, caller, fetching, reports, unready);
    for (const copy of copies) {
      if (!unready.includes(copy.room_ref)) await this.attached(this.copies.get(copy.key) as Copy, caller, fetching, reports.get(copy.key)!);
    }
  }

  private async attached(copy: Copy, caller: Caller, fetching: Fetching, report: Report): Promise<void> {
    if (!fetching.attachments) return;
    const manifest = await readManifest(copy.repository);
    const wanted = Object.entries(manifest.files).filter(([, entry]) => entry.skipped && entry.bytes <= fetching.maxSize * MEGABYTE);
    if (wanted.length === 0) return;
    const root = rootOf(copy.room_handle);
    const work = await staging();
    const present = await scanned(copy.repository);
    for (const [path, { skipped: _skipped, ...entry }] of wanted) {
      if (present.has(path)) continue;
      const file = await receivedBinary(work, `${root}/${path}`, async () => {
        const held = await caller.info(`${root}/${path}`, entry.revision);
        if (held === null) throw new Error(`House holds no attachment at ${root}/${path}`);
        return held;
      });
      if (!report.touched.has(path)) report.touched.set(path, null);
      await mkdir(dirname(join(copy.repository, path)), { recursive: true });
      await rename(file, join(copy.repository, path));
      manifest.files[path] = entry;
    }
    await writeManifest(copy.repository, work, manifest);
  }

  private async caughtUp(
    copies: readonly Copy[],
    whole: boolean,
    caller: Caller,
    fetching: Fetching,
    reports: Map<string, Report>,
    unready?: string[],
  ): Promise<Copy[]> {
    const caught = new Map(copies.map((copy) => [copy.key, copy]));
    const read = new Set<string>();
    const waiting: string[] = unready ?? [];
    let asking = [...copies];
    while (asking.length > 0) {
      let answer: { authorities: Enumerated[] };
      try {
        answer = await this.house.door('changes/enumerate', {
          prefixes: asking.map((copy) => rootOf(copy.room_handle)),
          positions: asking.map((copy) => ({ authority: copy.room_ref, position: copy.position, log_epoch: copy.log_epoch })),
        });
      } catch (error) {
        const expired = asking.find((copy) => copy.room_ref === expiredAuthority(error));
        if (expired === undefined) throw error;
        asking = asking.filter((copy) => copy !== expired);
        if (read.has(expired.key)) {
          waiting.push(expired.room_ref);
          continue;
        }
        read.add(expired.key);
        try {
          const next = await this.save(await this.reread(expired, caller, fetching, reports.get(expired.key)!));
          caught.set(expired.key, next);
          asking.push(next);
        } catch (refused) {
          if (!(refused instanceof NotReady)) throw refused;
          waiting.push(expired.room_ref);
        }
        continue;
      }
      const advanced: Copy[] = [];
      for (const copy of asking) {
        const view = answer.authorities.find((entry) => entry.authority === copy.room_ref);
        if (view === undefined || (view.position === copy.position && view.log_epoch === copy.log_epoch)) continue;
        const next = await this.save(await this.incorporated(copy, view, caller, fetching, reports.get(copy.key)!));
        caught.set(copy.key, next);
        advanced.push(next);
      }
      asking = advanced.filter((copy) => whole || read.has(copy.key));
    }
    if (unready === undefined && waiting.length > 0) throw new NotReady(waiting);
    return copies.map((copy) => caught.get(copy.key)!);
  }

  private async incorporated(copy: Copy, view: Enumerated, caller: Caller, fetching: Fetching, report: Report): Promise<Copy> {
    const manifest = await readManifest(copy.repository);
    const work = await staging();
    const applying = this.applying(copy, manifest, copy, work, report, fetching, caller);
    await applying.start();
    try {
      for (const change of view.changes) {
        if ('removed' in change) applying.removal(change.path);
        else if ('content' in change) await applying.text(change);
        else applying.binary(change);
      }
      await applying.finish();
    } finally {
      await writeManifest(copy.repository, work, manifest);
    }
    return { ...copy, position: view.position, log_epoch: view.log_epoch };
  }

  private async converted(held: Held): Promise<Copy> {
    if (!earlier(held)) return held;
    const copy: Copy = {
      key: held.key,
      room_ref: held.room_ref,
      room_handle: held.room_handle,
      repository: held.repository,
      position: held.position,
      log_epoch: held.log_epoch,
      write: held.write,
      protected: held.protected,
      ...(held.unfollowed === undefined ? {} : { unfollowed: held.unfollowed }),
    };
    const root = rootOf(copy.room_handle);
    const directory = this.chunksFolder();
    const recorded = recordedFiles(held);
    const manifest: Manifest = { room_ref: copy.room_ref, files: {} };
    const work = await staging();
    try {
      const read = await this.chunked(root, copy.room_ref, directory);
      const present = await scanned(copy.repository);
      const current = new Map<string, { revision: string; sha256: string; bytes: number }>();
      const unbrought = new Map<string, string>();
      const binaries: KitBinaryChange[] = [];
      const readOnly = async (path: string, content: string, revision: string) => {
        if (present.get(path)?.sha256 !== digest(content)) await placed(work, join(copy.repository, path), content);
        manifest.files[path] = { revision, sha256: digest(content), bytes: Buffer.byteLength(content), read_only: true };
      };
      for await (const entry of read.entries) {
        if (!('content' in entry)) {
          binaries.push(entry);
          continue;
        }
        if (entry.provenance !== undefined) await readOnly(sidecar(entry.path), entry.provenance, entry.revision);
        if (declaredWritable(entry.path, copy)) {
          current.set(entry.path, { revision: entry.revision, sha256: digest(entry.content), bytes: Buffer.byteLength(entry.content) });
          if (!present.has(entry.path)) unbrought.set(entry.path, entry.content);
        } else {
          await readOnly(entry.path, entry.content, entry.revision);
        }
      }
      for (const [path, { revision, held: attached }] of recorded) {
        if (manifest.files[path]?.read_only) continue;
        if (attached !== undefined) {
          manifest.files[path] = present.has(path) ? { revision, ...attached } : { revision, ...attached, skipped: true };
          continue;
        }
        const named = `${root}/${path}`;
        const now = current.get(path);
        const read = now?.revision === revision ? null : await this.revisionRead(named, revision);
        if (now?.revision !== revision && read === null) continue;
        const latest = now?.revision === revision ? now : { revision, sha256: digest(read!), bytes: Buffer.byteLength(read!) };
        const local = present.get(path);
        if (local === undefined) {
          await placed(work, join(copy.repository, path), read ?? unbrought.get(path)!);
          manifest.files[path] = latest;
          continue;
        }
        if (local.sha256 === latest.sha256) {
          manifest.files[path] = latest;
          continue;
        }
        const edited = await readFile(join(copy.repository, local.name), 'utf8');
        const latestText = read ?? (await this.revisionText(named, revision));
        let closest = { revision, text: latestText, apart: differing(latestText, edited) };
        for (const before of recordedRevisions(held, path).filter((other) => other !== revision)) {
          const text = await this.revisionRead(named, before);
          if (text === null) continue;
          const apart = differing(text, edited);
          if (apart < closest.apart) closest = { revision: before, text, apart };
        }
        if (closest.revision !== revision && closest.text === edited) {
          await placed(work, join(copy.repository, local.name), latestText);
          manifest.files[path] = latest;
        } else {
          manifest.files[path] = { revision: closest.revision, sha256: digest(closest.text), bytes: Buffer.byteLength(closest.text) };
        }
      }
      for (const [path, now] of current) {
        if (manifest.files[path] === undefined && present.get(path)?.sha256 === now.sha256) manifest.files[path] = now;
      }
      for (const { path, revision, bytes, sha256 } of binaries) {
        if (manifest.files[path] !== undefined) continue;
        const writable = declaredWritable(path, copy) ? {} : { read_only: true as const };
        manifest.files[path] = present.get(path)?.sha256 === sha256 ? { revision, sha256, bytes, ...writable } : { revision, sha256, bytes, skipped: true, ...writable };
      }
      for (const [path, local] of present) {
        if (manifest.files[path] !== undefined || current.has(path)) continue;
        if (await this.deletedByHouse(held, `${root}/${path}`, path, local.sha256)) await removed(copy.repository, local.name);
      }
      for (const path of held.read_only) if (manifest.files[path] === undefined) await removed(copy.repository, path);
      for (const name of [...KIT_IGNORES, ...KIT_GIT]) await rm(join(copy.repository, name), { recursive: true, force: true });
      await rmdir(join(copy.repository, '.git', 'refs', 'house')).catch(() => undefined);
      await writeManifest(copy.repository, work, manifest);
    } catch (error) {
      if (error instanceof NotReady) throw error;
      throw new Error(`${root}: Kit could not convert the copy an earlier Kit kept yet (${houseCause(error)}); the next house download or house upload converts it`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return this.save(copy);
  }

  private async uploaded(key: string, caller: Caller): Promise<Answered> {
    let copy: Copy;
    try {
      copy = await this.converted(this.copies.get(key)!);
    } catch (error) {
      return { refused: true, text: error instanceof NotReady ? `${rootOf(this.copies.get(key)!.room_handle)}: ${NOT_READY}` : causeOf(error) };
    }
    const lines: string[] = [];
    let files = 0;
    let landed = 0;
    if (copy.pending !== undefined) {
      const settled = await this.settle(copy, caller);
      if (settled.refused) return settled;
      files += settled.files;
      landed++;
      lines.push(...settled.lines);
      copy = this.copies.get(key) as Copy;
    }
    const root = rootOf(copy.room_handle);
    const manifest = await readManifest(copy.repository);
    const present = await scanned(copy.repository);
    const unresolved: string[] = [];
    for (const [path, entry] of Object.entries(manifest.files)) {
      if (entry.conflicted && (await marked(copy.repository, present.get(path)?.name ?? path))) unresolved.push(`${root}/${path}`);
    }
    if (unresolved.length > 0) {
      const [named, they] = unresolved.length === 1 ? [`${unresolved[0]} still holds`, 'it'] : [`${unresolved.join(', ')} still hold`, 'each'];
      return { refused: true, text: `${named} conflict markers; resolve ${they}, then run house upload again` };
    }
    let built: Built;
    try {
      built = await this.built(copy, manifest, present);
    } catch (error) {
      return { refused: true, text: houseCause(error) };
    }
    if ('refused' in built) return built;
    const batches = batched(built.changes);
    for (const [index, changes] of batches.entries()) {
      const read = Object.fromEntries(changedPaths(changes).flatMap((path) => (built.read[relative(path)] === undefined ? [] : [[relative(path), built.read[relative(path)]!]])));
      copy = await this.save({ ...(this.copies.get(key) as Copy), pending: { operation_id: operationId(), caller: caller.key, changes, read } });
      const settled = await this.settle(copy, caller);
      if (settled.refused) {
        const done = landed === 0 ? [] : [`House accepted ${counted(landed, 'batch', 'batches')} of ${rootOf(copy.room_handle)} before this one.`];
        return { refused: true, text: [...done, ...lines, settled.text, ...(index + 1 < batches.length ? [`${counted(batches.length - index - 1, 'batch', 'batches')} after it ${batches.length - index - 1 === 1 ? 'was' : 'were'} not sent`] : [])].join('\n') };
      }
      files += settled.files;
      landed++;
      lines.push(...settled.lines);
    }
    const now = rootOf((this.copies.get(key) as Copy).room_handle);
    if (landed === 0) return { refused: false, text: `Nothing to upload: ${root} matches House.` };
    return {
      refused: false,
      text: [`House accepted ${counted(files, 'file')} of ${now}${landed > 1 ? ` in ${landed} batches` : ''}.`, ...lines].join('\n'),
    };
  }

  private async built(copy: Copy, manifest: Manifest, present: Map<string, Present>): Promise<Built> {
    const root = rootOf(copy.room_handle);
    const added: string[] = [];
    const changed: string[] = [];
    const gone: string[] = [];
    let adopted = false;
    for (const [path, file] of present) {
      const entry = manifest.files[path];
      if (kitsOwn(path)) continue;
      if (entry === undefined) added.push(path);
      else if (entry.read_only) continue;
      else if (entry.sha256 !== file.sha256) changed.push(path);
      else if (entry.skipped) {
        manifest.files[path] = { revision: entry.revision, sha256: entry.sha256, bytes: entry.bytes };
        adopted = true;
      }
    }
    for (const [path, entry] of Object.entries(manifest.files)) {
      if (!kitsOwn(path) && !entry.read_only && !entry.skipped && !present.has(path)) gone.push(path);
    }
    if (adopted) await writeManifest(copy.repository, await staging(), manifest);
    const listed = (paths: string[], file: (path: string) => { sha256: string; bytes: number }) => {
      const found = new Map<string, string[]>();
      for (const path of paths) found.set(sameBytes(file(path)), [...(found.get(sameBytes(file(path))) ?? []), path]);
      return found;
    };
    const leaving = listed(gone, (path) => manifest.files[path]!);
    const arriving = listed(added, (path) => present.get(path)!);
    const moves = new Map<string, string>();
    for (const [held, [from, ...others]] of leaving) {
      const [to, ...more] = arriving.get(held) ?? [];
      if (others.length === 0 && more.length === 0 && to !== undefined && isDocument(from!) === isDocument(to)) moves.set(from!, to);
    }
    const arrived = new Set(moves.values());
    const documents = [...added.filter((path) => !arrived.has(path)), ...changed].filter(isDocument).sort();
    const texts = new Map<string, string>();
    if (documents.length > 0) {
      const { bounds } = await this.house.door<Discovery>('rooms/discover', { prefixes: [root] });
      const refused: string[] = [];
      for (const path of documents) {
        const bytes = await readFile(join(copy.repository, present.get(path)!.name));
        if (bytes.length > bounds.max_authored_file_bytes || !isUtf8(bytes) || bytes.includes(0)) refused.push(path);
        else texts.set(path, bytes.toString('utf8'));
      }
      if (refused.length > 0) return { refused: true, text: markdownOnly(refused, bounds.max_authored_file_bytes) };
    }
    const changes: Change[] = [];
    const read: Record<string, Read> = {};
    for (const path of [...new Set([...added, ...changed, ...gone])].sort()) {
      if (arrived.has(path)) continue;
      const named = `${root}/${path}`;
      const entry = manifest.files[path];
      const to = moves.get(path);
      if (to !== undefined) {
        changes.push({ op: 'move', path: named, to: `${root}/${to}`, base: entry!.revision });
        read[to] = { name: present.get(to)!.name, sha256: present.get(to)!.sha256 };
        continue;
      }
      const file = present.get(path);
      if (file === undefined) {
        changes.push({ op: 'delete', path: named, base: entry!.revision });
        continue;
      }
      const base = entry === undefined ? {} : { base: entry.revision };
      const text = texts.get(path);
      if (text !== undefined) {
        changes.push({ op: 'write', path: named, content: text, ...base });
        read[path] = { name: file.name, sha256: digest(text) };
      } else {
        changes.push({ op: 'upload', path: named, ...base, bytes: file.bytes, sha256: file.sha256, media_type: mediaType(path) });
        read[path] = { name: file.name, sha256: file.sha256 };
      }
    }
    return { changes, read };
  }

  private async settle(start: Copy, caller: Caller, restaged = false): Promise<Settled> {
    let copy = start;
    if (copy.pending!.caller !== caller.key) {
      const { upload: _upload, ...pending } = copy.pending!;
      copy = await this.save({ ...copy, pending: { ...pending, caller: caller.key } });
    }
    const finished = new Set<string>();
    let rehandledOnce = false;
    let outcome!: Submitted;
    for (;;) {
      const pending = copy.pending!;
      try {
        outcome = await caller.submit(pending.operation_id, pending.changes, pending.upload, async (upload) => {
          copy = await this.save({ ...copy, pending: { ...copy.pending!, upload } });
        });
      } catch (error) {
        const refusal = error instanceof HouseRefusal ? refusalOf(error.text) : null;
        return { refused: true, text: refusal?.text ?? "House's answer to this upload did not arrive; run house upload again" };
      }
      if (!('refused' in outcome)) break;
      if (outcome.refused.code === 'files_unstaged') {
        const named = unstagedUploads(outcome.refused).filter(({ id }) => !finished.has(id));
        if (named.length === 0) break;
        for (const { id } of named) finished.add(id);
        const failed = await this.sentParts(copy, named, caller);
        copy = this.copies.get(copy.key) as Copy;
        if (failed.size > 0) return this.stopped(copy, failed);
        continue;
      }
      const handle = outcome.refused.code === 'handle_changed' && !rehandledOnce ? currentHandle(outcome.refused) : null;
      if (handle === null) break;
      rehandledOnce = true;
      copy = await this.save(rehandled(copy, handle));
    }
    if ('refused' in outcome) {
      if (stopsPush(outcome.refused)) return this.stopped(copy, firstLine(outcome.refused));
      if (outcome.refused.code === 'upload_unavailable' && copy.pending!.upload !== undefined && !restaged) {
        const { upload: _upload, ...unstaged } = copy.pending!;
        return this.settle(await this.save({ ...copy, pending: unstaged }), caller, true);
      }
      const settled = await this.save(without(copy));
      if (outcome.refused.code !== 'edit_conflict') return { refused: true, text: outcome.refused.text };
      const lines = await this.conflicted(settled, copy.pending!, outcome.refused, caller);
      return { refused: true, text: [outcome.refused.text, ...lines].join('\n') };
    }
    return this.integrated(copy, outcome.accepted);
  }

  private async sentParts(start: Copy, named: readonly StagedUpload[], caller: Caller): Promise<Map<string, string | Changed>> {
    let copy = start;
    const pending = copy.pending!;
    const parts = new Map(pending.changes.filter((change): change is Part => change.op === 'upload').map((part) => [part.sha256, part]));
    const staged = new Set(pending.staged ?? []);
    const failed = new Map<string, string | Changed>();
    const work = await staging();
    let saving = Promise.resolve();
    await eachAtOnce(named, async (upload) => {
      const part = parts.get(upload.sha256)!;
      const path = relative(part.path);
      try {
        await sentBinary(work, join(copy.repository, pending.read[path]?.name ?? path), path, part, upload, (id, partSha256) =>
          caller.finish(id, part.path, partSha256),
        );
      } catch (error) {
        failed.set(upload.sha256, error instanceof Changed ? error : `its transfer failed: ${causeOf(error)}`);
        return;
      }
      staged.add(upload.sha256);
      saving = saving.then(async () => {
        copy = await this.save({ ...copy, pending: { ...copy.pending!, staged: [...staged] } });
      });
      await saving;
    });
    return failed;
  }

  private async stopped(copy: Copy, reasons: ReadonlyMap<string, string | Changed> | string): Promise<Settled> {
    const pending = copy.pending!;
    const root = rootOf(copy.room_handle);
    const unchanged = `House holds nothing of this upload yet, so ${root} is unchanged`;
    const changed = typeof reasons === 'string' ? [] : [...reasons.values()].filter((reason): reason is Changed => reason instanceof Changed);
    if (changed.length > 0) {
      await this.save(without(copy));
      return { refused: true, text: `${unchanged}: ${changed.map((reason) => reason.message).join('; ')}; run house upload again to send the copy as it is now` };
    }
    const again = 'house upload again resumes this upload and sends only what it has not sent';
    const staged = new Set(pending.staged ?? []);
    const unsent = pending.changes.filter((change): change is Part => change.op === 'upload' && !staged.has(change.sha256));
    if (typeof reasons === 'string' && unsent.length === 0) return { refused: true, text: `${unchanged}: ${reasons}\n${again}` };
    const why = (sha256: string) => (typeof reasons === 'string' ? reasons : String(reasons.get(sha256) ?? 'not sent yet'));
    return {
      refused: true,
      text: [`${unchanged}; these attachments are not sent:`, ...unsent.map(({ path, sha256 }) => `${relative(path)}: ${why(sha256)}`), again].join('\n'),
    };
  }

  private async conflicted(copy: Copy, pending: Pending, refusal: Refusal, caller: Caller): Promise<string[]> {
    const root = rootOf(copy.room_handle);
    const manifest = await readManifest(copy.repository);
    const present = await scanned(copy.repository);
    const work = await staging();
    const lines: string[] = [];
    const nameOf = (path: string) => present.get(path)?.name ?? path;
    const holds = async (path: string, sha256: string) => present.has(path) && (await holding(copy.repository, nameOf(path), sha256));
    const brought = async (path: string, revision: string): Promise<boolean> => {
      const named = `${root}/${path}`;
      const target = join(copy.repository, nameOf(path));
      if (isDocument(path)) {
        const text = await this.revisionRead(named, revision);
        if (text === null) return false;
        await placed(work, target, text);
        manifest.files[path] = { revision, sha256: digest(text), bytes: Buffer.byteLength(text) };
      } else {
        const held: { file?: FileInfo } = {};
        const file = await receivedBinary(work, named, async () => {
          const info = await caller.info(named, revision);
          if (info === null) throw new Error(`House holds no attachment at ${named}`);
          held.file = info;
          return info;
        });
        await mkdir(dirname(target), { recursive: true });
        await rename(file, target);
        manifest.files[path] = { revision, sha256: held.file!.sha256, bytes: held.file!.bytes };
      }
      present.set(path, { name: nameOf(path), sha256: manifest.files[path]!.sha256, bytes: manifest.files[path]!.bytes });
      return true;
    };
    for (const conflict of refusal.conflicts) {
      const path = relative(conflict.path);
      const change = pending.changes.find((sent) => relative(sent.path) === path || (sent.op === 'move' && relative(sent.to) === path));
      if (change === undefined) continue;
      const named = `${root}/${path}`;
      const read = pending.read[path];
      const busy = `${named}: changed while it uploaded; the next house upload merges it`;
      if (conflict.revision === undefined) {
        delete manifest.files[path];
        lines.push(`${named}: House no longer holds it; the next house upload sends it as a new file`);
        continue;
      }
      if (change.op === 'write') {
        if (read === undefined || !(await holds(path, read.sha256))) {
          lines.push(busy);
          continue;
        }
        const content = conflict.content ?? whole(await this.revisionText(named, conflict.revision), change.content);
        await placed(work, join(copy.repository, nameOf(path)), content);
        manifest.files[path] = { revision: conflict.revision, sha256: digest(content), bytes: Buffer.byteLength(content), conflicted: true };
        lines.push(`${named}: conflict markers written; resolve them, then run house upload again`);
        continue;
      }
      if (change.op === 'upload') {
        const current = await caller.info(named, conflict.revision);
        if (current === null) throw new Error(`House holds no attachment at ${named}`);
        manifest.files[path] = { revision: conflict.revision, sha256: current.sha256, bytes: current.bytes };
        const theirs = JSON.stringify({ path: named, file: join(copy.repository, nameOf(path)) });
        lines.push(`${named}: House holds ${conflict.revision}, a version this copy never held; the next house upload replaces it with this file, and house download '${theirs}' brings House's instead`);
        continue;
      }
      if (change.op === 'delete') {
        if (present.has(path)) lines.push(busy);
        else if (await brought(path, conflict.revision)) {
          lines.push(`${named}: House changed it since this copy read it and now holds ${conflict.revision}; that version is back here, so delete it again if you still mean to`);
        }
        continue;
      }
      const from = relative(change.path);
      const to = relative(change.to);
      const moved = pending.read[to];
      if (!present.has(from) && moved !== undefined && (await holds(to, moved.sha256))) {
        await mkdir(dirname(join(copy.repository, from)), { recursive: true });
        await rename(join(copy.repository, nameOf(to)), join(copy.repository, from));
        await removed(copy.repository, nameOf(to));
        present.set(from, { ...present.get(to)!, name: from });
        present.delete(to);
      }
      const entry = manifest.files[from];
      if (path === from && entry !== undefined && (await holds(from, entry.sha256)) && (await brought(from, conflict.revision))) {
        lines.push(`${named}: House changed it since this copy read it and now holds ${conflict.revision}; it is back at ${named} with that version, so move it again if you still mean to`);
      } else if (path === to && !present.has(to) && (await brought(to, conflict.revision))) {
        lines.push(`${named}: House already holds a file there (${conflict.revision}); ${root}/${from} is back where it was and ${named} holds House's file`);
      } else lines.push(busy);
    }
    await writeManifest(copy.repository, work, manifest);
    return lines;
  }

  private async textOf(written: Written, sent: string | undefined): Promise<string> {
    if (typeof written.content === 'string' && !CUT.test(written.content)) return written.content;
    if (written.content === undefined && sent !== undefined) return sent;
    return this.revisionText(written.path, written.revision!);
  }

  private async integrated(copy: Copy, accepted: Written[]): Promise<Settled> {
    const pending = copy.pending!;
    const root = rootOf(copy.room_handle);
    const manifest = await readManifest(copy.repository);
    const work = await staging();
    const answered = new Map(accepted.filter((written) => written.revision !== null).map((written) => [relative(written.path), written]));
    const lines: string[] = [];
    const sent = new Set<string>();
    for (const change of pending.changes) {
      const path = relative(change.path);
      sent.add(path);
      if (change.op === 'delete') {
        delete manifest.files[path];
        continue;
      }
      if (change.op === 'move') {
        const to = relative(change.to);
        sent.add(to);
        const entry = manifest.files[path]!;
        delete manifest.files[path];
        manifest.files[to] = { revision: answered.get(to)?.revision ?? entry.revision, sha256: entry.sha256, bytes: entry.bytes };
        continue;
      }
      const written = answered.get(path)!;
      if (change.op === 'upload') {
        manifest.files[path] = { revision: written.revision!, sha256: change.sha256, bytes: change.bytes };
        continue;
      }
      const text = await this.textOf(written, change.content);
      const read = pending.read[path]!;
      if (text === change.content) {
        manifest.files[path] = { revision: written.revision!, sha256: read.sha256, bytes: Buffer.byteLength(text) };
      } else if (await holding(copy.repository, read.name, read.sha256)) {
        await placed(work, join(copy.repository, read.name), text);
        manifest.files[path] = { revision: written.revision!, sha256: digest(text), bytes: Buffer.byteLength(text) };
      } else {
        lines.push(`${root}/${path}: changed while it uploaded; House accepted it and local integration is pending, so the next house upload merges it`);
      }
    }
    for (const [path, written] of answered) {
      const entry = manifest.files[path];
      if (sent.has(path) || entry === undefined || entry.revision === written.revision) continue;
      const text = await this.textOf(written, undefined);
      if (!(await holding(copy.repository, path, entry.sha256))) {
        lines.push(`${root}/${path}: changed here, so House's change was not brought; the next house upload merges it`);
        continue;
      }
      await placed(work, join(copy.repository, path), text);
      manifest.files[path] = { revision: written.revision!, sha256: digest(text), bytes: Buffer.byteLength(text) };
    }
    await writeManifest(copy.repository, work, manifest);
    await this.save(without(copy));
    return { refused: false, files: pending.changes.length, lines };
  }

  private async deletedByHouse(held: EarlierCopy, named: string, path: string, sha256: string): Promise<boolean> {
    const attachments = Object.values(held.manifests).flatMap((manifest) => (manifest.binary?.[path] === undefined ? [] : [manifest.binary[path].sha256]));
    if (attachments.length > 0) return attachments.includes(sha256);
    for (const revision of recordedRevisions(held, path)) {
      const text = await this.revisionRead(named, revision);
      if (text !== null && digest(text) === sha256) return true;
    }
    return false;
  }

  private async revisionRead(path: string, wanted: string): Promise<string | null> {
    const page = await this.house.door<{ revisions: { revision: string; content?: string | null }[] }>('files/revisions/list', {
      path,
      revision: wanted,
    });
    const found = page.revisions.find((entry) => entry.revision === wanted);
    if (found === undefined) return null;
    if (typeof found.content !== 'string') throw new Error(`House's text of ${path} at ${wanted} is not readable yet`);
    return found.content;
  }

  private async revisionText(path: string, wanted: string): Promise<string> {
    const text = await this.revisionRead(path, wanted);
    if (text === null) throw new Error(`House holds no revision ${wanted} of ${path}`);
    return text;
  }
}
