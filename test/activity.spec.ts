import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { settle, until, type KitConnection } from './double.ts';
import { hostKit, lastCall, type Hosted, type Hosting } from './environment.ts';
import { alive, stop, temporaryDirectory } from './kit.ts';

type Reported = { turn: string; secret: boolean; background: boolean | 'runs' };

const IDLE: Reported = { turn: 'ended', secret: false, background: false };
const RUNNING: Reported = { turn: 'running', secret: false, background: true };
const WORKING: Reported = { turn: 'ended', secret: false, background: true };
const WAITING: Reported = { turn: 'ended', secret: false, background: 'runs' };

const FAST_INTERVALS = ['--import', fileURLToPath(new URL('./fast-intervals.ts', import.meta.url))];
const ENDING = ['--import', fileURLToPath(new URL('./ending.ts', import.meta.url))];
const CONTROL_GROUP = process.env.KIT_TEST_CGROUP === '1';

// A second and a half lets any look the Kit keeps at a scope, capped at 300 ms under fast-intervals, run several times.
const LOOKS_MS = 1_500;

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path === '/kit/turns/end');

function activities(connection: KitConnection, conversation = 'conversation-1'): Reported[] {
  return connection.oneWayCalls
    .filter((oneWayCall) => oneWayCall.type === 'activity' && oneWayCall.conversation_id === conversation)
    .map(({ turn, secret, background }) => ({ turn, secret, background }) as Reported);
}

async function reporting(hosted: Hosted, activity: Reported): Promise<void> {
  const reported = () => activities(hosted.house.connections.at(-1)!);
  try {
    await until(() => JSON.stringify(reported().at(-1)) === JSON.stringify(activity));
  } catch {
    throw new Error(`the Kit never reported ${JSON.stringify(activity)} last; it reported ${JSON.stringify(reported())}`);
  }
}

async function opened(hosting: Hosting = {}): Promise<Hosted> {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }], hosting);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  await reporting(hosted, IDLE);
  await until(() => hosted.idles[1]);
  return hosted;
}

async function said(hosted: Hosted, text: string): Promise<void> {
  const turns = ended(hosted).length;
  hosted.call({ kind: 'message', text: `${text}\n@say done`, first: turns === 0 });
  await until(() => ended(hosted)[turns]);
}

async function outside(): Promise<number> {
  const holder = spawn('sh', ['-c', 'sleep 600 & echo $!; exec sleep 600'], { stdio: ['ignore', 'pipe', 'ignore'] });
  onTestFinished(() => void holder.kill('SIGKILL'));
  const [pid] = (await once(createInterface({ input: holder.stdout }), 'line')) as [string];
  return Number(pid);
}

async function logged(hosted: Hosted, field: string): Promise<number> {
  return (await until(async () => (await hosted.adapterLog()).findLast((entry) => entry[field] !== undefined)))![field] as number;
}

it("reports each change of a process's turn and background work once, both parts in each report", async () => {
  const hosted = await opened();
  const from = activities(hosted.connection).length;

  hosted.call({ kind: 'message', text: '@ask', first: true });
  const question = await until(() => hosted.interactions[0]);
  await reporting(hosted, { turn: 'asking', secret: false, background: false });
  const { interaction_id } = question.body as { interaction_id: string };
  hosted.call({ kind: 'answer', interaction_id, response: { outcome: { outcome: 'cancelled' } } });
  await until(() => ended(hosted)[0]);
  await reporting(hosted, IDLE);
  await settle();

  expect(activities(hosted.connection).slice(from)).toEqual([RUNNING, { turn: 'asking', secret: false, background: false }, RUNNING, IDLE]);
  for (const oneWayCall of hosted.connection.oneWayCalls.filter(({ type }) => type === 'activity')) {
    expect(Object.keys(oneWayCall).sort()).toEqual(['background', 'conversation_id', 'secret', 'turn', 'type']);
  }
});

