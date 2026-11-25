import { KIT_WAITED_RUNS, KIT_WAITED_RUNS_MAX, type KitRunState } from '@agentshouse/kit-wire';
import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import { createInterface } from 'node:readline';
import { text as textOf } from 'node:stream/consumers';
import { answerDocument } from './mcp.ts';

export const AGENT_RUN_USAGE = `usage: house agent run '{"runs":[{"room":"<handle>","agent_function":"<card>","payload":"<brief>"}]}', each Run with agent_update request_send's arguments, or house agent run '{"refs":["<Run reference or name>"]}' to wait again; - reads them from stdin`;

export const WAIT_PATH = '/runs/wait';

export const OUTPUT_BYTES_MAX = 32 * 1024;

const STARTS_BYTES_MAX = OUTPUT_BYTES_MAX / 2;

const LINE_BYTES_MAX = 1024;

const CUT_NOTE_BYTES = 80;


const ENDS: ReadonlySet<KitRunState> = new Set(['idle', 'failed', 'not_started', 'declined', 'withdrawn', 'deleted']);

const WORDS: Readonly<Record<KitRunState, string>> = {
  waiting: 'waiting',
  undelivered: 'undelivered',
  working: 'working',
  idle: 'idle',
  failed: 'failed',
  not_started: 'not started',
  declined: 'declined',
  withdrawn: 'withdrawn',
  deleted: 'deleted',
};

// A quarter second finds the Kit's owner socket soon after the Kit starts again, and costs only a local connect.
const KIT_BACK_MS = 250;

export interface Asked {
  run?: string;
  name?: string;
}

export interface Heard {
  run: string;
  name?: string;
  state: KitRunState;
  cause?: string;
}

export interface Again {
  again: true;
}

export interface Resolved {
  runs: { run: string; name: string | null }[];
}

export interface Asking {
  call(name: string, args: Record<string, unknown>): Promise<string>;
  socket: string;
  inside: boolean;
}

interface Waited {
  run: string;
  name: string | null;
  state: KitRunState | null;
  cause: string | null;
}

type Given = { runs: Record<string, unknown>[] } | { refs: string[] };

export function isRunReference(text: string): boolean {
  return KIT_WAITED_RUNS.element.safeParse(text).success;
}

function cutTo(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let kept = text.slice(0, bytes);
  while (Buffer.byteLength(`${kept}…`) > bytes) kept = kept.slice(0, -1);
  return `${kept}…`;
}

class Printed {
  private used = 0;
  private cut = 0;

  line(text: string, limit: number): void {
    const line = `${cutTo(text.replaceAll('\n', ' '), LINE_BYTES_MAX)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.used + bytes > limit) {
      this.cut++;
      return;
    }
    this.used += bytes;
    process.stdout.write(line);
  }

  note(text: string): void {
    const line = `house: ${text}\n`;
    this.used += Buffer.byteLength(line);
    process.stderr.write(line);
  }

  left(): number {
    return OUTPUT_BYTES_MAX - this.used - CUT_NOTE_BYTES;
  }

  end(): void {
    if (this.cut > 0) process.stdout.write(`${this.cut} more lines cut to stay within 32 kB\n`);
  }
}

function given(parsed: unknown): Given {
  const object = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const keys = object === null ? [] : Object.keys(object);
  if (object === null || keys.length !== 1 || !['runs', 'refs'].includes(keys[0]!)) throw new Error(AGENT_RUN_USAGE);
  const listed = object[keys[0]!];
  if (!Array.isArray(listed) || listed.length === 0) throw new Error(`"${keys[0]}" lists one or more entries; ${AGENT_RUN_USAGE}`);
  if (listed.length > KIT_WAITED_RUNS_MAX) throw new Error(`house agent run waits on at most ${KIT_WAITED_RUNS_MAX} Runs at once`);
  if (keys[0] === 'runs') {
    if (!listed.every((run) => typeof run === 'object' && run !== null && !Array.isArray(run))) throw new Error(`each of "runs" is an object; ${AGENT_RUN_USAGE}`);
    return { runs: listed as Record<string, unknown>[] };
  }
  if (!listed.every((ref) => typeof ref === 'string' && ref !== '')) throw new Error(`each of "refs" is a Run's reference or name; ${AGENT_RUN_USAGE}`);
  return { refs: listed as string[] };
}

async function argument(args: string[]): Promise<Given | null> {
  if (args.length === 1 && args[0] === '--help') return null;
  if (args.length !== 1 || (args[0]!.startsWith('-') && args[0] !== '-')) throw new Error(AGENT_RUN_USAGE);
  const text = args[0] === '-' ? await textOf(process.stdin) : args[0]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(AGENT_RUN_USAGE);
  }
  return given(parsed);
}

async function started(runs: Record<string, unknown>[], asking: Asking, printed: Printed): Promise<{ asked: Asked[]; refused: boolean }> {
  const asked: Asked[] = [];
  let refused = false;
  for (const [index, run] of runs.entries()) {
    let answer: { request?: unknown; runName?: unknown } | null;
    try {
      answer = answerDocument(await asking.call('agent_update', { ...run, op: 'request_send' }));
    } catch (error) {
      refused = true;
      printed.line(`runs[${index}] refused: ${error instanceof Error ? error.message : String(error)}`, STARTS_BYTES_MAX);
      continue;
    }
    const ref = typeof answer?.request === 'string' ? answer.request : null;
    if (ref === null) {
      refused = true;
      printed.line(`runs[${index}] refused: House's answer named no Run`, STARTS_BYTES_MAX);
      continue;
    }
    const name = typeof answer?.runName === 'string' ? answer.runName : undefined;
    asked.push({ run: ref, ...(name === undefined ? {} : { name }) });
    printed.line(`${name ?? ref} ${ref}`, STARTS_BYTES_MAX);
  }
  return { asked, refused };
}

