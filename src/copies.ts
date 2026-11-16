import type { KitBinaryChange } from '@agentshouse/kit-wire';
import { HOUSE_ROOM_TYPES, readTypes, type VerifiedModel } from '@agentshouse/mdmodel';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { finalRefusal, HouseRefusal, retrying, type House } from './api.ts';
import {
  eachAtOnce,
  receivedBinary,
  sentBinary,
  sorted,
  sweptTransfers,
  type Described,
  type Staged,
  type StagedUpload,
} from './binaries.ts';
import { chunkEntries, stagedChunks, type Chunk, type Text } from './chunks.ts';
import {
  blobId,
  blobText,
  git,
  HOUSE_REF,
  importCommits,
  type Content,
  type Imported,
  localCopies,
  revision,
  run,
  succeeded,
  tree,
} from './git.ts';
import { fileInfo, paused, type FileInfo, type Finished } from './files.ts';
import { kitHome } from './home.ts';
import { ownAgentCall, rpc, toolAnswer, Unsettled } from './mcp.ts';
import { operationId } from './operation.ts';
import { firstLine, refusalOf, retryable, stopsPush, type Refusal } from './refusals.ts';
import { changed, readDocument, type Edit } from './translate.ts';

const BRANCH = 'main';
const PROVENANCE = '_provenance';
const IDENTITY = { GIT_COMMITTER_NAME: 'Kit', GIT_COMMITTER_EMAIL: 'house-kit@localhost' };
const ROOMS = 'rooms/';
const NOT_READY = 'not ready yet; Kit copies it once House has built it';
const STAGED_CHUNKS = 'house-chunks';
const SCHEMA = 'settings/schema.yaml';

// A Room answered not ready is asked again on this schedule: its chunk build usually catches up within seconds, so the first asks come soon and the last repeats until it does.
const ASKED_AGAIN_MS = [1000, 2000, 3000, 5000, 8000, 11_000, 15_000];

interface Held {
  bytes: number;
  sha256: string;
}

interface Manifest {
  parent: string | null;
  files: Record<string, string | null>;
  binary?: Record<string, Held>;
}

type BinaryPart = Extract<Edit, { op: 'upload' }>;

interface Move {
  worktree: string;
  from: string;
  to: string;
}

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

interface Push {
  state: 'submitted' | 'accepted';
  caller: string;
  operation_id: string;
  commit: string;
  base: string;
  changes: Edit[];
  worktree: string;
  branch: string | null;
  house: string;
  upload?: Upload;
  written?: Written[];
  acknowledged?: string;
  staged?: string[];
}

interface Copy {
  key: string;
  room_ref: string;
  room_handle: string;
  repository: string;
  house: string;
  position: string;
  log_epoch: string;
  write: string[];
  protected: string[];
  read_only: string[];
  manifests: Record<string, Manifest>;
  moves: Move[];
  push?: Push;
  unfollowed?: 'unsaid' | 'said';
}

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

type Change = Text | KitBinaryChange | { path: string; removed: true };

interface Enumerated {
  authority: string;
  position: string;
  log_epoch: string;
  changes: Change[];
  next?: unknown;
}

type Listed =
  | { room_ref: string; ready: false }
  | { room_ref: string; ready: true; position: string; log_epoch: string; chunks: Chunk[]; models: Text[] };

type Entry = Text | KitBinaryChange;

interface Whole {
  position: string;
  log_epoch: string;
  entries: Iterable<Entry> | AsyncIterable<Entry>;
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

interface ReadOnlyFiles {
  remove(path: string): Promise<void>;
  place(path: string, content: string): Promise<void>;
  held(): string[];
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
    changes: Edit[],
    upload: Upload | undefined,
    retain: (upload: Upload) => Promise<void>,
  ): Promise<Submitted>;
  finish(upload: string, room: string, partSha256: string[]): Promise<Finished<Staged>>;
  info(path: string, revision?: string): Promise<FileInfo | null>;
}

export interface Pushed {
  refused: boolean;
  text: string;
}

export interface Observed {
  common: string;
  worktree: string;
  moves: { from: string; to: string }[];
}

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function houseCause(error: unknown): string {
  return error instanceof HouseRefusal ? (refusalOf(error.text)?.text ?? causeOf(error)) : causeOf(error);
}

function logged(error: unknown): void {
  process.stderr.write(`kit: ${causeOf(error)}\n`);
}

const REBASED = new Set([
  'field_base_stale',
  'section_base_stale',
  'preamble_base_stale',
  'base_revision_stale',
  'path_exists',
  'path_absent',
  'base_required',
  'binary_file',
  'text_file',
]);

function rebaseFixes(refusal: Refusal): boolean {
  return refusal.code === 'edit_conflict' && refusal.conflicts.some(({ code }) => REBASED.has(code));
}

