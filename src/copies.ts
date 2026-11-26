import type { KitBinaryChange, KitNotSavedFile, KitRun, LocalCopyRoom } from '@agentshouse/kit-wire';
import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { link, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { finalRefusal, HouseRefusal, retrying, type House } from './api.ts';
import { Changed, eachAtOnce, isDocument, mediaType, receivedBinary, sentBinary, type Staged, type StagedUpload } from './binaries.ts';
import { chunkEntries, stagedChunks, type Chunk, type Text } from './chunks.ts';
import { fileInfo, roomInstructions, type FileInfo, type Finished, type RoomInstructions } from './files.ts';
import { conversationsFolder, kitHome, roomsFolder } from './home.ts';
import {
  covered,
  digest,
  hashed,
  holding,
  leaves,
  leftIn,
  MANIFEST,
  marked,
  placed,
  readManifest,
  removed,
  scanned,
  scannedAt,
  writeManifest,
  type Entry,
  type Manifest,
  type Present,
  type Scan,
} from './manifest.ts';
import { answerDocument, environmentTool, toolAnswer, Unsettled, type Forwarded, type Message, type ToolResult } from './mcp.ts';
import { operationId } from './operation.ts';
import { firstLine, namedWait, PlaceRefused, refusalOf, retryable, stopsPush, type Refusal } from './refusals.ts';
import { codeFolder, listedRef, REPOSITORIES } from './repositories.ts';
import { SaveTimer } from './saves.ts';
import {
  NO_ROOM_SKILLS,
  placeRoomSkills,
  removeRoomSkills,
  roomSkillsReading,
  SKILL_FOLDERS,
  type RoomSkillSet,
  type RoomSkillsReading,
  type RoomSkillsRecord,
} from './skills.ts';
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
const KIT_IGNORES = ['.gitignore', '.ignore'];
const KIT_GIT = ['.git/refs/house/received', '.git/house-chunks', '.git/house-uploads', '.git/house-downloads'];
const KIT_FILES = ['AGENTS.md', 'CLAUDE.md'];
const IMPORTED = '@AGENTS.md\n';
const FOLDERS = 'folders.json';
const PRIVATE = 'private';
const UNWRITTEN = 'unwritten';
const NOTHING_NEW = 'Nothing new from House.';

interface RoomFolder {
  name: string;
  lost?: true;
}

interface Ran {
  copy: KitRun['copy']['kind'];
  name: string;
  code?: string;
  follows?: true;
}

interface Placed {
  copies: Record<string, string>;
  session?: string;
  ended?: Record<string, number>;
  removed?: string[];
  run?: Ran;
  deleted?: true;
}

export interface KeptCopy {
  room_ref: string;
  path: string;
}

export interface Place {
  directory: string;
  copy: boolean;
  synced: boolean;
  name: string | null;
  code: string | null;
}

export type Reader = (path: string) => Promise<string | null>;

export interface Opening {
  room_ref: string | null;
  name: string;
  run?: KitRun;
}

export interface Sent {
  op: string;
  path: string;
  content?: unknown;
}

export const UPDATE_PATH = '/copy/update';

export interface Updating {
  message: Message;
  cwd: string;
}

export function updateChanges(message: Message): Sent[] {
  return (message.params.arguments as { changes?: Sent[] }).changes ?? [];
}

export const DEFAULT_MAX_SIZE = 10;

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
  proposal?: Proposal;
  from?: string;
  ref?: string;
}

interface Proposal {
  proposal: string;
  base_version?: number;
  waits_on: string;
  approval?: string;
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
  refused?: Record<string, string>;
  reported?: Record<string, string>;
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
  revised: Set<string>;
}

type Linking = (path: string, held: { revision: string; sha256: string }, target: string) => Promise<boolean>;

interface Meanwhile {
  named(path: string): boolean;
  writes(path: string): void;
}

const UNWATCHED: Meanwhile = { named: () => false, writes: () => undefined };

type Reckoning = (conversation: string, room: string, directory: string) => Promise<void>;

interface Integrating {
  repository: string;
  manifest: Manifest;
  work: string;
}

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

export type Submitted = { accepted: Written[] } | { refused: Refusal; admits?: number };

export function updateAnswer(forwarded: Forwarded): Submitted {
  const answer = toolAnswer(forwarded);
  if ('refused' in answer) return forwarded.admits === undefined ? answer : { ...answer, admits: forwarded.admits };
  const results = answerDocument<{ results?: (Omit<Written, 'revision'> & { revision?: string })[] } | null>(answer.text)?.results ?? [];
  return {
    accepted: results.flatMap(({ revision, ...written }) => [
      ...(written.from === undefined ? [] : [{ path: written.from, revision: null, content: null }]),
      { ...written, revision: revision ?? null },
    ]),
  };
}

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
  instructions(root: string): Promise<RoomInstructions>;
}

export interface Answered {
  refused: boolean;
  text: string;
}

export interface Saves {
  caller(conversation: string): Promise<Caller>;
  changed(): void;
}

type Uploaded = Answered & { admits?: number; read?: ReadonlyMap<string, string> };

interface Saving {
  whole: boolean;
  byHand: boolean;
}

const NAMED: Saving = { whole: false, byHand: false };
const WHOLE: Saving = { whole: true, byHand: false };
const BY_HAND: Saving = { whole: true, byHand: true };

interface Followed {
  repository: string;
  watcher: FSWatcher | null;
  heard: Set<string>;
  looking: boolean;
  writing: Set<string>;
  named: Set<string>;
  refused: Map<string, string | null>;
  changes: number;
  saved: number;
  running: number;
  waiting: { through: number; ended: () => void }[];
  timer: SaveTimer;
}

interface Batch {
  changes: Change[];
  read: Record<string, Read>;
}

type Settled =
  | { refused: true; text: string; refusal?: Refusal; batch?: Batch; lines?: string[]; admits?: number }
  | { refused: false; files: number; lines: string[] };

type Stopped = Extract<Settled, { refused: true }>;

interface Sending {
  files: number;
  landed: number;
  lines: string[];
  conflicted: boolean;
  read: Map<string, string>;
  stopped?: Stopped;
}

type Built = Batch & { unsendable: Map<string, string> };

interface Unsaved {
  path: string;
  refused?: string;
}

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

function skillsKept(root: string, error: unknown): string {
  return `${root}: its skills kept as they were: ${houseCause(error)}`;
}

function markdownOnly(maxBytes: number): string {
  return `it is Markdown, which holds text only: UTF-8 without NUL, at most ${maxBytes} bytes`;
}

const SETTLED_IN_PLACE = new Set(['handle_changed', 'files_unstaged', 'upload_unavailable']);

function names(change: Change, path: string): boolean {
  const named = relative(path);
  return relative(change.path) === named || (change.op === 'move' && relative(change.to) === named);
}

function refusedChanges(refusal: Refusal, changes: readonly Change[]): Change[] {
  const paths =
    refusal.code === 'edit_conflict'
      ? refusal.conflicts.map((conflict) => conflict.path)
      : typeof refusal.detail.path === 'string' && !SETTLED_IN_PLACE.has(refusal.code)
        ? [refusal.detail.path]
        : [];
  return changes.filter((change) => paths.some((path) => names(change, path)));
}

function notSaved(root: string, refused: ReadonlyMap<string, string>): string[] {
  return [...refused].sort(([left], [right]) => (left < right ? -1 : 1)).map(([path, reason]) => `${root}/${path}: not saved: ${reason}`);
}

function notSavedFile(root: string, file: Unsaved): KitNotSavedFile {
  const path = `${root}/${file.path}`;
  return file.refused === undefined ? { path, markers: true } : { path, refused: file.refused };
}