function ended(waited: Waited[]): boolean {
  return waited.length > 0 && waited.every(({ state }) => state !== null && ENDS.has(state));
}

function stateLine({ run, name, state, cause }: Waited): string {
  const word = WORDS[state!];
  const named = name === null ? run : `${name} ${run}`;
  return cause === null ? `${named} ${word}` : `${named} ${word}: ${cause}`;
}

function refusedWait(answer: IncomingMessage, text: string): Error {
  return new Error(text.trim() === '' ? `the Kit refused the wait with ${answer.statusCode}` : text.trim());
}

class Lost extends Error {}

function waitedOnce(asking: Asking, asked: Asked[], waited: Waited[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let sent: ClientRequest;
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      sent.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    sent = request({ socketPath: asking.socket, path: WAIT_PATH, method: 'POST', headers: { 'content-type': 'application/json' } }, (answer) => {
      if (answer.statusCode !== 200) {
        void textOf(answer).then((text) => settle(refusedWait(answer, text)), () => settle(new Lost()));
        return;
      }
      let first = true;
      const lines = createInterface({ input: answer });
      lines.on('line', (line) => {
        if (line === '') return;
        if (first) {
          first = false;
          const resolved = JSON.parse(line) as Resolved;
          waited.splice(0, waited.length, ...resolved.runs.map(({ run, name }) => ({ run, name, state: null, cause: null })));
          return;
        }
        const heard = JSON.parse(line) as Heard | Again;
        if ('again' in heard) {
          for (const one of waited) one.state = null;
          return;
        }
        for (const one of waited) {
          if (one.run !== heard.run) continue;
          one.state = heard.state;
          one.cause = heard.cause ?? null;
          if (heard.name !== undefined) one.name = heard.name;
        }
        if (ended(waited)) settle();
      });
      lines.on('error', () => settle(new Lost()));
      answer.on('error', () => settle(new Lost()));
      answer.on('close', () => settle(new Lost()));
    });
    sent.on('error', () => settle(new Lost()));
    sent.end(JSON.stringify({ runs: asked }));
  });
}

async function waitedOn(asking: Asking, asked: Asked[], printed: Printed): Promise<Waited[] | null> {
  const waited: Waited[] = [];
  let told = false;
  for (;;) {
    const again = waited.length === 0 ? asked : waited.map(({ run, name }) => ({ run, ...(name === null ? {} : { name }) }));
    try {
      await waitedOnce(asking, again, waited);
      return waited;
    } catch (error) {
      if (!(error instanceof Lost)) throw error;
      if (asking.inside) return waited.length === 0 ? null : waited;
      if (!told) printed.note('the Kit process does not answer on this computer; house agent run waits until it does');
      told = true;
    }
    await new Promise((resolve) => setTimeout(resolve, KIT_BACK_MS));
  }
}

function waitAgain(waited: Waited[], asked: Asked[], bytes: number): string {
  const refs = waited.length === 0 ? asked.map(({ run, name }) => run ?? name!) : waited.map(({ run }) => run);
  const said = (kept: string[]) => `the Kit ended this wait before its Runs ended; house agent run '${JSON.stringify({ refs: kept })}' waits again`;
  const whole = said(refs);
  if (Buffer.byteLength(whole) <= bytes) return whole;
  const cutNote = (cut: number) => `; ${cut} more of its Runs cut to stay within 32 kB`;
  let used = Buffer.byteLength(said([])) + Buffer.byteLength(cutNote(refs.length));
  const kept: string[] = [];
  for (const ref of refs) {
    used += Buffer.byteLength(JSON.stringify(ref)) + 1;
    if (used > bytes) break;
    kept.push(ref);
  }
  return `${said(kept)}${cutNote(refs.length - kept.length)}`;
}

export async function agentRun(args: string[], asking: Asking, about: string): Promise<void> {
  const input = await argument(args);
  if (input === null) {
    process.stdout.write(`${AGENT_RUN_USAGE}\n${about}\n`);
    return;
  }
  const printed = new Printed();
  const { asked, refused } =
    'runs' in input
      ? await started(input.runs, asking, printed)
      : { asked: input.refs.map((ref): Asked => (isRunReference(ref) ? { run: ref } : { name: ref })), refused: false };
  process.exitCode = 1;
  if (asked.length === 0) {
    printed.end();
    return;
  }
  let waited: Waited[] | null;
  try {
    waited = await waitedOn(asking, asked, printed);
  } catch (error) {
    printed.end();
    throw new Error(cutTo(error instanceof Error ? error.message : String(error), printed.left()));
  }
  if (waited === null || !ended(waited)) {
    printed.end();
    throw new Error(waitAgain(waited ?? [], asked, printed.left()));
  }
  for (const one of waited) printed.line(stateLine(one), OUTPUT_BYTES_MAX - CUT_NOTE_BYTES);
  printed.end();
  if (!refused && waited.every(({ state }) => state === 'idle')) process.exitCode = 0;
}
