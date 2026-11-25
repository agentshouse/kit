import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { settle, until, type KitConnection } from './double.ts';
import { hostKit, lastCall, type Hosted, type Hosting } from './environment.ts';
import { alive, temporaryDirectory } from './kit.ts';

type Reported = { turn: string; secret: boolean; background: boolean | 'runs' };

const IDLE: Reported = { turn: 'ended', secret: false, background: false };
const RUNNING: Reported = { turn: 'running', secret: false, background: true };
const WORKING: Reported = { turn: 'ended', secret: false, background: true };
const WAITING: Reported = { turn: 'ended', secret: false, background: 'runs' };

const PROCESS_READS = fileURLToPath(new URL('./process-reads.ts', import.meta.url));

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
  await until(() => hosted.idles[1]);
  return hosted;
}

async function said(hosted: Hosted, text: string): Promise<void> {
  const turns = ended(hosted).length;
  hosted.call({ kind: 'message', text: `${text}\n@say done`, first: turns === 0 });
  await until(() => ended(hosted)[turns]);
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

async function reads(log: string): Promise<number> {
  return (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '').length;
}

it('reports the process idle once its turn ends while what it started runs that its CLI tracks as no unfinished work, reading no process for it: an MCP server it started with its session, a language server it started in the turn and a server the agent left running', async () => {
  const log = join(await temporaryDirectory(), 'process-reads');
  const hosted = await opened({
    environment: { KIT_PROCESS_READS: log },
    node: ['--import', PROCESS_READS],
    prepare: (home) => writeFile(join(home, 'start-server'), ''),
  });
  const mcp = await logged(hosted, 'server');
  const idles = hosted.idles.length;
  const read = await reads(log);

  await said(hosted, '@server\n@sh sleep 606 > /dev/null 2>&1 & echo $!');
  const [language, left] = [await logged(hosted, 'server'), Number(await logged(hosted, 'stdout'))];

  await reporting(hosted, IDLE);
  await until(() => hosted.idles[idles]);
  await settle();
  expect(activities(hosted.connection).at(-1)).toEqual(IDLE);
  expect([mcp, language, left].map(alive)).toEqual([true, true, true]);
  expect(new Set([mcp, language, left]).size).toBe(3);
  expect(await reads(log)).toBe(read);
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
  ['by its name', `house agent run '{"refs":["019a0000-0000-7000-8000-000000000a17"]}'`],
  ['by a path', '/usr/local/bin/house agent run -'],
])('reports waiting on Runs while all its background work is background commands its CLI reports running house agent run %s, and background work once anything else runs beside them', async (_form, command) => {
  const hosted = await opened();
  const idles = hosted.idles.length;

  await said(hosted, `@job job-1 ${command}`);

  await reporting(hosted, WAITING);
  await said(hosted, '@job job-2 sleep 600');
  await reporting(hosted, WORKING);
  await said(hosted, '@jobdone job-2');
  await reporting(hosted, WAITING);
  await settle();
  expect(hosted.idles).toHaveLength(idles);

  await said(hosted, '@jobdone job-1');
  await reporting(hosted, IDLE);
  await until(() => hosted.idles[idles]);
});

it('reports the process idle once it crashes, though what it started still runs', async () => {
  const hosted = await opened();

  await said(hosted, '@spawn\n@exit 1');

  await until(() => hosted.connection.oneWayCalls.find(({ type, running }) => type === 'process' && running === false));
  await reporting(hosted, IDLE);
  expect(alive(await logged(hosted, 'spawned'))).toBe(true);
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

it('tells a reopened Kit connection the activity a closed one did not take, after the background work its CLI keeps ended', async () => {
  const hosted = await opened();
  await mkdir(join(hosted.workingDirectory, '.claude'));
  const tasks = join(hosted.workingDirectory, '.claude', 'scheduled_tasks.json');
  await writeFile(tasks, JSON.stringify({ tasks: [{ id: '7b99af94', cron: '0 3 1 1 *', prompt: 'say hi', createdAt: 1791648534000, recurring: true }] }));
  await reporting(hosted, WORKING);
  const upgrades = () => hosted.house.requests.filter((request) => request.method === 'UPGRADE').length;
  const before = upgrades();
  const admit = hosted.house.holdConnections();

  hosted.house.connections.at(-1)!.close(1001, 'shutting_down');
  await until(() => upgrades() > before);
  await rm(tasks);
  await settle();
  expect(activities(hosted.connection).at(-1)).toEqual(WORKING);
  admit();

  const reopened = await until(() => hosted.house.connections[1]);
  await until(() => activities(reopened)[0]);
  await settle();
  expect(activities(reopened)).toEqual([IDLE]);
});
