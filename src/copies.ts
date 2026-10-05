import { parse } from '@agentshouse/mdmodel';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HouseRefusal, type House } from './api.ts';
import {
  blobId,
  blobText,
  git,
  HOUSE_REF,
  importCommits,
  revision,
  run,
  succeeded,
  tree,
  workingCopies,
} from './git.ts';
import { kitHome } from './home.ts';
import { operationId } from './operation.ts';
import { refusalOf, type Refusal } from './refusals.ts';
import { changed, type Edit } from './translate.ts';

const BRANCH = 'main';
const ROOM_HOMES = ['capture', 'library', 'collaboration'];
const PROVENANCE = '_provenance';
const REPLICA_RETRY_MS = 30_000;
const IDENTITY = { GIT_COMMITTER_NAME: 'House Kit', GIT_COMMITTER_EMAIL: 'house-kit@localhost' };

interface Selected {
  key: string;
  private: boolean;
  handle: string | null;
}

interface Manifest {
  parent: string | null;
  files: Record<string, string | null>;
}

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
}

interface Copy {
  key: string;
  private: boolean;
  room_ref: string;
  room_handle: string | null;
  repository: string;
  active: boolean;
  house: string;
  position: string;
  log_epoch: string;
  write: string[];
  protected: string[];
  read_only: string[];
  manifests: Record<string, Manifest>;
  moves: Move[];
  push?: Push;
}

interface Authority {
  room_ref: string;
  managed_replication: string;
  protected_paths: string[];
  operations: { write: string[] };
  position: string;
  log_epoch: string;
}

interface Bundle {
  scopes: {
    manifest: {
      anchor: string;
      position: string;
      log_epoch: string;
      files: { path: string; revision: string; writable: boolean; provenance?: string }[];
    };
    contents: { path: string; content: string }[];
  }[];
}

type Change = { path: string; content: string; revision: string; provenance?: string } | { path: string; removed: true };

interface Read {
  anchor: string;
  position: string;
  log_epoch: string;
  write: string[];
  protected: string[];
  writable: Map<string, string>;
  revisions: Record<string, string>;
  readOnly: Map<string, string>;
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
]);

function rebaseFixes(refusal: Refusal): boolean {
  return refusal.code === 'edit_conflict' && refusal.conflicts.some((code) => REBASED.has(code));
}

function short(commit: string): string {
  return commit.slice(0, 12);
}

function covers(path: string, prefix: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
}

function sidecar(path: string): string {
  const segments = path.split('/');
  segments.splice(-1, 0, PROVENANCE);
  return segments.join('/');
}

function rootOf(copy: { private: boolean; room_handle: string | null }): string {
  return copy.private ? '/private' : `/rooms/${copy.room_handle}`;
}

function relative(path: string): string {
  return path.replace(/^\/private\//, '').replace(/^\/rooms\/[^/]+\//, '');
}

function prefixesOf(selected: { private: boolean; room_handle: string | null }): string[] {
  return selected.private ? ['/private'] : ROOM_HOMES.map((home) => `${rootOf(selected)}/${home}`);
}

function declaredWritable(path: string, copy: { write: string[]; protected: string[] }): boolean {
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

async function readOnlyPlaced(
  repository: string,
  held: readonly string[],
  written: ReadonlyMap<string, string>,
  removed: readonly string[],
): Promise<string[]> {
  const tracked = new Set((await git(repository, ['ls-files', '-z'])).split('\0'));
  const holding = new Set(held);
  for (const path of removed) {
    if (!holding.has(path)) continue;
    if (!tracked.has(path)) await removeFile(repository, path);
    holding.delete(path);
  }
  for (const [path, content] of written) {
    if (tracked.has(path)) continue;
    if (!holding.has(path) && (await exists(join(repository, path)))) continue;
    await writeText(join(repository, path), content);
    holding.add(path);
  }
  return [...holding].sort();
}

async function ruled(path: string, rules: string): Promise<void> {
  if ((await readFile(path, 'utf8').catch(() => null)) !== rules) await writeFile(path, rules);
}

async function ignoreRules(repository: string, writable: readonly string[], copy: Copy | Read): Promise<void> {
  const readOnly = ('read_only' in copy ? copy.read_only : [...copy.readOnly.keys()]).filter(
    (path) => !path.split('/').includes(PROVENANCE),
  );
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
      '# House Kit writes this file and .ignore. The paths below are read-only House',
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
      '# House Kit writes this file so native search still reads the read-only House',
      '# content that .gitignore keeps out of Git.',
      `!${PROVENANCE}`,
      ...[...house, ...granted].map((rule) => `!${rule}`),
      '',
    ].join('\n'),
  );
}

