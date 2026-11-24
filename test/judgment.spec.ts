import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { settle, until, type KitConnection } from './double.ts';
import { hostKit, lastCall, type Hosted } from './environment.ts';
import { stop } from './kit.ts';

type Judged = { turn: string; secret: boolean; background: boolean | 'runs' };

const IDLE: Judged = { turn: 'ended', secret: false, background: false };
const RUNNING: Judged = { turn: 'running', secret: false, background: true };
const WORKING: Judged = { turn: 'ended', secret: false, background: true };
const WAITING: Judged = { turn: 'ended', secret: false, background: 'runs' };

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path === '/kit/turns/end');

function judgments(connection: KitConnection, conversation = 'conversation-1'): Judged[] {
  return connection.oneWayCalls
    .filter((oneWayCall) => oneWayCall.type === 'judgment' && oneWayCall.conversation_id === conversation)
    .map(({ turn, secret, background }) => ({ turn, secret, background }) as Judged);
}

function judging(hosted: Hosted, judgment: Judged): Promise<unknown> {
  return until(() => JSON.stringify(judgments(hosted.house.connections.at(-1)!).at(-1)) === JSON.stringify(judgment));
}

async function opened(): Promise<Hosted> {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  await judging(hosted, IDLE);
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
  const from = judgments(hosted.connection).length;

  hosted.call({ kind: 'message', text: '@ask', first: true });
  const question = await until(() => hosted.interactions[0]);
  await judging(hosted, { turn: 'asking', secret: false, background: false });
  const { interaction_id } = question.body as { interaction_id: string };
  hosted.call({ kind: 'answer', interaction_id, response: { outcome: { outcome: 'cancelled' } } });
  await until(() => ended(hosted)[0]);
  await judging(hosted, IDLE);
  await settle();

  expect(judgments(hosted.connection).slice(from)).toEqual([RUNNING, { turn: 'asking', secret: false, background: false }, RUNNING, IDLE]);
  for (const oneWayCall of hosted.connection.oneWayCalls.filter(({ type }) => type === 'judgment')) {
    expect(Object.keys(oneWayCall).sort()).toEqual(['background', 'conversation_id', 'secret', 'turn', 'type']);
  }
});

it('reports a turn waiting on a secret question as asking for a secret', async () => {
  const hosted = await opened();
  hosted.house.route('POST', '/kit/secret-inputs/await', async () => {
    // House holds the secret question two tenths of a second each time, so the Kit keeps holding it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { body: { outcome: 'released', release: 'held' } };
  });

  hosted.call({ kind: 'message', text: `@secret ${createHash('sha256').update('x').digest('hex')}`, first: true });

  await judging(hosted, { turn: 'asking', secret: true, background: false });
  await settle();
  expect(hosted.idles).toHaveLength(2);
});

it('reports background work while its evidence is uncertain, a schedule file the Kit cannot parse, and the process idle once it goes', async () => {
  const hosted = await opened();
  await said(hosted, '@say started');
  await judging(hosted, IDLE);

  await mkdir(join(hosted.workingDirectory, '.claude'));
  await writeFile(join(hosted.workingDirectory, '.claude', 'scheduled_tasks.json'), '{"tasks": [');

  await judging(hosted, WORKING);
  const idles = hosted.idles.length;
  await rm(join(hosted.workingDirectory, '.claude', 'scheduled_tasks.json'));
  await judging(hosted, IDLE);
  await until(() => hosted.idles[idles]);
});

it.each([
  ['the command itself', ''],
  ['the shell that waits on it', ' sh'],
])('reports waiting on Runs while all its background work is house agent run commands, through %s, and background work once anything else runs beside them', async (_form, through) => {
  const hosted = await opened();
  const idles = hosted.idles.length;

  await said(hosted, `@job job-1\n@runs${through}`);

  await judging(hosted, WAITING);
  await said(hosted, '@spawn');
  await judging(hosted, WORKING);
  const job = await logged(hosted, 'spawned');
  stop(await logged(hosted, 'clean'));
  stop(job);
  await said(hosted, '@say again');
  await judging(hosted, WAITING);
  await settle();
  expect(hosted.idles).toHaveLength(idles);

  stop(-(await logged(hosted, 'waiting')));
  await said(hosted, '@jobdone job-1');
  await judging(hosted, IDLE);
  await until(() => hosted.idles[idles]);
});

it('reports background work for what a crashed process left, after its end, and the process idle once that ends', async () => {
  const hosted = await opened();

  await said(hosted, '@spawn\n@exit 1');

  await until(() => hosted.connection.oneWayCalls.find(({ type, running }) => type === 'process' && running === false));
  await judging(hosted, WORKING);
  stop(await logged(hosted, 'clean'));
  stop(await logged(hosted, 'spawned'));
  await judging(hosted, IDLE);
});

it("reports each running process's judgment again on a Kit connection that reopens", async () => {
  const hosted = await opened();
  await said(hosted, '@say started');
  await judging(hosted, IDLE);

  hosted.house.connections.at(-1)!.close(1001, 'shutting_down');
  const reopened = await until(() => hosted.house.connections[1]);

  await until(() => judgments(reopened)[0]);
  await settle();
  expect(judgments(reopened)).toEqual([IDLE]);
});
