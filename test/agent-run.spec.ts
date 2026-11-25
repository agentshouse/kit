import { CONVERSATION_META_KEY, type KitRunState } from '@agentshouse/kit-wire';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { settle, startHouse, until, type KitConnection, type Received } from './double.ts';
import { hostKit, opened, runs, type Hosted, type McpCall, type ToolResult } from './environment.ts';
import { writeFile } from 'node:fs/promises';
import { accountOf, runKit, stop, temporaryHome } from './kit.ts';

const HOUSE = fileURLToPath(new URL('../src/house-main.ts', import.meta.url));
const ROOM = 'garden-club';
const AGENT = '019a0000-0000-7000-8000-0000000000a2';
const RUN_1 = '019a0000-0000-7000-8000-000000000001';
const RUN_2 = '019a0000-0000-7000-8000-000000000002';
const WAITED_RUN = '019a0000-0000-7000-8000-000000000a17';
const REVIEW = { room: ROOM, agent_function: 'review', payload: 'the diff' };
const USAGE = `usage: house agent run '{"runs":[{"room":"<handle>","agent_function":"<card>","payload":"<brief>"}]}', each Run with agent_update request_send's arguments, or house agent run '{"refs":["<Run reference or name>"]}' to wait again; - reads them from stdin`;
const OWN_WORDS = { room: ROOM, agent: AGENT, payload: 'the plan', model: 'route-model', copy: 'new' };

interface Command {
  pid: number;
  stdout(): string;
  ended: Promise<{ status: number | null; stdout: string; stderr: string }>;
}

function started(run: string, name: string): ToolResult {
  return { content: [{ type: 'text', text: `request: ${run}\nrunName: ${name}\nroomId: 019a0000-0000-7000-8000-0000000000f1\nagentId: ${AGENT}\nduplicate: false\n` }] };
}

function refused(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function answering(hosted: Hosted, ...answers: ToolResult[]): Received[] {
  const asked: Received[] = [];
  hosted.tools.agent_update = (_args, request) => {
    asked.push(request);
    return answers.shift() ?? refused('not_found: no such request');
  };
  return asked;
}

async function bridgeOf(hosted: Hosted): Promise<string> {
  await opened(hosted);
  const entry = await until(async () =>
    (await hosted.adapterLog()).find((logged) => logged.method === 'initialize' && (logged.env as Record<string, string> | undefined)?.HOUSE_BRIDGE !== undefined),
  );
  return (entry.env as Record<string, string>).HOUSE_BRIDGE!;
}

function agentRun(hosted: Hosted, input: unknown, bridge?: string): Command {
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: accountOf(hosted.home) };
  delete environment.HOUSE_BRIDGE;
  if (bridge !== undefined) environment.HOUSE_BRIDGE = bridge;
  const child = spawn(process.execPath, [HOUSE, 'agent', 'run', '-'], { env: environment });
  child.stdin.end(JSON.stringify(input));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const ended = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on('close', (status) => resolve({ status, stdout, stderr })),
  );
  onTestFinished(() => stop(child.pid!));
  return { pid: child.pid!, stdout: () => stdout, ended };
}

function waitings(connection: KitConnection): { wait: string; runs: string[] }[] {
  return connection.oneWayCalls.filter((oneWayCall) => oneWayCall.type === 'waiting') as unknown as { wait: string; runs: string[] }[];
}

function named(hosted: Hosted, runs: string[]): Promise<{ wait: string; runs: string[] }> {
  return until(() => waitings(hosted.house.connections.at(-1)!).find((waiting) => JSON.stringify(waiting.runs) === JSON.stringify(runs)));
}

function told(hosted: Hosted, run: string, state: KitRunState, more: { name?: string; cause?: string } = {}): void {
  hosted.house.connections.at(-1)!.send({ type: 'run', run, state, ...more });
}

function records(hosted: Hosted): Promise<Record<string, unknown>[]> {
  const folder = join(hosted.home, 'run-waits');
  return readdir(folder)
    .catch(() => [] as string[])
    .then((files) =>
      Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => JSON.parse(await readFile(join(folder, file), 'utf8')) as Record<string, unknown>)),
    );
}

