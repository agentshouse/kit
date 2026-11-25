import { KIT_WAITED_RUNS_MAX, KIT_WAITS_MAX, type HouseOneWayCallOf, type KitOneWayCall } from '@agentshouse/kit-wire';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { isRunReference, type Again, type Asked, type Heard, type Resolved } from './agent-run.ts';
import { received } from './bridge.ts';
import { kitHome, readHome, writeHome } from './home.ts';

const RECORDS = 'run-waits';

const NAMES = 'run-names.json';

const NAMES_KEPT = 1000;

interface Named {
  name: string;
  run: string;
}

interface WaitRecord {
  conversation_id: string;
  runs: string[];
}

interface Wait {
  id: string;
  runs: ReadonlySet<string>;
  heard(line: string): void;
}

export interface EndedWaits {
  waits: WaitRecord[];
  forget(): Promise<void>;
}

class Refused extends Error {}

function recordOf(id: string): string {
  return join(RECORDS, `${id}.json`);
}

export async function endedWaits(): Promise<EndedWaits> {
  const folder = join(kitHome(), RECORDS);
  const files = (await readdir(folder).catch(() => [] as string[])).filter((file) => file.endsWith('.json'));
  const byConversation = new Map<string, Set<string>>();
  for (const file of files) {
    const record = await readHome<WaitRecord>(join(RECORDS, file));
    if (record === null) continue;
    const runs = byConversation.get(record.conversation_id) ?? new Set<string>();
    for (const run of record.runs) runs.add(run);
    byConversation.set(record.conversation_id, runs);
  }
  return {
    waits: [...byConversation].map(([conversation, runs]) => ({ conversation_id: conversation, runs: [...runs].slice(0, KIT_WAITED_RUNS_MAX) })).slice(0, KIT_WAITS_MAX),
    forget: async () => {
      await Promise.all(files.map((file) => rm(join(folder, file), { force: true })));
    },
  };
}

export class RunWaits {
  private readonly waits = new Map<string, Wait>();
  private names: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private readonly send: (oneWayCall: KitOneWayCall) => boolean;

  constructor(send: (oneWayCall: KitOneWayCall) => boolean) {
    this.send = send;
  }

  async serve(conversation: string | null, request: IncomingMessage, response: ServerResponse): Promise<void> {
    let wait: Wait | null = null;
    let gone = false;
    response.on('close', () => {
      gone = true;
      if (wait !== null) void this.end(wait, conversation !== null);
    });
    let asked: Asked[];
    try {
      ({ runs: asked } = JSON.parse(await received(request)) as { runs: Asked[] });
    } catch {
      response.writeHead(400).end('house agent run sent no Runs to wait on');
      return;
    }
    let resolved: Resolved['runs'];
    try {
      if (this.waits.size >= KIT_WAITS_MAX) throw new Refused(`this computer already holds ${KIT_WAITS_MAX} waiting house agent run commands; end one first`);
      resolved = await this.resolved(asked);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      response.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' }).end(error.message);
      return;
    }
    const id = randomUUID();
    const runs = [...new Set(resolved.map(({ run }) => run))];
    if (conversation !== null) {
      await mkdir(join(kitHome(), RECORDS), { recursive: true, mode: 0o700 });
      await writeHome(recordOf(id), { conversation_id: conversation, runs } satisfies WaitRecord);
    }
    wait = { id, runs: new Set(runs), heard: (line) => response.write(line) };
    this.waits.set(id, wait);
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write(`${JSON.stringify({ runs: resolved } satisfies Resolved)}\n`);
    this.name(wait);
    if (gone) void this.end(wait, conversation !== null);
  }

  opened(): void {
    for (const wait of this.waits.values()) {
      wait.heard(`${JSON.stringify({ again: true } satisfies Again)}\n`);
      this.name(wait);
    }
  }

  heard(call: HouseOneWayCallOf<'run'>): void {
    const { type: _type, ...run } = call;
    const line = `${JSON.stringify(run satisfies Heard)}\n`;
    for (const wait of this.waits.values()) if (wait.runs.has(run.run)) wait.heard(line);
  }

  stop(): void {
    this.stopping = true;
  }

  private name(wait: Wait): void {
    this.send({ type: 'waiting', wait: wait.id, runs: [...wait.runs] });
  }

  private async end(wait: Wait, recorded: boolean): Promise<void> {
    if (this.stopping) return;
    this.waits.delete(wait.id);
    this.send({ type: 'waiting', wait: wait.id, runs: [] });
    if (recorded) await rm(join(kitHome(), recordOf(wait.id)), { force: true });
  }

  private resolved(asked: Asked[]): Promise<Resolved['runs']> {
    const reading = this.names.then(async () => {
      const kept = (await readHome<Named[]>(NAMES)) ?? [];
      const learned = asked.filter((one): one is Named => one.run !== undefined && one.name !== undefined && isRunReference(one.run));
      const resolved = asked.map(({ run, name }) => {
        if (run !== undefined) {
          if (!isRunReference(run)) throw new Refused(`${run} is no Run reference`);
          return { run, name: name ?? null };
        }
        const runs = new Set([...learned, ...kept].filter((one) => one.name === name).map((one) => one.run));
        if (runs.size === 0) throw new Refused(`${name} names no Run started on this computer; wait on its reference`);
        if (runs.size > 1) throw new Refused(`${name} names more than one Run started on this computer; wait on its reference`);
        return { run: [...runs][0]!, name: name! };
      });
      const fresh = learned.filter((one) => !kept.some((held) => held.run === one.run));
      if (fresh.length > 0) await writeHome(NAMES, [...kept, ...fresh.map(({ name, run }) => ({ name, run }))].slice(-NAMES_KEPT));
      return resolved;
    });
    this.names = reading.catch(() => undefined);
    return reading;
  }
}