function revisionAt(copy: Copy, commit: string, path: string): string | undefined {
  let manifest: Manifest | undefined = copy.manifests[commit];
  while (manifest !== undefined) {
    if (path in manifest.files) return manifest.files[path] ?? undefined;
    manifest = manifest.parent === null ? undefined : copy.manifests[manifest.parent];
  }
  return undefined;
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

export class WorkingCopies {
  readonly owner: Caller;
  private readonly house: House;
  private readonly copies = new Map<string, Copy>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly delivering = new Set<string>();
  private selecting: Promise<unknown> = Promise.resolve();

  constructor(house: House) {
    this.house = house;
    this.owner = {
      key: 'owner',
      submit: async (operation, changes) => {
        try {
          const outcome = await house.post<{ contents: Written[] }>('/kit/door/batch', { operation_id: operation, changes });
          return { accepted: outcome.contents };
        } catch (error) {
          if (!(error instanceof HouseRefusal) || error.status >= 500) throw error;
          return {
            refused: refusalOf(error.text) ?? { code: '', text: `House refused it with ${error.status}`, conflicts: [] },
          };
        }
      },
    };
  }

  async load(): Promise<void> {
    const home = join(kitHome(), 'working-copies');
    const names = (await readdir(join(home, 'rooms')).catch(() => [])).filter((name) => name.endsWith('.json'));
    for (const path of [...names.map((name) => join(home, 'rooms', name)), join(home, 'private.json')]) {
      const text = await readFile(path, 'utf8').catch(() => null);
      if (text === null) continue;
      const copy = JSON.parse(text) as Copy;
      this.copies.set(copy.key, copy);
    }
  }

  async mapping(): Promise<string[]> {
    await this.selecting;
    return [...this.copies.values()]
      .filter((copy) => copy.active)
      .map((copy) => `${rootOf(copy)}: ${copy.repository}`)
      .sort();
  }

  select(): Promise<void> {
    const selected = this.selecting.then(() => this.reselect());
    this.selecting = selected.catch(() => undefined);
    return selected;
  }

  private async reselect(): Promise<void> {
    const { working_copy: chosen } = await this.house.post<{
      working_copy: { rooms: { room_ref: string; room_handle: string | null }[]; private: boolean } | null;
    }>('/kit/working-copy/selection', {});
    const selected: Selected[] = [
      ...(chosen?.rooms ?? [])
        .filter((room) => room.room_handle !== null)
        .map((room) => ({ key: `rooms/${room.room_ref}`, private: false, handle: room.room_handle })),
      ...(chosen?.private === true ? [{ key: 'private', private: true, handle: null }] : []),
    ];
    const keys = new Set(selected.map((scope) => scope.key));
    const work: Promise<unknown>[] = [];
    for (const key of this.copies.keys()) {
      if (keys.has(key)) continue;
      work.push(
        this.exclusive(key, async () => {
          const copy = this.copies.get(key)!;
          if (copy.active) await this.save({ ...copy, active: false });
        }),
      );
    }
    for (const scope of selected) work.push(this.exclusive(scope.key, () => this.apply(scope)).catch(logged));
    await Promise.all(work);
  }

  entries(frame: { authority: string; position: string; log_epoch: string }): void {
    const copy = [...this.copies.values()].find((held) => held.active && held.room_ref === frame.authority);
    if (copy === undefined) return;
    if (copy.log_epoch === frame.log_epoch && BigInt(frame.position) <= BigInt(copy.position)) return;
    this.deliver(copy.key);
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
    if (located.status !== 0) return { refused: true, text: `${cwd} is not a House working copy; run house git push inside one` };
    const [common, worktree] = located.stdout.toString('utf8').split('\n') as [string, string];
    const key = await this.keyAt(dirname(common));
    if (key === undefined) return { refused: true, text: `${worktree} is not a House working copy; run house git push inside one` };
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

  private deliver(key: string): void {
    if (this.delivering.has(key)) return;
    this.delivering.add(key);
    void this.exclusive(key, async () => {
      this.delivering.delete(key);
      const copy = this.copies.get(key)!;
      if (copy.active) await this.save(await this.caughtUp(copy));
    }).catch(logged);
  }

  private async save(copy: Copy): Promise<Copy> {
    const path = join(kitHome(), 'working-copies', copy.private ? 'private.json' : `${copy.key}.json`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}`;
    await writeFile(temporary, JSON.stringify(copy), { mode: 0o600 });
    await rename(temporary, path);
    this.copies.set(copy.key, copy);
    return copy;
  }

  private async read(selected: { private: boolean; room_handle: string | null }): Promise<Read | null> {
    const prefixes = prefixesOf(selected);
    const discovery = await this.house.post<{ authorities: Authority[] }>('/kit/door/discover', { prefixes });
    let bundle = await this.house.post<Bundle | { transfer: { url: string } }>('/kit/door/bootstrap', { prefixes });
    if ('transfer' in bundle) bundle = (await (await fetch(bundle.transfer.url)).json()) as Bundle;
    const [view] = bundle.scopes;
    if (view === undefined) return null;
    const authority = discovery.authorities.find((entry) => entry.room_ref === view.manifest.anchor)!;
    const contents = new Map(view.contents.map((entry) => [entry.path, entry.content]));
    const read: Read = {
      anchor: view.manifest.anchor,
      position: view.manifest.position,
      log_epoch: view.manifest.log_epoch,
      write: authority.operations.write,
      protected: authority.protected_paths,
      writable: new Map(),
      revisions: {},
      readOnly: new Map(),
    };
    for (const file of view.manifest.files) {
      const content = contents.get(file.path)!;
      if (file.writable) {
        read.writable.set(file.path, content);
        read.revisions[file.path] = file.revision;
      } else {
        read.readOnly.set(file.path, content);
      }
      if (file.provenance !== undefined) read.readOnly.set(sidecar(file.path), file.provenance);
    }
    return read;
  }

  private async apply(scope: Selected): Promise<void> {
    let copy = this.copies.get(scope.key);
    if (copy === undefined || !(await exists(copy.repository))) {
      await this.materialize(scope);
      return;
    }
    if (copy.room_handle !== scope.handle) copy = await this.save({ ...copy, room_handle: scope.handle });
    if (!copy.active) {
      await this.save(await this.received({ ...copy, active: true }));
      return;
    }
    const discovery = await this.house.post<{ authorities: Authority[] }>('/kit/door/discover', {
      prefixes: prefixesOf(copy),
    });
    const authority = discovery.authorities.find((entry) => entry.room_ref === copy.room_ref);
    if (authority === undefined) return;
    if (authority.managed_replication !== 'admitted') {
      logged(`operation_denied: ${rootOf(copy)} is not synchronized to this Environment`);
      return;
    }
    if (
      JSON.stringify([authority.operations.write, authority.protected_paths]) !==
      JSON.stringify([copy.write, copy.protected])
    ) {
      await this.save(await this.received(copy));
      return;
    }
    await this.save(await this.caughtUp(copy));
  }

  private async materialize(scope: Selected): Promise<void> {
    const read = await this.read({ private: scope.private, room_handle: scope.handle });
    if (read === null) {
      logged(`House serves nothing of ${rootOf({ private: scope.private, room_handle: scope.handle })} to copy`);
      return;
    }
    const repository = scope.private ? join(workingCopies(), 'private') : join(workingCopies(), 'rooms', read.anchor);
    if (await exists(repository)) {
      logged(`${repository} already exists and House Kit leaves it as it is`);
      return;
    }
    const staging = join(dirname(repository), `.${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    let house: string;
    let readOnly: string[];
    try {
      await git(staging, ['init', '-q', '-b', BRANCH]);
      house = await importCommits(staging, [
        { message: `House ${rootOf({ private: scope.private, room_handle: scope.handle })}`, from: null, files: read.writable },
      ]);
      await git(staging, ['update-ref', `refs/heads/${BRANCH}`, house]);
      await git(staging, ['reset', '-q', '--hard']);
      readOnly = await readOnlyPlaced(staging, [], read.readOnly, []);
      await ignoreRules(staging, [...read.writable.keys()], read);
      await rename(staging, repository);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await this.save({
      key: scope.key,
      private: scope.private,
      room_ref: read.anchor,
      room_handle: scope.handle,
      repository,
      active: true,
      house,
      position: read.position,
      log_epoch: read.log_epoch,
      write: read.write,
      protected: read.protected,
      read_only: readOnly,
      manifests: { [house]: { parent: null, files: read.revisions } },
      moves: [],
    });
  }

  private async received(copy: Copy): Promise<Copy> {
    const read = await this.read(copy);
    if (read === null) return copy;
    const house = await importCommits(copy.repository, [
      { message: `House ${rootOf(copy)} at position ${read.position}`, from: copy.house, replaces: true, files: read.writable },
    ]);
    const removed = copy.read_only.filter((path) => !read.readOnly.has(path));
    const readOnly = await readOnlyPlaced(copy.repository, copy.read_only, read.readOnly, removed);
    const next: Copy = {
      ...copy,
      house,
      position: read.position,
      log_epoch: read.log_epoch,
      write: read.write,
      protected: read.protected,
      read_only: readOnly,
      manifests: { ...copy.manifests, [house]: { parent: null, files: read.revisions } },
    };
    await ignoreRules(copy.repository, [...read.writable.keys()], next);
    return next;
  }

  private async caughtUp(start: Copy): Promise<Copy> {
    let copy = start;
    for (;;) {
      let answer: { authorities: { authority: string; position: string; log_epoch: string; changes: Change[] }[] };
      try {
        answer = await this.house.post('/kit/door/enumerate', {
          prefixes: prefixesOf(copy),
          positions: [{ authority: copy.room_ref, position: copy.position, log_epoch: copy.log_epoch }],
        });
      } catch (error) {
        const code = error instanceof HouseRefusal ? (refusalOf(error.text)?.code ?? null) : null;
        if (code === 'position_expired') return this.received(copy);
        if (code !== 'replica_behind') throw error;
        setTimeout(() => this.deliver(copy.key), REPLICA_RETRY_MS).unref();
        return copy;
      }
      const view = answer.authorities.find((entry) => entry.authority === copy.room_ref);
      if (view === undefined || (view.position === copy.position && view.log_epoch === copy.log_epoch)) return copy;
      copy = await this.save(await this.incorporated(copy, view.changes, view.position, view.log_epoch));
    }
  }

  private async incorporated(copy: Copy, changes: readonly Change[], position: string, logEpoch: string): Promise<Copy> {
    const houseTree = await tree(copy.repository, copy.house);
    const held = new Set(copy.read_only);
    const files = new Map<string, string | null>();
    const revisions: Record<string, string | null> = {};
    const written = new Map<string, string>();
    const removed: string[] = [];
    for (const change of changes) {
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
        { message: `House ${rootOf(copy)} at position ${position}`, from: copy.house, files },
      ]);
      manifests = { ...manifests, [house]: { parent: copy.house, files: revisions } };
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
    if (copy.push?.state === 'submitted') return this.settle(copy, caller);
    const selected = await run(worktree, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${selector}^{commit}`]);
    if (selected.status !== 0) return { refused: true, text: `${selector} names no commit` };
    const commit = selected.stdout.toString('utf8').trim();
    if (copy.push !== undefined) {
      const held = copy.push.acknowledged;
      if (held === undefined || !(await succeeded(worktree, ['merge-base', '--is-ancestor', held, commit]))) {
        return this.finished(copy);
      }
      copy = await this.save(without(copy));
    }
    if (!copy.active) {
      return { refused: true, text: `${rootOf(copy)} is no longer synced to this Environment, so House takes no push from it` };
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
      return { refused: true, text: causeOf(error) };
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

  private async derived(copy: Copy, base: string, commit: string): Promise<Edit[]> {
    const root = rootOf(copy);
    const before = await tree(copy.repository, base);
    const after = await tree(copy.repository, commit);
    const moved = movedPaths(copy.moves, before, after);
    const arrived = new Set(moved.values());
    const text = (entry: string, path: string) => blobText(copy.repository, entry, path);
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
        if (moving !== prior) {
          changes.push({ op: 'replace', path: `${root}/${to}`, base: known, content: await text(moving, to) });
        }
        continue;
      }
      if (prior === next) continue;
      if (next === undefined) changes.push({ op: 'remove', path: `${root}/${path}`, base: known });
      else if (prior === undefined) changes.push({ op: 'create', path: `${root}/${path}`, content: await text(next, path) });
      else changes.push(...changed(`${root}/${path}`, path, known, await text(prior, path), await text(next, path)));
    }
    return changes;
  }

  private async settle(start: Copy, caller: Caller, restaged = false): Promise<Pushed> {
    let copy = start;
    const push = copy.push!;
    if (push.caller !== caller.key) return this.recovered(copy);
    let outcome: Submitted;
    try {
      outcome = await caller.submit(push.operation_id, push.changes, push.upload, async (upload) => {
        copy = await this.save({ ...copy, push: { ...push, upload } });
      });
    } catch (error) {
      const refusal = error instanceof HouseRefusal ? refusalOf(error.text) : null;
      return {
        refused: true,
        text: refusal?.text ?? `House's answer to ${short(push.commit)} did not arrive; run house git push again`,
      };
    }
    if ('refused' in outcome) {
      if (outcome.refused.code === 'upload_unavailable' && copy.push!.upload !== undefined && !restaged) {
        const { upload, ...unstaged } = copy.push!;
        return this.settle(await this.save({ ...copy, push: unstaged }), caller, true);
      }
      if (outcome.refused.code === 'operation_expired') return this.recovered(copy);
      const rebased = rebaseFixes(outcome.refused);
      let settled = await this.save(without(copy));
      try {
        settled = await this.save(await this.caughtUp(settled));
      } catch {
        return {
          refused: true,
          text: rebased ? `${outcome.refused.text}\nHouse's current state did not arrive; push again later` : outcome.refused.text,
        };
      }
      return {
        refused: true,
        text: rebased
          ? `${outcome.refused.text}\n${HOUSE_REF} holds House's current state; rebase onto it and push again`
          : outcome.refused.text,
      };
    }
    return this.finished(await this.save({ ...copy, push: { ...copy.push!, state: 'accepted', written: outcome.accepted } }));
  }

  private async recovered(copy: Copy): Promise<Pushed> {
    const push = copy.push!;
    const current = await this.save(await this.caughtUp(copy));
    const house = await tree(copy.repository, current.house);
    const root = rootOf(current);
    if (!(await this.landed(copy.repository, push.changes, house, await tree(copy.repository, push.commit)))) {
      await this.save(without(current));
      return {
        refused: true,
        text: `House does not hold ${short(push.commit)}; run house git push again`,
      };
    }
    const written: Written[] = [];
    for (const path of changedPaths(push.changes).map(relative)) {
      const entry = house.get(path);
      written.push({
        path: `${root}/${path}`,
        revision: entry === undefined ? null : (revisionAt(current, current.house, path) ?? null),
        content: entry === undefined ? null : await blobText(copy.repository, entry, path),
      });
    }
    return this.finished(await this.save({ ...current, push: { ...push, state: 'accepted', written } }));
  }

  private async finished(start: Copy): Promise<Pushed> {
    let copy = start;
    const { commit } = copy.push!;
    try {
      if (copy.push!.acknowledged === undefined) copy = await this.save(await this.acknowledged(copy));
      const integrated = await this.integrated(copy.push!);
      if (integrated.done) await this.save(without(copy));
      return { refused: false, text: integrated.text };
    } catch {
      return {
        refused: false,
        text: `House accepted ${short(commit)}; run house git push again to finish integrating it here`,
      };
    }
  }

  private async acknowledged(start: Copy): Promise<Copy> {
    let copy = start;
    const push = copy.push!;
    let written = push.written!;
    if (push.changes.some((change) => change.op === 'rename')) {
      copy = await this.save(await this.caughtUp(copy));
      const house = await tree(copy.repository, copy.house);
      const sent = await tree(copy.repository, push.house);
      if (push.changes.some((change) => change.op === 'rename' && !house.has(relative(change.to)))) {
        throw new Error(`House's result for ${short(push.commit)} is not readable yet`);
      }
      const known = new Set(written.map((entry) => relative(entry.path)));
      for (const path of new Set([...sent.keys(), ...house.keys()])) {
        const entry = house.get(path);
        if (known.has(path) || sent.get(path) === entry) continue;
        written = [
          ...written,
          {
            path: `${rootOf(copy)}/${path}`,
            revision: entry === undefined ? null : (revisionAt(copy, copy.house, path) ?? null),
            content: entry === undefined ? null : await blobText(copy.repository, entry, path),
          },
        ];
      }
    }
    const selected = await tree(copy.repository, push.commit);
    const houseTree = await tree(copy.repository, copy.house);
    const files = new Map<string, string | null>();
    const revisions: Record<string, string | null> = {};
    for (const entry of written) {
      const path = relative(entry.path);
      if (!selected.has(path) && !houseTree.has(path) && !declaredWritable(path, copy)) continue;
      files.set(path, entry.revision === null ? null : (entry.content ?? (await this.revisionText(entry.path, entry.revision))));
      revisions[path] = entry.revision;
    }
    const edits = new Map(
      [...files].filter(([path, content]) => (content === null ? selected.has(path) : selected.get(path) !== blobId(content))),
    );
    const received = [...files.keys()].filter(
      (path) => revisionAt(copy, copy.house, path) === revisionAt(copy, push.house, path),
    );
    const accepted = `House ${rootOf(copy)} with ${push.commit} accepted`;
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
        [acknowledged]: { parent: push.base, files: revisions },
        [house]: { parent: copy.house, files: Object.fromEntries(received.map((path) => [path, revisions[path] ?? null])) },
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
  ): Promise<boolean> {
    const text = async (path: string) => {
      const entry = house.get(relative(path));
      return entry === undefined ? undefined : blobText(repository, entry, path);
    };
    for (const change of changes) {
      const current = await text(change.path);
      if (change.op === 'remove' && current === undefined) continue;
      if (change.op === 'rename' && current === undefined && house.get(relative(change.to)) === selected.get(relative(change.to))) {
        continue;
      }
      if ((change.op === 'create' || change.op === 'replace') && current === change.content) continue;
      const parsed = current === undefined ? null : parse(current, change.path);
      const document = parsed?.ok === true ? parsed.document : null;
      if (document === null) return false;
      if (change.op === 'set_field' && JSON.stringify(document.fields[change.field]) === JSON.stringify(change.value)) continue;
      if (change.op === 'replace_section' && document.sections[change.section] === change.content) continue;
      if (change.op === 'replace_preamble' && document.preamble === change.content) continue;
      return false;
    }
    return true;
  }

  private async revisionText(path: string, wanted: string): Promise<string> {
    const page = await this.house.post<{ revisions: { revision: string; content?: string }[] }>('/kit/door/revisions', {
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