it('starts two Runs by one start act each, prints both names and references at once, and ends once both are idle with exit 0', async () => {
  const hosted = await hostKit();
  const asked = answering(hosted, started(RUN_1, 'rev-1'), started(RUN_2, 'ba-1'));
  const bridge = await bridgeOf(hosted);

  const command = agentRun(hosted, { runs: [REVIEW, OWN_WORDS] }, bridge);

  await until(() => command.stdout() === `rev-1 ${RUN_1}\nba-1 ${RUN_2}\n`);
  const { wait } = await named(hosted, [RUN_1, RUN_2]);
  expect(asked.map((request) => (request.body as McpCall).params.arguments)).toEqual([
    { ...REVIEW, op: 'request_send' },
    { ...OWN_WORDS, op: 'request_send' },
  ]);
  expect(asked.map((request) => (request.body as McpCall).params._meta[CONVERSATION_META_KEY])).toEqual(['conversation-1', 'conversation-1']);
  told(hosted, RUN_1, 'working', { name: 'rev-1' });
  told(hosted, RUN_2, 'undelivered', { name: 'ba-1' });
  told(hosted, RUN_1, 'idle', { name: 'rev-1' });
  told(hosted, RUN_2, 'waiting', { name: 'ba-1' });
  await settle();
  expect(command.stdout()).toBe(`rev-1 ${RUN_1}\nba-1 ${RUN_2}\n`);

  told(hosted, RUN_2, 'idle', { name: 'ba-1' });

  expect(await command.ended).toEqual({ status: 0, stdout: `rev-1 ${RUN_1}\nba-1 ${RUN_2}\nrev-1 ${RUN_1} idle\nba-1 ${RUN_2} idle\n`, stderr: '' });
  await until(() => waitings(hosted.house.connections.at(-1)!).find((waiting) => waiting.wait === wait && waiting.runs.length === 0));
});

it("holds the wait in the foreground of a conversation's turn, which ends once the command does", async () => {
  const hosted = await hostKit();
  answering(hosted, started(RUN_1, 'rev-1'));
  await opened(hosted);

  hosted.call({ kind: 'message', text: `@house agent run ${JSON.stringify({ runs: [REVIEW] })}\n@say done`, first: true });

  await named(hosted, [RUN_1]);
  await settle();
  expect(hosted.turns.filter((turn) => turn.path === '/kit/turns/end')).toEqual([]);
  told(hosted, RUN_1, 'idle', { name: 'rev-1' });
  const [ran] = await runs(hosted, 1);
  expect(ran).toMatchObject({ house: ['agent', 'run', JSON.stringify({ runs: [REVIEW] })], status: 0, stdout: `rev-1 ${RUN_1}\nrev-1 ${RUN_1} idle\n` });
  await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end'));
});

it.each([
  ['a failed Run, with its cause', 'failed' as const, { cause: 'cli_limit_reached' }, `ba-1 ${RUN_2} failed: cli_limit_reached`],
  ['a deleted Run, printed deleted', 'deleted' as const, {}, `ba-1 ${RUN_2} deleted`],
])('ends with exit 1 at %s', async (_case, state, more, line) => {
  const hosted = await hostKit();
  answering(hosted, started(RUN_1, 'rev-1'), started(RUN_2, 'ba-1'));
  const bridge = await bridgeOf(hosted);
  const command = agentRun(hosted, { runs: [REVIEW, OWN_WORDS] }, bridge);
  await named(hosted, [RUN_1, RUN_2]);

  told(hosted, RUN_1, 'idle', { name: 'rev-1' });
  told(hosted, RUN_2, state, more);

  expect(await command.ended).toEqual({ status: 1, stdout: `rev-1 ${RUN_1}\nba-1 ${RUN_2}\nrev-1 ${RUN_1} idle\n${line}\n`, stderr: '' });
});

it('prints a refused start and starts and waits on the others, ending with exit 1', async () => {
  const hosted = await hostKit();
  answering(hosted, refused('own_text_not_admitted: the Agent takes no own words in garden-club'), started(RUN_2, 'ba-1'));
  const bridge = await bridgeOf(hosted);

  const command = agentRun(hosted, { runs: [OWN_WORDS, REVIEW] }, bridge);

  await until(() => command.stdout() === `runs[0] refused: own_text_not_admitted: the Agent takes no own words in garden-club\nba-1 ${RUN_2}\n`);
  await named(hosted, [RUN_2]);
  told(hosted, RUN_2, 'idle', { name: 'ba-1' });
  expect(await command.ended).toEqual({
    status: 1,
    stdout: `runs[0] refused: own_text_not_admitted: the Agent takes no own words in garden-club\nba-1 ${RUN_2}\nba-1 ${RUN_2} idle\n`,
    stderr: '',
  });
});

