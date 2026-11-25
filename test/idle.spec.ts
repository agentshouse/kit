import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { RELEASES, updatesRun } from './cli.ts';
import { settle, until } from './double.ts';
import { hostKit, installHeld, lastCall, type Hosted } from './environment.ts';
import { MODELS } from './fixtures/clis/session-options.ts';
import { alive } from './kit.ts';
import { callUpdate, released, serveRelease } from './release.ts';

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path === '/kit/turns/end');

const FAST_MODEL_READ = fileURLToPath(new URL('./fast-model-read.ts', import.meta.url));

// A model read ends five seconds after it starts under fast-model-read, so twenty seconds see the idle report on a loaded runner.
const HUNG_READ_ENDED_MS = 20_000;

async function opened(hosted: Hosted): Promise<void> {
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
}

it('reports idle once no turn runs and not while a turn runs without waiting on a question', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  await opened(hosted);
  await until(() => hosted.idles[1]);

  // The turn holds a second and a half, outlasting the half second the spec watches for an idle report.
  hosted.call({ kind: 'message', text: '@hold 1500\n@say done', first: true });
  await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/start'));
  await settle();
  expect(hosted.idles).toHaveLength(2);

  await until(() => ended(hosted)[0]);
  await until(() => hosted.idles[2]);
});

it('reports idle once its deadline ends a model read whose CLI never answers', async () => {
  const hosted = await hostKit([{}], { environment: { NODE_OPTIONS: `--import=${FAST_MODEL_READ}` } });
  await mkdir(join(hosted.home, 'signed-in'), { recursive: true });
  await writeFile(join(hosted.home, 'signed-in', 'claude-agent-acp'), '');
  await writeFile(join(hosted.home, 'probe-hold'), MODELS['claude-agent-acp']![0]!.id);
  await rm(await installHeld(hosted));
  const held = (await until(async () => (await hosted.adapterLog()).find((entry) => entry.heldProbe !== undefined))).pid as number;

  await until(() => hosted.idles[1], HUNG_READ_ENDED_MS);

  await until(() => !alive(held));
  expect((await hosted.adapterLog()).some((entry) => entry.releasedProbe !== undefined)).toBe(false);
});

it('does not report idle while a CLI House asks for installs, and reports it once that CLI is reported', async () => {
  const hosted = await hostKit();
  const hold = await installHeld(hosted);
  await settle();
  expect(hosted.idles).toHaveLength(1);

  await rm(hold);
  await until(() => hosted.idles[1]);

  const paths = hosted.house.requests.map((request) => request.path);
  expect(paths.lastIndexOf('/kit/kits/report-idle')).toBeGreaterThan(paths.lastIndexOf('/kit/agents/report'));
  expect(hosted.reports.at(-1)!.agents).toContainEqual(expect.objectContaining({ kind: 'claude-agent-acp', release: RELEASES['claude-agent-acp'] }));
});

it('reports idle again once it has loaded the agents House asked it to refresh after its last idle report', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);

  hosted.transcribe(false);

  await until(() => hosted.idles[1]);
  const paths = hosted.house.requests.map((request) => request.path);
  expect(paths.lastIndexOf('/kit/kits/report-idle')).toBeGreaterThan(paths.lastIndexOf('/kit/agents/desired/list'));
});

it('does not report idle while the update command its start began runs, and reports idle once that command ends', async () => {
  const hosted = await hostKit([{}], { untilIdle: false, prepare: (home) => writeFile(join(home, 'update-hold'), '') });
  await until(() => updatesRun(hosted.home).find((update) => update.held));
  await opened(hosted);
  hosted.call({ kind: 'message', text: '@say done', first: true });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(0);

  await rm(join(hosted.home, 'update-hold'));

  await until(() => hosted.idles[0]);
});

