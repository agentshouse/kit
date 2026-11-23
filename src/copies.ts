import type { KitBinaryChange, LocalCopyRoom } from '@agentshouse/kit-wire';
import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { finalRefusal, HouseRefusal, retrying, type House } from './api.ts';
import { Changed, eachAtOnce, isDocument, mediaType, receivedBinary, sentBinary, type Staged, type StagedUpload } from './binaries.ts';
import { chunkEntries, stagedChunks, type Chunk, type Text } from './chunks.ts';
import { fileInfo, instructionsText, paused, type FileInfo, type Finished } from './files.ts';
import { conversationsFolder, kitHome, roomsFolder } from './home.ts';
import {
  digest,
  hashed,
  holding,
  MANIFEST,
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
import { environmentCall, rpc, toolAnswer, Unsettled } from './mcp.ts';
import { operationId } from './operation.ts';
import { firstLine, namedWait, refusalOf, retryable, stopsPush, type Refusal } from './refusals.ts';
import { keptName, moved as carried, present as found, removeFolder, rerooted, within } from './workspace.ts';

const ROOMS = 'rooms/';
const CONVERSATIONS = 'conversations/';
const PLACES = 'places';
const REFUSED_CHARACTER = /[/\\:*?"<>|\p{Cc}]/gu;
const COPY_NAME_BYTES = 240;
const NOT_READY = 'not ready yet; Kit copies it once House has built it';
const PROVENANCE = '_provenance';
const BATCH_FILES = 1000;
const BATCH_BYTES = 15_000_000;
const MEGABYTE = 1_000_000;
const CUT = /\noutput_cut \d+ of \d+ bytes$/;
const KIT_IGNORES = ['.gitignore', '.ignore'];
const KIT_GIT = ['.git/refs/house/received', '.git/house-chunks', '.git/house-uploads', '.git/house-downloads'];
const KIT_FILES = ['AGENTS.md', 'CLAUDE.md'];
const IMPORTED = '@AGENTS.md\n';
const FOLDERS = 'folders.json';

interface RoomFolder {
  name: string;
  lost?: true;
}

interface Placed {
  copies: Record<string, string>;
  session?: string;
  ended?: Record<string, number>;
  removed?: string[];
}

export interface KeptCopy {
  room_ref: string;
  path: string;
}

export interface Place {
  directory: string;
  copy: boolean;
}

export interface Opening {
  room_ref: string | null;
  name: string;
}

export const DEFAULT_MAX_SIZE = 10;

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
  cut?: unknown;
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
  left: Set<string>;
}

type Linking = (path: string, held: { revision: string; sha256: string }, target: string) => Promise<boolean>;

interface Folder {
  repository: string;
  manifest: Manifest;
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
  instructions(root: string): Promise<string>;
}

export interface Answered {
  refused: boolean;
  text: string;
  kept?: true;
  conflicted?: true;
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

async function ownInfo(args: Record<string, unknown>): Promise<string> {
  const read = toolAnswer({ status: 200, text: await environmentCall(rpc('tools/call', { name: 'info', arguments: args })) });
  if ('refused' in read) throw new Error(read.refused.text);
  return read.text;
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

function blankReport(): Report {
  return { touched: new Map<string, string | null>(), kept: new Set<string>(), left: new Set<string>() };
}

function leftOnHouse(paths: readonly string[]): string {
  return `Left on House, changed since this copy took them: ${paths.join(', ')}. house download --with-attachments brings them, adding --max-size <MB> for one over ${DEFAULT_MAX_SIZE} MB.`;
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

function stagingPrefix(): string {
  return `.${createHash('sha256').update(kitHome()).digest('hex').slice(0, 16)}-`;
}

async function sweptIn(folder: string): Promise<void> {
  for (const name of await readdir(folder).catch(() => [])) {
    if (name.startsWith(stagingPrefix())) await rm(join(folder, name), { recursive: true, force: true });
  }
}

async function staging(): Promise<string> {
  const folder = join(roomsFolder(), `${stagingPrefix()}work`);
  await mkdir(folder, { recursive: true });
  return `${folder}/`;
}

async function linked(source: string, target: string, sha256: string): Promise<boolean> {
  const temporary = `${await staging()}${randomUUID()}`;
  try {
    await link(source, temporary);
  } catch {
    return false;
  }
  if ((await hashed(temporary))?.sha256 !== sha256) {
    await rm(temporary, { force: true });
    return false;
  }
  await mkdir(dirname(target), { recursive: true });
  await rename(temporary, target);
  return true;
}

function leftForAgents(path: string, chosen: readonly string[]): void {
  if (chosen.some((folder) => within(folder, path))) throw new Error(`${path} holds a folder an Agent works in, so Kit leaves it as it is`);
}

function rootOf(handle: string): string {
  return `/rooms/${handle}`;
}

function copyKey(conversation: string, room: string): string {
  return `${CONVERSATIONS}${conversation}.${room}`;
}

function placeOf(conversation: string): string {
  return join(kitHome(), 'local-copies', PLACES, `${conversation}.json`);
}

function copyName(name: string): string {
  const characters = [...name.replace(REFUSED_CHARACTER, '-')];
  while (Buffer.byteLength(characters.join('')) > COPY_NAME_BYTES) characters.pop();
  return characters.join('').replace(/[ .]$/u, '-');
}

function relative(path: string): string {
  return path.replace(/^\/rooms\/[^/]+\//, '');
}

function kitsOwn(path: string): boolean {
  return !path.includes('/') && KIT_FILES.some((name) => name.toLowerCase() === path.toLowerCase());
}

async function stillMarked(directory: string, manifest: Manifest, present: Map<string, Present>): Promise<string[]> {
  const named: string[] = [];
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (entry.conflicted && (await marked(directory, present.get(path)?.name ?? path))) named.push(path);
  }
  return named;
}

async function kitFiles(folder: string, text: string): Promise<void> {
  const contents = new Map(text === '' ? [] : [['AGENTS.md', text], ['CLAUDE.md', IMPORTED]]);
  for (const name of KIT_FILES) {
    const content = contents.get(name);
    const target = join(folder, name);
    if (content === undefined) await rm(target, { force: true });
    else if ((await readFile(target, 'utf8').catch(() => null)) !== content) {
      const temporary = `${await staging()}${randomUUID()}`;
      await writeFile(temporary, content, { mode: 0o444 });
      await rename(temporary, target);
    }
  }
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

function changeSet(manifest: Manifest, present: Map<string, Present>): { added: string[]; changed: string[]; gone: string[]; adopted: string[] } {
  const added: string[] = [];
  const changed: string[] = [];
  const adopted: string[] = [];
  for (const [path, file] of present) {
    const entry = manifest.files[path];
    if (kitsOwn(path)) continue;
    if (entry === undefined) added.push(path);
    else if (entry.read_only) continue;
    else if (entry.sha256 !== file.sha256) changed.push(path);
    else if (entry.skipped) adopted.push(path);
  }
  const gone = Object.entries(manifest.files).flatMap(([path, entry]) => (!kitsOwn(path) && !entry.read_only && !entry.skipped && !present.has(path) ? [path] : []));
  return { added, changed, gone, adopted };
}

function adopt(manifest: Manifest, paths: readonly string[]): void {
  for (const path of paths) {
    const { skipped: _skipped, ...held } = manifest.files[path]!;
    manifest.files[path] = held;
  }
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
  private readonly link: Linking;

  constructor(
    repository: string,
    manifest: Manifest,
    scope: Scope,
    staging: string,
    report: Report,
    fetching: Fetching,
    bytesOf: (change: KitBinaryChange) => Promise<string>,
    link: Linking,
  ) {
    this.repository = repository;
    this.manifest = manifest;
    this.scope = scope;
    this.staging = staging;
    this.report = report;
    this.fetching = fetching;
    this.bytesOf = bytesOf;
    this.link = link;
  }

  async start(): Promise<void> {
    this.present = await scanned(this.repository);
    adopt(this.manifest, changeSet(this.manifest, this.present).adopted);
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
    const target = join(this.repository, this.nameOf(path));
    const asked = this.fetching.attachments && bytes <= this.fetching.maxSize * MEGABYTE;
    const fromFolder = (asked || (holds && !this.fetching.attachments)) && (await this.link(path, change, target));
    if (!fromFolder && !asked) {
      if (holds) {
        if (local !== undefined) await removed(this.repository, local.name);
        this.present.delete(path);
        this.report.left.add(path);
      }
      this.manifest.files[path] = { ...held, skipped: true };
      return;
    }
    this.touch(path);
    if (!fromFolder) {
      const file = await this.bytesOf(change);
      await mkdir(dirname(target), { recursive: true });
      await rename(file, target);
    }
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
  private readonly launched: () => Promise<readonly string[]>;
  private readonly copies = new Map<string, Held>();
  private readonly folders = new Map<string, RoomFolder>();
  private readonly places = new Map<string, Placed>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly waiting = new Set<string>();
  private answering: Promise<unknown> = Promise.resolve();

  constructor(house: House, launched: () => Promise<readonly string[]>) {
    this.house = house;
    this.launched = launched;
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
          throw retryable(error.text) === false ? new Error(houseCause(error)) : new Unsettled(houseCause(error), namedWait(error.text));
        }
      },
      info: async (path, revision) => fileInfo(await ownInfo({ path, ...(revision === undefined ? {} : { ref: revision }) })),
      instructions: (root) => instructionsText(ownInfo, root),
    };
  }

  async load(): Promise<void> {
    const home = join(kitHome(), 'local-copies');
    const folders = await readFile(join(home, FOLDERS), 'utf8').catch(() => null);
    if (folders !== null) for (const [ref, folder] of Object.entries(JSON.parse(folders) as Record<string, RoomFolder>)) this.folders.set(ref, folder);
    for (const records of ['rooms', 'conversations']) {
      const names = (await readdir(join(home, records)).catch(() => [])).filter((name) => name.endsWith('.json'));
      for (const path of names.map((name) => join(home, records, name))) {
        const text = await readFile(path, 'utf8').catch(() => null);
        if (text === null) continue;
        const copy = JSON.parse(text) as Held;
        this.copies.set(copy.key, copy);
      }
    }
    for (const name of (await readdir(join(home, PLACES)).catch(() => [])).filter((held) => held.endsWith('.json'))) {
      const text = await readFile(join(home, PLACES, name), 'utf8').catch(() => null);
      if (text !== null) this.places.set(name.slice(0, -'.json'.length), JSON.parse(text) as Placed);
    }
  }

  async swept(): Promise<void> {
    await sweptIn(roomsFolder());
  }

  connected(): Promise<void> {
    return this.selected();
  }

  async download(caller: Caller, fetching: Fetching, cwd: string): Promise<Answered> {
    const copy = await this.copyAt(cwd);
    return copy === null ? this.answered(() => this.fetched(true, caller, fetching)) : this.freshened(copy, caller, fetching);
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
    const reached = new Map(answer.rooms.map((room) => [room.room_ref, room.room_handle]));
    const synced = new Map(answer.rooms.filter((room) => room.level === 'keep').map((room) => [`${ROOMS}${room.room_ref}`, room.room_handle]));
    return this.holding([...new Set([...this.roomCopies().map((copy) => copy.key), ...synced.keys()])].sort(), async () => {
      const chosen = await this.launched();
      const said: string[] = [];
      const made = new Set<string>();
      let refused = false;
      const mark = refreshing ? 'said' : 'unsaid';
      for (const copy of this.roomCopies()) {
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
          current.push(await this.renamed(named, chosen));
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
            const wanted = { key, handle, authority };
            const copy = await this.copied(wanted, fetching, this.owner, (whole) => this.materialized(wanted, whole, chosen));
            said.push(`${rootOf(handle)}: copied to ${copy.repository}`);
            made.add(authority.room_ref);
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
        const reports = new Map<string, Report>(reading.map((copy) => [copy.key, blankReport()]));
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
      const unwritten = await this.foldered(reached, new Set(synced.keys()), made, refreshing, caller, chosen);
      if (refreshing) said.push(...unwritten);
      else unwritten.forEach(logged);
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
      ...(report.left.size === 0 ? [] : [leftOnHouse([...report.left].sort().map((path) => `${root}/${path}`))]),
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

  async placed(conversation: string, opening: Opening | null, caller: Caller, launch: string): Promise<Place> {
    if (opening === null) {
      const held = this.places.get(conversation) ?? { copies: {} };
      const directory = held.session ?? launch;
      const room = Object.keys(held.copies).find((ref) => held.copies[ref] === directory);
      if (room === undefined) return { directory, copy: false };
      await this.ensured(conversation, room, directory, caller, () => this.reachedRoom(room));
      return { directory, copy: true };
    }
    const reached = opening.room_ref === null ? null : await this.reachedRoom(opening.room_ref);
    if (reached === null) {
      await this.exclusive(PLACES, () => this.savePlace(conversation, { ...(this.places.get(conversation) ?? { copies: {} }), session: launch }));
      return { directory: launch, copy: false };
    }
    const directory = await this.exclusive(PLACES, async () => {
      const recorded = this.places.get(conversation) ?? { copies: {} };
      const path = recorded.copies[reached.room_ref] ?? (await this.freePath(reached.room_handle, opening.name));
      await this.savePlace(conversation, { ...recorded, copies: { ...recorded.copies, [reached.room_ref]: path }, session: path });
      return path;
    });
    await this.ensured(conversation, reached.room_ref, directory, caller, () => Promise.resolve(reached));
    return { directory, copy: true };
  }

  async turnEnded(directory: string): Promise<void> {
    const held = this.conversationCopyAt(directory);
    if (held !== null) await this.exclusive(PLACES, () => this.used(held.conversation, held.room));
  }

  async deleted(conversation: string): Promise<KeptCopy[]> {
    const kept: KeptCopy[] = [];
    const reckon = this.reckoning();
    for (const [room, path] of Object.entries(this.places.get(conversation)?.copies ?? {})) {
      const key = copyKey(conversation, room);
      const removed = await this.exclusive(key, async () => {
        if (!this.places.get(conversation)?.removed?.includes(room)) {
          await reckon(key);
          if (await this.holdsWork(key, path)) return false;
        }
        await this.removedHeld(conversation, room, path);
        return true;
      });
      if (!removed) kept.push({ room_ref: room, path });
    }
    await this.exclusive(PLACES, async () => {
      await rm(placeOf(conversation), { force: true });
      this.places.delete(conversation);
    });
    return kept;
  }

  async removedIdle(before: number, runsIn: (directory: string) => boolean): Promise<void> {
    const reckon = this.reckoning();
    for (const [conversation, place] of [...this.places]) {
      for (const [room, path] of Object.entries(place.copies)) {
        const key = copyKey(conversation, room);
        await this.exclusive(key, async () => {
          const current = this.places.get(conversation);
          if (current?.copies[room] !== path || runsIn(path)) return;
          if (current.removed?.includes(room)) {
            await rm(path, { recursive: true, force: true });
            return;
          }
          if ((current.ended?.[room] ?? 0) > before || !(await exists(path))) return;
          await reckon(key);
          if (await this.holdsWork(key, path)) return;
          await this.removedHeld(conversation, room, path);
        });
      }
    }
  }

  private ensured(conversation: string, room: string, directory: string, caller: Caller, reach: () => Promise<LocalCopyRoom | null>): Promise<void> {
    const key = copyKey(conversation, room);
    return this.exclusive(key, async () => {
      const removed = this.places.get(conversation)?.removed?.includes(room) === true;
      if (removed) {
        await this.forgotten(key);
        await rm(directory, { recursive: true, force: true });
      }
      if (removed || !(await exists(directory))) {
        const reached = await reach();
        if (reached === null) await mkdir(directory, { recursive: true, mode: 0o700 });
        else await this.made(conversation, reached, directory, caller);
      }
      await this.exclusive(PLACES, () => this.used(conversation, room));
    });
  }

  private async used(conversation: string, room: string): Promise<void> {
    const place = this.places.get(conversation);
    if (place?.copies[room] === undefined) return;
    const { removed = [], ...held } = place;
    const still = removed.filter((one) => one !== room);
    await this.savePlace(conversation, { ...held, ended: { ...held.ended, [room]: Date.now() }, ...(still.length === 0 ? {} : { removed: still }) });
  }

  private reckoning(): (key: string) => Promise<void> {
    let selection: Promise<LocalCopyRoom[]> | undefined;
    return async (key) => {
      const copy = this.copies.get(key) as Copy | undefined;
      if (copy === undefined || !(await exists(copy.repository))) return;
      try {
        selection ??= this.house.act('local-copies/selection/read', {}).then(({ local_copy: answer }) => answer.rooms);
        const reached = (await selection).find((room) => room.room_ref === copy.room_ref);
        if (reached?.level !== 'keep') return;
        const named = copy.room_handle === reached.room_handle ? copy : await this.save({ ...copy, room_handle: reached.room_handle });
        await this.refreshed([named], [], new Map<string, string>(), this.owner, HELD, new Map([[key, blankReport()]]));
      } catch (error) {
        logged(error);
      }
    };
  }

  private async holdsWork(key: string, directory: string): Promise<boolean> {
    const copy = this.copies.get(key) as Copy | undefined;
    if (copy === undefined || !(await exists(directory))) return false;
    if (copy.pending !== undefined) return true;
    try {
      const manifest = await readManifest(directory);
      if (Object.values(manifest.files).some((entry) => entry.conflicted)) return true;
      const { added, changed, gone } = changeSet(manifest, await scanned(directory));
      return added.length + changed.length + gone.length > 0;
    } catch {
      return true;
    }
  }

  private async removedHeld(conversation: string, room: string, directory: string): Promise<void> {
    await this.exclusive(PLACES, async () => {
      const place = this.places.get(conversation);
      if (place !== undefined && !place.removed?.includes(room)) await this.savePlace(conversation, { ...place, removed: [...(place.removed ?? []), room] });
    });
    await this.forgotten(copyKey(conversation, room));
    await rm(directory, { recursive: true, force: true });
  }

  async freshened(directory: string, caller: Caller, fetching: Fetching = HELD): Promise<Answered> {
    const held = this.conversationCopyAt(directory);
    if (held === null) return { refused: false, text: 'Nothing new from House.' };
    const { key, room } = held;
    const { local_copy: answer } = await this.house.act('local-copies/selection/read', {});
    const reached = answer.rooms.find((one) => one.room_ref === room);
    return this.exclusive(key, async () => {
      const copy = this.copies.get(key) as Copy | undefined;
      if (reached === undefined) {
        await this.unreachedHeld(key, directory);
        return { refused: false, text: `${directory}: no longer followed; kept as it is` };
      }
      const root = rootOf(reached.room_handle);
      const lines: string[] = [];
      let refused = false;
      if (reached.level === 'keep') {
        try {
          if (copy === undefined) {
            await this.madeKept(held.conversation, reached, directory, caller, (folder) => this.placedIn(folder, directory, []));
            lines.push(`${root}: copied to ${directory}`);
          } else {
            const named = copy.room_handle === reached.room_handle ? copy : await this.save({ ...copy, room_handle: reached.room_handle });
            const report = blankReport();
            const unready: string[] = [];
            const unconverted = new Map<string, string>();
            await this.refreshed([named], unready, unconverted, caller, fetching, new Map([[key, report]]));
            lines.push(...(unready.length > 0 ? [`${root}: ${NOT_READY}`] : await this.reported(this.copies.get(key)!, report)));
          }
        } catch (error) {
          refused = true;
          lines.push(`${root}: ${houseCause(error)}`);
        }
      }
      const unwritten = await this.instructed(directory, root, caller, this.copies.has(key));
      if (unwritten !== null) lines.push(unwritten);
      return { refused, text: lines.length === 0 ? 'Nothing new from House.' : lines.join('\n') };
    });
  }

  async ended(directory: string, caller: Caller): Promise<Answered | null> {
    const held = this.conversationCopyAt(directory);
    if (held === null || !this.copies.has(held.key)) return null;
    const answer = await this.exclusive(held.key, () => this.uploaded(held.key, caller));
    if (!answer.refused) return answer;
    if ((this.copies.get(held.key) as Copy).pending !== undefined) return { ...answer, kept: true };
    return (await this.markedIn(directory)).length > 0 ? { ...answer, conflicted: true } : answer;
  }

  async markedIn(directory: string): Promise<string[]> {
    const manifest = await readManifest(directory).catch(() => null);
    if (manifest === null) return [];
    return (await stillMarked(directory, manifest, await scanned(directory))).sort();
  }

  private roomCopies(): Held[] {
    return [...this.copies.values()].filter((copy) => copy.key.startsWith(ROOMS));
  }

  private conversationCopyAt(directory: string): { key: string; conversation: string; room: string } | null {
    for (const [conversation, place] of this.places) {
      for (const [room, path] of Object.entries(place.copies)) {
        if (path === directory) return { key: copyKey(conversation, room), conversation, room };
      }
    }
    return null;
  }

  private async copyAt(cwd: string): Promise<string | null> {
    const physical = await realpath(cwd).catch(() => cwd);
    for (const place of this.places.values()) {
      for (const path of Object.values(place.copies)) {
        if (within(physical, await realpath(path).catch(() => path))) return path;
      }
    }
    return null;
  }

  private async reachedRoom(room: string): Promise<LocalCopyRoom | null> {
    const { local_copy: answer } = await this.house.act('local-copies/selection/read', {});
    return answer.rooms.find((one) => one.room_ref === room) ?? null;
  }

  private async freePath(handle: string, name: string): Promise<string> {
    const taken = new Set([...this.places.values()].flatMap((place) => Object.values(place.copies)));
    const folder = join(conversationsFolder(), handle);
    for (let count = 1; ; count++) {
      const path = join(folder, count === 1 ? copyName(name) : `${copyName(name)} ${count}`);
      if (!taken.has(path) && (await found(path)) === null) return path;
    }
  }

  private async savePlace(conversation: string, place: Placed): Promise<void> {
    const path = placeOf(conversation);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}`;
    await writeFile(temporary, JSON.stringify(place), { mode: 0o600 });
    await rename(temporary, path);
    this.places.set(conversation, place);
  }

  private async made(conversation: string, room: LocalCopyRoom, directory: string, caller: Caller): Promise<void> {
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    if (room.level === 'keep') await this.madeKept(conversation, room, directory, caller, (folder) => rename(folder, directory));
    else {
      await this.forgotten(copyKey(conversation, room.room_ref));
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const unwritten = await this.instructed(directory, rootOf(room.room_handle), caller, room.level === 'keep');
    if (unwritten !== null) logged(unwritten);
  }

  private async madeKept(conversation: string, room: LocalCopyRoom, directory: string, caller: Caller, placing: (folder: string) => Promise<void>): Promise<void> {
    const key = copyKey(conversation, room.room_ref);
    const { authorities } = await this.discovered([room.room_handle]);
    const authority = authorities.find((entry) => entry.room_ref === room.room_ref);
    if (authority === undefined) throw new Error('House serves nothing of it to copy');
    const wanted = { key, handle: room.room_handle, authority };
    await this.copied(wanted, HELD, caller, (whole) => this.madeIn(wanted, directory, whole, placing, this.linking(room.room_ref, key)));
  }

  private linking(room: string, except: string): Linking {
    let folders: Promise<Folder[]> | undefined;
    return async (path, { revision, sha256 }, target) => {
      folders ??= this.foldersOf(room, except);
      for (const { repository, manifest } of await folders) {
        const entry = manifest.files[path];
        if (entry?.revision === revision && entry.sha256 === sha256 && (await linked(join(repository, path), target, sha256))) return true;
      }
      return false;
    };
  }

  private async foldersOf(room: string, except: string): Promise<Folder[]> {
    const folders: Folder[] = [];
    for (const copy of [...this.copies.values()]) {
      if (copy.room_ref !== room || copy.key === except || earlier(copy)) continue;
      const manifest = await readManifest(copy.repository).catch(() => null);
      if (manifest !== null) folders.push({ repository: copy.repository, manifest });
    }
    return folders;
  }

  private async instructed(directory: string, root: string, caller: Caller, kept: boolean): Promise<string | null> {
    try {
      await this.written(directory, root, caller, kept);
      return null;
    } catch (error) {
      return `${root}: AGENTS.md kept as it was: ${houseCause(error)}`;
    }
  }

  private async written(folder: string, root: string, caller: Caller, kept: boolean): Promise<void> {
    const text = await caller.instructions(root);
    await (kept ? this.kitMarked(folder, text, await readManifest(folder)) : kitFiles(folder, text));
  }

  private unreached(key: string, directory: string): Promise<void> {
    return this.exclusive(key, () => this.unreachedHeld(key, directory));
  }

  private async unreachedHeld(key: string, directory: string): Promise<void> {
    if (!(await exists(directory))) return;
    if (!this.copies.has(key)) {
      await kitFiles(directory, '');
      return;
    }
    const manifest = await readManifest(directory).catch(() => null);
    if (manifest !== null) await this.kitMarked(directory, '', manifest);
  }

  private async forgotten(key: string): Promise<void> {
    if (!this.copies.delete(key)) return;
    await rm(recordOf(key), { force: true });
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

  private async setAside(path: string, chosen: readonly string[]): Promise<void> {
    if ((await found(path)) === null) return;
    leftForAgents(path, chosen);
    const kept = await keptName(path);
    await rename(path, kept);
    for (const copy of [...this.copies.values()]) if (within(copy.repository, path)) await this.save(rerooted(copy, path, kept));
    const named = [...this.folders].filter(([, folder]) => join(roomsFolder(), folder.name) === path);
    for (const [ref, folder] of named) this.folders.set(ref, { ...folder, name: basename(kept) });
    if (named.length > 0) await this.savedFolders();
  }

  private async savedFolders(): Promise<void> {
    const path = join(kitHome(), 'local-copies', FOLDERS);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}`;
    await writeFile(temporary, JSON.stringify(Object.fromEntries(this.folders)), { mode: 0o600 });
    await rename(temporary, path);
  }

  private async heldFolder(ref: string, handle: string, chosen: readonly string[]): Promise<string | null> {
    const record = this.folders.get(ref);
    const held = record === undefined ? null : join(roomsFolder(), record.name);
    if (held === null || !(await found(held))?.isDirectory()) return null;
    const target = join(roomsFolder(), handle);
    if (held === target || chosen.some((launch) => within(launch, held))) {
      this.folders.set(ref, { name: basename(held) });
      return held;
    }
    await this.setAside(target, chosen);
    await rename(held, target);
    this.folders.set(ref, { name: handle });
    await this.savedFolders();
    return target;
  }

  private async placedIn(staged: string, folder: string, chosen: readonly string[]): Promise<void> {
    const names = (await readdir(staged)).sort((left, right) => Number(left === MANIFEST) - Number(right === MANIFEST));
    for (const name of names) if ((await found(join(folder, name))) !== null) leftForAgents(join(folder, name), chosen);
    for (const name of names) {
      await this.setAside(join(folder, name), chosen);
      await rename(join(staged, name), join(folder, name));
    }
    await removeFolder(staged);
  }

  private async foldered(
    reached: ReadonlyMap<string, string>,
    synced: ReadonlySet<string>,
    made: ReadonlySet<string>,
    refreshing: boolean,
    caller: Caller,
    chosen: readonly string[],
  ): Promise<string[]> {
    const lines: string[] = [];
    for (const copy of this.roomCopies()) {
      if (reached.has(copy.room_ref) || earlier(copy)) continue;
      const manifest = await readManifest(copy.repository).catch(() => null);
      if (manifest !== null) await this.kitMarked(copy.repository, '', manifest);
    }
    for (const [conversation, place] of [...this.places]) {
      for (const [room, path] of Object.entries(place.copies)) {
        if (!reached.has(room)) await this.unreached(copyKey(conversation, room), path);
      }
    }
    for (const [ref, folder] of [...this.folders]) {
      if (reached.has(ref) || folder.lost) continue;
      await kitFiles(join(roomsFolder(), folder.name), '');
      this.folders.set(ref, { ...folder, lost: true });
    }
    const due: { root: string; folder: string; copied: boolean }[] = [];
    for (const [ref, handle] of reached) {
      const key = `${ROOMS}${ref}`;
      try {
        const copy = this.copies.get(key);
        if (copy !== undefined && (await exists(copy.repository))) {
          if (earlier(copy)) continue;
          const named = copy.unfollowed === undefined || copy.room_handle === handle ? copy : await this.save({ ...copy, room_handle: handle });
          const current = copy.unfollowed === undefined ? named : await this.renamed(named, chosen);
          if (refreshing || made.has(ref)) due.push({ root: rootOf(handle), folder: current.repository, copied: true });
          continue;
        }
        if (synced.has(key)) continue;
        const held = await this.heldFolder(ref, handle, chosen);
        if (held !== null) {
          if (refreshing) due.push({ root: rootOf(handle), folder: held, copied: false });
          continue;
        }
        const target = join(roomsFolder(), handle);
        await this.setAside(target, chosen);
        await mkdir(target, { recursive: true, mode: 0o700 });
        this.folders.set(ref, { name: handle });
        due.push({ root: rootOf(handle), folder: target, copied: false });
      } catch (error) {
        lines.push(`${rootOf(handle)}: ${causeOf(error)}`);
      }
    }
    await this.savedFolders();
    const unread = new Map<string, string[]>();
    await eachAtOnce(due, async ({ root, folder, copied }) => {
      try {
        await this.written(folder, root, caller, copied);
      } catch (error) {
        const cause = houseCause(error);
        unread.set(cause, [...(unread.get(cause) ?? []), root]);
      }
    });
    for (const [cause, roots] of unread) lines.push(`${roots.sort().join(', ')}: AGENTS.md kept as it was: ${cause}`);
    return lines;
  }

  private async kitMarked(folder: string, text: string, manifest: Manifest): Promise<void> {
    if (text === '' && manifest.kit === undefined) return;
    await kitFiles(folder, text);
    if (text === '') delete manifest.kit;
    else if (manifest.kit === undefined) manifest.kit = [...KIT_FILES];
    else return;
    await writeManifest(folder, await staging(), manifest);
  }

  async laidOut(earlier: string, rooms: string, kept: readonly string[]): Promise<{ moved: boolean; kept: string[] }> {
    const folders = (await readdir(earlier, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(earlier, entry.name));
    const held = (folder: string) => [...this.copies.values()].find((copy) => copy.repository === folder);
    const followed = (folder: string) => held(folder)?.unfollowed === undefined && held(folder) !== undefined;
    const staying = folders.filter((folder) => kept.some((chosen) => within(chosen, folder)));
    const moving = folders.filter((folder) => !staying.includes(folder));
    await mkdir(rooms, { recursive: true, mode: 0o700 });
    for (const source of [...moving.filter(followed), ...moving.filter((folder) => !followed(folder))]) {
      const copy = held(source);
      let target: string;
      if (copy !== undefined && copy.unfollowed === undefined) {
        target = join(rooms, copy.room_handle);
        await this.setAside(target, kept);
      } else {
        target = await keptName(join(rooms, basename(source)));
      }
      await carried(source, target);
      if (copy !== undefined) await this.save(rerooted(copy, source, target));
    }
    await sweptIn(earlier);
    await removeFolder(earlier);
    await removeFolder(dirname(earlier));
    return { moved: moving.length > 0, kept: staying };
  }

  private async renamed<T extends Held>(copy: T, chosen: readonly string[]): Promise<T> {
    const folder = join(roomsFolder(), copy.room_handle);
    if (dirname(copy.repository) !== roomsFolder() || basename(copy.repository) === copy.room_handle) return copy;
    if (chosen.some((launch) => within(launch, copy.repository))) return copy;
    await this.setAside(folder, chosen);
    await rename(copy.repository, folder);
    return this.save(rerooted(copy, copy.repository, folder));
  }

  private async materialized(wanted: Wanted, whole: (directory: string) => Promise<Whole>, chosen: readonly string[]): Promise<Copy> {
    const { handle, authority } = wanted;
    const held = await this.heldFolder(authority.room_ref, handle, chosen);
    const repository = held ?? join(roomsFolder(), handle);
    if (held === null) await this.setAside(repository, chosen);
    const placing = (folder: string) => (held === null ? rename(folder, repository) : this.placedIn(folder, repository, chosen));
    const saved = await this.madeIn(wanted, repository, whole, placing, async () => false);
    if (this.folders.delete(authority.room_ref)) await this.savedFolders();
    return saved;
  }

  private async madeIn(
    { key, handle, authority }: Wanted,
    repository: string,
    whole: (directory: string) => Promise<Whole>,
    placing: (folder: string) => Promise<void>,
    link: Linking,
  ): Promise<Copy> {
    const folder = join(roomsFolder(), `${stagingPrefix()}${randomUUID()}`);
    const chunks = this.chunksFolder();
    const scope = { write: authority.operations.write, protected: authority.protected_paths };
    const manifest: Manifest = { room_ref: authority.room_ref, files: {} };
    await mkdir(folder, { recursive: true });
    let copy: Copy;
    try {
      const read = await whole(chunks);
      const work = await staging();
      for await (const entry of read.entries) {
        const writable = declaredWritable(entry.path, scope) ? {} : { read_only: true as const };
        if (!('content' in entry)) {
          const held = await link(entry.path, entry, join(folder, entry.path));
          manifest.files[entry.path] = { revision: entry.revision, sha256: entry.sha256, bytes: entry.bytes, ...(held ? {} : { skipped: true as const }), ...writable };
          continue;
        }
        const { path, content, revision, provenance } = entry;
        await placed(work, join(folder, path), content);
        manifest.files[path] = { revision, sha256: digest(content), bytes: Buffer.byteLength(content), ...writable };
        if (provenance !== undefined) {
          await placed(work, join(folder, sidecar(path)), provenance);
          manifest.files[sidecar(path)] = { revision, sha256: digest(provenance), bytes: Buffer.byteLength(provenance), read_only: true };
        }
      }
      await writeManifest(folder, work, manifest);
      await placing(folder);
      copy = { key, room_ref: authority.room_ref, room_handle: handle, repository, position: read.position, log_epoch: read.log_epoch, ...scope };
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(chunks, { recursive: true, force: true });
    }
    return this.save(copy);
  }

  private async copied(
    wanted: Wanted,
    fetching: Fetching,
    caller: Caller,
    made: (whole: (directory: string) => Promise<Whole>) => Promise<Copy>,
  ): Promise<Copy> {
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
      const copy = await made(async () => ({ position: view.position, log_epoch: view.log_epoch, entries }));
      await this.attached(copy, caller, fetching, blankReport());
      return copy;
    }
    const copy = await made((directory) => this.chunked(root, authority.room_ref, directory));
    const report = blankReport();
    const [caught] = await this.caughtUp([copy], true, caller, fetching, new Map([[copy.key, report]]));
    await this.attached(caught!, caller, fetching, report);
    return caught!;
  }

  private applying(copy: Copy, manifest: Manifest, scope: Scope, work: string, report: Report, fetching: Fetching, caller: Caller): Applying {
    const root = rootOf(copy.room_handle);
    return new Applying(
      copy.repository,
      manifest,
      scope,
      work,
      report,
      fetching,
      (change) =>
        receivedBinary(work, `${root}/${change.path}`, async () => {
          const file = await caller.info(`${root}/${change.path}`, change.revision);
          if (file === null) throw new Error(`House holds no attachment at ${root}/${change.path}`);
          return file;
        }),
      this.linking(copy.room_ref, copy.key),
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
    const manifest = await readManifest(copy.repository);
    const skipped = Object.entries(manifest.files).filter(([, entry]) => entry.skipped);
    const present = new Map<string, Present>();
    for (const [path] of skipped) {
      const file = await hashed(join(copy.repository, path));
      if (file !== null) present.set(path, { name: path, ...file });
    }
    const { adopted } = changeSet(manifest, present);
    adopt(manifest, adopted);
    const wanted = fetching.attachments ? skipped.filter(([path, entry]) => !present.has(path) && entry.bytes <= fetching.maxSize * MEGABYTE) : [];
    if (adopted.length + wanted.length === 0) return;
    const root = rootOf(copy.room_handle);
    const work = await staging();
    const link = this.linking(copy.room_ref, copy.key);
    for (const [path, { skipped: _skipped, ...entry }] of wanted) {
      const target = join(copy.repository, path);
      if (!(await link(path, entry, target))) {
        const file = await receivedBinary(work, `${root}/${path}`, async () => {
          const held = await caller.info(`${root}/${path}`, entry.revision);
          if (held === null) throw new Error(`House holds no attachment at ${root}/${path}`);
          return held;
        });
        await mkdir(dirname(target), { recursive: true });
        await rename(file, target);
      }
      if (!report.touched.has(path)) report.touched.set(path, null);
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
    const unresolved = (await stillMarked(copy.repository, manifest, present)).map((path) => `${root}/${path}`);
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
    const { added, changed, gone, adopted } = changeSet(manifest, present);
    adopt(manifest, adopted);
    if (adopted.length > 0) await writeManifest(copy.repository, await staging(), manifest);
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
    if (typeof written.content === 'string' && written.cut === undefined && !CUT.test(written.content)) return written.content;
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
