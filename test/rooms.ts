import { apply, parse, serialize, type Change } from '@agentshouse/mdmodel';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { stringify } from 'yaml';
import { until, type Received } from './double.ts';
import { GIT_IDENTITY, type Hosted, type ToolResult } from './environment.ts';

const HOUSE = fileURLToPath(new URL('../src/house-main.ts', import.meta.url));
export const COPIES = '/agents/house/working-copies';
const LOG_EPOCH = '0192f0e4-1c2d-7000-8000-000000000001';

interface Stored {
  content: string;
  revision: string;
  provenance?: string;
}

interface Write {
  path: string;
  op: string;
  content: string | null;
  revision: string | null;
  from?: string;
  rewrite?: true;
}

type Edited = { writes: Write[] } | { refusal: { code: string; conflicts?: Record<string, unknown>[] } };

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

export class Room {
  readonly ref = `r_${randomBytes(5).toString('hex')}.x`;
  readonly private: boolean;
  handle: string | null;
  position = 1;
  logEpoch = LOG_EPOCH;
  write = ['ROOM.md', 'library'];
  protected = ['capture', 'collaboration'];
  files = new Map<string, Stored>();
  readonly history = new Map<string, string>();
  readonly log: { position: number; paths: string[] }[] = [];
  readonly batches: EditChange[][] = [];

  constructor(handle: string | null) {
    this.handle = handle;
    this.private = handle === null;
  }

  get root(): string {
    return this.private ? '/private' : `/rooms/${this.handle}`;
  }

