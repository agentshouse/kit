import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { settle, until } from './double.ts';
import { hostKit, lastInput, type Hosted } from './environment.ts';
import { stop } from './kit.ts';

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/ended'));

async function opened(hosted: Hosted): Promise<void> {
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
}

it('reports idle once no turn runs and not while a turn runs without waiting on a question', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  await opened(hosted);
  await until(() => hosted.idles[1]);

  // The turn holds a second and a half, outlasting the half second the spec watches for an idle report.
  hosted.input({ kind: 'message', text: '@hold 1500\n@say done', files: [], first: true });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  await settle();
  expect(hosted.idles).toHaveLength(2);

  await until(() => ended(hosted)[0]);
  await until(() => hosted.idles[2]);
});

it('reports idle only after it acknowledges the input it carried out', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  hosted.house.route('POST', '/kit/inputs/:input/ack', async (request) => {
    // The acknowledgement takes three tenths of a second, so an idle report sent before it would show.
    await new Promise((resolve) => setTimeout(resolve, 300));
    hosted.acks.push(request);
    return { body: {} };
  });

  hosted.input({ kind: 'open' });

  await hosted.ack(lastInput());
  const paths = (await until(() => hosted.idles[1] && hosted.house.requests)).map((request) => request.path);
  expect(paths.lastIndexOf('/kit/idle')).toBeGreaterThan(paths.indexOf(`/kit/inputs/${lastInput()}/ack`));
  expect(paths.filter((path) => path === '/kit/idle')).toHaveLength(2);
});

it('counts a turn waiting on a non-secret question as idle', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.input({ kind: 'message', text: '@ask', files: [], first: true });
  await until(() => hosted.interactions[0]);

  await until(() => hosted.idles[2]);
});

