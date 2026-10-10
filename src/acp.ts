import {
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientApp,
  type ClientConnection,
  type InitializeResponse,
} from '@agentclientprotocol/sdk';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { CLIS, KIT_VERSION, adapterCommand, withoutProxy } from './clis.ts';
import type { Message } from './events.ts';

export interface Adapter {
  child: ChildProcess;
  connection: ClientConnection;
  initialized: InitializeResponse;
  exited: Promise<string>;
}

export async function startAdapter(
  kind: string,
  cli: string,
  cwd: string,
  app: ClientApp,
  events: (message: Message) => void = () => undefined,
  added: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Adapter> {
  const adapter = CLIS[kind]!.adapter;
  const child = spawn(adapter === null ? cli : adapterCommand(kind), CLIS[kind]!.args, {
    cwd,
    env: { ...withoutProxy(), ...(adapter === null ? {} : { ...adapter.env, [adapter.executable]: cli }), ...added },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const stop = () => killTree(child);
  signal?.addEventListener('abort', stop, { once: true });
  child.on('exit', () => signal?.removeEventListener('abort', stop));
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });
  const exited = new Promise<string>((resolve) => {
    child.on('error', (error) => resolve(`the CLI did not start: ${error.message}`));
    child.on('exit', (code, signal) => {
      const last = stderr.trim().split('\n').at(-1);
      resolve(`the CLI exited with ${code ?? signal}${last ? `: ${last}` : ''}`);
    });
  });
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect({
    writable: stream.writable,
    readable: stream.readable.pipeThrough(
      new TransformStream({
        transform(message, controller) {
          const read = message as Message;
          events(read);
          if (read.id !== undefined || (read.method !== 'session/update' && !read.method!.startsWith('_'))) {
            controller.enqueue(message);
          }
        },
      }),
    ),
  });
  void exited.then((cause) => connection.close(new Error(cause)));
  try {
    const initialized = await connection.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
        session: { compaction: {}, notices: {} },
        _meta: { jetbrains: { air: { version: 1, capabilities: CLIS[kind]!.air } } },
      },
      clientInfo: { name: '@agentshouse/kit', version: KIT_VERSION },
    });
    return { child, connection, initialized, exited };
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

const LISTING_BYTES = 1 << 28;

function listed(options: string): [number, number, string][] {
  return execFileSync('ps', [options, '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: LISTING_BYTES })
    .split('\n')
    .flatMap((line) => {
      const fields = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
      return fields === null ? [] : [[Number(fields[1]), Number(fields[2]), fields[3]!] as [number, number, string]];
    });
}

function parents(): Map<number, number[]> {
  const children = new Map<number, number[]>();
  const adopt = (pid: number, parent: number) => children.set(parent, [...(children.get(parent) ?? []), pid]);
  if (process.platform === 'darwin') {
    for (const [pid, parent] of listed('-Aww')) adopt(pid, parent);
    return children;
  }
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      adopt(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch {}
  }
  return children;
}

function descendants(roots: number[]): number[] {
  const children = parents();
  const tree: number[] = [];
  const pending = roots.flatMap((root) => children.get(root) ?? []);
  while (pending.length > 0) {
    const pid = pending.pop()!;
    tree.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return tree;
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

function marked(marker: string): number[] {
  if (process.platform === 'darwin') {
    return listed('-AEww')
      .filter(([, , command]) => ` ${command} `.includes(` ${marker} `))
      .map(([pid]) => pid);
  }
  return readdirSync('/proc')
    .filter((entry) => {
      try {
        return /^\d+$/.test(entry) && readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(marker);
      } catch {
        return false;
      }
    })
    .map(Number);
}

function commandLine(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
  } catch {
    return '';
  }
}

export function processes(marker: string): Set<string> {
  const pids = marked(marker);
  const tree = [...pids, ...descendants(pids)];
  const commands =
    process.platform === 'darwin'
      ? new Map(listed('-Aww').map(([pid, , command]) => [pid, command]))
      : new Map(tree.map((pid) => [pid, commandLine(pid)]));
  return new Set(tree.flatMap((pid) => (commands.get(pid) ? [`${pid} ${commands.get(pid)}`] : [])));
}

export function killTree(child: ChildProcess): void {
  killAll([child.pid!, ...descendants([child.pid!])]);
}

export function killMarked(marker: string): void {
  const pids = marked(marker);
  killAll([...pids, ...descendants(pids)]);
}

export function killDescendants(): void {
  const pids = marked(`HOUSE_KIT_RESIDENT=${process.pid}`);
  killAll([...pids, ...descendants([process.pid, ...pids])]);
}
