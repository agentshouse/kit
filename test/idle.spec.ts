import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { RELEASES, updatesRun } from './cli.ts';
import { settle, until } from './double.ts';
import { hostKit, installHeld, lastCall, type Hosted } from './environment.ts';
import { MODELS } from './fixtures/clis/session-options.ts';
import { alive, stop } from './kit.ts';
import { callUpdate, released, serveRelease } from './release.ts';

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/ended'));

const FAST_SILENCE = fileURLToPath(new URL('./fast-silence.ts', import.meta.url));

const FAST_UPDATES = fileURLToPath(new URL('./fast-updates.ts', import.meta.url));

// A model read waits two quiet seconds and its silent CLI ends five seconds later under fast-silence, so twenty seconds see the idle report on a loaded runner.
const SILENT_READ_ENDED_MS = 20_000;

async function opened(hosted: Hosted): Promise<void> {
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
}

const CONTROL_GROUP = process.env.KIT_TEST_CGROUP === '1';

function controlGroup(pid: number): string {
  return readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((line) => line.startsWith('0::'))!.slice(3);
}

it('reports idle once no turn runs and not while a turn runs without waiting on a question', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  await opened(hosted);
  await until(() => hosted.idles[1]);

  // The turn holds a second and a half, outlasting the half second the spec watches for an idle report.
  hosted.call({ kind: 'message', text: '@hold 1500\n@say done', first: true });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  await settle();
  expect(hosted.idles).toHaveLength(2);

  await until(() => ended(hosted)[0]);
  await until(() => hosted.idles[2]);
});

it('reports idle once the silence bound ends a model read whose CLI never answers', async () => {
  const hosted = await hostKit([{}], { environment: { NODE_OPTIONS: `--import=${FAST_SILENCE}` } });
  await mkdir(join(hosted.home, 'signed-in'), { recursive: true });
  await writeFile(join(hosted.home, 'signed-in', 'claude-agent-acp'), '');
  await writeFile(join(hosted.home, 'probe-hold'), MODELS['claude-agent-acp']![0]!.id);
  await rm(await installHeld(hosted));
  const held = (await until(async () => (await hosted.adapterLog()).find((entry) => entry.heldProbe !== undefined))).pid as number;

  await until(() => hosted.idles[1], SILENT_READ_ENDED_MS);

  await until(() => !alive(held));
  expect((await hosted.adapterLog()).some((entry) => entry.releasedProbe !== undefined)).toBe(false);
});

it("reports idle while an exited process of the Kit's user waits to be reaped beside a running conversation", async () => {
  const hosted = await hostKit();
  await opened(hosted);
  await until(() => hosted.idles[1]);
  const parent = spawn('sh', ['-c', 'sleep 0.2 & exec sleep 60'], { stdio: 'ignore' });
  onTestFinished(() => stop(parent.pid!));
  const children = () => {
    try {
      return readFileSync(`/proc/${parent.pid}/task/${parent.pid}/children`, 'utf8').split(' ').filter(Boolean);
    } catch {
      return [];
    }
  };
  await until(() => children().some((child) => /\) Z /.test(readFileSync(`/proc/${child}/stat`, 'utf8'))));

  hosted.call({ kind: 'message', text: '@say done', first: true });

  await until(() => ended(hosted)[0]);
  await until(() => hosted.idles[2]);
});

it('does not report idle while a CLI House asks for installs, and reports it once that CLI is reported', async () => {
  const hosted = await hostKit();
  const hold = await installHeld(hosted);
  await settle();
  expect(hosted.idles).toHaveLength(1);

  await rm(hold);
  await until(() => hosted.idles[1]);

  const paths = hosted.house.requests.map((request) => request.path);
  expect(paths.lastIndexOf('/kit/idle')).toBeGreaterThan(paths.lastIndexOf('/kit/agents/report'));
  expect(hosted.reports.at(-1)!.agents).toContainEqual(expect.objectContaining({ kind: 'claude-agent-acp', release: RELEASES['claude-agent-acp'] }));
});