it('does not count a turn waiting on a question as idle while a process the conversation started runs', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.input({ kind: 'message', text: '@spawn\n@ask', files: [], first: true });
  await until(() => hosted.interactions[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  const job = (await hosted.adapterLog()).find((entry) => entry.spawned !== undefined)!;
  for (const target of [job.spawned, job.clean]) stop(target as number);

  await until(() => hosted.idles[2]);
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

  hosted.input({ kind: 'message', text: `@secret ${createHash('sha256').update('x').digest('hex')}`, files: [], first: true });
  await until(() => hosted.interactions[0]);
  await settle();

  expect(hosted.idles).toHaveLength(2);
});

it.each(['codex-acp', 'claude-agent-acp', 'grok-build'])('does not report idle while %s reports a running background job', async (kind) => {
  const hosted = await hostKit([{ kind }]);
  await opened(hosted);
  await until(() => hosted.idles[1]);
  const { clientCapabilities } = (await hosted.adapterLog()).find((entry) => entry.method === 'initialize')!.params as {
    clientCapabilities: { session: unknown; _meta: { jetbrains: { air: { capabilities: string[] } } } };
  };
  expect(clientCapabilities.session).toEqual({ compaction: {}, notices: {} });
  expect(clientCapabilities._meta.jetbrains.air.capabilities).toContain('asyncTasks');

  hosted.input({ kind: 'message', text: '@job job-1\n@say started', files: [], first: true });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  hosted.input({ kind: 'message', text: '@jobdone job-1', files: [], first: false });
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

  hosted.input({ kind: 'message', text: '@job job-1\n@say started', files: [], first: true });
  await until(() => ended(hosted)[0]);
  // A second outlasts the first retry of the refused idle report, which the running job must drop.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  hosted.input({ kind: 'message', text: '@jobdone job-1', files: [], first: false });
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

function grok(method: string, update: Record<string, unknown>): string {
  return emitted({ method, params: { sessionId: '$SESSION', update } });
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
  [
    'codex-acp',
    'a sub-agent',
    update({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child-1', name: 'Count files', task: 'Count files', capabilities: {} }),
    update({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child-1', state: 'completed' }),
  ],
  [
    'grok-build',
    'a background sub-agent',
    grok('_x.ai/session_notification', { sessionUpdate: 'subagent_spawned', subagent_id: 'child-1', child_session_id: 'child-1', description: 'Count' }),
    grok('_x.ai/session_notification', { sessionUpdate: 'subagent_finished', subagent_id: 'child-1', child_session_id: 'child-1', status: 'completed', output: 'one file' }),
  ],
  [
    'grok-build',
    'a backgrounded task',
    grok('_x.ai/task_backgrounded', { sessionUpdate: 'task_backgrounded', task_id: 'task-1', command: 'sleep 600' }),
    grok('_x.ai/task_completed', { sessionUpdate: 'task_completed', task_snapshot: { task_id: 'task-1', command: 'sleep 600', exit_code: 0 } }),
  ],
  [
    'grok-build',
    'a scheduled task',
    grok('_x.ai/scheduled_task_created', { sessionUpdate: 'scheduled_task_created', task_id: 'schedule-1', prompt: 'say hi' }),
    grok('_x.ai/scheduled_task_deleted', { sessionUpdate: 'scheduled_task_deleted', task_id: 'schedule-1', reason: 'deleted' }),
  ],
];

it.each(FORMS)('does not report idle while %s reports %s, from its start until its end', async (kind, _form, start, end) => {
  const hosted = await hostKit([{ kind }]);
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.input({ kind: 'message', text: `${start}\n@say started`, files: [], first: true });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  hosted.input({ kind: 'message', text: `${end}\n@say done`, files: [], first: false });
  await until(() => ended(hosted)[1]);
  await until(() => hosted.idles[2]);
});

it('keeps a background form whose end never arrives busy until the Conversation process exits', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  await opened(hosted);
  await until(() => hosted.idles[1]);
  hosted.input({ kind: 'message', text: `${tasks('local_bash')[0]}\n@say started`, files: [], first: true });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  hosted.input({ kind: 'kill' });

  await until(() => hosted.idles[2]);
});

it('does not report idle while a process the conversation started after its session opened runs, though the servers that ran then do not count', async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'start-server'), '');
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.input({ kind: 'message', text: '@spawn\n@say started', files: [], first: true });
  await until(() => ended(hosted)[0]);
  // Six seconds outlast the Kit's five-second look at the conversation's processes, so an idle report it should not send would show.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  expect(hosted.idles).toHaveLength(2);

  const log = await hosted.adapterLog();
  expect(log.filter((entry) => entry.server !== undefined)).toHaveLength(1);
  const job = log.find((entry) => entry.spawned !== undefined)!;
  for (const target of [job.spawned, job.clean]) stop(target as number);

  await until(() => hosted.idles[2]);
});

it('counts a process started after the session opened even when a server with its command line ran then', async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'start-server'), '');
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.input({ kind: 'message', text: '@serve\n@say started', files: [], first: true });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  const servers = (await hosted.adapterLog()).filter((entry) => entry.server !== undefined);
  expect(servers).toHaveLength(2);
  stop(servers[1]!.server as number);

  await until(() => hosted.idles[2]);
});

it("ignores the queue of a Grok Build session that is neither the conversation's own nor a sub-agent's", async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }]);
  await opened(hosted);
  await until(() => hosted.idles[1]);
  const queue = {
    method: '_x.ai/queue/changed',
    params: { sessionId: 'session-other', entries: [], runningPromptId: 'prompt-other' },
  };

  hosted.input({ kind: 'message', text: `@emit ${JSON.stringify(queue)}\n@say done`, files: [], first: true });
  await until(() => ended(hosted)[0]);

  await until(() => hosted.idles[2]);
});

it.each(['grok-background', 'grok-subagent'])(
  'reports idle once the turn Grok Build starts on its own after the work of %s ends has ended',
  async (fixture) => {
    const hosted = await hostKit([{ kind: 'grok-build' }]);
    await opened(hosted);
    await until(() => hosted.idles[1]);

    hosted.input({ kind: 'message', text: `@replay ${fixture}`, files: [], first: true });
    await until(() => ended(hosted)[1]);

    await until(() => hosted.idles[2]);
  },
);