it.skipIf(CONTROL_GROUP)("reports no background work for a process of the Kit's user outside the conversation that ends while the Kit reads the conversation's processes", async () => {
  const ending = join(await temporaryDirectory(), 'ending');
  const hosted = await opened({ environment: { KIT_ENDING: ending }, node: ENDING });
  const from = activities(hosted.connection).length;
  await writeFile(ending, String(await outside()));

  await said(hosted, '@say read');
  await reporting(hosted, IDLE);
  await settle();

  await expect(access(ending)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(activities(hosted.connection).slice(from)).toEqual([RUNNING, IDLE]);
});

it('reports a turn waiting on a secret question as asking for a secret', async () => {
  const hosted = await opened();
  hosted.house.route('POST', '/kit/secret-inputs/await', async () => {
    // House holds the secret question two tenths of a second each time, so the Kit keeps holding it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { body: { outcome: 'released', release: 'held' } };
  });

  hosted.call({ kind: 'message', text: `@secret ${createHash('sha256').update('x').digest('hex')}`, first: true });

  await reporting(hosted, { turn: 'asking', secret: true, background: false });
  await settle();
  expect(hosted.idles).toHaveLength(2);
});

it('reports background work while its evidence is uncertain, a schedule file the Kit cannot parse, and the process idle once it goes', async () => {
  const hosted = await opened();
  await said(hosted, '@say started');
  await reporting(hosted, IDLE);

  await mkdir(join(hosted.workingDirectory, '.claude'));
  await writeFile(join(hosted.workingDirectory, '.claude', 'scheduled_tasks.json'), '{"tasks": [');

  await reporting(hosted, WORKING);
  const idles = hosted.idles.length;
  await rm(join(hosted.workingDirectory, '.claude', 'scheduled_tasks.json'));
  await reporting(hosted, IDLE);
  await until(() => hosted.idles[idles]);
});

it.each([
  ['the command itself', ''],
  ['the shell that waits on it', ' sh'],
])('reports waiting on Runs while all its background work is house agent run commands, through %s, and background work once anything else runs beside them', async (_form, through) => {
  const hosted = await opened();
  const idles = hosted.idles.length;

  await said(hosted, `@job job-1\n@runs${through}`);

  await reporting(hosted, WAITING);
  await said(hosted, '@spawn');
  await reporting(hosted, WORKING);
  const [job, clean] = [await logged(hosted, 'spawned'), await logged(hosted, 'clean')];
  stop(clean);
  stop(job);
  await until(() => !alive(job) && !alive(clean));
  await said(hosted, '@say again');
  await reporting(hosted, WAITING);
  await settle();
  expect(hosted.idles).toHaveLength(idles);

  stop(-(await logged(hosted, 'waiting')));
  await said(hosted, '@jobdone job-1');
  await reporting(hosted, IDLE);
  await until(() => hosted.idles[idles]);
});

it('reports background work for what a crashed process left, after its end, and the process idle once that ends', async () => {
  const hosted = await opened();

  await said(hosted, '@spawn\n@exit 1');

  await until(() => hosted.connection.oneWayCalls.find(({ type, running }) => type === 'process' && running === false));
  await reporting(hosted, WORKING);
  stop(await logged(hosted, 'clean'));
  stop(await logged(hosted, 'spawned'));
  await reporting(hosted, IDLE);
});

it("reports each running process's activity again on a Kit connection that reopens", async () => {
  const hosted = await opened();
  await said(hosted, '@say started');
  await reporting(hosted, IDLE);

  hosted.house.connections.at(-1)!.close(1001, 'shutting_down');
  const reopened = await until(() => hosted.house.connections[1]);

  await until(() => activities(reopened)[0]);
  await settle();
  expect(activities(reopened)).toEqual([IDLE]);
});

it('tells a reopened Kit connection the activity a closed one did not take, after the process and what it left ended', async () => {
  const hosted = await opened({ node: FAST_INTERVALS });
  await said(hosted, '@spawn\n@exit 1');
  await reporting(hosted, WORKING);
  const upgrades = () => hosted.house.requests.filter((request) => request.method === 'UPGRADE').length;
  const before = upgrades();
  const admit = hosted.house.holdConnections();

  hosted.house.connections.at(-1)!.close(1001, 'shutting_down');
  await until(() => upgrades() > before);
  stop(await logged(hosted, 'clean'));
  stop(await logged(hosted, 'spawned'));
  await new Promise((resolve) => setTimeout(resolve, LOOKS_MS));
  expect(activities(hosted.connection).at(-1)).toEqual(WORKING);
  admit();

  const reopened = await until(() => hosted.house.connections[1]);
  await until(() => activities(reopened)[0]);
  await settle();
  expect(activities(reopened)).toEqual([IDLE]);
});