it('reports idle again once it has loaded the agents House asked it to refresh after its last idle report', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);

  hosted.transcribe(false);

  await until(() => hosted.idles[1]);
  const paths = hosted.house.requests.map((request) => request.path);
  expect(paths.lastIndexOf('/kit/idle')).toBeGreaterThan(paths.lastIndexOf('/kit/agents/desired'));
});

it('does not report idle while the update command its interval started runs, and reports idle once that command ends', async () => {
  const hosted = await hostKit([{}], { environment: { NODE_OPTIONS: `--import=${FAST_UPDATES}` } });
  await until(() => hosted.idles[0]);

  await writeFile(join(hosted.home, 'update-hold'), '');
  await until(() => updatesRun(hosted.home).find((update) => update.held));
  const idled = hosted.idles.length;
  await settle();
  expect(hosted.idles).toHaveLength(idled);

  await rm(join(hosted.home, 'update-hold'));

  await until(() => hosted.idles.length > idled);
});

it('reports idle only after it returns the result of the Kit call it carried out', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  hosted.house.route('POST', '/kit/inputs/:input/ack', async (request) => {
    // The result takes three tenths of a second to return, so an idle report sent before it would show.
    await new Promise((resolve) => setTimeout(resolve, 300));
    hosted.results.push(request);
    return { body: {} };
  });

  hosted.call({ kind: 'open' });

  await hosted.result(lastCall());
  const paths = (await until(() => hosted.idles[1] && hosted.house.requests)).map((request) => request.path);
  expect(paths.lastIndexOf('/kit/idle')).toBeGreaterThan(paths.indexOf(`/kit/inputs/${lastCall()}/ack`));
  expect(paths.filter((path) => path === '/kit/idle')).toHaveLength(2);
});

it('counts a turn waiting on a non-secret question as idle', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.call({ kind: 'message', text: '@ask', first: true });
  await until(() => hosted.interactions[0]);

  await until(() => hosted.idles[2]);
});

it('does not count a turn waiting on a question as idle while a process the conversation started runs', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.call({ kind: 'message', text: '@spawn\n@ask', first: true });
  await until(() => hosted.interactions[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  const job = (await hosted.adapterLog()).find((entry) => entry.spawned !== undefined)!;
  for (const target of [job.spawned, job.clean]) stop(target as number);

  await until(() => hosted.idles[2]);
});

it(`holds the exit of a placed Kit release while a Conversation process its turn started still runs, tracked ${CONTROL_GROUP ? 'in a control group the Kit makes' : 'by the marker the Kit falls back to where it cannot make a control group'}, and ends once that process ended`, async () => {
  const hosted = await hostKit();
  await serveRelease(hosted, await released('0.2.1-c000000000002'));
  await opened(hosted);
  hosted.call({ kind: 'message', text: '@spawn\n@say started', first: true });
  await until(() => ended(hosted)[0]);
  const job = (await until(async () => (await hosted.adapterLog()).find((entry) => entry.spawned !== undefined)))!;
  expect(controlGroup(job.spawned as number) !== controlGroup(hosted.kit.pid)).toBe(CONTROL_GROUP);

  callUpdate(hosted, 'update-held', '0.2.1-c000000000002');
  expect(await hosted.result('update-held')).toEqual({});
  await settle();
  expect(alive(hosted.kit.pid)).toBe(true);
  for (const target of [job.spawned, job.clean]) stop(target as number);

  expect(await hosted.kit.exited).toBe(1);
});

it('does not count a turn waiting on a secret question as idle', async () => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/kit/secret-input/:subject', async () => {
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
  hosted.house.route('POST', '/kit/idle', (request) => {
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
  const event = JSON.parse(lines.find((line) => JSON.parse(line).params.update?.sessionUpdate === kind)!);
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
