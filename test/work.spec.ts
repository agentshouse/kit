import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { settle, until } from './double.ts';
import { hostKit, lastInput, type Hosted, type Hosting } from './environment.ts';

type Recorded = { method: string; params: Record<string, any> };

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/ended'));

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/work/${name}.jsonl`, import.meta.url));
}

function recorded(name: string): Recorded[] {
  return readFileSync(fixture(name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Recorded);
}

async function written(hosted: Hosted, name: string, lines: Recorded[]): Promise<string> {
  const path = join(hosted.home, `${name}.jsonl`);
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

function raw(line: Recorded): Record<string, any> {
  return line.params.message ?? {};
}

async function opened(kind: string, hosting: Hosting = {}): Promise<Hosted> {
  const hosted = await hostKit([{ kind }], hosting);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  await until(() => hosted.idles[1]);
  return hosted;
}

async function stays(hosted: Hosted, text: string, idle: boolean): Promise<void> {
  const idles = hosted.idles.length;
  const turns = ended(hosted).length;
  hosted.input({ kind: 'message', text: `${text}\n@say ok`, files: [], first: false });
  await until(() => ended(hosted)[turns]);
  if (idle) {
    await until(() => hosted.idles[idles]);
  } else {
    await settle();
    expect(hosted.idles).toHaveLength(idles);
  }
}

it.each([
  ['a background shell', 'claude-shell'],
  ['a Monitor', 'claude-monitor'],
  ['a background sub-agent', 'claude-subagent'],
  ['a Workflow', 'claude-workflow'],
])('stays busy over Claude Code’s recorded %s until the level no longer lists it', async (_form, name) => {
  const hosted = await opened('claude-agent-acp');
  const end = recorded(name).findLastIndex((line) => raw(line).subtype === 'background_tasks_changed');

  await stays(hosted, `@play ${fixture(name)} 0 ${end}`, false);

  await stays(hosted, `@play ${fixture(name)} ${end}`, true);
});

it('stays busy while the level lists an ambient task', async () => {
  const hosted = await opened('claude-agent-acp');
  const levels = recorded('claude-monitor')
    .filter((line) => raw(line).subtype === 'background_tasks_changed')
    .map((line) => {
      const tasks = (raw(line).tasks as Record<string, unknown>[]).map((task) => ({ ...task, ambient: true }));
      return { ...line, params: { ...line.params, message: { ...raw(line), tasks } } };
    });
  const path = await written(hosted, 'ambient', levels);

  await stays(hosted, `@play ${path} 0 ${levels.length - 1}`, false);

  await stays(hosted, `@play ${path} ${levels.length - 1}`, true);
});

it('stays busy from a task’s start edge until its notification when no level lists it', async () => {
  const hosted = await opened('claude-agent-acp');
  const task = raw(recorded('claude-subagent').find((line) => raw(line).owned_by_subagent === true)!).task_id as string;
  const owned = recorded('claude-subagent').filter((line) => raw(line).task_id === task);
  const path = await written(hosted, 'owned', owned);

  await stays(hosted, `@play ${path} 0 1`, false);

  await stays(hosted, `@play ${path} 1`, true);
});

it('stays busy while a hook runs', async () => {
  const hosted = await opened('claude-agent-acp');
  const hooks = recorded('claude-shell').filter((line) => raw(line).hook_event === 'PostToolUse');
  const path = await written(hosted, 'hook', hooks);

  await stays(hosted, `@play ${path} 0 1`, false);

  await stays(hosted, `@play ${path} 1`, true);
});

it('stays busy from a CronCreate until its CronDelete', async () => {
  const hosted = await opened('claude-agent-acp');
  const wakeup = recorded('claude-cron').find((line) => line.params.update?._meta?.claudeCode?.toolName === 'ScheduleWakeup')!.params.update
    .toolCallId;
  const crons = await written(
    hosted,
    'crons',
    recorded('claude-cron').filter((line) => line.params.update?.toolCallId !== wakeup),
  );

  await stays(hosted, `@play ${crons}`, false);

  await stays(hosted, `@play ${fixture('claude-cron-delete')}`, true);
});

async function wakeup(hosted: Hosted, reported: string): Promise<{ path: string; runs: number[] }> {
  const lines = recorded('claude-wakeup').map((line) => JSON.parse(JSON.stringify(line).replace('16:29:00 (in 102s)', reported)) as Recorded);
  const runs = lines.flatMap((line, index) => (raw(line).state === 'running' ? [index] : []));
  return { path: await written(hosted, 'wakeup', lines), runs };
}

function clocked(at: string): Hosting {
  return {
    environment: { TZ: 'UTC', KIT_CLOCK: at, NODE_OPTIONS: `--import=${fileURLToPath(new URL('./clock.ts', import.meta.url))}` },
  };
}

it.each([
  ['as recorded', '2026-10-10T16:27:18Z', '16:29:00 (in 102s)'],
  ['past midnight', '2026-10-10T23:59:00Z', '00:00:42 (in 102s)'],
  ['more than half a day ahead', '2026-10-10T17:00:00Z', '07:00:00 (in 50400s)'],
])('stays busy from a ScheduleWakeup through turns that start before the time it reports, %s', async (_, clock, reported) => {
  const hosted = await opened('claude-agent-acp', clocked(clock));
  const { path, runs } = await wakeup(hosted, reported);

  await stays(hosted, `@play ${path} 0 ${runs[1]}`, false);

  await stays(hosted, `@play ${path} ${runs[1]}`, false);
});

it.each([
  ['as reported', '2026-10-10T16:29:00Z', '16:29:00 (in 0s)'],
  ['across midnight', '2026-10-10T23:59:59.500Z', '23:59:59 (in 1s)'],
])('ends a ScheduleWakeup at the first turn that starts at or after the time it reports, %s', async (_, clock, reported) => {
  const hosted = await opened('claude-agent-acp', clocked(clock));
  const { path, runs } = await wakeup(hosted, reported);

  await stays(hosted, `@play ${path} 0 ${runs[1]}`, false);

  await stays(hosted, `@play ${path} ${runs[1]} ${runs[2]}`, true);
});

it('stays busy while the working directory holds a durable schedule when a session resumes', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  await until(() => hosted.idles[0]);
  await mkdir(join(hosted.workingDirectory, '.claude'));
  const tasks = join(hosted.workingDirectory, '.claude', 'scheduled_tasks.json');
  await writeFile(tasks, JSON.stringify({ tasks: [{ id: '7b99af94', cron: '0 3 1 1 *', prompt: 'say hi', createdAt: 1791648534000, recurring: true }] }));

  hosted.input({ kind: 'message', text: '@say resumed', files: [], first: false, provider_session_id: 'session-earlier' });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(1);
  expect((await hosted.adapterLog()).some((entry) => entry.method === 'session/resume')).toBe(true);

  await rm(tasks);
  await until(() => hosted.idles[1]);
});

it('stays busy while a goal is active', async () => {
  const hosted = await opened('claude-agent-acp');
  const cleared = { sessionUpdate: 'session_info_update', _meta: { jetbrains: { air: { version: 1, goal: null } } } };

  await stays(hosted, `@play ${fixture('claude-goal')}`, false);

  await stays(hosted, `@emit ${JSON.stringify({ method: 'session/update', params: { sessionId: '$SESSION', update: cleared } })}`, true);
});

it('stays busy while a Codex background terminal is open after its turn ends', async () => {
  const hosted = await opened('codex-acp');
  const end = recorded('codex-terminal').findLastIndex((line) => line.method === 'item/completed');

  await stays(hosted, `@stream ${fixture('codex-terminal')} 0 ${end}`, false);

  await stays(hosted, `@stream ${fixture('codex-terminal')} ${end}`, true);
});

it('stays busy while a Codex sub-agent’s thread runs, also after the adapter reports the sub-agent failed', async () => {
  const hosted = await opened('codex-acp');
  const lines = recorded('codex-subagent');
  const child = lines.find((line) => line.params.item?.type === 'subAgentActivity')!.params.item.agentThreadId as string;
  const childIdle = lines.findLastIndex((line) => line.params.threadId === child && line.params.status?.type === 'idle');
  const failed = { sessionUpdate: 'subagent_state_update', subagentSessionId: child, state: 'failed' };

  await stays(hosted, `@stream ${fixture('codex-subagent')} 0 ${childIdle}`, false);
  await stays(hosted, `@emit ${JSON.stringify({ method: 'session/update', params: { sessionId: '$SESSION', update: failed } })}`, false);

  await stays(hosted, `@stream ${fixture('codex-subagent')} ${childIdle}`, true);
});

it('stays busy while Codex runs an internal thread of its own', async () => {
  const hosted = await opened('codex-acp');
  const titling = recorded('codex-subagent').find((line) => JSON.stringify(line.params.item?.content ?? '').includes('generate a very short title'))!;
  const lines = recorded('codex-subagent').filter((line) => line.params.threadId === titling.params.threadId);
  const own = await written(hosted, 'internal', lines);
  const idle = lines.findIndex((line) => line.params.status?.type === 'idle');

  await stays(hosted, `@stream ${own} 0 ${idle}`, false);

  await stays(hosted, `@stream ${own} ${idle}`, true);
});

it('stays busy while a Codex thread’s queue holds an entry', async () => {
  const hosted = await opened('codex-acp');
  const thread = recorded('codex-queue')[0]!.params.threadId as string;
  const changed = recorded('codex-queue').findIndex((line) => line.method === 'thread/queue/changed');
  const idle = recorded('codex-queue').findIndex((line) => line.params.status?.type === 'idle');

  await stays(hosted, `@codex ${JSON.stringify({ queue: { [thread]: 1 } })}\n@stream ${fixture('codex-queue')} 0 ${changed + 1}`, false);
  await stays(hosted, `@stream ${fixture('codex-queue')} ${changed + 1} ${idle + 1}`, false);

  await stays(hosted, `@codex ${JSON.stringify({ queue: { [thread]: 0 } })}\n@stream ${fixture('codex-queue')} ${idle + 1}`, true);
});

it('stays busy while a Codex goal is active', async () => {
  const hosted = await opened('codex-acp');
  const complete = recorded('codex-goal').findIndex((line) => line.params.goal?.status === 'complete');

  await stays(hosted, `@stream ${fixture('codex-goal')} 0 ${complete}`, false);

  await stays(hosted, `@stream ${fixture('codex-goal')} ${complete}`, true);
});

it.each([
  ['stalls', '@stall'],
  ['is lost', '@lose'],
])('keeps a Codex conversation busy once its stream %s', async (_, directive) => {
  const hosted = await opened('codex-acp');

  await stays(hosted, directive, false);

  hosted.input({ kind: 'kill' });
  await until(() => hosted.idles[2]);
});

it('starts Codex with its memory feature off on a Sandbox whatever the User’s configuration says', async () => {
  const hosted = await opened('codex-acp', {
    environment: { HOUSE_KIT_SANDBOX: '1' },
    prepare: (home) => writeFile(join(home, 'codex-memories'), ''),
  });

  const started = (await readFile(join(hosted.home, 'app-server.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
  expect(started).toContainEqual(['app-server', '--disable', 'memories']);
});

it.each([
  ['a Codex conversation with its memory feature on', 'codex-acp'],
  ['every Grok conversation', 'grok-build'],
])('keeps %s busy until its process exits', async (_case, kind) => {
  const hosted = await hostKit([{ kind }], { prepare: (home) => writeFile(join(home, 'codex-memories'), '') });
  await until(() => hosted.idles[0]);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  await settle();
  expect(hosted.idles).toHaveLength(1);

  hosted.input({ kind: 'kill' });

  await until(() => hosted.idles[1]);
});

it('keeps work whose end never arrives busy until the Conversation process exits', async () => {
  const hosted = await opened('claude-agent-acp');
  const start = recorded('claude-shell').findIndex((line) => raw(line).subtype === 'task_started');
  await stays(hosted, `@play ${fixture('claude-shell')} 0 ${start + 1}`, false);

  hosted.input({ kind: 'kill' });

  await until(() => hosted.idles[2]);
});

it('names a new Claude Code session itself and passes the CLI’s background reports through', async () => {
  const hosted = await opened('claude-agent-acp');

  const created = (await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!;
  expect(created.params).toMatchObject({
    _meta: {
      claudeCode: {
        options: { title: 'conversation-1', includeHookEvents: true },
        emitRawSDKMessages: [
          'background_tasks_changed',
          'task_started',
          'task_updated',
          'task_notification',
          'session_state_changed',
          'hook_started',
          'hook_response',
        ].map((subtype) => ({ type: 'system', subtype })),
      },
    },
  });
});

it('names a new Codex session itself before its first prompt and outside any turn', async () => {
  const hosted = await opened('codex-acp');

  hosted.input({ kind: 'message', text: '@say first', files: [], first: false });
  await until(() => ended(hosted)[0]);

  const log = await hosted.adapterLog();
  const renamed = log.findIndex((entry) => entry.renamed !== undefined);
  expect(log[renamed]!.renamed).toBe('conversation-1');
  expect(renamed).toBeLessThan(log.findIndex((entry) => entry.method === 'session/prompt'));
  expect(hosted.turns.filter((turn) => turn.path.endsWith('/started'))).toHaveLength(1);
});