it('reports idle only after it returns the result of the Kit call it carried out', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  hosted.house.route('POST', '/kit/kit-calls/results/return', async (request) => {
    // The result takes three tenths of a second to return, so an idle report sent before it would show.
    await new Promise((resolve) => setTimeout(resolve, 300));
    hosted.results.push(request);
    return { body: {} };
  });

  hosted.call({ kind: 'open' });

  await hosted.result(lastCall());
  const paths = (await until(() => hosted.idles[1] && hosted.house.requests)).map((request) => request.path);
  expect(paths.lastIndexOf('/kit/kits/report-idle')).toBeGreaterThan(paths.indexOf('/kit/kit-calls/results/return'));
  expect(paths.filter((path) => path === '/kit/kits/report-idle')).toHaveLength(2);
});

it('counts a turn waiting on a non-secret question as idle', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.call({ kind: 'message', text: '@ask', first: true });
  await until(() => hosted.interactions[0]);

  await until(() => hosted.idles[2]);
});

it('does not count a turn waiting on a question as idle while its CLI reports a running background job', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.call({ kind: 'message', text: '@job job-1\n@ask', first: true });
  const question = await until(() => hosted.interactions[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  const { interaction_id } = question.body as { interaction_id: string };
  hosted.call({ kind: 'answer', interaction_id, response: { outcome: { outcome: 'cancelled' } } });
  await until(() => ended(hosted)[0]);
  hosted.call({ kind: 'message', text: '@jobdone job-1', first: false });
  await until(() => hosted.idles[2]);
});

it('holds the exit of a placed Kit release while its CLI reports a running background job, and not for a process the conversation left, and ends once the job ended', async () => {
  const hosted = await hostKit();
  await serveRelease(hosted, await released('0.2.1-c000000000002'));
  await opened(hosted);
  hosted.call({ kind: 'message', text: '@job job-1\n@spawn\n@say started', first: true });
  await until(() => ended(hosted)[0]);
  const job = (await until(async () => (await hosted.adapterLog()).find((entry) => entry.spawned !== undefined)))!;

  callUpdate(hosted, 'update-held', '0.2.1-c000000000002');
  expect(await hosted.result('update-held')).toEqual({});
  await settle();
  expect(alive(hosted.kit.pid)).toBe(true);
  hosted.call({ kind: 'message', text: '@jobdone job-1', first: false });

  expect(await hosted.kit.exited).toBe(1);
  expect([job.spawned, job.clean].map((pid) => alive(pid as number))).toEqual([true, true]);
});

it('does not count a turn waiting on a secret question as idle', async () => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/kit/secret-inputs/await', async () => {
    // House holds the secret question two tenths of a second each time, so the Kit keeps holding it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { body: { outcome: 'released', release: 'held' } };
  });
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.call({ kind: 'message', text: `@secret ${createHash('sha256').update('x').digest('hex')}`, first: true });
  await until(() => hosted.interactions[0]);
  await settle();

  expect(hosted.idles).toHaveLength(2);
});

it.each(['codex-acp', 'claude-agent-acp'])('does not report idle while %s reports a running background job', async (kind) => {
  const hosted = await hostKit([{ kind }]);
  await opened(hosted);
  await until(() => hosted.idles[1]);
  const { clientCapabilities } = (await hosted.adapterLog()).find((entry) => entry.method === 'initialize')!.params as {
    clientCapabilities: { session: unknown; _meta: { jetbrains: { air: { capabilities: string[] } } } };
  };
  expect(clientCapabilities.session).toEqual({ compaction: {}, notices: {} });
  expect(clientCapabilities._meta.jetbrains.air.capabilities).toContain('asyncTasks');

  hosted.call({ kind: 'message', text: '@job job-1\n@say started', first: true });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  hosted.call({ kind: 'message', text: '@jobdone job-1', first: false });
  await until(() => ended(hosted)[1]);
  await until(() => hosted.idles[2]);
});