function markdownOnly(paths: string[], maxBytes: number): string {
  const [named, them] = paths.length === 1 ? [`${paths[0]} is`, 'it'] : [`${paths.join(', ')} are`, 'them'];
  return `${named} Markdown, which holds text only: UTF-8 without NUL, at most ${maxBytes} bytes; commit ${them} as text and push again`;
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

function heldKey(file: Held): string {
  return `${file.sha256}:${file.bytes}`;
}

function outside(path: string): Pushed {
  return { refused: true, text: `${path} is not a House Local copy; run house push inside one` };
}

function short(commit: string): string {
  return commit.slice(0, 12);
}

function moved(before: Copy, after: Copy): string[] {
  if (before.house !== after.house) return [`${rootOf(after.room_handle)}: ${HOUSE_REF} is at ${short(after.house)}`];
  return before.position === after.position ? [] : [`${rootOf(after.room_handle)}: read-only files refreshed`];
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

function rootOf(handle: string): string {
  return `/rooms/${handle}`;
}

function relative(path: string): string {
  return path.replace(/^\/rooms\/[^/]+\//, '');
}

function declaredWritable(path: string, copy: Scope): boolean {
  const deepest = (scopes: string[]) =>
    Math.max(-1, ...scopes.filter((scope) => covers(path, scope)).map((scope) => scope.length));
  return deepest(copy.write) > deepest(copy.protected);
}

function pattern(path: string): string {
  return `/${path.replace(/[\\*?[]/g, '\\$&').replace(/ +$/, (spaces) => spaces.replace(/ /g, '\\ '))}`;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function removeFile(repository: string, path: string): Promise<void> {
  await rm(join(repository, path), { force: true });
  for (let folder = dirname(path); folder !== '.'; folder = dirname(folder)) {
    if (!(await rmdir(join(repository, folder)).then(() => true, () => false))) return;
  }
}

async function readOnlyFiles(repository: string, held: readonly string[]): Promise<ReadOnlyFiles> {
  const tracked = new Set((await git(repository, ['ls-files', '-z'])).split('\0'));
  const holding = new Set(held);
  return {
    remove: async (path) => {
      if (!holding.has(path)) return;
      if (!tracked.has(path)) await removeFile(repository, path);
      holding.delete(path);
    },
    place: async (path, content) => {
      if (tracked.has(path)) return;
      if (!holding.has(path) && (await exists(join(repository, path)))) return;
      await writeText(join(repository, path), content);
      holding.add(path);
    },
    held: () => [...holding].sort(),
  };
}

async function readOnlyPlaced(
  repository: string,
  held: readonly string[],
  written: ReadonlyMap<string, string>,
  removed: readonly string[],
): Promise<string[]> {
  const files = await readOnlyFiles(repository, held);
  for (const path of removed) await files.remove(path);
  for (const [path, content] of written) await files.place(path, content);
  return files.held();
}

async function importedWhole(
  repository: string,
  scope: Scope,
  entries: Whole['entries'],
  commit: Pick<Imported, 'message' | 'from' | 'replaces'>,
  readOnly: ReadOnlyFiles,
  kept: (entries: readonly KitBinaryChange[]) => Promise<ReadonlyMap<string, string>>,
): Promise<{ house: string; revisions: Record<string, string>; binary: Record<string, Held> }> {
  const revisions: Record<string, string> = {};
  const binary: Record<string, Held> = {};
  async function* tracked(): AsyncGenerator<readonly [string, Content]> {
    const binaries: KitBinaryChange[] = [];
    for await (const entry of entries) {
      if (!('content' in entry)) {
        if (declaredWritable(entry.path, scope)) binaries.push(entry);
        continue;
      }
      const { path, content, revision: held, provenance } = entry;
      if (declaredWritable(path, scope)) {
        revisions[path] = held;
        yield [path, content];
      } else {
        await readOnly.place(path, content);
      }
      if (provenance !== undefined) await readOnly.place(sidecar(path), provenance);
    }
    const blobs = await kept(binaries);
    for (const entry of binaries) {
      const blob = blobs.get(entry.path);
      if (blob === undefined) continue;
      revisions[entry.path] = entry.revision;
      binary[entry.path] = { bytes: entry.bytes, sha256: entry.sha256 };
      yield [entry.path, { blob }];
    }
  }
  return { house: await importCommits(repository, [{ ...commit, files: tracked() }]), revisions, binary };
}

async function ruled(path: string, rules: string): Promise<void> {
  if ((await readFile(path, 'utf8').catch(() => null)) !== rules) await writeFile(path, rules);
}

async function ignoreRules(
  repository: string,
  writable: readonly string[],
  copy: Pick<Copy, 'read_only' | 'protected'>,
): Promise<void> {
  const readOnly = copy.read_only.filter((path) => !path.split('/').includes(PROVENANCE));
  const protectedPath = (path: string) => copy.protected.some((prefix) => prefix !== '' && covers(path, prefix));
  const whole = copy.protected.filter((prefix) => prefix !== '' && !writable.some((path) => covers(path, prefix)));
  const house = [
    ...whole,
    ...readOnly.filter((path) => protectedPath(path) && !whole.some((prefix) => covers(path, prefix))),
  ].map(pattern);
  const granted = readOnly.filter((path) => !protectedPath(path)).map(pattern);
  await ruled(
    join(repository, '.gitignore'),
    [
      '# Kit writes this file and .ignore. The paths below are read-only House',
      '# content: Git does not track them, and House refuses a change to them even',
      '# when this file is edited or a path is force-added.',
      '/.gitignore',
      '/.ignore',
      PROVENANCE,
      '',
      '# House maintains or protects these paths.',
      ...house,
      '',
      '# Your current House grant does not allow writing these paths.',
      ...granted,
      '',
    ].join('\n'),
  );
  await ruled(
    join(repository, '.ignore'),
    [
      '# Kit writes this file so native search still reads the read-only House',
      '# content that .gitignore keeps out of Git.',
      `!${PROVENANCE}`,
      ...[...house, ...granted].map((rule) => `!${rule}`),
      '',
    ].join('\n'),
  );
}

async function modelOf(copy: Copy, files: ReadonlyMap<string, string>): Promise<VerifiedModel> {
  const entry = files.get(SCHEMA);
  if (entry !== undefined) return readTypes(await blobText(copy.repository, entry), HOUSE_ROOM_TYPES);
  return readTypes(copy.read_only.includes(SCHEMA) ? await readFile(join(copy.repository, SCHEMA), 'utf8') : '', HOUSE_ROOM_TYPES);
}

function entryAt(copy: Copy, commit: string, path: string): { revision: string; held?: Held } | undefined {
  let manifest: Manifest | undefined = copy.manifests[commit];
  while (manifest !== undefined) {
    if (path in manifest.files) {
      const revision = manifest.files[path];
      if (revision === null || revision === undefined) return undefined;
      const held = manifest.binary?.[path];
      return held === undefined ? { revision } : { revision, held };
    }
    manifest = manifest.parent === null ? undefined : copy.manifests[manifest.parent];
  }
  return undefined;
}

function revisionAt(copy: Copy, commit: string, path: string): string | undefined {
  return entryAt(copy, commit, path)?.revision;
}

function heldAt(copy: Copy, commit: string, path: string): Held | undefined {
  return entryAt(copy, commit, path)?.held;
}

function manifest(parent: string | null, files: Record<string, string | null>, binary: Record<string, Held>): Manifest {
  return Object.keys(binary).length === 0 ? { parent, files } : { parent, files, binary };
}

function binaryParts(changes: readonly Edit[]): BinaryPart[] {
  return changes.filter((change): change is BinaryPart => change.op === 'upload');
}

function pushedBinary(copy: Copy, push: Push): Map<string, Held> {
  const sent = new Map<string, Held>();
  for (const change of push.changes) {
    if (change.op === 'upload') sent.set(relative(change.path), { bytes: change.bytes, sha256: change.sha256 });
    else if (change.op === 'rename') {
      const held = heldAt(copy, push.base, relative(change.path));
      if (held !== undefined) sent.set(relative(change.to), held);
    }
  }
  return sent;
}

async function writtenAt(copy: Copy, house: ReadonlyMap<string, string>, path: string): Promise<Written> {
  const named = `${rootOf(copy.room_handle)}/${path}`;
  const entry = house.get(path);
  if (entry === undefined) return { path: named, revision: null, content: null };
  const revision = revisionAt(copy, copy.house, path) ?? null;
  return heldAt(copy, copy.house, path) === undefined
    ? { path: named, revision, content: await blobText(copy.repository, entry) }
    : { path: named, revision };
}

function without(copy: Copy): Copy {
  const { push, ...settled } = copy;
  return settled;
}

export function changedPaths(changes: readonly Edit[]): string[] {
  return [
    ...new Set(changes.flatMap((change) => (change.op === 'rename' ? [change.path, change.to] : [change.path]))),
  ].sort();
}

function movedPaths(moves: readonly Move[], before: Map<string, string>, after: Map<string, string>): Map<string, string> {
  const pairs = moves.filter(
    ({ from, to }) => before.has(from) && !after.has(from) && after.has(to) && !before.has(to),
  );
  return new Map(
    pairs
      .filter((pair) => pairs.filter((other) => other.from === pair.from || other.to === pair.to).length === 1)
      .map(({ from, to }) => [from, to]),
  );
}

function sameBytesMoved(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  held: (path: string) => Held | undefined,
  binary: ReadonlyMap<string, Described>,
  intended: ReadonlyMap<string, string>,
): Map<string, string> {
  const arriving = new Set(intended.values());
  const leaving = new Map<string, string[]>();
  const added = new Map<string, string[]>();
  const listed = (paths: Map<string, string[]>, file: Held, path: string) => {
    paths.set(heldKey(file), [...(paths.get(heldKey(file)) ?? []), path]);
  };
  for (const [path, entry] of before) {
    const file = held(path);
    if (file !== undefined && !intended.has(path) && !binary.has(path) && after.get(path) !== entry) listed(leaving, file, path);
  }
  for (const [path, file] of binary) {
    if (!arriving.has(path) && held(path) === undefined) listed(added, file, path);
  }
  const moved = new Map<string, string>();
  for (const [key, [from, ...others]] of leaving) {
    const [to, ...more] = added.get(key) ?? [];
    if (others.length === 0 && more.length === 0 && to !== undefined && !after.has(from!) && !before.has(to)) moved.set(from!, to);
  }
  return moved;
}

export class LocalCopies {
  readonly owner: Caller;
  private readonly house: House;
  private readonly copies = new Map<string, Copy>();
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
            stopping(house.door<{ contents: Written[] }>('files/batch', { operation_id: operation, changes })),
          );
          return 'refused' in outcome ? outcome : { accepted: outcome.contents };
        } catch (error) {
          if (!finalRefusal(error)) throw error;
          return {
            refused: refusalOf(error.text) ?? { code: '', text: `House refused it with ${error.status}`, conflicts: [], detail: {} },
          };
        }
      },
      finish: async (upload, _room, partSha256) => {
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
      const copy = JSON.parse(text) as Copy;
      this.copies.set(copy.key, copy);
    }
  }

  async swept(): Promise<void> {
    const rooms = join(localCopies(), 'rooms');
    for (const name of await readdir(rooms).catch(() => [])) {
      if (name.startsWith(stagingPrefix())) await rm(join(rooms, name), { recursive: true, force: true });
    }
    for (const copy of this.copies.values()) await sweptTransfers(copy.repository);
  }

  connected(): Promise<void> {
    return this.selected();
  }

  fetch(caller: Caller): Promise<Pushed> {
    return this.answered(() => this.fetched(true, caller));
  }

  private async selected(): Promise<void> {
    const copied = await this.answered(() => this.fetched(false, this.owner));
    if (copied.refused) logged(copied.text);
  }

  private answered<T>(work: () => Promise<T>): Promise<T> {
    const answered = this.answering.then(work);
    this.answering = answered.catch(() => undefined);
    return answered;
  }

  private async fetched(refreshing: boolean, caller: Caller): Promise<Pushed> {
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
      const current: Copy[] = [];
      const wanted = new Map<string, string>();
      for (const [key, handle] of synced) {
        try {
          const held = this.copies.get(key);
          if (held === undefined || !(await exists(held.repository))) {
            wanted.set(key, handle);
            continue;
          }
          const { unfollowed, ...followed } = held;
          current.push(
            unfollowed === undefined && held.room_handle === handle ? held : await this.save({ ...followed, room_handle: handle }),
          );
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
            said.push(await this.copied({ key, handle, authority }));
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
        const failed = await this.refreshed(reading, unready, caller).then(() => null, houseCause);
        for (const copy of reading) {
          said.push(...(unready.includes(copy.room_ref) ? [`${rootOf(copy.room_handle)}: ${NOT_READY}`] : moved(copy, this.copies.get(copy.key)!)));
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

  private async askedAgain(rooms: readonly string[]): Promise<void> {
    let asking = rooms;
    for (let step = 0; asking.length > 0; step++) {
      await paused(ASKED_AGAIN_MS[Math.min(step, ASKED_AGAIN_MS.length - 1)]!);
      await this.selected().catch(logged);
      asking = asking.filter((room) => this.waiting.has(room));
    }
  }

  async observed(report: Observed): Promise<void> {
    const key = await this.keyAt(dirname(report.common));
    if (key === undefined) return;
    await this.exclusive(key, async () => {
      const copy = this.copies.get(key)!;
      let moves = copy.moves;
      for (const { from, to } of report.moves) {
        const held = moves.find((move) => move.worktree === report.worktree && move.to === from);
        moves = moves.filter((move) => move !== held);
        if (held === undefined) moves.push({ worktree: report.worktree, from, to });
        else if (held.from !== to) moves.push({ ...held, to });
      }
      if (moves.some((move) => move.worktree === report.worktree)) {
        const index = new Set((await git(report.worktree, ['ls-files', '-z'])).split('\0'));
        const head = await tree(report.worktree, 'HEAD').catch(() => new Map<string, string>());
        const live = ({ from, to }: Move) =>
          (index.has(to) && !index.has(from)) || (head.has(to) && !head.has(from));
        moves = moves.filter((move) => move.worktree !== report.worktree || live(move));
      }
      if (JSON.stringify(moves) !== JSON.stringify(copy.moves)) await this.save({ ...copy, moves });
    });
  }

  async push(cwd: string, selector: string, caller: Caller): Promise<Pushed> {
    const located = await run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']);
    if (located.status !== 0) return outside(cwd);
    const [common, worktree] = located.stdout.toString('utf8').split('\n') as [string, string];
    const key = await this.keyAt(dirname(common));
    if (key === undefined) return outside(worktree);
    return this.exclusive(key, () => this.pushed(key, worktree, selector, caller));
  }

  private async keyAt(repository: string): Promise<string | undefined> {
    const real = await realpath(repository).catch(() => repository);
    for (const copy of this.copies.values()) {
      if ((await realpath(copy.repository).catch(() => copy.repository)) === real) return copy.key;
    }
    return undefined;
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

  private async save(copy: Copy): Promise<Copy> {
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

  private async materialized({ key, handle, authority }: Wanted, whole: (staging: string) => Promise<Whole>): Promise<Copy> {
    const repository = join(localCopies(), 'rooms', authority.room_ref);
    if (await exists(repository)) throw new Error(`${repository} already exists and Kit leaves it as it is`);
    const staging = join(dirname(repository), `${stagingPrefix()}${randomUUID()}`);
    const scope = { write: authority.operations.write, protected: authority.protected_paths };
    await mkdir(staging, { recursive: true });
    let copy: Copy;
    try {
      await git(staging, ['init', '-q', '-b', BRANCH]);
      await git(staging, ['config', 'core.precomposeUnicode', 'true']);
      const read = await whole(join(staging, '.git', STAGED_CHUNKS));
      const readOnly = await readOnlyFiles(staging, []);
      const commit = { message: `House ${rootOf(handle)}`, from: null };
      const { house, revisions } = await importedWhole(staging, scope, read.entries, commit, readOnly, async () => new Map());
      await git(staging, ['update-ref', `refs/heads/${BRANCH}`, house]);
      await git(staging, ['reset', '-q', '--hard']);
      copy = {
        key,
        room_ref: authority.room_ref,
        room_handle: handle,
        repository,
        house,
        position: read.position,
        log_epoch: read.log_epoch,
        ...scope,
        read_only: readOnly.held(),
        manifests: { [house]: { parent: null, files: revisions } },
        moves: [],
      };
      await ignoreRules(staging, Object.keys(revisions), copy);
      await rm(join(staging, '.git', STAGED_CHUNKS), { recursive: true, force: true });
      await rename(staging, repository);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    return this.save(copy);
  }

  private async copied(wanted: Wanted): Promise<string> {
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
      const entries = view.changes.filter((change): change is Text => 'content' in change);
      const copy = await this.materialized(wanted, async () => ({ position: view.position, log_epoch: view.log_epoch, entries }));
      return `${root}: copied to ${copy.repository}`;
    }
    const copy = await this.materialized(wanted, (directory) => this.chunked(root, authority.room_ref, directory));
    const [caught] = await this.caughtUp([copy], true, this.owner);
    await succeeded(copy.repository, ['merge', '--ff-only', '-q', caught!.house]);
    return `${root}: copied to ${copy.repository}`;
  }

  private async received(copy: Copy, authority: Authority, caller: Caller): Promise<Copy> {
    const root = rootOf(copy.room_handle);
    const directory = join(copy.repository, '.git', STAGED_CHUNKS);
    const scope = { write: authority.operations.write, protected: authority.protected_paths };
    try {
      const read = await this.chunked(root, copy.room_ref, directory);
      const readOnly = await readOnlyFiles(copy.repository, copy.read_only);
      for (const path of copy.read_only) await readOnly.remove(path);
      const commit = { message: `House ${root} at position ${read.position}`, from: copy.house, replaces: true };
      const houseTree = await tree(copy.repository, copy.house);
      const pushing = await this.pushing(copy);
      const kept = async (entries: readonly KitBinaryChange[]) => {
        const present = new Set(entries.map((entry) => entry.path));
        const leaving = new Map(
          [...houseTree].flatMap(([path, blob]) => {
            const held = present.has(path) ? undefined : heldAt(copy, copy.house, path);
            return held === undefined ? [] : [[heldKey(held), blob] as const];
          }),
        );
        const blobs = new Map<string, string>();
        for (const entry of entries) {
          const blob = await this.binaryIn(copy, houseTree, entry, pushing, leaving, caller);
          if (blob !== null) blobs.set(entry.path, blob);
        }
        return blobs;
      };
      const { house, revisions, binary } = await importedWhole(copy.repository, scope, read.entries, commit, readOnly, kept);
      const next: Copy = {
        ...copy,
        ...scope,
        house,
        position: read.position,
        log_epoch: read.log_epoch,
        read_only: readOnly.held(),
        manifests: { ...copy.manifests, [house]: manifest(null, revisions, binary) },
      };
      await ignoreRules(copy.repository, Object.keys(revisions), next);
      return next;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async reread(copy: Copy, caller: Caller): Promise<Copy> {
    const { authorities } = await this.discovered([copy.room_handle]);
    const authority = authorities.find((entry) => entry.room_ref === copy.room_ref);
    if (authority === undefined) throw new NotReady([copy.room_ref]);
    return this.received(copy, authority, caller);
  }

  private async refreshed(copies: readonly Copy[], unready: string[], caller: Caller): Promise<void> {
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
          read.push(await this.save(await this.received(copy, authority, caller)));
        } catch (error) {
          if (!(error instanceof NotReady)) throw error;
          unready.push(...error.rooms);
        }
      } else {
        unchanged.push(copy);
      }
    }
    for (const group of grouped(unchanged, bounds.max_prefixes)) await this.caughtUp(group, false, caller, unready);
    for (const group of grouped(read, bounds.max_prefixes)) await this.caughtUp(group, true, caller, unready);
  }

  private async caughtUp(copies: readonly Copy[], whole: boolean, caller: Caller, unready?: string[]): Promise<Copy[]> {
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
          const next = await this.save(await this.reread(expired, caller));
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
        const next = await this.save(await this.incorporated(copy, view.changes, view.position, view.log_epoch, caller));
        caught.set(copy.key, next);
        advanced.push(next);
      }
      asking = advanced.filter((copy) => whole || read.has(copy.key));
    }
    if (unready === undefined && waiting.length > 0) throw new NotReady(waiting);
    return copies.map((copy) => caught.get(copy.key)!);
  }

  private async pushing(copy: Copy): Promise<Map<string, Held & { blob: string }>> {
    const sent = copy.push === undefined ? new Map<string, Held>() : pushedBinary(copy, copy.push);
    if (sent.size === 0) return new Map();
    const commit = await tree(copy.repository, copy.push!.commit);
    return new Map([...sent].map(([path, held]) => [path, { ...held, blob: commit.get(path)! }]));
  }

  private async binaryIn(
    copy: Copy,
    houseTree: ReadonlyMap<string, string>,
    change: KitBinaryChange,
    pushing: ReadonlyMap<string, Held & { blob: string }>,
    leaving: ReadonlyMap<string, string>,
    caller: Caller,
  ): Promise<string | null> {
    const pushed = pushing.get(change.path);
    if (pushed !== undefined && heldKey(pushed) === heldKey(change)) return pushed.blob;
    const moved = leaving.get(heldKey(change));
    const kept = heldAt(copy, copy.house, change.path) ?? pushed;
    if (kept === undefined) return moved ?? null;
    if (heldKey(kept) === heldKey(change)) return houseTree.get(change.path)!;
    return moved ?? this.revisionBlob(copy, change.path, change.revision, caller);
  }

  private revisionBlob(copy: Copy, path: string, revision: string, caller: Caller, first: FileInfo | null = null): Promise<string> {
    const named = `${rootOf(copy.room_handle)}/${path}`;
    let answered = first;
    return receivedBinary(copy.repository, named, async () => {
      const file = answered ?? (await caller.info(named, revision));
      answered = null;
      if (file === null) throw new Error(`House holds no binary file at ${named}`);
      return file;
    });
  }

  private async incorporated(copy: Copy, changes: readonly Change[], position: string, logEpoch: string, caller: Caller): Promise<Copy> {
    const houseTree = await tree(copy.repository, copy.house);
    const held = new Set(copy.read_only);
    const files = new Map<string, Content | null>();
    const revisions: Record<string, string | null> = {};
    const binary: Record<string, Held> = {};
    const written = new Map<string, string>();
    const removed: string[] = [];
    const pushing = await this.pushing(copy);
    const leaving = new Map(
      changes.flatMap((change) => {
        const kept = 'removed' in change ? heldAt(copy, copy.house, change.path) : undefined;
        return kept === undefined ? [] : [[heldKey(kept), houseTree.get(change.path)!] as const];
      }),
    );
    for (const change of changes) {
      if (!('removed' in change) && !('content' in change)) {
        const blob = await this.binaryIn(copy, houseTree, change, pushing, leaving, caller);
        if (blob === null) {
          if (houseTree.has(change.path)) {
            files.set(change.path, null);
            revisions[change.path] = null;
          } else if (held.has(change.path)) removed.push(change.path, sidecar(change.path));
          continue;
        }
        const kept = heldAt(copy, copy.house, change.path);
        const unchanged =
          houseTree.get(change.path) === blob &&
          kept !== undefined &&
          heldKey(kept) === heldKey(change) &&
          revisionAt(copy, copy.house, change.path) === change.revision;
        if (unchanged) continue;
        files.set(change.path, { blob });
        revisions[change.path] = change.revision;
        binary[change.path] = { bytes: change.bytes, sha256: change.sha256 };
        continue;
      }
      const gone = 'removed' in change;
      if (houseTree.has(change.path) || (!gone && !held.has(change.path) && declaredWritable(change.path, copy))) {
        const unchanged = gone
          ? !houseTree.has(change.path)
          : houseTree.get(change.path) === blobId(change.content) &&
            revisionAt(copy, copy.house, change.path) === change.revision;
        if (unchanged) continue;
        files.set(change.path, gone ? null : change.content);
        revisions[change.path] = gone ? null : change.revision;
      } else if (gone) {
        removed.push(change.path, sidecar(change.path));
      } else {
        written.set(change.path, change.content);
        if (change.provenance !== undefined) written.set(sidecar(change.path), change.provenance);
      }
    }
    let { house, manifests } = copy;
    if (files.size > 0) {
      house = await importCommits(copy.repository, [
        { message: `House ${rootOf(copy.room_handle)} at position ${position}`, from: copy.house, files },
      ]);
      manifests = { ...manifests, [house]: manifest(copy.house, revisions, binary) };
    }
    const next: Copy = {
      ...copy,
      house,
      manifests,
      position,
      log_epoch: logEpoch,
      read_only: await readOnlyPlaced(copy.repository, copy.read_only, written, removed),
    };
    await ignoreRules(copy.repository, [...(await tree(copy.repository, house)).keys()], next);
    return next;
  }

  private async pushed(key: string, worktree: string, selector: string, caller: Caller): Promise<Pushed> {
    let copy = this.copies.get(key)!;
    const selected = await run(worktree, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${selector}^{commit}`]);
    if (selected.status !== 0) return { refused: true, text: `${selector} names no commit` };
    const commit = selected.stdout.toString('utf8').trim();
    if (copy.push?.state === 'submitted') {
      if (copy.push.commit === commit) return this.settle(copy, caller);
      const replaced = await this.recovered(copy, caller, async (current) => {
        await this.save(without(current));
        return { refused: false, text: '' };
      });
      if (replaced.refused) return replaced;
      copy = this.copies.get(key)!;
    }
    if (copy.push !== undefined) {
      const held = copy.push.acknowledged;
      if (held === undefined || !(await succeeded(worktree, ['merge-base', '--is-ancestor', held, commit]))) {
        return this.finished(copy, caller);
      }
      copy = await this.save(without(copy));
    }
    const listed = (await git(copy.repository, ['rev-list', '--topo-order', commit])).split('\n');
    const base = listed.find((ancestor) => ancestor in copy.manifests);
    if (base === undefined) {
      return { refused: true, text: `${short(commit)} holds no House state; merge or rebase onto ${HOUSE_REF}` };
    }
    let changes: Edit[];
    try {
      changes = await this.derived(copy, base, commit);
    } catch (error) {
      return { refused: true, text: houseCause(error) };
    }
    if (changes.length === 0) return { refused: false, text: `Nothing to submit: ${short(commit)} matches House.` };
    const branch = await git(worktree, ['symbolic-ref', '-q', 'HEAD']).then(
      (name) => name.trim(),
      () => null,
    );
    const submitted = await this.save({
      ...copy,
      push: {
        state: 'submitted',
        caller: caller.key,
        operation_id: operationId(),
        commit,
        base,
        changes,
        worktree,
        branch,
        house: copy.house,
      },
    });
    return this.settle(submitted, caller);
  }

  private async binaryFiles(copy: Copy, arriving: readonly (readonly [string, string])[]): Promise<Map<string, Described>> {
    if (arriving.length === 0) return new Map();
    const { bounds } = await this.house.door<Discovery>('rooms/discover', { prefixes: [rootOf(copy.room_handle)] });
    const { binary, markdown } = await sorted(copy.repository, arriving, bounds.max_authored_file_bytes);
    if (markdown.length > 0) throw new Error(markdownOnly(markdown, bounds.max_authored_file_bytes));
    return binary;
  }

  private async derived(copy: Copy, base: string, commit: string): Promise<Edit[]> {
    const root = rootOf(copy.room_handle);
    const before = await tree(copy.repository, base);
    const after = await tree(copy.repository, commit);
    const binary = await this.binaryFiles(
      copy,
      [...after].filter(([path, entry]) => before.get(path) !== entry),
    );
    const held = (path: string) => heldAt(copy, base, path);
    const heldBinary = (path: string) => held(path) !== undefined;
    const intended = new Map(
      [...movedPaths(copy.moves, before, after)].filter(([from, to]) => heldBinary(from) === binary.has(to)),
    );
    const moved = new Map([...intended, ...sameBytesMoved(before, after, held, binary, intended)]);
    const arrived = new Set(moved.values());
    const text = (entry: string) => blobText(copy.repository, entry);
    const created = async (path: string, entry: string): Promise<Edit> => {
      const part = binary.get(path);
      return part === undefined
        ? { op: 'create', path: `${root}/${path}`, content: await text(entry) }
        : { op: 'upload', path: `${root}/${path}`, ...part };
    };
    const model = await modelOf(copy, after);
    const changes: Edit[] = [];
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      if (arrived.has(path)) continue;
      const prior = before.get(path);
      const next = after.get(path);
      const known = revisionAt(copy, base, path);
      const to = moved.get(path);
      if (to !== undefined) {
        changes.push({ op: 'rename', path: `${root}/${path}`, to: `${root}/${to}`, base: known });
        const moving = after.get(to)!;
        const part = binary.get(to);
        if (moving !== prior) {
          changes.push(
            part === undefined
              ? { op: 'replace', path: `${root}/${to}`, base: known, content: await text(moving) }
              : { op: 'upload', path: `${root}/${to}`, base: known, ...part },
          );
        }
        continue;
      }
      if (prior === next) continue;
      const part = binary.get(path);
      if (next === undefined) changes.push({ op: 'remove', path: `${root}/${path}`, base: known });
      else if (prior === undefined) changes.push(await created(path, next));
      else if (heldBinary(path) !== (part !== undefined)) {
        changes.push({ op: 'remove', path: `${root}/${path}`, base: known }, await created(path, next));
      } else if (part !== undefined) changes.push({ op: 'upload', path: `${root}/${path}`, base: known, ...part });
      else changes.push(...changed(`${root}/${path}`, path, known, await text(prior), await text(next), model));
    }
    return changes;
  }

  private async settle(start: Copy, caller: Caller, restaged = false): Promise<Pushed> {
    let copy = start;
    if (copy.push!.caller !== caller.key) {
      return this.recovered(copy, caller, async (current) =>
        this.settle(await this.save({ ...current, push: { ...current.push!, caller: caller.key } }), caller),
      );
    }
    const finished = new Set<string>();
    let outcome: Submitted;
    for (;;) {
      const push = copy.push!;
      try {
        outcome = await caller.submit(push.operation_id, push.changes, push.upload, async (upload) => {
          copy = await this.save({ ...copy, push: { ...copy.push!, upload } });
        });
      } catch (error) {
        const refusal = error instanceof HouseRefusal ? refusalOf(error.text) : null;
        return {
          refused: true,
          text: refusal?.text ?? `House's answer to ${short(push.commit)} did not arrive; run house push again`,
        };
      }
      if (!('refused' in outcome) || outcome.refused.code !== 'files_unstaged') break;
      const named = unstagedUploads(outcome.refused).filter(({ id }) => !finished.has(id));
      if (named.length === 0) break;
      for (const { id } of named) finished.add(id);
      const failed = await this.sentUploads(copy, named, caller);
      copy = this.copies.get(copy.key)!;
      if (failed.size > 0) return this.stopped(copy, failed);
    }
    if ('refused' in outcome) {
      if (stopsPush(outcome.refused)) return this.stopped(copy, firstLine(outcome.refused));
      if (outcome.refused.code === 'upload_unavailable' && copy.push!.upload !== undefined && !restaged) {
        const { upload, ...unstaged } = copy.push!;
        return this.settle(await this.save({ ...copy, push: unstaged }), caller, true);
      }
      if (outcome.refused.code === 'expired') {
        return this.recovered(copy, caller, async (current) => {
          await this.save(without(current));
          return { refused: true, text: `House does not hold ${short(current.push!.commit)}; run house push again` };
        });
      }
      let settled = await this.save(without(copy));
      if (settled.unfollowed !== undefined) return { refused: true, text: outcome.refused.text };
      const rebased = rebaseFixes(outcome.refused);
      try {
        settled = (await this.caughtUp([settled], true, caller))[0]!;
        await this.save(await this.conflicted(settled, outcome.refused, copy.push!, caller));
      } catch (error) {
        return {
          refused: true,
          text: rebased ? `${outcome.refused.text}\nHouse's current state did not arrive: ${houseCause(error)}` : outcome.refused.text,
        };
      }
      return {
        refused: true,
        text: rebased
          ? `${outcome.refused.text}\n${HOUSE_REF} holds House's current state; rebase onto it and push again`
          : outcome.refused.text,
      };
    }
    return this.finished(await this.save({ ...copy, push: { ...copy.push!, state: 'accepted', written: outcome.accepted } }), caller);
  }

  private async sentUploads(start: Copy, named: readonly StagedUpload[], caller: Caller): Promise<Map<string, string>> {
    let copy = start;
    const parts = new Map(binaryParts(copy.push!.changes).map((part) => [part.sha256, part]));
    const commit = await tree(copy.repository, copy.push!.commit);
    const staged = new Set(copy.push!.staged ?? []);
    const failed = new Map<string, string>();
    let saving = Promise.resolve();
    await eachAtOnce(named, async (upload) => {
      const part = parts.get(upload.sha256)!;
      const path = relative(part.path);
      try {
        await sentBinary(copy.repository, commit.get(path)!, path, part, upload, (id, partSha256) =>
          caller.finish(id, copy.room_ref, partSha256),
        );
      } catch (error) {
        failed.set(upload.sha256, `its transfer failed: ${causeOf(error)}`);
        return;
      }
      staged.add(upload.sha256);
      saving = saving.then(async () => {
        copy = await this.save({ ...copy, push: { ...copy.push!, staged: [...staged] } });
      });
      await saving;
    });
    return failed;
  }

  private stopped(copy: Copy, reasons: ReadonlyMap<string, string> | string): Pushed {
    const push = copy.push!;
    const staged = new Set(push.staged ?? []);
    const unsent = binaryParts(push.changes).filter(({ sha256 }) => !staged.has(sha256));
    const unchanged = `House holds nothing of ${short(push.commit)} yet, so ${rootOf(copy.room_handle)} is unchanged`;
    const again = 'house push again resumes this push and sends only what it has not sent';
    if (typeof reasons === 'string' && unsent.length === 0) return { refused: true, text: `${unchanged}: ${reasons}\n${again}` };
    const why = (sha256: string) => (typeof reasons === 'string' ? reasons : (reasons.get(sha256) ?? 'not sent yet'));
    return {
      refused: true,
      text: [`${unchanged}; these binary files are not sent:`, ...unsent.map(({ path, sha256 }) => `${relative(path)}: ${why(sha256)}`), again].join(
        '\n',
      ),
    };
  }

  private async conflicted(copy: Copy, refusal: Refusal, push: Push, caller: Caller): Promise<Copy> {
    const root = rootOf(copy.room_handle);
    const touched = new Set(changedPaths(push.changes));
    const houseTree = await tree(copy.repository, copy.house);
    const paths = [
      ...new Set(refusal.conflicts.filter(({ code, path }) => code !== 'path_absent' && touched.has(path)).map(({ path }) => relative(path))),
    ].filter((path) => !houseTree.has(path));
    const files = new Map<string, Content>();
    const revisions: Record<string, string> = {};
    const binary: Record<string, Held> = {};
    for (const path of paths) {
      const file = await caller.info(`${root}/${path}`);
      if (file === null) continue;
      files.set(path, { blob: await this.revisionBlob(copy, path, file.revision, caller, file) });
      revisions[path] = file.revision;
      binary[path] = { bytes: file.bytes, sha256: file.sha256 };
    }
    if (files.size === 0) return copy;
    const house = await importCommits(copy.repository, [
      { message: `House ${root}: the binary files ${short(push.commit)} conflicts with`, from: copy.house, files },
    ]);
    return { ...copy, house, manifests: { ...copy.manifests, [house]: manifest(copy.house, revisions, binary) } };
  }

  private async recovered(copy: Copy, caller: Caller, unheld: (current: Copy) => Promise<Pushed>): Promise<Pushed> {
    const push = copy.push!;
    const current = (await this.caughtUp([copy], true, caller))[0]!;
    const house = await tree(copy.repository, current.house);
    const model = await modelOf(current, house);
    if (!(await this.landed(copy.repository, push.changes, house, await tree(copy.repository, push.commit), model))) {
      return unheld(current);
    }
    const written: Written[] = [];
    for (const path of changedPaths(push.changes).map(relative)) written.push(await writtenAt(current, house, path));
    return this.finished(await this.save({ ...current, push: { ...push, state: 'accepted', written } }), caller);
  }

  private async finished(start: Copy, caller: Caller): Promise<Pushed> {
    let copy = start;
    const { commit } = copy.push!;
    try {
      if (copy.push!.acknowledged === undefined) copy = await this.save(await this.acknowledged(copy, caller));
      const integrated = await this.integrated(copy.push!);
      if (integrated.done) await this.save(without(copy));
      return { refused: false, text: integrated.text };
    } catch {
      return {
        refused: false,
        text: `House accepted ${short(commit)}; run house push again to finish integrating it here`,
      };
    }
  }

  private async acknowledged(start: Copy, caller: Caller): Promise<Copy> {
    let copy = start;
    const push = copy.push!;
    let written = push.written!;
    const read = push.changes.some((change) => change.op === 'rename');
    if (read) {
      copy = (await this.caughtUp([copy], true, caller))[0]!;
      const house = await tree(copy.repository, copy.house);
      const sent = await tree(copy.repository, push.house);
      const unread = push.changes.some(
        (change) =>
          change.op === 'rename' &&
          house.get(relative(change.path)) === sent.get(relative(change.path)) &&
          !house.has(relative(change.to)),
      );
      if (unread) throw new Error(`House's result for ${short(push.commit)} is not readable yet`);
      const known = new Set(written.map((entry) => relative(entry.path)));
      for (const path of new Set([...sent.keys(), ...house.keys()])) {
        if (!known.has(path) && sent.get(path) !== house.get(path)) written = [...written, await writtenAt(copy, house, path)];
      }
    }
    const selected = await tree(copy.repository, push.commit);
    const houseTree = await tree(copy.repository, copy.house);
    const parts = pushedBinary(copy, push);
    const files = new Map<string, Content | null>();
    const revisions: Record<string, string | null> = {};
    const binary: Record<string, Held> = {};
    const settled = new Map<string, Written>();
    for (const entry of written) {
      const path = relative(entry.path);
      if (entry.revision !== null || !settled.has(path)) settled.set(path, entry);
    }
    for (const [path, entry] of settled) {
      if (!selected.has(path) && !houseTree.has(path) && !declaredWritable(path, copy)) continue;
      revisions[path] = entry.revision;
      const part = parts.get(path);
      const kept = heldAt(copy, copy.house, path);
      if (entry.revision === null) files.set(path, null);
      else if (part !== undefined) {
        files.set(path, { blob: selected.get(path)! });
        binary[path] = part;
      } else if (kept !== undefined && revisionAt(copy, copy.house, path) === entry.revision) {
        files.set(path, { blob: houseTree.get(path)! });
        binary[path] = kept;
      } else files.set(path, entry.content ?? (await this.revisionText(entry.path, entry.revision)));
    }
    const edits = new Map(
      [...files].filter(([path, content]) => (content === null ? selected.has(path) : selected.get(path) !== blobId(content))),
    );
    const received = read
      ? []
      : [...files.keys()].filter((path) => revisionAt(copy, copy.house, path) === revisionAt(copy, push.house, path));
    const accepted = `House ${rootOf(copy.room_handle)} with ${push.commit} accepted`;
    const house = await importCommits(copy.repository, [
      ...(edits.size === 0 ? [] : [{ message: accepted, from: push.commit, files: edits }]),
      {
        message: accepted,
        from: copy.house,
        merge: edits.size === 0 ? push.commit : ':1',
        files: new Map(received.map((path) => [path, files.get(path)!])),
      },
    ]);
    const acknowledged = edits.size === 0 ? push.commit : await revision(copy.repository, `${house}^2`);
    const after = await tree(copy.repository, house);
    return {
      ...copy,
      house,
      manifests: {
        ...copy.manifests,
        [acknowledged]: manifest(push.base, revisions, binary),
        [house]: manifest(
          copy.house,
          Object.fromEntries(received.map((path) => [path, revisions[path] ?? null])),
          Object.fromEntries(received.flatMap((path) => (binary[path] === undefined ? [] : [[path, binary[path]]]))),
        ),
      },
      moves: copy.moves.filter(({ from, to }) => !(after.has(to) && !after.has(from))),
      push: { ...push, acknowledged },
    };
  }

  private async landed(
    repository: string,
    changes: readonly Edit[],
    house: Map<string, string>,
    selected: Map<string, string>,
    model: VerifiedModel,
  ): Promise<boolean> {
    const created = new Set(changes.flatMap((change) => (change.op === 'create' || change.op === 'upload' ? [change.path] : [])));
    for (const change of changes) {
      const path = relative(change.path);
      if (change.op === 'upload') {
        if (house.get(path) === selected.get(path)) continue;
        return false;
      }
      if (change.op === 'remove') {
        if (created.has(change.path) || !house.has(path)) continue;
        return false;
      }
      if (change.op === 'rename') {
        if (!house.has(path) && house.get(relative(change.to)) === selected.get(relative(change.to))) continue;
        return false;
      }
      const entry = house.get(path);
      const current = entry === undefined ? undefined : await blobText(repository, entry);
      if ((change.op === 'create' || change.op === 'replace') && current === change.content) continue;
      const document = current === undefined ? undefined : readDocument(current, path, model)?.document;
      if (document === undefined) return false;
      if (change.op === 'set_field' && JSON.stringify(document.fields[change.field]) === JSON.stringify(change.value)) continue;
      if (change.op === 'replace_section' && document.sections[change.section] === change.content) continue;
      if (change.op === 'replace_preamble' && document.preamble === change.content) continue;
      return false;
    }
    return true;
  }

  private async revisionText(path: string, wanted: string): Promise<string> {
    const page = await this.house.door<{ revisions: { revision: string; content?: string }[] }>('files/revisions/list', {
      path,
      revision: wanted,
    });
    const content = page.revisions.find((entry) => entry.revision === wanted)?.content;
    if (content === undefined) throw new Error(`House's result for ${path} is not readable yet`);
    return content;
  }

  private async integrated(push: Push): Promise<{ done: boolean; text: string }> {
    const { commit, worktree, branch } = push;
    const acknowledged = push.acknowledged!;
    const accepted = `House accepted ${short(commit)}`;
    if (acknowledged === commit) return { done: true, text: `${accepted}.` };
    const pending = (reason: string) => ({
      done: false,
      text: `${accepted}; local integration is pending (${reason}): ${acknowledged} holds House's result.`,
    });
    const head = await git(worktree, ['symbolic-ref', '-q', 'HEAD']).then(
      (name) => name.trim(),
      () => null,
    );
    if (branch === null || head !== branch) return pending('the branch changed');
    const tip = await revision(worktree, 'HEAD');
    const name = branch.replace(/^refs\/heads\//, '');
    if (await succeeded(worktree, ['merge-base', '--is-ancestor', acknowledged, tip])) {
      return { done: true, text: `${accepted}; ${name} holds it.` };
    }
    if (!(await succeeded(worktree, ['merge-base', '--is-ancestor', commit, tip]))) return pending('the branch changed');
    if ((await git(worktree, ['status', '--porcelain', '--untracked-files=no'])).trim() !== '') {
      return pending('uncommitted changes');
    }
    if (tip === commit) {
      if (!(await succeeded(worktree, ['merge', '--ff-only', '-q', acknowledged]))) return pending('a conflict');
    } else if (!(await succeeded(worktree, ['rebase', '-q', '--onto', acknowledged, commit], IDENTITY))) {
      await succeeded(worktree, ['rebase', '--abort']);
      return pending('a conflict');
    }
    return { done: true, text: `${accepted}; ${name} is at ${short(await revision(worktree, 'HEAD'))}.` };
  }
}