it("waits again on refs, its own Runs' names or references, starting nothing, and refuses a name it started no Run of", async () => {
  const hosted = await hostKit();
  const asked = answering(hosted, started(RUN_2, 'ba-1'));
  const bridge = await bridgeOf(hosted);
  const first = agentRun(hosted, { runs: [OWN_WORDS] }, bridge);
  await named(hosted, [RUN_2]);
  told(hosted, RUN_2, 'idle', { name: 'ba-1' });
  expect((await first.ended).status).toBe(0);

  const again = agentRun(hosted, { refs: [RUN_1, 'ba-1'] }, bridge);

  await named(hosted, [RUN_1, RUN_2]);
  told(hosted, RUN_1, 'working', { name: 'rev-1' });
  told(hosted, RUN_2, 'idle', { name: 'ba-1' });
  told(hosted, RUN_1, 'idle', { name: 'rev-1' });
  expect(await again.ended).toEqual({ status: 0, stdout: `rev-1 ${RUN_1} idle\nba-1 ${RUN_2} idle\n`, stderr: '' });
  expect(asked).toHaveLength(1);

  expect(await agentRun(hosted, { refs: ['rev-9'] }, bridge).ended).toEqual({
    status: 1,
    stdout: '',
    stderr: 'house: rev-9 names no Run started on this computer; wait on its reference\n',
  });
});

it('names its Runs again on a Kit connection that opens again and ends on the states House reads then', async () => {
  const hosted = await hostKit();
  answering(hosted, started(RUN_1, 'rev-1'), started(RUN_2, 'ba-1'));
  const bridge = await bridgeOf(hosted);
  const command = agentRun(hosted, { runs: [REVIEW, OWN_WORDS] }, bridge);
  const { wait } = await named(hosted, [RUN_1, RUN_2]);
  told(hosted, RUN_1, 'idle', { name: 'rev-1' });
  told(hosted, RUN_2, 'working', { name: 'ba-1' });

  hosted.house.connections.at(-1)!.close(1001, 'shutting_down');
  const reopened = await until(() => hosted.house.connections[1]);

  expect(await named(hosted, [RUN_1, RUN_2])).toEqual({ type: 'waiting', wait, runs: [RUN_1, RUN_2] });
  told(hosted, RUN_2, 'idle', { name: 'ba-1' });
  await settle();
  expect(existsSync(`/proc/${command.pid}`)).toBe(true);
  told(hosted, RUN_1, 'idle', { name: 'rev-1' });
  expect((await command.ended).status).toBe(0);
  expect(reopened).toBe(hosted.house.connections.at(-1));
});

async function restarted(hosted: Hosted, signal: NodeJS.Signals): Promise<void> {
  const [connections, idles] = [hosted.house.connections.length, hosted.idles.length];
  process.kill(hosted.kit.pid, signal);
  await hosted.kit.exited;
  hosted.kit = runKit(['resident'], hosted.environment);
  await until(() => hosted.house.connections.length > connections);
  await until(() => hosted.idles.length > idles);
}

it.each([
  ['a crash', 'SIGKILL' as const, {}],
  ['a planned restart', 'SIGTERM' as const, { planned: true }],
])("records a conversation's waiting Runs in Kit home, removes the record when the command ends, and reports a record %s left at the next start", async (_case, signal, planned) => {
  const hosted = await hostKit();
  answering(hosted, started(RUN_1, 'rev-1'), started(RUN_2, 'ba-1'));
  const bridge = await bridgeOf(hosted);
  const ending = agentRun(hosted, { runs: [REVIEW] }, bridge);
  await named(hosted, [RUN_1]);
  expect(await records(hosted)).toEqual([{ conversation_id: 'conversation-1', runs: [RUN_1] }]);
  told(hosted, RUN_1, 'idle', { name: 'rev-1' });
  expect((await ending.ended).status).toBe(0);
  await until(async () => (await records(hosted)).length === 0);

  const cut = agentRun(hosted, { runs: [OWN_WORDS] }, bridge);
  await named(hosted, [RUN_2]);
  const turns = hosted.turns.filter((turn) => turn.path === '/kit/turns/end').length;
  hosted.call({ kind: 'message', text: '@runs\n@say waiting', first: true });
  await until(() => hosted.turns.filter((turn) => turn.path === '/kit/turns/end')[turns]);
  await named(hosted, [WAITED_RUN]);
  await until(async () => (await records(hosted)).length === 2);
  const reports = hosted.house.requests.filter((request) => request.path === '/kit/kits/report-restart').length;
  hosted.house.connections.at(-1)!.transport.pause();
  await restarted(hosted, signal);

  const [report] = hosted.house.requests.filter((request) => request.path === '/kit/kits/report-restart').slice(reports);
  const { waits, ...rest } = report!.body as { waits: { conversation_id: string; runs: string[] }[] };
  expect(rest).toEqual(planned);
  expect(waits.map(({ conversation_id, runs }) => ({ conversation_id, runs: [...runs].sort() }))).toEqual([
    { conversation_id: 'conversation-1', runs: [RUN_2, WAITED_RUN].sort() },
  ]);
  expect(await cut.ended).toEqual({
    status: 1,
    stdout: `ba-1 ${RUN_2}\n`,
    stderr: `house: the Kit ended this wait before its Runs ended; house agent run '{"refs":["${RUN_2}"]}' waits again\n`,
  });
  await until(async () => (await records(hosted)).length === 0);
});