async function stopping<T>(sent: Promise<T>): Promise<T | { refused: Refusal; admits?: number }> {
  try {
    return await sent;
  } catch (error) {
    const refusal = error instanceof HouseRefusal ? refusalOf(error.text) : null;
    if (refusal === null || !stopsPush(refusal)) throw error;
    const wait = namedWait((error as HouseRefusal).text);
    return wait === null ? { refused: refusal } : { refused: refusal, admits: Date.now() + wait };
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

function revisedLine(root: string, paths: readonly string[]): string {
  return `${root}: ${paths.length === 1 ? 'attachment brought at its' : 'attachments brought at their'} new revision: ${paths.join(', ')}`;
}

function blankReport(): Report {
  return { touched: new Map<string, string | null>(), kept: new Set<string>(), revised: new Set<string>() };
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
  const named = path.toLowerCase();
  return (!path.includes('/') && KIT_FILES.some((name) => name.toLowerCase() === named)) || SKILL_FOLDERS.some((folder) => named.startsWith(`${folder}/`));
}

function unsentPath(path: string): boolean {
  return path === MANIFEST || path.split('/').includes('.git') || kitsOwn(path);
}

function saving(state: Followed): boolean {
  return state.changes > state.saved || state.running > 0;
}

async function stillMarked(directory: string, manifest: Manifest, { present, left }: Scan): Promise<string[]> {
  const named: string[] = [];
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (entry.conflicted && !leaves(left, path) && (await marked(directory, present.get(path)?.name ?? path))) named.push(path);
  }
  return named;
}

function leftOut(root: string, left: readonly string[]): string[] {
  return left.map((folder) => `${root}/${folder}: not uploaded, as it holds a Git work tree`);
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

function withLines(forwarded: Forwarded, lines: readonly string[]): Forwarded {
  if (lines.length === 0) return forwarded;
  const answer = JSON.parse(forwarded.text) as { result: ToolResult };
  return { ...forwarded, text: JSON.stringify({ ...answer, result: { ...answer.result, content: [...answer.result.content, { type: 'text', text: lines.join('\n') }] } }) };
}

async function integratedFile(into: Integrating, path: string, name: string, held: string | null, revision: string, text: string): Promise<boolean> {
  const target = join(into.repository, name);
  if (held === null ? await exists(target) : !(await holding(into.repository, name, held))) return false;
  await placed(into.work, target, text);
  into.manifest.files[path] = { revision, sha256: digest(text), bytes: Buffer.byteLength(text) };
  return true;
}

function without(copy: Copy): Copy {
  const { pending, ...settled } = copy;
  return settled;
}

function earlier(copy: Held): copy is EarlierCopy {
  return 'manifests' in copy;
}

function skillRecord(manifest: Manifest | null): RoomSkillsRecord | typeof UNWRITTEN | null {
  if (manifest === null) return null;
  return manifest.skills ?? (manifest.kit === undefined ? null : UNWRITTEN);
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

function changeSet(manifest: Manifest, scan: Scan): { added: string[]; changed: string[]; gone: string[]; adopted: string[] } {
  const { present, left } = scan;
  const unsent = (path: string) => kitsOwn(path) || leaves(left, path) || !covered(scan, path);
  const added: string[] = [];
  const changed: string[] = [];
  const adopted: string[] = [];
  for (const [path, file] of present) {
    const entry = manifest.files[path];
    if (unsent(path)) continue;
    if (entry === undefined) added.push(path);
    else if (entry.skipped && entry.sha256 === file.sha256) adopted.push(path);
    else if (entry.read_only) continue;
    else if (entry.sha256 !== file.sha256) changed.push(path);
  }
  const gone = Object.entries(manifest.files).flatMap(([path, entry]) => (!unsent(path) && !entry.read_only && !entry.skipped && !present.has(path) ? [path] : []));
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
  private left: string[] = [];
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
  private readonly meanwhile: Meanwhile;

  constructor(
    repository: string,
    manifest: Manifest,
    scope: Scope,
    staging: string,
    report: Report,
    fetching: Fetching,
    bytesOf: (change: KitBinaryChange) => Promise<string>,
    link: Linking,
    meanwhile: Meanwhile,
  ) {
    this.repository = repository;
    this.manifest = manifest;
    this.scope = scope;
    this.staging = staging;
    this.report = report;
    this.fetching = fetching;
    this.bytesOf = bytesOf;
    this.link = link;
    this.meanwhile = meanwhile;
  }

  async start(): Promise<void> {
    const scan = await scanned(this.repository);
    this.present = scan.present;
    this.left = scan.left;
    adopt(this.manifest, changeSet(this.manifest, scan).adopted);
  }

  private nameOf(path: string): string {
    return this.present.get(path)?.name ?? path;
  }

  private touch(path: string): void {
    this.meanwhile.writes(path);
    if (!this.report.touched.has(path)) this.report.touched.set(path, this.present.get(path)?.sha256 ?? null);
  }

  private async untouched(path: string): Promise<boolean> {
    return !this.meanwhile.named(path) && ((await hashed(join(this.repository, this.nameOf(path))))?.sha256 ?? null) === (this.present.get(path)?.sha256 ?? null);
  }

  private async replaced(path: string, content: string): Promise<boolean> {
    const temporary = `${this.staging}${randomUUID()}`;
    await writeFile(temporary, content);
    if (!(await this.untouched(path))) {
      await rm(temporary, { force: true });
      return false;
    }
    const target = join(this.repository, this.nameOf(path));
    this.touch(path);
    await mkdir(dirname(target), { recursive: true });
    await rename(temporary, target);
    this.present.set(path, { name: this.nameOf(path), sha256: digest(content), bytes: Buffer.byteLength(content) });
    return true;
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
    if (leaves(this.left, path)) return;
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
    if (!unchanged || !(await this.replaced(path, content))) {
      this.report.kept.add(path);
      return;
    }
    this.manifest.files[path] = kept;
  }

  binary(change: KitBinaryChange): void {
    if (!leaves(this.left, change.path)) this.binaries.push(change);
  }

  removal(path: string): void {
    if (!leaves(this.left, path)) this.gone.push(path);
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
    const guarded = entry?.read_only !== true;
    const from = guarded && this.meanwhile.named(path) ? undefined : movedFrom(change);
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
    if (holds && !entry.read_only && local !== undefined && !(await holding(this.repository, local.name, entry.sha256))) {
      this.report.kept.add(path);
      return;
    }
    if (!holds && !(this.fetching.attachments && bytes <= this.fetching.maxSize * MEGABYTE)) {
      this.manifest.files[path] = { ...held, skipped: true };
      return;
    }
    const target = join(this.repository, this.nameOf(path));
    if (guarded && !(await this.untouched(path))) {
      this.report.kept.add(path);
      return;
    }
    this.touch(path);
    if (!(await this.link(path, change, target))) {
      const file = await this.bytesOf(change);
      if (guarded && !(await this.untouched(path))) {
        await rm(file, { force: true });
        this.report.kept.add(path);
        return;
      }
      await mkdir(dirname(target), { recursive: true });
      await rename(file, target);
    }
    this.present.set(path, { name: this.nameOf(path), sha256, bytes });
    this.manifest.files[path] = held;
    if (holds) this.report.revised.add(path);
  }

  private async removedHere(path: string): Promise<void> {
    const entry = this.manifest.files[path];
    if (entry === undefined) return;
    const local = this.present.get(path);
    if (entry.skipped || local === undefined) {
      delete this.manifest.files[path];
      return;
    }
    if (!entry.read_only && (local.sha256 !== entry.sha256 || !(await this.untouched(path)))) {
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
  private readonly saves: Saves;
  private readonly followed = new Map<string, Followed>();
  private following = false;
  private kept: Set<string> | null = null;
  private readonly copies = new Map<string, Held>();
  private readonly folders = new Map<string, RoomFolder>();
  private readonly places = new Map<string, Placed>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly waiting = new Set<string>();
  private readonly asking = new Set<string>();
  private readonly owed = new Set<string>();
  private readonly instructing = new Set<string>();
  private marks = 0;
  private sweep: Promise<void> | null = null;
  private privateRoom: string | null = null;
  private answering: Promise<unknown> = Promise.resolve();
  private readonly skillRecords = new Map<string, RoomSkillsRecord | typeof UNWRITTEN | null>();
  private reskilling: Promise<void> = Promise.resolve();
  private reskill: Promise<void> | null = null;

  constructor(house: House, launched: () => Promise<readonly string[]>, saves: Saves) {
    this.house = house;
    this.launched = launched;
    this.saves = saves;
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
      info: async (path, revision) => fileInfo(await environmentTool('info', { path, ...(revision === undefined ? {} : { ref: revision }) })),
      instructions: (root) => roomInstructions((args) => environmentTool('info', args), root),
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

  async connected(): Promise<void> {
    this.owe(null);
    try {
      await this.selected(null);
      await this.sweep;
    } finally {
      await this.reskilled();
    }
    this.following = true;
    this.watchedAll(true);
    await Promise.all([...this.followed.keys()].map((key) => this.saved(key, WHOLE).catch(logged)));
  }

  saving(directory: string): boolean {
    for (const state of this.followed.values()) if (state.repository === directory) return saving(state);
    return false;
  }

  isPrivate(room: string): boolean {
    return room === this.privateRoom;
  }

  async noticed(room: string): Promise<void> {
    this.owe(room);
    try {
      await this.selected(room);
    } finally {
      if (room === this.privateRoom) await this.reskilled();
    }
  }

  async download(caller: Caller, fetching: Fetching, cwd: string): Promise<Answered> {
    const copy = await this.copyAt(cwd);
    return copy === null ? this.answered(() => this.fetched(true, caller, fetching, null)) : this.freshened(copy, caller, fetching);
  }

  private async selected(notice: string | null): Promise<void> {
    if (notice !== null && this.asking.has(notice)) return;
    if (notice !== null) this.asking.add(notice);
    const copied = await this.answered(async () => {
      if (notice !== null) this.asking.delete(notice);
      return this.fetched(false, this.owner, HELD, notice);
    });
    if (copied.refused) logged(copied.text);
  }

  private owe(room: string | null): void {
    for (const { key, room: copied } of this.conversationCopies()) {
      if (room === null || room === copied) this.owed.add(key);
      else if (room === this.privateRoom) this.instructing.add(key);
    }
    this.freshenOwed();
  }

  private conversationCopies(): { key: string; conversation: string | null; room: string; directory: string }[] {
    const found = new Map<string, { key: string; conversation: string | null; room: string; directory: string }>();
    for (const [conversation, place] of this.places) {
      for (const [room, directory] of Object.entries(place.copies)) {
        if (!place.removed?.includes(room)) found.set(copyKey(conversation, room), { key: copyKey(conversation, room), conversation, room, directory });
      }
    }
    for (const copy of this.copies.values()) {
      if (copy.key.startsWith(CONVERSATIONS) && !found.has(copy.key)) found.set(copy.key, { key: copy.key, conversation: null, room: copy.room_ref, directory: copy.repository });
    }
    return [...found.values()].filter(({ key }) => this.follows(key));
  }

  private freshenOwed(): void {
    this.marks++;
    this.sweep ??= this.freshening().finally(() => {
      this.sweep = null;
    });
  }

  private async freshening(): Promise<void> {
    for (let marks = -1; marks !== this.marks; ) {
      marks = this.marks;
      for (const { key, directory } of this.conversationCopies()) {
        if (!this.owes(key) || !(await exists(directory))) continue;
        const answer = await this.freshened(directory, this.owner, HELD, true).catch((error: unknown) => ({ refused: true, text: houseCause(error) }));
        if (answer.refused) logged(`${directory}: ${answer.text}`);
      }
    }
  }

  private owes(key: string): boolean {
    return this.owed.has(key) || this.instructing.has(key);
  }

  private async selection(): Promise<LocalCopyRoom[]> {
    const { local_copy: answer } = await this.house.act('local-copies/selection/read', {});
    this.privateRoom = answer.rooms.find((room) => room.room_handle === PRIVATE)?.room_ref ?? null;
    this.kept = new Set(answer.rooms.flatMap((room) => (room.level === 'keep' ? [room.room_ref] : [])));
    this.watchedAll(false);
    return answer.rooms;
  }

  private answered<T>(work: () => Promise<T>): Promise<T> {
    const answered = this.answering.then(work);
    this.answering = answered.catch(() => undefined);
    return answered;
  }

  private async fetched(refreshing: boolean, caller: Caller, fetching: Fetching, notice: string | null): Promise<Answered> {
    const rooms = await this.selection();
    const reached = new Map(rooms.map((room) => [room.room_ref, room.room_handle]));
    const synced = new Map(rooms.filter((room) => room.level === 'keep').map((room) => [`${ROOMS}${room.room_ref}`, room.room_handle]));
    const asked = notice === null ? synced : new Map([...synced].filter(([key]) => key === `${ROOMS}${notice}`));
    return this.holding([...new Set([...this.roomCopies().map((copy) => copy.key), ...synced.keys()])].sort(), async () => {
      const chosen = [...(await this.launched()), ...this.workedIn()];
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
      for (const [key, handle] of asked) {
        try {
          const held = this.copies.get(key);
          if (held === undefined || !(await exists(held.repository)) || (!earlier(held) && !(await exists(join(held.repository, MANIFEST))))) {
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
      const reading = current;
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
      const rewrites = (ref: string) => refreshing || notice === null || notice === ref || notice === this.privateRoom || made.has(ref);
      const unwritten = await this.foldered(reached, new Set(synced.keys()), rewrites, caller, chosen);
      if (refreshing) said.push(...unwritten);
      else unwritten.forEach(logged);
      for (const room of notice === null ? [...this.waiting] : [notice]) {
        if (!unready.includes(room) && !unsettled.includes(room)) this.waiting.delete(room);
      }
      for (const room of unready) this.waiting.add(room);
      return { refused, text: said.length === 0 ? NOTHING_NEW : said.join('\n') };
    });
  }

  private async reported(copy: Held, report: Report): Promise<string[]> {
    const root = rootOf(copy.room_handle);
    let updated = 0;
    for (const [path, before] of report.touched) if (((await hashed(join(copy.repository, path)))?.sha256 ?? null) !== before) updated++;
    return [
      ...(updated === 0 ? [] : [`${root}: ${counted(updated, 'file')} updated from House`]),
      ...(report.revised.size === 0 ? [] : [revisedLine(root, [...report.revised].sort())]),
      ...[...report.kept].sort().map((path) => `${root}/${path}: changed here, so House's change was not brought; ${this.nextOf(copy.key)} merges it`),
    ];
  }

  async upload(cwd: string, caller: Caller): Promise<Answered> {
    const key = await this.keyAt(cwd);
    if (key === undefined) return outside(cwd);
    const { refused, text } = this.followed.has(key)
      ? await this.saved(key, BY_HAND)
      : await this.exclusive(key, async () => {
          const answer = await this.uploaded(key, caller, true, null);
          if (this.livingConversation(key) === null) await this.reportedOutside(key);
          return answer;
        });
    return { refused, text };
  }

  private livingConversation(key: string): string | null {
    for (const [conversation, place] of this.places) {
      if (place.deleted !== true && Object.keys(place.copies).some((room) => copyKey(conversation, room) === key)) return conversation;
    }
    return null;
  }

  private placeHolding(key: string): Placed | undefined {
    for (const [conversation, place] of this.places) if (Object.keys(place.copies).some((room) => copyKey(conversation, room) === key)) return place;
    return undefined;
  }

  private follows(key: string): boolean {
    const copy = this.copies.get(key);
    if (copy?.unfollowed !== undefined) return false;
    if (key.startsWith(ROOMS)) return copy !== undefined;
    const run = this.placeHolding(key)?.run;
    return run?.copy !== 'new' || run.follows === true;
  }

  private nextOf(key: string): string {
    return this.follows(key) ? 'the next save' : 'the next house upload';
  }

  private callerOf(key: string): Promise<Caller> {
    const conversation = this.livingConversation(key);
    return conversation === null ? Promise.resolve(this.owner) : this.saves.caller(conversation);
  }

  private watchedAll(again: boolean): void {
    for (const key of new Set([...this.copies.keys(), ...this.followed.keys()])) this.watched(key, again);
  }

  private watched(key: string, again = false): void {
    const copy = this.copies.get(key);
    const state = this.followed.get(key);
    const wanted =
      this.following && copy !== undefined && this.follows(key) && (key.startsWith(ROOMS) || this.kept === null || this.kept.has(copy.room_ref));
    if (!wanted) {
      if (state === undefined) return;
      this.followed.delete(key);
      state.watcher?.close();
      state.timer.stop();
      for (const { ended } of state.waiting.splice(0)) ended();
      if (saving(state)) this.saves.changed();
      return;
    }
    if (state !== undefined && state.repository === copy.repository && (state.watcher !== null || !again)) return;
    const held: Followed = state ?? {
      repository: copy.repository,
      watcher: null,
      heard: new Set(),
      looking: false,
      writing: new Set(),
      named: new Set(),
      refused: new Map(),
      changes: 0,
      saved: 0,
      running: 0,
      waiting: [],
      timer: new SaveTimer(() => void this.saved(key, NAMED).catch(logged)),
    };
    held.watcher?.close();
    held.watcher = null;
    held.repository = copy.repository;
    this.followed.set(key, held);
    try {
      const watcher: FSWatcher = watch(held.repository, { recursive: true }, (_event, name) => {
        if (held.watcher === watcher) this.heard(key, held, name);
      });
      watcher.on('error', (error) => {
        if (held.watcher !== watcher) return;
        watcher.close();
        held.watcher = null;
        logged(`${held.repository}: Kit lost its watch of the folder (${causeOf(error)}), so it saves what the whole folder changed`);
        void this.saved(key, WHOLE).catch(logged);
      });
      held.watcher = watcher;
    } catch (error) {
      logged(`${held.repository}: the system refused Kit a watch of the folder (${causeOf(error)}), so it saves what the whole folder changed`);
      void this.saved(key, WHOLE).catch(logged);
    }
  }

  private heard(key: string, state: Followed, name: string | null): void {
    const path = name ?? '';
    if (path !== '' && (unsentPath(path) || state.writing.delete(path.normalize('NFC')))) return;
    state.heard.add(path);
    if (state.looking) return;
    state.looking = true;
    void this.exclusive(key, () => this.looked(key, state)).catch(logged);
  }

  private async looked(key: string, state: Followed): Promise<void> {
    state.looking = false;
    const heard = [...state.heard];
    state.heard.clear();
    const copy = this.copies.get(key);
    if (heard.length === 0 || copy === undefined || this.followed.get(key) !== state) return;
    if (earlier(copy)) {
      this.named(state, heard);
      return;
    }
    const manifest = await readManifest(copy.repository).catch(() => null);
    if (manifest === null) return;
    const known = heard.filter((path) => state.named.has(path.normalize('NFC')));
    const unknown = heard.filter((path) => !known.includes(path));
    const scan = unknown.includes('') ? await scanned(copy.repository) : await scannedAt(copy.repository, unknown);
    const { added, changed, gone } = unknown.length === 0 ? { added: [], changed: [], gone: [] } : changeSet(manifest, scan);
    const refusedAlike = (path: string) => state.refused.has(path) && state.refused.get(path) === (scan.present.get(path)?.sha256 ?? null);
    const fresh = [...added, ...changed, ...gone].filter((path) => !refusedAlike(path));
    if (known.length + fresh.length > 0) this.named(state, fresh);
  }

  private named(state: Followed, paths: readonly string[]): void {
    const was = saving(state);
    for (const path of paths) state.named.add(path);
    state.changes++;
    state.timer.changed();
    if (!was) this.saves.changed();
  }

  private async saved(key: string, how: Saving): Promise<Uploaded> {
    const state = this.followed.get(key);
    if (state === undefined) return { refused: false, text: NOTHING_NEW };
    const was = saving(state);
    state.running++;
    if (!was) this.saves.changed();
    let through = state.saved;
    try {
      return await this.exclusive(key, async () => {
        through = state.changes;
        const named = how.whole ? null : [...state.named];
        state.named.clear();
        state.timer.taken();
        const copy = this.copies.get(key);
        if (copy === undefined) return { refused: false, text: NOTHING_NEW };
        if (!earlier(copy) && !(await exists(join(copy.repository, MANIFEST)))) {
          return { refused: false, text: `${rootOf(copy.room_handle)}: ${copy.repository} holds no manifest, so Kit sends nothing from it and copies the Room there again` };
        }
        const answer = await this.uploaded(key, await this.callerOf(key), how.byHand, named === null ? null : [...named, ...Object.keys((copy as Copy).refused ?? {})]);
        if (answer.refused && !how.byHand) logged(`${copy.repository}: ${answer.text}`);
        this.refusedAt(key, state, answer.read);
        if (this.livingConversation(key) === null) await this.reportedOutside(key);
        if (answer.admits !== undefined && answer.admits > Date.now()) state.timer.admitted(answer.admits);
        return answer;
      });
    } finally {
      state.running--;
      state.saved = Math.max(state.saved, through);
      for (const waiting of state.waiting.filter(({ through: wanted }) => wanted <= state.saved)) waiting.ended();
      state.waiting = state.waiting.filter(({ through: wanted }) => wanted > state.saved);
      if (!saving(state)) this.saves.changed();
    }
  }

  private refusedAt(key: string, state: Followed, read: ReadonlyMap<string, string> | undefined): void {
    const copy = this.copies.get(key);
    state.refused.clear();
    if (copy === undefined || earlier(copy)) return;
    for (const path of Object.keys(copy.refused ?? {})) state.refused.set(path, read?.get(path) ?? null);
  }

  private async settled(key: string): Promise<void> {
    const state = this.followed.get(key);
    if (state === undefined) return;
    await this.exclusive(key, () => this.looked(key, state));
    if (!saving(state)) return;
    await new Promise<void>((ended) => state.waiting.push({ through: state.changes, ended }));
  }

  private async reportedOutside(key: string): Promise<void> {
    const copy = this.copies.get(key)!;
    if (earlier(copy)) return;
    const root = rootOf(copy.room_handle);
    const held = copy.reported ?? {};
    const reported: Record<string, string> = {};
    for (const file of await this.unsavedIn(copy)) {
      const reason = file.refused ?? '';
      if (held[file.path] !== reason) {
        try {
          await this.house.act('local-copies/not-saved/report', { room_ref: copy.room_ref, ...notSavedFile(root, file) });
        } catch (error) {
          logged(error);
          continue;
        }
      }
      reported[file.path] = reason;
    }
    if (Object.keys(held).length + Object.keys(reported).length === 0) return;
    const { reported: _held, ...rest } = this.copies.get(key) as Copy;
    await this.save(Object.keys(reported).length === 0 ? rest : { ...rest, reported });
  }

  private async unsavedIn(copy: Copy): Promise<Unsaved[]> {
    const manifest = await readManifest(copy.repository).catch(() => null);
    if (manifest === null) return [];
    const conflicted = Object.entries(manifest.files).flatMap(([path, entry]) => (entry.conflicted ? [path] : []));
    const refusedPaths = Object.keys(copy.refused ?? {});
    if (conflicted.length + refusedPaths.length === 0) return [];
    const scan = await scannedAt(copy.repository, [...refusedPaths, ...conflicted]);
    const marked = await stillMarked(copy.repository, manifest, scan);
    const { added, changed, gone } = changeSet(manifest, scan);
    const unsent = new Set([...added, ...changed, ...gone]);
    const refused = Object.entries(copy.refused ?? {}).flatMap(([path, reason]) => (unsent.has(path) && !marked.includes(path) ? [{ path, refused: reason }] : []));
    return [...refused, ...marked.map((path) => ({ path }))].sort((left, right) => (left.path < right.path ? -1 : 1));
  }

  private async unsentPaths(copy: Copy, read: Map<string, string>): Promise<string[]> {
    const manifest = await readManifest(copy.repository);
    const scan = await scanned(copy.repository);
    for (const [path, file] of scan.present) read.set(path, file.sha256);
    const marked = await stillMarked(copy.repository, manifest, scan);
    const { added, changed, gone } = changeSet(manifest, scan);
    return [...new Set([...added, ...changed, ...gone])].filter((path) => !marked.includes(path));
  }

  async updated(conversation: string | null, cwd: string, changes: readonly Sent[], forwarded: Forwarded): Promise<Forwarded> {
    const answer = updateAnswer(forwarded);
    if ('refused' in answer) return forwarded;
    const session = conversation === null ? undefined : this.places.get(conversation)?.session;
    const key = (session === undefined ? undefined : await this.keyAt(session)) ?? (await this.keyAt(cwd));
    if (key === undefined) return forwarded;
    const lines = await this.exclusive(key, async () =>
      this.wroteBack(await this.currentlyNamed(await this.converted(this.copies.get(key)!), answer.accepted), changes, answer.accepted),
    ).catch((error: unknown) => [
      `${this.copies.get(key)!.repository}: House accepted the update, but Kit could not write it here (${houseCause(error)}), so local integration is pending; ${this.follows(key) ? "the next notice brings House's text" : "house download here brings House's text"}`,
    ]);
    return withLines(forwarded, lines);
  }

  private async currentlyNamed(copy: Copy, accepted: readonly Written[]): Promise<Copy> {
    if (accepted.every((written) => written.path.startsWith(`${rootOf(copy.room_handle)}/`))) return copy;
    const reached = await this.reachedRoom(copy.room_ref);
    return reached === null || reached.room_handle === copy.room_handle ? copy : this.save({ ...copy, room_handle: reached.room_handle });
  }

  private async wroteBack(copy: Copy, changes: readonly Sent[], accepted: readonly Written[]): Promise<string[]> {
    const root = rootOf(copy.room_handle);
    const local = (path: string) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null);
    const into: Integrating = { repository: copy.repository, manifest: await readManifest(copy.repository), work: await staging() };
    const { files } = into.manifest;
    const left = await leftIn(copy.repository);
    const lines: string[] = [];
    const pending = (path: string): void => {
      lines.push(`${root}/${path}: changed here, so House accepted the update and local integration is pending; ${this.nextOf(copy.key)} sends this file as it is`);
    };
    const unchanged = async (path: string) =>
      files[path]!.skipped === true ? !(await exists(join(copy.repository, path))) : await holding(copy.repository, path, files[path]!.sha256);
    const sent = (path: string) => {
      const named = changes.filter((change) => change.path === path);
      return named.length === 1 && named[0]!.op === 'write' && typeof named[0]!.content === 'string' ? named[0]!.content : undefined;
    };
    const deleting = changes.flatMap((change) => (change.op === 'delete' ? [local(change.path)].filter((path) => path !== null) : []));
    let changed = false;
    const dropped = async (path: string) => {
      if (!(await unchanged(path))) {
        pending(path);
        return;
      }
      await removed(copy.repository, path);
      delete files[path];
      changed = true;
    };
    try {
      for (const written of accepted) {
        const path = local(written.path);
        const from = written.from === undefined ? null : local(written.from);
        if (written.ref !== undefined || [path, from].some((one) => one !== null && leaves(left, one))) continue;
        if (from !== null && files[from] !== undefined) {
          if (path === null) await dropped(from);
          else if (!(await unchanged(from)) || (await exists(join(copy.repository, path)))) pending(from);
          else {
            const { revision: _revision, ...entry } = files[from]!;
            if (entry.skipped !== true) {
              await mkdir(dirname(join(copy.repository, path)), { recursive: true });
              await rename(join(copy.repository, from), join(copy.repository, path));
              await removed(copy.repository, from);
            }
            delete files[from];
            files[path] = { ...entry, revision: written.revision! };
            changed = true;
          }
          continue;
        }
        if (path === null || path === '') continue;
        if (written.revision === null) {
          for (const held of Object.keys(files).filter((name) => !leaves(left, name) && deleting.some((gone) => covers(name, gone) && covers(name, path)))) await dropped(held);
          continue;
        }
        const entry = files[path];
        if (entry === undefined ? !isDocument(path) : entry.read_only === true || entry.skipped === true) continue;
        const text = await this.textOf(written, sent(written.path));
        if (await integratedFile(into, path, path, entry?.sha256 ?? null, written.revision, text)) changed = true;
        else pending(path);
      }
    } finally {
      if (changed) await writeManifest(copy.repository, into.work, into.manifest);
    }
    return lines;
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

  async placed(conversation: string, opening: Opening | null, caller: Caller, launch: string, read: Reader): Promise<Place> {
    if (opening === null) return this.placedAgain(conversation, caller, launch);
    const coded = this.places.get(conversation)?.run?.code;
    const place = await this.placedCopy(conversation, opening, caller, launch, coded);
    const repository = opening.run?.repository ?? null;
    if (repository === null) return place;
    const code =
      coded ??
      (await codeFolder(
        repository,
        opening.run!.name,
        () => this.listed(opening.room_ref, repository.url, read),
        (key, work) => this.exclusive(key, work),
      ));
    await this.exclusive(PLACES, () => {
      const held = this.places.get(conversation)!;
      return this.savePlace(conversation, { ...held, run: { ...held.run!, code } });
    });
    return { ...place, code };
  }

  private async listed(room: string | null, url: string, read: Reader): Promise<string | null> {
    const reached = room === null ? null : await this.reachedRoom(room);
    if (reached === null) throw new PlaceRefused(`this Environment does not reach the Run's Room, so Kit cannot read its ${REPOSITORIES}`);
    return listedRef(await read(`${rootOf(reached.room_handle)}/${REPOSITORIES}`), url);
  }

  private async placedCopy(conversation: string, opening: Opening, caller: Caller, launch: string, code: string | undefined): Promise<Place> {
    const kind = opening.run?.copy.kind;
    const run =
      opening.run === undefined
        ? undefined
        : { copy: opening.run.copy.kind, name: opening.run.name, ...(code === undefined ? {} : { code }), ...(kind === 'new' ? { follows: true as const } : {}) };
    const place = (directory: string, copy: boolean): Place => ({ directory, copy, synced: true, name: run?.name ?? null, code: null });
    if (opening.run?.copy.kind === 'none') {
      await this.session(conversation, launch, run);
      return place(launch, false);
    }
    if (opening.run?.copy.kind === 'existing') {
      const directory = await this.existing(opening.run.copy.path, opening.room_ref, caller);
      await this.session(conversation, directory, run);
      return place(directory, true);
    }
    const reached = opening.room_ref === null ? null : await this.reachedRoom(opening.room_ref);
    if (reached === null) {
      await this.session(conversation, launch, run);
      return place(launch, false);
    }
    const directory = await this.exclusive(PLACES, async () => {
      const recorded = this.places.get(conversation) ?? { copies: {} };
      const path = recorded.copies[reached.room_ref] ?? (await this.freePath(reached.room_handle, run?.name ?? opening.name));
      await this.savePlace(conversation, { ...recorded, copies: { ...recorded.copies, [reached.room_ref]: path }, session: path, ...(run === undefined ? {} : { run }) });
      return path;
    });
    await this.ensured(conversation, reached.room_ref, directory, caller, () => Promise.resolve(reached));
    return place(directory, true);
  }

  private async placedAgain(conversation: string, caller: Caller, launch: string): Promise<Place> {
    const held = this.places.get(conversation) ?? { copies: {} };
    const directory = held.session ?? launch;
    const place = (copy: boolean): Place => {
      const run = this.places.get(conversation)?.run;
      return { directory, copy, synced: run?.copy !== 'new' || run.follows === true, name: run?.name ?? null, code: run?.code ?? null };
    };
    const room = Object.keys(held.copies).find((ref) => held.copies[ref] === directory);
    if (room !== undefined) {
      await this.ensured(conversation, room, directory, caller, () => this.reachedRoom(room));
      return place(true);
    }
    if (held.run?.copy !== 'existing') return place(false);
    const owner = this.conversationCopyAt(directory);
    if (owner?.conversation !== undefined && owner.conversation !== null) {
      const { conversation: holder, room: copied } = owner;
      await this.ensured(holder, copied, directory, caller, () => this.reachedRoom(copied));
    }
    return place(true);
  }

  private session(conversation: string, directory: string, run: Ran | undefined): Promise<void> {
    return this.exclusive(PLACES, () =>
      this.savePlace(conversation, { ...(this.places.get(conversation) ?? { copies: {} }), session: directory, ...(run === undefined ? {} : { run }) }),
    );
  }

  private async existing(path: string, room: string | null, caller: Caller): Promise<string> {
    const physical = await realpath(path).catch(() => resolve(path));
    let owner: { conversation: string; room: string; path: string } | null = null;
    for (const [conversation, place] of this.places) {
      for (const [copied, held] of Object.entries(place.copies)) {
        if (copied === room && (await realpath(held).catch(() => held)) === physical) owner = { conversation, room: copied, path: held };
      }
    }
    if (owner !== null) await this.ensured(owner.conversation, owner.room, owner.path, caller, () => this.reachedRoom(owner.room));
    const directory = owner?.path ?? physical;
    const manifest = await readManifest(directory).catch(() => null);
    if (manifest === null) throw new PlaceRefused(`${path} holds no Local copy of a Room`);
    if (manifest.room_ref !== room) throw new PlaceRefused(`${path} is a Local copy of another Room`);
    return directory;
  }

  async turnEnded(directory: string): Promise<void> {
    const held = this.conversationCopyAt(directory);
    if (held === null || held.conversation === null) return;
    const { conversation, room } = held;
    await this.exclusive(PLACES, () => this.used(conversation, room, false));
  }

  async deleted(conversation: string): Promise<KeptCopy[]> {
    const reckon = this.reckoning();
    const session = this.places.get(conversation)?.session;
    const kept = await this.deletedPlace(conversation, reckon);
    const owner = session === undefined ? null : (this.conversationCopyAt(session)?.conversation ?? null);
    if (owner !== null && owner !== conversation && this.places.get(owner)?.deleted === true) kept.push(...(await this.deletedPlace(owner, reckon)));
    return kept;
  }

  private async deletedPlace(conversation: string, reckon: Reckoning): Promise<KeptCopy[]> {
    const kept: KeptCopy[] = [];
    const shared: Record<string, string> = {};
    for (const [room, path] of Object.entries(this.places.get(conversation)?.copies ?? {})) {
      if (this.workedInBeside(conversation, path)) {
        shared[room] = path;
        continue;
      }
      const key = copyKey(conversation, room);
      const removed = await this.exclusive(key, async () => {
        if (!this.places.get(conversation)?.removed?.includes(room)) {
          await reckon(conversation, room, path);
          if (await this.holdsWork(conversation, room, path)) {
            const copy = this.copies.get(key);
            if (copy !== undefined && !this.follows(key)) await this.save({ ...copy, unfollowed: 'said' });
            return false;
          }
        }
        await this.removedHeld(conversation, room, path);
        return true;
      });
      if (!removed) kept.push({ room_ref: room, path });
    }
    await this.exclusive(PLACES, async () => {
      const place = this.places.get(conversation);
      if (place !== undefined && Object.keys(shared).length > 0) {
        await this.savePlace(conversation, { ...place, copies: shared, deleted: true });
        return;
      }
      await rm(placeOf(conversation), { force: true });
      this.places.delete(conversation);
    });
    return kept;
  }

  private workedIn(): string[] {
    return [...this.places.values()].flatMap((place) => (place.deleted === true || place.session === undefined ? [] : [place.session]));
  }

  private workedInBeside(conversation: string, directory: string): boolean {
    return [...this.places].some(([other, place]) => other !== conversation && place.deleted !== true && place.session === directory);
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
          await reckon(conversation, room, path);
          if (await this.holdsWork(conversation, room, path)) return;
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
      const making = removed || !(await exists(directory));
      if (making) {
        const reached = await reach();
        if (reached === null) await mkdir(directory, { recursive: true, mode: 0o700 });
        else await this.made(conversation, reached, directory, caller);
      }
      await this.exclusive(PLACES, () => this.used(conversation, room, making));
    });
  }

  private async used(conversation: string, room: string, made: boolean): Promise<void> {
    const place = this.places.get(conversation);
    if (place?.copies[room] === undefined) return;
    const { removed = [], run, ...held } = place;
    const still = removed.filter((one) => one !== room);
    const follows = run === undefined ? {} : { run: made && run.copy === 'new' ? { ...run, follows: true as const } : run };
    await this.savePlace(conversation, { ...held, ...follows, ended: { ...held.ended, [room]: Date.now() }, ...(still.length === 0 ? {} : { removed: still }) });
  }

  private reckoning(): Reckoning {
    let selection: Promise<LocalCopyRoom[]> | undefined;
    return async (conversation, room, directory) => {
      const key = copyKey(conversation, room);
      const copy = this.copies.get(key) as Copy | undefined;
      if (copy === undefined || copy.pending !== undefined || !(await exists(copy.repository)) || !this.follows(key)) return;
      try {
        selection ??= this.selection();
        const reached = (await selection).find((room) => room.room_ref === copy.room_ref);
        if (reached?.level !== 'keep') return;
        const named = copy.room_handle === reached.room_handle ? copy : await this.save({ ...copy, room_handle: reached.room_handle });
        await this.refreshed([named], [], new Map<string, string>(), this.owner, HELD, new Map([[key, blankReport()]]));
      } catch (error) {
        logged(error);
      }
    };
  }

  private async holdsWork(conversation: string, room: string, directory: string): Promise<boolean> {
    const key = copyKey(conversation, room);
    const copy = this.copies.get(key) as Copy | undefined;
    if (copy === undefined || !(await exists(directory))) return false;
    if (copy.pending !== undefined) return true;
    try {
      const manifest = await readManifest(directory);
      if (Object.values(manifest.files).some((entry) => entry.conflicted)) return true;
      const scan = await scanned(directory);
      if (scan.left.length > 0) return true;
      const { added, changed, gone } = changeSet(manifest, scan);
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

  async freshened(directory: string, caller: Caller, fetching: Fetching = HELD, owed = false): Promise<Answered> {
    const held = this.conversationCopyAt(directory);
    if (held === null) return { refused: false, text: NOTHING_NEW };
    const { key, room } = held;
    return this.exclusive(key, async () => {
      if (owed && !this.owes(key)) return { refused: false, text: NOTHING_NEW };
      const kept = this.copies.get(key);
      if (owed && !this.owed.has(key) && kept !== undefined) return this.reinstructed(key, directory, kept, caller);
      this.owed.delete(key);
      this.instructing.delete(key);
      try {
        const reached = (await this.selection()).find((one) => one.room_ref === room);
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
            if (copy === undefined || (!earlier(copy) && !(await exists(join(directory, MANIFEST))))) {
              await this.forgotten(key);
              await this.madeKept(key, reached, directory, caller, (folder) => this.placedIn(folder, directory, []));
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
        if (refused || unwritten !== null) this.owed.add(key);
        return { refused, text: lines.length === 0 ? NOTHING_NEW : lines.join('\n') };
      } catch (error) {
        this.owed.add(key);
        throw error;
      }
    });
  }

  private async reinstructed(key: string, directory: string, copy: Held, caller: Caller): Promise<Answered> {
    this.instructing.delete(key);
    const unwritten = await this.instructed(directory, rootOf(copy.room_handle), caller, true);
    if (unwritten !== null) this.instructing.add(key);
    return { refused: false, text: unwritten ?? NOTHING_NEW };
  }

  async ended(directory: string): Promise<KitNotSavedFile[] | null> {
    const held = this.conversationCopyAt(directory);
    if (held === null || !this.copies.has(held.key)) return null;
    await this.settled(held.key);
    return this.exclusive(held.key, () => this.unsavedAt(held.key));
  }

  async unsaved(directory: string): Promise<string[]> {
    const held = this.conversationCopyAt(directory);
    if (held === null || !this.copies.has(held.key)) return [];
    return this.exclusive(held.key, async () => (await this.unsavedAt(held.key)).map((file) => file.path));
  }

  private async unsavedAt(key: string): Promise<KitNotSavedFile[]> {
    const copy = this.copies.get(key)!;
    if (earlier(copy)) return [];
    const root = rootOf(copy.room_handle);
    return (await this.unsavedIn(copy)).map((file) => notSavedFile(root, file));
  }

  private roomCopies(): Held[] {
    return [...this.copies.values()].filter((copy) => copy.key.startsWith(ROOMS));
  }

  private conversationCopyAt(directory: string): { key: string; conversation: string | null; room: string } | null {
    for (const [conversation, place] of this.places) {
      for (const [room, path] of Object.entries(place.copies)) {
        if (path === directory) return { key: copyKey(conversation, room), conversation, room };
      }
    }
    for (const copy of this.copies.values()) {
      if (copy.key.startsWith(CONVERSATIONS) && copy.repository === directory) return { key: copy.key, conversation: null, room: copy.room_ref };
    }
    return null;
  }

  private async copyAt(cwd: string): Promise<string | null> {
    const physical = await realpath(cwd).catch(() => cwd);
    const conversations = [...this.places.values()].flatMap((place) => Object.values(place.copies));
    const kept = [...this.copies.values()].flatMap((copy) => (copy.key.startsWith(CONVERSATIONS) ? [copy.repository] : []));
    for (const path of [...conversations, ...kept]) {
      if (within(physical, await realpath(path).catch(() => path))) return path;
    }
    return null;
  }

  private async reachedRoom(room: string): Promise<LocalCopyRoom | null> {
    return (await this.selection()).find((one) => one.room_ref === room) ?? null;
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
    for (const room of Object.keys(place.copies)) this.watched(copyKey(conversation, room));
  }

  private async made(conversation: string, room: LocalCopyRoom, directory: string, caller: Caller): Promise<void> {
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    if (room.level === 'keep') await this.madeKept(copyKey(conversation, room.room_ref), room, directory, caller, (folder) => rename(folder, directory));
    else {
      await this.forgotten(copyKey(conversation, room.room_ref));
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const unwritten = await this.instructed(directory, rootOf(room.room_handle), caller, room.level === 'keep');
    if (unwritten !== null) logged(unwritten);
  }

  private async madeKept(key: string, room: LocalCopyRoom, directory: string, caller: Caller, placing: (folder: string) => Promise<void>): Promise<void> {
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
      return await this.written(directory, root, caller, kept, roomSkillsReading());
    } catch (error) {
      return `${root}: AGENTS.md kept as it was: ${houseCause(error)}`;
    }
  }

  private async written(folder: string, root: string, caller: Caller, kept: boolean, reading: RoomSkillsReading): Promise<string | null> {
    const { text, approved } = await caller.instructions(root);
    if (!kept) {
      await kitFiles(folder, text);
      return null;
    }
    const manifest = await readManifest(folder);
    await this.kitMarked(folder, text, manifest);
    return this.skilled(folder, root, manifest, approved, reading);
  }

  private async skilled(folder: string, root: string, manifest: Manifest, approved: number | null, reading: RoomSkillsReading): Promise<string | null> {
    const held = manifest.skills;
    if (held !== undefined && held.approved === approved) return null;
    if (approved === null && skillRecord(manifest) === null) return null;
    try {
      await this.reskilledIn(folder, manifest, approved === null ? NO_ROOM_SKILLS : await reading.of(manifest.room_ref), approved);
      return null;
    } catch (error) {
      return skillsKept(root, error);
    }
  }

  private async reskilledIn(folder: string, manifest: Manifest, set: RoomSkillSet, approved: number | null | undefined): Promise<void> {
    const held = manifest.skills;
    const record = async (names: string[], digest: string) => {
      manifest.skills = { ...(approved === undefined ? {} : { approved }), listed: set.listed, sources: set.sources, names, digest };
      await writeManifest(folder, await staging(), manifest);
      this.skillRecords.set(folder, manifest.skills);
    };
    if (held?.digest === set.digest) {
      if (held.approved !== approved || JSON.stringify([held.listed, held.sources]) !== JSON.stringify([set.listed, set.sources])) await record(held.names, held.digest);
      return;
    }
    if (set.skills.length === 0 && (held?.names ?? []).length === 0) {
      await record([], set.digest);
      return;
    }
    await record(await placeRoomSkills(folder, set.skills, held?.names ?? [], (names) => record(names, '')), set.digest);
  }

  reskilled(): Promise<void> {
    this.reskill ??= this.reskilling.then(() => {
      this.reskill = null;
      return this.reskilledWhereChanged();
    });
    this.reskilling = this.reskill.catch(() => undefined);
    return this.reskill;
  }

  private async skillRecordOf(folder: string): Promise<RoomSkillsRecord | typeof UNWRITTEN | null> {
    const known = this.skillRecords.get(folder);
    if (known !== undefined) return known;
    const record = skillRecord(await readManifest(folder).catch(() => null));
    this.skillRecords.set(folder, record);
    return record;
  }

  private async reskilledWhereChanged(): Promise<void> {
    const due: { copy: Copy; record: RoomSkillsRecord | typeof UNWRITTEN }[] = [];
    await eachAtOnce([...this.copies.values()], async (copy) => {
      if (earlier(copy)) return;
      const record = await this.skillRecordOf(copy.repository);
      if (record === UNWRITTEN || (record !== null && record.listed.length > 0)) due.push({ copy, record });
    });
    if (due.length === 0) return;
    const reading = roomSkillsReading();
    const sources = await reading.sources(due.flatMap(({ record }) => (record === UNWRITTEN ? [] : record.listed))).catch((error: unknown) => {
      logged(`the Rooms' skills kept as they were: ${houseCause(error)}`);
      return null;
    });
    if (sources === null) return;
    await eachAtOnce(due, async ({ copy: { key, room_handle: handle }, record }) => {
      if (record !== UNWRITTEN && record.listed.every((name) => record.sources[name] === sources[name])) return;
      await this.exclusive(key, () => this.reskilledHeld(key, reading)).catch((error: unknown) => logged(skillsKept(rootOf(handle), error)));
    });
  }

  private async reskilledHeld(key: string, reading: RoomSkillsReading): Promise<void> {
    const copy = this.copies.get(key);
    if (copy === undefined || earlier(copy)) return;
    const manifest = await readManifest(copy.repository).catch(() => null);
    if (manifest === null || skillRecord(manifest) === null) return;
    await this.reskilledIn(copy.repository, manifest, await reading.of(manifest.room_ref), manifest.skills?.approved);
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
    if (manifest !== null) await this.left(directory, manifest);
  }

  private async forgotten(key: string): Promise<void> {
    if (!this.copies.delete(key)) return;
    this.watched(key);
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
    this.watched(copy.key);
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
    rewrites: (ref: string) => boolean,
    caller: Caller,
    chosen: readonly string[],
  ): Promise<string[]> {
    const lines: string[] = [];
    for (const copy of this.roomCopies()) {
      if (reached.has(copy.room_ref) || earlier(copy)) continue;
      const manifest = await readManifest(copy.repository).catch(() => null);
      if (manifest !== null) await this.left(copy.repository, manifest);
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
          if (rewrites(ref)) due.push({ root: rootOf(handle), folder: current.repository, copied: true });
          continue;
        }
        if (synced.has(key)) continue;
        const held = await this.heldFolder(ref, handle, chosen);
        if (held !== null) {
          if (rewrites(ref)) due.push({ root: rootOf(handle), folder: held, copied: false });
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
    const unskilled: string[] = [];
    const reading = roomSkillsReading();
    await eachAtOnce(due, async ({ root, folder, copied }) => {
      try {
        const kept = await this.written(folder, root, caller, copied, reading);
        if (kept !== null) unskilled.push(kept);
      } catch (error) {
        const cause = houseCause(error);
        unread.set(cause, [...(unread.get(cause) ?? []), root]);
      }
    });
    for (const [cause, roots] of unread) lines.push(`${roots.sort().join(', ')}: AGENTS.md kept as it was: ${cause}`);
    return [...lines, ...unskilled.sort()];
  }

  private async kitMarked(folder: string, text: string, manifest: Manifest): Promise<void> {
    if (text === '' && manifest.kit === undefined) return;
    await kitFiles(folder, text);
    if (text === '') delete manifest.kit;
    else if (manifest.kit === undefined) manifest.kit = [...KIT_FILES];
    else return;
    await this.marked(folder, manifest);
  }

  private async left(folder: string, manifest: Manifest): Promise<void> {
    if (manifest.kit === undefined && manifest.skills === undefined) return;
    if (manifest.kit !== undefined) await kitFiles(folder, '');
    await removeRoomSkills(folder, manifest.skills?.names ?? []);
    delete manifest.kit;
    delete manifest.skills;
    await this.marked(folder, manifest);
  }

  private async marked(folder: string, manifest: Manifest): Promise<void> {
    await writeManifest(folder, await staging(), manifest);
    this.skillRecords.set(folder, skillRecord(manifest));
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
    const made = await this.save(copy);
    const state = this.followed.get(key);
    if (state !== undefined) {
      state.watcher?.close();
      state.watcher = null;
      state.heard.clear();
    }
    this.watched(key, true);
    return made;
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
      this.meanwhileOf(copy.key),
    );
  }

  private meanwhileOf(key: string): Meanwhile {
    const state = this.followed.get(key);
    return state === undefined ? UNWATCHED : { named: (path) => state.heard.has(path), writes: (path) => void state.writing.add(path) };
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
        this.followed.get(copy.key)?.writing.clear();
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
    const held = Object.entries(manifest.files).filter(([, entry]) => entry.skipped);
    const left = held.length === 0 ? [] : await leftIn(copy.repository);
    const skipped = held.filter(([path]) => !leaves(left, path));
    const present = new Map<string, Present>();
    for (const [path] of skipped) {
      const file = await hashed(join(copy.repository, path));
      if (file !== null) present.set(path, { name: path, ...file });
    }
    const { adopted } = changeSet(manifest, { present, left });
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
      this.followed.get(copy.key)?.writing.clear();
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
      const { present, left } = await scanned(copy.repository);
      const current = new Map<string, { revision: string; sha256: string; bytes: number }>();
      const unbrought = new Map<string, string>();
      const binaries: KitBinaryChange[] = [];
      const readOnly = async (path: string, content: string, revision: string) => {
        if (present.get(path)?.sha256 !== digest(content)) await placed(work, join(copy.repository, path), content);
        manifest.files[path] = { revision, sha256: digest(content), bytes: Buffer.byteLength(content), read_only: true };
      };
      for await (const entry of read.entries) {
        if (leaves(left, entry.path)) continue;
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
        if (manifest.files[path]?.read_only || leaves(left, path)) continue;
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
      for (const path of held.read_only) if (manifest.files[path] === undefined && !leaves(left, path)) await removed(copy.repository, path);
      for (const name of [...KIT_IGNORES, ...KIT_GIT]) await rm(join(copy.repository, name), { recursive: true, force: true });
      await rmdir(join(copy.repository, '.git', 'refs', 'house')).catch(() => undefined);
      await writeManifest(copy.repository, work, manifest);
    } catch (error) {
      if (error instanceof NotReady) throw error;
      throw new Error(`${root}: Kit could not convert the copy an earlier Kit kept yet (${houseCause(error)}); ${this.nextOf(held.key)} converts it`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return this.save(copy);
  }

  private async uploaded(key: string, caller: Caller, byHand: boolean, named: string[] | null): Promise<Uploaded> {
    let copy: Copy;
    try {
      copy = await this.converted(this.copies.get(key)!);
    } catch (error) {
      return { refused: true, text: error instanceof NotReady ? `${rootOf(this.copies.get(key)!.room_handle)}: ${NOT_READY}` : causeOf(error) };
    }
    const refused = new Map<string, string>();
    const sending: Sending = { files: 0, landed: 0, lines: [], conflicted: false, read: new Map() };
    if (copy.pending !== undefined) {
      for (const [path, held] of Object.entries(copy.pending.read)) sending.read.set(path, held.sha256);
      await this.sentBatch(copy, caller, refused, sending);
      if (sending.stopped !== undefined) return this.stoppedUpload(key, refused, sending, 0);
      copy = this.copies.get(key) as Copy;
    }
    const root = rootOf(copy.room_handle);
    const manifest = await readManifest(copy.repository);
    const scan = named === null ? await scanned(copy.repository) : await scannedAt(copy.repository, named);
    for (const [path, file] of scan.present) sending.read.set(path, file.sha256);
    const marked = await stillMarked(copy.repository, manifest, scan);
    if (byHand && marked.length > 0) {
      await this.keptRefused(key, refused, true);
      const unresolved = marked.map((path) => `${root}/${path}`);
      const [holding, they] = unresolved.length === 1 ? [`${unresolved[0]} still holds`, 'it'] : [`${unresolved.join(', ')} still hold`, 'each'];
      const next = this.follows(key) ? `the next save sends ${they} once its markers go` : `resolve ${they}, then run house upload again`;
      return { refused: true, text: `${holding} conflict markers; ${next}`, read: sending.read };
    }
    let built: Built;
    try {
      built = await this.built(copy, manifest, scan, marked);
    } catch (error) {
      return { refused: true, text: houseCause(error) };
    }
    for (const [path, reason] of built.unsendable) refused.set(path, reason);
    const batches = batched(built.changes);
    for (const [index, changes] of batches.entries()) {
      const read = Object.fromEntries(changedPaths(changes).flatMap((path) => (built.read[relative(path)] === undefined ? [] : [[relative(path), built.read[relative(path)]!]])));
      copy = await this.save({ ...(this.copies.get(key) as Copy), pending: { operation_id: operationId(), caller: caller.key, changes, read } });
      await this.sentBatch(copy, caller, refused, sending);
      if (sending.stopped !== undefined) return this.stoppedUpload(key, refused, sending, batches.length - index - 1);
    }
    await this.keptRefused(key, refused, false);
    const now = rootOf((this.copies.get(key) as Copy).room_handle);
    if (sending.landed === 0 && refused.size === 0 && !sending.conflicted) return { refused: false, text: [`Nothing to upload: ${root} matches House.`, ...leftOut(root, scan.left)].join('\n') };
    const accepted = sending.landed === 0 ? [] : [`House accepted ${counted(sending.files, 'file')} of ${now}${sending.landed > 1 ? ` in ${sending.landed} batches` : ''}.`];
    return {
      refused: refused.size > 0 || sending.conflicted,
      text: [...accepted, ...sending.lines, ...notSaved(now, refused), ...leftOut(now, scan.left)].join('\n'),
      read: sending.read,
    };
  }

  private async sentBatch(start: Copy, caller: Caller, refused: Map<string, string>, sending: Sending): Promise<void> {
    let copy = start;
    for (;;) {
      const settled = await this.settle(copy, caller);
      if (!settled.refused) {
        sending.files += settled.files;
        sending.landed++;
        sending.lines.push(...settled.lines);
        return;
      }
      const { refusal, batch } = settled;
      const named = refusal === undefined || batch === undefined ? [] : refusedChanges(refusal, batch.changes);
      if (named.length === 0) {
        sending.stopped = settled;
        return;
      }
      if (refusal!.code === 'edit_conflict') sending.conflicted = true;
      else for (const change of named) refused.set(relative(change.path), firstLine(refusal!));
      sending.lines.push(...(settled.lines ?? []));
      const rest = batch!.changes.filter((change) => !named.includes(change));
      if (rest.length === 0) return;
      const paths = new Set(changedPaths(rest).map(relative));
      const read = Object.fromEntries(Object.entries(batch!.read).filter(([path]) => paths.has(path)));
      copy = await this.save({ ...(this.copies.get(start.key) as Copy), pending: { operation_id: operationId(), caller: caller.key, changes: rest, read } });
    }
  }

  private async stoppedUpload(key: string, refused: Map<string, string>, sending: Sending, after: number): Promise<Uploaded> {
    const stopped = sending.stopped!;
    const copy = this.copies.get(key) as Copy;
    const root = rootOf(copy.room_handle);
    const named = notSaved(root, refused);
    if (stopped.refusal !== undefined) {
      const reason = firstLine(stopped.refusal);
      for (const path of await this.unsentPaths(copy, sending.read)) if (!refused.has(path)) refused.set(path, reason);
    }
    await this.keptRefused(key, refused, stopped.refusal === undefined);
    const done = sending.landed === 0 ? [] : [`House accepted ${counted(sending.landed, 'batch', 'batches')} of ${root} before this one.`];
    const unsent = after > 0 ? [`${counted(after, 'batch', 'batches')} after it ${after === 1 ? 'was' : 'were'} not sent`] : [];
    const text = [...done, ...sending.lines, ...named, stopped.text, ...unsent].join('\n');
    return stopped.admits === undefined ? { refused: true, text, read: sending.read } : { refused: true, text, read: sending.read, admits: stopped.admits };
  }

  private async keptRefused(key: string, refused: ReadonlyMap<string, string>, merged: boolean): Promise<void> {
    const { refused: held, ...copy } = this.copies.get(key) as Copy;
    const kept = { ...(merged ? held : {}), ...Object.fromEntries(refused) };
    await this.save(Object.keys(kept).length === 0 ? copy : { ...copy, refused: kept });
  }

  private async built(copy: Copy, manifest: Manifest, scan: Scan, marked: readonly string[]): Promise<Built> {
    const root = rootOf(copy.room_handle);
    const { present } = scan;
    const { added, changed, gone, adopted } = changeSet(manifest, scan);
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
    const documents = [...added.filter((path) => !arrived.has(path)), ...changed].filter((path) => isDocument(path) && !marked.includes(path)).sort();
    const texts = new Map<string, string>();
    const unsendable = new Map<string, string>();
    if (documents.length > 0) {
      const { bounds } = await this.house.door<Discovery>('rooms/discover', { prefixes: [root] });
      for (const path of documents) {
        const bytes = await readFile(join(copy.repository, present.get(path)!.name));
        if (bytes.length > bounds.max_authored_file_bytes || !isUtf8(bytes) || bytes.includes(0)) unsendable.set(path, markdownOnly(bounds.max_authored_file_bytes));
        else texts.set(path, bytes.toString('utf8'));
      }
    }
    const changes: Change[] = [];
    const read: Record<string, Read> = {};
    for (const path of [...new Set([...added, ...changed, ...gone])].sort()) {
      if (arrived.has(path) || marked.includes(path) || unsendable.has(path)) continue;
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
    return { changes, read, unsendable };
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
        const again = this.follows(copy.key) ? 'Kit sends it again with the next change' : 'run house upload again';
        return { refused: true, text: refusal?.text ?? `House's answer to this upload did not arrive; ${again}` };
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
      if (stopsPush(outcome.refused)) {
        const stopped = { ...(await this.stopped(copy, firstLine(outcome.refused))), refusal: outcome.refused };
        return outcome.admits === undefined ? stopped : { ...stopped, admits: outcome.admits };
      }
      if (outcome.refused.code === 'upload_unavailable' && copy.pending!.upload !== undefined && !restaged) {
        const { upload: _upload, ...unstaged } = copy.pending!;
        return this.settle(await this.save({ ...copy, pending: unstaged }), caller, true);
      }
      const settled = await this.save(without(copy));
      const sent = { refusal: outcome.refused, batch: { changes: copy.pending!.changes, read: copy.pending!.read } };
      if (outcome.refused.code !== 'edit_conflict') return { refused: true, text: outcome.refused.text, ...sent };
      const lines = await this.conflicted(settled, copy.pending!, outcome.refused, caller);
      return { refused: true, text: [outcome.refused.text, ...lines].join('\n'), ...sent, lines };
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

  private async stopped(copy: Copy, reasons: ReadonlyMap<string, string | Changed> | string): Promise<Stopped> {
    const pending = copy.pending!;
    const root = rootOf(copy.room_handle);
    const unchanged = `House holds nothing of this upload yet, so ${root} is unchanged`;
    const followed = this.follows(copy.key);
    const changed = typeof reasons === 'string' ? [] : [...reasons.values()].filter((reason): reason is Changed => reason instanceof Changed);
    if (changed.length > 0) {
      await this.save(without(copy));
      const now = followed ? 'the next save sends the copy as it is now' : 'run house upload again to send the copy as it is now';
      return { refused: true, text: `${unchanged}: ${changed.map((reason) => reason.message).join('; ')}; ${now}` };
    }
    const again = followed ? 'Kit sends it again with the next change, resuming this upload and sending only what it has not sent' : 'house upload again resumes this upload and sends only what it has not sent';
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
    const { present } = await scanned(copy.repository);
    const work = await staging();
    const lines: string[] = [];
    const next = this.nextOf(copy.key);
    const followed = this.follows(copy.key);
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
      const busy = `${named}: changed while it uploaded; ${next} merges it`;
      if (conflict.revision === undefined) {
        delete manifest.files[path];
        lines.push(`${named}: House no longer holds it; ${next} sends it as a new file`);
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
        lines.push(`${named}: conflict markers written; ${followed ? 'the next save sends it once its markers go' : 'resolve them, then run house upload again'}`);
        continue;
      }
      if (change.op === 'upload') {
        const current = await caller.info(named, conflict.revision);
        if (current === null) throw new Error(`House holds no attachment at ${named}`);
        manifest.files[path] = { revision: conflict.revision, sha256: current.sha256, bytes: current.bytes };
        const theirs = JSON.stringify({ path: named, file: join(copy.repository, nameOf(path)) });
        const instead = followed ? '' : `, and house download '${theirs}' brings House's instead`;
        lines.push(`${named}: House holds ${conflict.revision}, a version this copy never held; ${next} replaces it with this file${instead}`);
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
    if (typeof written.content === 'string' && written.cut === undefined) return written.content;
    if (written.content === undefined && sent !== undefined) return sent;
    return this.revisionText(written.path, written.revision!);
  }

  private async integrated(copy: Copy, accepted: Written[]): Promise<Settled> {
    const pending = copy.pending!;
    const root = rootOf(copy.room_handle);
    const into: Integrating = { repository: copy.repository, manifest: await readManifest(copy.repository), work: await staging() };
    const { manifest } = into;
    const answered = new Map(accepted.filter((written) => written.revision !== null && written.proposal === undefined).map((written) => [relative(written.path), written]));
    const proposed = new Map(accepted.flatMap((written) => (written.proposal === undefined ? [] : [[relative(written.path), written] as const])));
    const lines: string[] = [];
    const sent = new Set<string>();
    for (const change of pending.changes) {
      const path = relative(change.path);
      sent.add(path);
      const proposal = proposed.get(path);
      if (proposal !== undefined) {
        lines.push(await this.writtenBack(copy, into.work, manifest, pending.read[path]!, path, proposal));
        continue;
      }
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
      } else if (!(await integratedFile(into, path, read.name, read.sha256, written.revision!, text))) {
        lines.push(`${root}/${path}: changed while it uploaded; House accepted it and local integration is pending, so ${this.nextOf(copy.key)} merges it`);
      }
    }
    const left = await leftIn(copy.repository);
    for (const [path, written] of answered) {
      const entry = manifest.files[path];
      if (sent.has(path) || leaves(left, path) || entry === undefined || entry.revision === written.revision) continue;
      const text = await this.textOf(written, undefined);
      if (!(await integratedFile(into, path, path, entry.sha256, written.revision!, text))) {
        lines.push(`${root}/${path}: changed here, so House's change was not brought; ${this.nextOf(copy.key)} merges it`);
      }
    }
    await writeManifest(copy.repository, into.work, manifest);
    await this.save(without(copy));
    return { refused: false, files: pending.changes.length - proposed.size, lines };
  }

  private async writtenBack(copy: Copy, work: string, manifest: Manifest, read: Read, path: string, written: Written): Promise<string> {
    const { proposal } = written as Written & { proposal: Proposal };
    const answer = proposal.approval === undefined ? 'in their Asks you' : `at ${proposal.approval}`;
    const said = `${rootOf(copy.room_handle)}/${path}: House keeps your change as a proposal, which waits for ${proposal.waits_on} to answer it ${answer}`;
    if (!(await holding(copy.repository, read.name, read.sha256))) return `${said}; it changed here while it uploaded, so ${this.nextOf(copy.key)} proposes it again`;
    if (written.revision === null) {
      await removed(copy.repository, read.name);
      delete manifest.files[path];
      return `${said}; the Room has no instructions, so this copy holds none`;
    }
    const text = await this.textOf(written, undefined);
    await placed(work, join(copy.repository, read.name), text);
    manifest.files[path] = { revision: written.revision, sha256: digest(text), bytes: Buffer.byteLength(text) };
    return `${said}; this copy holds the Room's current instructions again`;
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
