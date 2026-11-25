import { execFileSync, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const LISTING_BYTES = 1 << 28;
const GONE = new Set(['ENOENT', 'ESRCH']);

function failure(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? '';
}

function listed(environment: boolean): Map<number, { parent: number; command: string }> {
  const found = new Map<number, { parent: number; command: string }>();
  const output = execFileSync('ps', [environment ? '-AEww' : '-Aww', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: LISTING_BYTES,
  });
  for (const line of output.split('\n')) {
    const fields = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (fields !== null) found.set(Number(fields[1]), { parent: Number(fields[2]), command: fields[3]! });
  }
  return found;
}

function parents(): Map<number, number> {
  if (process.platform === 'darwin') return new Map([...listed(false)].map(([pid, { parent }]) => [pid, parent]));
  const found = new Map<number, number>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      found.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch (error) {
      if (!GONE.has(failure(error))) throw error;
    }
  }
  return found;
}

function descendants(roots: number[]): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, parent] of parents()) children.set(parent, [...(children.get(parent) ?? []), pid]);
  const tree: number[] = [];
  const pending = roots.flatMap((root) => children.get(root) ?? []);
  while (pending.length > 0) {
    const pid = pending.pop()!;
    tree.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return tree;
}

function marked(marker: string): number[] {
  if (process.platform === 'darwin') {
    return [...listed(true)].filter(([, { command }]) => ` ${command} `.includes(` ${marker} `)).map(([pid]) => pid);
  }
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry) && carries(entry, marker))
    .map(Number);
}

function carries(pid: string, marker: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(marker);
  } catch (error) {
    if (GONE.has(failure(error)) || failure(error) === 'EACCES') return false;
    throw error;
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

export function killTree(child: Pick<ChildProcess, 'pid'>): void {
  killAll([child.pid!, ...descendants([child.pid!])]);
}

export function killMarked(marker: string): void {
  const pids = marked(marker);
  killAll([...pids, ...descendants(pids)]);
}

export function killDescendants(): void {
  killAll(descendants([process.pid]));
}