it("keeps the wait of a command your own agent holds outside any conversation through a Kit restart, recording nothing, and reads its Runs' states again once the Kit is back", async () => {
  const hosted = await hostKit();
  const asked = answering(hosted, started(RUN_1, 'rev-1'));

  const command = agentRun(hosted, { runs: [REVIEW] });

  await named(hosted, [RUN_1]);
  expect((asked[0]!.body as McpCall).params._meta[CONVERSATION_META_KEY]).toBeUndefined();
  expect(await records(hosted)).toEqual([]);
  told(hosted, RUN_1, 'working', { name: 'rev-1' });
  await hosted.restart();

  await until(() => waitings(hosted.house.connections.at(-1)!).find((waiting) => waiting.runs[0] === RUN_1));
  told(hosted, RUN_1, 'idle', { name: 'rev-1' });
  expect(await command.ended).toEqual({ status: 0, stdout: `rev-1 ${RUN_1}\nrev-1 ${RUN_1} idle\n`, stderr: '' });
  expect(hosted.house.requests.filter((request) => request.path === '/kit/kits/report-restart').map((request) => request.body)).toEqual([{}, {}]);
});

it('keeps its output within 32 kB, cutting the lines past it and saying how many', async () => {
  const hosted = await hostKit();
  const count = 40;
  const runs = Array.from({ length: count }, (_unused, index) => `019a0000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`);
  answering(hosted, ...runs.map((run, index) => started(run, `rev-${index + 1}`)));
  const bridge = await bridgeOf(hosted);
  const command = agentRun(hosted, { runs: runs.map(() => REVIEW) }, bridge);
  await named(hosted, runs);

  for (const run of runs) told(hosted, run, 'failed', { cause: 'c'.repeat(4000) });

  const { status, stdout } = await command.ended;
  expect(status).toBe(1);
  expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(32 * 1024);
  expect(stdout.split('\n').slice(0, count)).toEqual(runs.map((run, index) => `rev-${index + 1} ${run}`));
  expect(stdout).toMatch(/\n\d+ more lines cut to stay within 32 kB\n$/u);
});

it.each([
  [[], USAGE],
  [['{"runs":[]}'], `"runs" lists one or more entries; ${USAGE}`],
  [['{"runs":[{}],"refs":["rev-1"]}'], USAGE],
  [['{"runs":["review"]}'], `each of "runs" is an object; ${USAGE}`],
  [['{"refs":[""]}'], `each of "refs" is a Run's reference or name; ${USAGE}`],
  [[JSON.stringify({ refs: Array.from({ length: 1001 }, () => RUN_1) })], 'house agent run waits on at most 1000 Runs at once'],
  [['{"refs":["rev-1"]}', '--wait'], USAGE],
])('refuses house agent run %j, calling nothing', async (argv, refusal) => {
  const house = await startHouse();
  const home = await temporaryHome();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_kit' }));
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: accountOf(home) };
  delete environment.HOUSE_BRIDGE;
  const child = spawn(process.execPath, [HOUSE, 'agent', 'run', ...argv], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const status = await new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));

  expect({ status, stderr }).toEqual({ status: 1, stderr: `house: ${refusal}\n` });
  expect(house.requests).toEqual([]);
});
