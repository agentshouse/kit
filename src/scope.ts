import { execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

interface Running {
  parent: number;
  session: string | null;
  processGroup: string;
  command: string;
}

const LISTING_BYTES = 1 << 28;
const CGROUPS = '/sys/fs/cgroup';
const LEFT = 'left';
const GONE = new Set(['ENOENT', 'ESRCH']);
const EXITED = new Set(['Z', 'X']);
// A process a turn left ends without a report where no control group's event tells of it, so the Kit looks every two seconds while one runs and goes idle within two seconds of its end.
const LOOK_MS = 2_000;

function failure(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? '';
}

function listed(environment: boolean): Map<number, Running> {
  const found = new Map<number, Running>();
  const output = execFileSync('ps', [environment ? '-AEww' : '-Aww', '-o', 'pid=,ppid=,pgid=,command='], {
    encoding: 'utf8',
    maxBuffer: LISTING_BYTES,
  });
  for (const line of output.split('\n')) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (fields !== null) found.set(Number(fields[1]), { parent: Number(fields[2]), session: null, processGroup: fields[3]!, command: fields[4]! });
  }
  return found;
}

function read(pid: string): Running | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (EXITED.has(fields[0]!)) return null;
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    return { parent: Number(fields[1]), session: fields[3]!, processGroup: fields[2]!, command };
  } catch (error) {
    if (GONE.has(failure(error))) return null;
    throw error;
  }
}

function processes(): Map<number, Running> {
  if (process.platform === 'darwin') return listed(false);
  const found = new Map<number, Running>();
  for (const entry of readdirSync('/proc')) {
    const running = /^\d+$/.test(entry) ? read(entry) : null;
    if (running !== null) found.set(Number(entry), running);
  }
  return found;
}

function descendants(roots: number[], table = processes()): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, { parent }] of table) children.set(parent, [...(children.get(parent) ?? []), pid]);
  const tree: number[] = [];
  const pending = roots.flatMap((root) => children.get(root) ?? []);
  while (pending.length > 0) {
    const pid = pending.pop()!;
    tree.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return tree;
}

function marked(marker: string, doubted: boolean): number[] {
  if (process.platform === 'darwin') {
    return [...listed(true)].filter(([, { command }]) => ` ${command} `.includes(` ${marker} `)).map(([pid]) => pid);
  }
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry) && carries(entry, marker, doubted))
    .map(Number);
}

function carries(pid: string, marker: string, doubted: boolean): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(marker);
  } catch (error) {
    if (GONE.has(failure(error))) return false;
    if (failure(error) !== 'EACCES') throw error;
    return doubted && statSync(`/proc/${pid}`, { throwIfNoEntry: false })?.uid === process.getuid!() && stillRuns(pid);
  }
}

function stillRuns(pid: string): boolean {
  return Boolean(read(pid)?.command);
}

function killAll(pids: number[]): void {
  for (const pid of pids) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {}
    }
  }
}

export function killTree(child: Pick<ChildProcess, 'pid'>): void {
  killAll([child.pid!, ...descendants([child.pid!])]);
}

export function killMarked(marker: string): void {
  const pids = marked(marker, false);
  killAll([...pids, ...descendants(pids)]);
}

export function killDescendants(): void {
  const pids = marked(`HOUSE_KIT_RESIDENT=${process.pid}`, false);
  killAll([...pids, ...descendants([process.pid, ...pids])]);
}

function ownGroup(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('0::'));
    return line === undefined ? null : join(CGROUPS, line.slice(3));
  } catch {
    return null;
  }
}