  get repository(): string {
    return this.private ? join(COPIES, 'private') : join(COPIES, 'rooms', this.ref);
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

  bundle(): Record<string, unknown> {
    const paths = [...this.files.keys()].sort();
    return {
      manifest: {
        version: 'working-copy/1',
        scope: 'room',
        anchor: this.ref,
        path: this.root,
        room_handle: this.handle,
        position: String(this.position),
        log_epoch: this.logEpoch,
        files: paths.map((path) => {
          const file = this.files.get(path)!;
          return {
            path,
            revision: file.revision,
            sha256: 'unused',
            writable: this.writable(path),
            ...(file.provenance === undefined ? {} : { provenance: file.provenance }),
          };
        }),
      },
      contents: paths.map((path) => ({ path, content: this.files.get(path)!.content })),
      originals: [],
    };
  }

  enumerated(after: number): Record<string, unknown> {
    const paths = [...new Set(this.log.filter((entry) => entry.position > after).flatMap((entry) => entry.paths))].sort();
    return {
      authority: this.ref,
      position: String(this.position),
      log_epoch: this.logEpoch,
      changes: paths.map((path) => {
        const file = this.files.get(path);
        if (file === undefined) return { path, removed: true };
        return {
          path,
          content: file.content,
          revision: file.revision,
          sha256: 'unused',
          ...(file.provenance === undefined ? {} : { provenance: file.provenance }),
        };
      }),
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
        return { refusal: { code: 'protected_path' } };
      }
      const current = next.get(path);
      const stale = (code: string) =>
        conflicts.push({ path: change.path, code, state: current === undefined ? 'absent' : 'current', revision: current?.revision });
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
        const result = apply(parsed.document, structured);
        if (result.outcome !== 'applied') stale('component_stale');
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
  selection: { rooms: { room_ref: string; room_handle: string | null }[]; private: boolean } | null;
  room(handle: string | null): Room;
  select(rooms: Room[]): Promise<void>;
  denied: Set<string>;
  expired: Set<string>;
  dropping: number;
  dropsEdits: number;
  reads: boolean[];
  prepared: unknown[];
  uploaded: Buffer[];
  edits(): Received[];
}

function selectedRooms(rooms: Room[], prefixes: string[]): Room[] {
  return rooms.filter((room) =>
    prefixes.some((prefix) => (room.private ? prefix === '/private' : prefix.startsWith(`/rooms/${room.handle}/`))),
  );
}

export function serveRooms(hosted: Hosted): Rooms {
  const rooms: Room[] = [];
  const receipts = new Map<string, unknown>();
  const state: Rooms = {
    selection: null,
    denied: new Set(),
    expired: new Set(),
    dropping: 0,
    dropsEdits: 0,
    reads: [],
    prepared: [],
    uploaded: [],
    room: (handle) => {
      const room = new Room(handle);
      rooms.push(room);
      onTestFinished(() => rm(room.repository, { recursive: true, force: true }));
      return room;
    },
    select: async (selected) => {
      state.selection = {
        rooms: selected.filter((room) => !room.private).map((room) => ({ room_ref: room.ref, room_handle: room.handle })),
        private: selected.some((room) => room.private),
      };
      hosted.socket.send({ type: 'work_available', subject: 'working_copy' });
      for (const room of selected) {
        const key = room.private ? 'private.json' : join('rooms', `${room.ref}.json`);
        await until(() => existsSync(join(hosted.home, 'working-copies', key)));
      }
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
  hosted.house.route('POST', '/kit/working-copy/selection', () => ({ body: { working_copy: state.selection } }));
  hosted.house.route('POST', '/kit/door/discover', (request) => {
    const { prefixes } = request.body as { prefixes: string[] };
    return {
      body: {
        md_model_version: '0.1.0-alpha.17',
        authorities: selectedRooms(rooms, prefixes).map((room) => room.authority()),
      },
    };
  });
  hosted.house.route('POST', '/kit/door/bootstrap', (request) => {
    const { prefixes } = request.body as { prefixes: string[] };
    return { body: { scopes: selectedRooms(rooms, prefixes).map((room) => room.bundle()) } };
  });
  hosted.house.route('POST', '/kit/door/enumerate', (request) => {
    const { positions } = request.body as { positions: { authority: string; position: string; log_epoch: string }[] };
    const [known] = positions;
    const room = rooms.find((candidate) => candidate.ref === known!.authority)!;
    if (state.reads.shift() === false) return { status: 503, body: { error: { code: 'house_unavailable' } } };
    if (state.expired.delete(room.ref) || known!.log_epoch !== room.logEpoch) {
      return { status: 410, body: { error: { code: 'position_expired' } } };
    }
    return { body: { authorities: [room.enumerated(Number(known!.position))] } };
  });
  hosted.house.route('POST', '/kit/door/revisions', (request) => {
    const { path, revision } = request.body as { path: string; revision: string };
    const room = roomOf(path);
    return { body: { path, revisions: [{ revision, content: room.history.get(revision) }], next_before: null } };
  });
  hosted.house.route('POST', '/kit/door/batch', (request) => {
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
    if ('refusal' in outcome) return { status: 409, body: { error: outcome.refusal } };
    const { writes, ...rest } = outcome;
    return {
      body: { ...rest, contents: answered(writes).map((write) => ({ path: write.path, content: write.content, revision: write.revision })) },
    };
  });
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
      return { isError: true, content: [{ type: 'text', text: 'operation_denied: you cannot get around this.\n' }] };
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
      const { code, ...facts } = outcome.refusal;
      const said = `${code}: read the current state, then call again.\n${Object.keys(facts).length > 0 ? stringify(facts) : ''}`;
      return { isError: true, content: [{ type: 'text', text: said }] } satisfies ToolResult;
    }
    const room = roomOf(changes[0]!.path);
    return {
      content: [
        {
          type: 'text',
          text: stringify({
            protocol: 'render=edit/1',
            mount: 'room',
            room_ref: room.ref,
            room_handle: room.handle,
            results: answered(outcome.writes).map((write) => ({
              path: write.path,
              op: write.op,
              revision: write.revision ?? 'rev-removed',
              bytes: write.content?.length ?? 0,
              lines: 0,
              diff: [],
              truncated: false,
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
