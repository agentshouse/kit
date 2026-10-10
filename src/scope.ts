import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Running {
  parent: number;
  session: string;
  command: string;
}

const LISTING_BYTES = 1 << 28;
const CGROUPS = '/sys/fs/cgroup';
const GONE = new Set(['ENOENT', 'ESRCH']);

function failure(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? '';
}

function listed(environment: boolean): Map<number, Running> {
  const found = new Map<number, Running>();
  const output = execFileSync('ps', [environment ? '-AEww' : '-Aww', '-o', 'pid=,ppid=,sess=,command='], {
    encoding: 'utf8',
    maxBuffer: LISTING_BYTES,
  });
  for (const line of output.split('\n')) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line);
    if (fields !== null) found.set(Number(fields[1]), { parent: Number(fields[2]), session: fields[3]!, command: fields[4]! });
  }
  return found;
}

function read(pid: string): Running | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    return { parent: Number(fields[1]), session: fields[3]!, command };
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
    return doubted && statSync(`/proc/${pid}`, { throwIfNoEntry: false })?.uid === process.getuid!();
  }
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

export function killTree(child: ChildProcess): void {
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

function members(group: string): number[] {
  const pids = readFileSync(join(group, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number);
  for (const entry of readdirSync(group, { withFileTypes: true })) {
    if (entry.isDirectory()) pids.push(...members(join(group, entry.name)));
  }
  return pids;
}

export class Scope {
  private readonly marker: string;
  private readonly cli: string;
  private group: string | null;
  private session: string | null = null;
  private recorded: Set<number> | null = null;

  constructor(marker: string, name: string, cli: string) {
    this.marker = marker;
    this.cli = cli;
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
    this.session = process.platform === 'darwin' ? (listed(false).get(pid)?.session ?? null) : String(pid);
    if (this.group === null) return;
    const joined = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((entry) => entry.startsWith('0::'));
    if (joined !== undefined && join(CGROUPS, joined.slice(3)) === this.group) return;
    this.close();
    this.group = null;
  }

  record(): void {
    const found = this.found();
    if (found === null) return;
    this.recorded = new Set([...found].filter(([, { session }]) => session === this.session).map(([pid]) => pid));
  }

  working(): boolean {
    const found = this.found();
    if (found === null) return true;
    if (this.recorded === null) return found.size > 0;
    return [...found].some(
      ([pid, { session, command }]) =>
        session !== this.session || !(this.recorded!.has(pid) || command.startsWith(`${this.cli}-`)),
    );
  }

  empty(): boolean {
    return this.found()?.size === 0;
  }

  kill(): void {
    killMarked(this.marker);
    if (this.group === null) return;
    try {
      writeFileSync(join(this.group, 'cgroup.kill'), '1');
    } catch {
      killAll([...(this.found()?.keys() ?? [])]);
    }
  }

  close(): void {
    if (this.group === null) return;
    try {
      rmdirSync(this.group);
    } catch {}
  }

  private found(): Map<number, Running> | null {
    try {
      const table = processes();
      const roots = this.group === null ? marked(this.marker, true) : members(this.group);
      const pids = this.group === null ? [...roots, ...descendants(roots, table)] : roots;
      return new Map(pids.flatMap((pid): [number, Running][] => (table.has(pid) ? [[pid, table.get(pid)!]] : [])));
    } catch {
      return null;
    }
  }
}