function members(group: string, skipped: string | null = null): number[] {
  const pids = readFileSync(join(group, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number);
  for (const entry of readdirSync(group, { withFileTypes: true })) {
    if (entry.isDirectory() && join(group, entry.name) !== skipped) pids.push(...members(join(group, entry.name)));
  }
  return pids;
}

function populated(group: string): boolean {
  try {
    return readFileSync(join(group, 'cgroup.events'), 'utf8').split('\n').includes('populated 1');
  } catch (error) {
    if (failure(error) === 'ENOENT') return false;
    throw error;
  }
}

function besideCli(cli: string): string | null {
  try {
    return `${realpathSync(cli)}-`;
  } catch {
    return null;
  }
}

interface Reading {
  busy: boolean;
  empty: boolean;
  events: string | null;
  beyond: () => Map<number, Running> | null;
}

const UNREAD: Reading = { busy: true, empty: false, events: null, beyond: () => null };

function leftBehind(group: string): () => Map<number, Running> | null {
  let listed: { beyond: Map<number, Running> | null } | null = null;
  return () => {
    listed ??= { beyond: membersRunning(join(group, LEFT)) };
    return listed.beyond;
  };
}

function membersRunning(group: string): Map<number, Running> | null {
  try {
    return new Map(
      members(group).flatMap((pid): [number, Running][] => {
        const running = read(String(pid));
        return running === null ? [] : [[pid, running]];
      }),
    );
  } catch {
    return null;
  }
}

function onlyWaiting(beyond: Map<number, Running>, waits: (command: string) => boolean): boolean {
  const parents = new Set([...beyond.values()].map(({ parent }) => parent));
  let waiting = false;
  for (const [pid, { command }] of beyond) {
    if (waits(command)) waiting = true;
    else if (!parents.has(pid)) return false;
  }
  return waiting;
}

export class Scope {
  private readonly marker: string;
  private readonly helpers: string | null;
  private readonly changed: () => void;
  private group: string | null;
  private leader: string | null = null;
  private recorded: Set<number> | null = null;
  private exited = false;
  private stale = true;
  private reading: Reading = UNREAD;
  private watcher: FSWatcher | null = null;
  private watched: string | null = null;
  private looking: ReturnType<typeof setInterval> | null = null;

  constructor(marker: string, name: string, cli: string, changed: () => void) {
    this.marker = marker;
    this.helpers = besideCli(cli);
    this.changed = changed;
    const own = ownGroup();
    this.group = own === null ? null : join(own, name);
    try {
      if (this.group !== null) mkdirSync(this.group);
    } catch {
      this.group = null;
    }
  }

  command(command: string, args: string[]): [string, string[]] {
    if (this.group === null) return [command, args];
    return ['/bin/sh', ['-c', 'echo $$ > "$0/cgroup.procs" 2>/dev/null; exec "$@"', this.group, command, ...args]];
  }

  entered(pid: number): void {
    this.leader = String(pid);
    if (this.group === null) return;
    const joined = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((entry) => entry.startsWith('0::'));
    if (joined !== undefined && join(CGROUPS, joined.slice(3)) === this.group) return;
    this.close();
    this.group = null;
  }

  record(): void {
    const found = this.found();
    if (found !== null) this.recorded = new Set(found.keys());
    this.heard();
  }

  heard(): void {
    this.stale = true;
  }

  ended(): void {
    this.exited = true;
    this.heard();
  }

  working(): boolean {
    return this.read().busy;
  }

  empty(): boolean {
    return this.read().empty;
  }

  waiting(waits: (command: string) => boolean): boolean {
    const reading = this.read();
    if (!reading.busy || this.recorded === null) return false;
    const beyond = reading.beyond();
    return beyond !== null && onlyWaiting(beyond, waits);
  }

  kill(): void {
    killMarked(this.marker);
    this.heard();
    if (this.group === null) return;
    try {
      writeFileSync(join(this.group, 'cgroup.kill'), '1');
    } catch {
      killAll([...(this.found()?.keys() ?? [])]);
    }
  }

  close(): void {
    this.unfollow();
    if (this.group === null) return;
    for (const group of [join(this.group, LEFT), this.group]) {
      try {
        rmdirSync(group);
      } catch {}
    }
  }

  private read(): Reading {
    if (!this.stale) return this.reading;
    this.stale = false;
    this.reading = this.group === null ? this.looked() : this.swept(this.group);
    const { busy, empty, events } = this.reading;
    if (empty || (!busy && !(this.exited && events !== null))) this.unfollow();
    else if (events === null) this.look();
    return this.reading;
  }

  private looked(): Reading {
    const found = this.found();
    if (found === null) return UNREAD;
    const beyond = new Map([...found].filter(([pid, running]) => this.beyond(pid, running)));
    return { busy: beyond.size > 0, empty: found.size === 0, events: null, beyond: () => beyond };
  }

  private swept(group: string): Reading {
    const left = join(group, LEFT);
    try {
      if (this.recorded !== null) this.sweep(group, left);
      const judged = this.recorded === null ? group : left;
      const told = existsSync(judged) ? this.follow(judged) : null;
      const busy = populated(judged);
      const events = busy || !this.exited ? told : this.follow(group);
      return { busy, empty: !populated(group), events, beyond: leftBehind(group) };
    } catch {
      return UNREAD;
    }
  }

  private follow(group: string): string | null {
    return this.watch(group) ? group : null;
  }

  private sweep(group: string, left: string): void {
    for (let moved = true; moved; ) {
      moved = false;
      for (const pid of members(group, left)) {
        const running = read(String(pid));
        if (running === null || !this.beyond(pid, running)) continue;
        if (!existsSync(left)) mkdirSync(left);
        moved = this.moved(left, pid) || moved;
      }
    }
  }

  private moved(left: string, pid: number): boolean {
    try {
      writeFileSync(join(left, 'cgroup.procs'), String(pid));
      return true;
    } catch (error) {
      if (failure(error) === 'ESRCH') return false;
      throw error;
    }
  }

  private beyond(pid: number, { session, processGroup, command }: Running): boolean {
    if (this.recorded === null) return true;
    if (session !== null) return session !== this.leader;
    return processGroup !== this.leader && !this.recorded.has(pid) && !(this.helpers !== null && command.startsWith(this.helpers));
  }

  private watch(group: string): boolean {
    if (this.watched === group && this.watcher !== null) return true;
    this.unfollow();
    try {
      this.watcher = watch(join(group, 'cgroup.events'), () => this.heardEvent()).on('error', () => {
        this.unfollow();
        this.heardEvent();
      });
      this.watched = group;
      return true;
    } catch {
      return false;
    }
  }

  private look(): void {
    if (this.looking !== null) return;
    this.watcher?.close();
    this.watcher = null;
    this.watched = null;
    this.looking = setInterval(() => this.heardEvent(), LOOK_MS);
  }

  private heardEvent(): void {
    this.heard();
    this.changed();
  }

  private unfollow(): void {
    this.watcher?.close();
    this.watcher = null;
    this.watched = null;
    if (this.looking !== null) clearInterval(this.looking);
    this.looking = null;
  }

  private found(): Map<number, Running> | null {
    try {
      if (this.group !== null) return membersRunning(this.group);
      const table = processes();
      const roots = marked(this.marker, true);
      return new Map(
        [...roots, ...descendants(roots, table)].flatMap((pid): [number, Running][] => (table.has(pid) ? [[pid, table.get(pid)!]] : [])),
      );
    } catch {
      return null;
    }
  }
}