it('drops an idle report House did not take once the CLI reports a running background job', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  const endedAtReport: number[] = [];
  hosted.house.route('POST', '/kit/kits/report-idle', (request) => {
    endedAtReport.push(ended(hosted).length);
    if (endedAtReport.length === 1) return { status: 503, body: { error: { code: 'house_unavailable', retryable: true } } };
    hosted.idles.push(request);
    return { body: {} };
  });
  await opened(hosted);
  await until(() => endedAtReport.length > 0);

  hosted.call({ kind: 'message', text: '@job job-1\n@say started', first: true });
  await until(() => ended(hosted)[0]);
  // A second outlasts the first retry of the refused idle report, which the running job must drop.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  hosted.call({ kind: 'message', text: '@jobdone job-1', first: false });
  await until(() => ended(hosted)[1]);
  await until(() => hosted.idles[1]);

  expect(endedAtReport).toEqual([0, 2]);
});

function emitted(event: unknown): string {
  return `@emit ${JSON.stringify(event)}`;
}

function sdk(message: Record<string, unknown>): string {
  return emitted({ method: '_claude/sdkMessage', params: { sessionId: '$SESSION', message: { type: 'system', ...message } } });
}

function tasks(type: string): [string, string] {
  return [
    sdk({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-1', task_type: type, description: type }] }),
    sdk({ subtype: 'background_tasks_changed', tasks: [] }),
  ];
}

function update(update: Record<string, unknown>): string {
  return emitted({ method: 'session/update', params: { sessionId: '$SESSION', update } });
}

function recorded(fixture: string, kind: string): string {
  const lines = readFileSync(new URL(`./fixtures/events/${fixture}.jsonl`, import.meta.url), 'utf8').trim().split('\n');
  const event = JSON.parse(lines.find((line) => JSON.parse(line).params?.update?.sessionUpdate === kind)!);
  return update(event.params.update);
}

const CRON = { claudeCode: { toolName: 'CronCreate' } };
const DELETE = { claudeCode: { toolName: 'CronDelete' } };

const FORMS: [string, string, string, string][] = [
  ['claude-agent-acp', 'a background shell or Monitor', ...tasks('local_bash')],
  ['claude-agent-acp', 'a background sub-agent', ...tasks('local_agent')],
  ['claude-agent-acp', 'a Workflow', ...tasks('local_workflow')],
  ['claude-agent-acp', 'a running session state', sdk({ subtype: 'session_state_changed', state: 'running' }), sdk({ subtype: 'session_state_changed', state: 'idle' })],
  [
    'claude-agent-acp',
    'a scheduled prompt',
    [
      update({ sessionUpdate: 'tool_call', toolCallId: 'cron-1', _meta: CRON, title: 'CronCreate', kind: 'other', status: 'pending' }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'cron-1', rawInput: { cron: '0 3 1 1 *', prompt: 'say hi', recurring: true } }),
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cron-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Scheduled recurring job 88f652b2 (0 3 1 1 *).' } }],
      }),
    ].join('\n'),
    [
      update({ sessionUpdate: 'tool_call', toolCallId: 'cron-2', _meta: DELETE, title: 'CronDelete', kind: 'other', status: 'pending' }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'cron-2', rawInput: { id: '88f652b2' } }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'cron-2', status: 'completed' }),
    ].join('\n'),
  ],
  [
    'codex-acp',
    'a backgrounded shell',
    recorded('codex-terminal', 'async_task_spawned'),
    recorded('codex-terminal', 'async_task_state_update'),
  ],
];

it.each(FORMS)('does not report idle while %s reports %s, from its start until its end', async (kind, _form, start, end) => {
  const hosted = await hostKit([{ kind }]);
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.call({ kind: 'message', text: `${start}\n@say started`, first: true });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  hosted.call({ kind: 'message', text: `${end}\n@say done`, first: false });
  await until(() => ended(hosted)[1]);
  await until(() => hosted.idles[2]);
});

it('keeps a background form whose end never arrives busy until the Conversation process exits', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  await opened(hosted);
  await until(() => hosted.idles[1]);
  hosted.call({ kind: 'message', text: `${tasks('local_bash')[0]}\n@say started`, first: true });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  hosted.call({ kind: 'kill' });

  await until(() => hosted.idles[2]);
});
