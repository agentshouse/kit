import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { settle, until, type Received } from './double.ts';
import { hostKit, lastInput, type Hosted, type RouteOverrides } from './environment.ts';

const KINDS: Record<string, string> = { claude: 'claude-agent-acp', codex: 'codex-acp', grok: 'grok-build' };

interface Ended {
  parts: Record<string, unknown>[];
  context: { used: number; window: number } | null;
}

interface Replayed {
  hosted: Hosted;
  turns: Ended[];
}

function recorded(fixture: string): { method: string; params: Record<string, any> }[] {
  return readFileSync(new URL(`./fixtures/events/${fixture}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

interface Recording {
  route?: RouteOverrides;
  options?: [string, string][];
  questions?: number;
}

async function replayed(fixture: string, count = 1, recording: Recording = {}): Promise<Replayed> {
  const hosted = await hostKit([{ kind: KINDS[fixture.split('-')[0]!]!, ...recording.route }]);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  for (const [option, value] of recording.options ?? []) {
    hosted.input({ kind: 'option', option, value });
    await hosted.ack(lastInput());
  }
  hosted.watch(true);
  hosted.input({ kind: 'message', text: `@gate admitted\n@replay ${fixture}`, files: [], first: false });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  await writeFile(join(hosted.home, 'admitted'), '');
  for (let index = 0; index < (recording.questions ?? 0); index++) {
    const { interaction_id, request } = (await until(() => hosted.interactions[index])).body as {
      interaction_id: string;
      request: { params: { options: { optionId: string; kind: string }[] } };
    };
    const allowed = request.params.options.find((option) => option.kind.startsWith('allow'))!;
    hosted.input({ kind: 'answer', interaction_id, response: { outcome: { outcome: 'selected', optionId: allowed.optionId } } });
  }
  const ended = await until(() => {
    const found = hosted.turns.filter((turn) => turn.path.endsWith('/ended'));
    return found.length === count ? found : undefined;
  });
  const order = hosted.turns.filter((turn) => turn.path.endsWith('/started')).map((turn) => turn.params.turn);
  const byTurn = new Map(ended.map((turn): [string | undefined, Received] => [turn.params.turn, turn]));
  return { hosted, turns: order.map((turn) => byTurn.get(turn)!.body as Ended) };
}

function written(turns: Ended[]): string {
  return turns
    .flatMap((turn) => turn.parts)
    .filter((part) => part.type === 'text' || part.type === 'reasoning')
    .map((part) => part.text)
    .join('');
}

function chunks(fixture: string): string {
  const events = recorded(fixture);
  const own = events.find((event) => event.params.sessionId !== undefined)!.params.sessionId;
  return events
    .filter((event) => event.method === 'session/update' && event.params.sessionId === own)
    .map((event) => event.params.update)
    .filter((update) => ['agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate) && update.content.type === 'text')
    .filter((update) => update._meta?.claudeCode?.parentToolUseId === undefined)
    .map((update) => update.content.text)
    .join('');
}

function kinds(turn: Ended): string[] {
  return turn.parts.map((part) => (part.type === 'marker' ? `marker:${part.marker}` : String(part.type)));
}

it('maps recorded Claude Code tool calls: commands fold into counts, a house routine request is a message, and a sub-agent is one part', async () => {
  const { turns } = await replayed('claude-tools', 2);

  expect(turns[0]!.parts).toEqual([
    { type: 'commands', count: 4 },
    { type: 'text', text: expect.stringContaining('TodoWrite') },
    { type: 'message', command: 'send_routine_request', target: 'ra_123' },
    { type: 'commands', count: 1 },
    { type: 'subagent', description: 'Count files', status: 'running', result: null },
    { type: 'text', text: expect.stringContaining('still running') },
  ]);
  expect(kinds(turns[1]!)).toEqual(['text']);
  expect(written(turns)).toBe(chunks('claude-tools'));
  expect(JSON.stringify(turns)).not.toContain('ls -la');
  expect(turns[0]!.context).toEqual({ used: 41331, window: 1000000 });
});

it('maps recorded Codex tool calls, its sub-agent session and its image generation', async () => {
  const { hosted, turns } = await replayed('codex-tools');

  expect(kinds(turns[0]!)).toEqual([
    'reasoning',
    'text',
    'commands',
    'reasoning',
    'commands',
    'reasoning',
    'reasoning',
    'reasoning',
    'text',
    'message',
    'commands',
    'reasoning',
    'subagent',
    'reasoning',
    'reasoning',
    'reasoning',
    'text',
    'image',
  ]);
  const parts = turns[0]!.parts;
  expect(parts.filter((part) => part.type === 'commands')).toEqual([
    { type: 'commands', count: 3 },
    { type: 'commands', count: 1 },
    { type: 'commands', count: 1 },
  ]);
  expect(parts.find((part) => part.type === 'message')).toEqual({
    type: 'message',
    command: 'send_routine_request',
    target: 'ra_123',
  });
  expect(parts.find((part) => part.type === 'subagent')).toEqual({
    type: 'subagent',
    description: 'Count files',
    status: 'done',
    result: '`ls` shows **1 file** in the current working directory: `notes.txt`.',
  });
  expect(JSON.stringify(parts)).not.toContain('inspect only the current directory');
  expect(written(turns)).toBe(chunks('codex-tools'));
  expect(parts.at(-1)).toEqual({ type: 'image', file: 'version-1', name: 'image-1.png', media_type: 'image/png' });
  expect(hosted.images.map((image) => image.body)).toEqual([
    { name: 'image-1.png', media_type: 'image/png', bytes: 69, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
  ]);
  expect(hosted.uploads.map((upload) => [upload.headers['x-house-byte-operation'], (upload.body as Buffer).length])).toEqual([
    ['operation-1', 69],
  ]);
  expect(turns[0]!.context).toEqual({ used: 42323, window: 258400 });
});

it('maps recorded Grok Build tool calls, its plan and its sub-agent, whose own session opens and ends no turn', async () => {
  const { hosted, turns } = await replayed('grok-tools');
  await settle();

  expect(kinds(turns[0]!).filter((kind) => kind !== 'reasoning')).toEqual([
    'text',
    'commands',
    'commands',
    'commands',
    'plan',
    'message',
    'commands',
    'subagent',
    'text',
  ]);
  const parts = turns[0]!.parts;
  expect(parts.find((part) => part.type === 'plan')).toEqual({
    type: 'plan',
    entries: [
      { content: 'first', status: 'pending' },
      { content: 'second', status: 'pending' },
    ],
  });
  expect(parts.find((part) => part.type === 'subagent')).toEqual({
    type: 'subagent',
    description: 'Count files with ls',
    status: 'done',
    result: 'There is **1** file in the current working directory:\n\n- `notes.txt`',
  });
  expect(parts.filter((part) => part.type === 'commands').every((part) => part.count === 1)).toBe(true);
  expect(written(turns)).toBe(chunks('grok-tools'));
  expect(hosted.turns.filter((turn) => turn.path.endsWith('/started'))).toHaveLength(1);
  expect(turns[0]!.context).toEqual({ used: 24106, window: 256000 });
});

it('shows a recorded Claude Code foreground sub-agent with its result and a background one whose end and result appear in the turn running then', async () => {
  const { turns } = await replayed('claude-subagents', 2);

  expect(turns[0]!.parts).toEqual([
    { type: 'subagent', description: 'Count files', status: 'done', result: '1 file. The `ls` output is:\n\n```\nnotes.txt\n```' },
    { type: 'subagent', description: 'Sleep and list', status: 'running', result: null },
    { type: 'text', text: expect.any(String) },
  ]);
  expect(turns[1]!.parts[0]).toEqual({
    type: 'subagent',
    description: 'Sleep and list',
    status: 'done',
    result: expect.stringContaining('The directory contains a single file'),
  });
  expect(JSON.stringify(turns)).not.toContain('Sleep 5 seconds then list');
});

it("shows a recorded Grok Build background sub-agent running in its turn and done with Grok's output in the next one", async () => {
  const { turns } = await replayed('grok-subagent', 2);

  expect(turns[0]!.parts.find((part) => part.type === 'subagent')).toEqual({
    type: 'subagent',
    description: 'Sleep then list files',
    status: 'running',
    result: null,
  });
  expect(turns[1]!.parts[0]).toEqual({
    type: 'subagent',
    description: 'Sleep then list files',
    status: 'done',
    result: 'The command finished successfully. The working directory contains one file: `notes.txt`.',
  });
});

it.each([
  ['claude-background', 2],
  ['grok-background', 2],
])('marks the start and the end of the background job recorded in %s', async (fixture, count) => {
  const { turns } = await replayed(fixture, count);

  expect(kinds(turns[0]!)).toContain('marker:job');
  expect(turns[0]!.parts.find((part) => part.type === 'marker')!.text).toMatch(/: running$/);
  expect(turns[1]!.parts[0]).toEqual({ type: 'marker', marker: 'job', text: expect.stringMatching(/: completed$/) });
});

it.each(['claude-compact', 'codex-compact', 'grok-compact'])('marks the compaction recorded in %s once', async (fixture) => {
  const { turns } = await replayed(fixture);

  expect(turns[0]!.parts).toEqual([{ type: 'marker', marker: 'compaction', text: '' }]);
});

it("marks a recorded Claude Code plan approval and the mode it left plan mode for", async () => {
  const { turns } = await replayed('claude-plan', 1, { route: { mode: 'plan', model: 'haiku', effort: null }, questions: 1 });

  expect(turns[0]!.parts.filter((part) => part.type === 'marker')).toEqual([
    { type: 'marker', marker: 'mode', text: 'Approve Plan' },
    { type: 'marker', marker: 'mode', text: 'default' },
  ]);
  expect(JSON.stringify(turns)).not.toContain('# Plan: create hello.txt');
});

it("marks a recorded Codex plan approval and the collaboration mode it switched to", async () => {
  const { turns } = await replayed('codex-plan', 2, { options: [['collaboration_mode', 'plan']], questions: 1 });

  expect(turns.flatMap((turn) => turn.parts).filter((part) => part.type === 'marker')).toEqual([
    { type: 'marker', marker: 'mode', text: 'Implement this plan?' },
    { type: 'marker', marker: 'mode', text: 'default' },
  ]);
});

it("marks Grok Build's recorded entry into plan mode and its exit", async () => {
  const { turns } = await replayed('grok-plan');

  expect(turns[0]!.parts.filter((part) => part.type === 'marker')).toEqual([
    { type: 'marker', marker: 'mode', text: 'enter_plan_mode' },
    { type: 'marker', marker: 'mode', text: 'plan' },
    { type: 'marker', marker: 'mode', text: 'exit_plan_mode' },
  ]);
});

it.each([
  ['claude-schedule', 'say hi: scheduled'],
  ['grok-schedule', 'say hi: next run 2026-10-10T16:41:15.376222610+00:00'],
])('marks the native schedule recorded in %s as a job marker naming its next run where the CLI reports one, and does not count its call', async (fixture, text) => {
  const { turns } = await replayed(fixture);

  const parts = turns.flatMap((turn) => turn.parts);
  expect(parts.filter((part) => part.type === 'marker' && part.marker === 'job')).toEqual([{ type: 'marker', marker: 'job', text }]);
  expect(parts.filter((part) => part.type === 'commands').reduce((sum, part) => sum + Number(part.count), 0)).toBe(fixture === 'claude-schedule' ? 2 : 1);
});

it("marks each of Grok Build's recorded retries with its reason", async () => {
  const { turns } = await replayed('grok-schedule');

  const retries = turns[0]!.parts.filter((part) => part.type === 'marker' && part.marker === 'retry');
  expect(retries).toHaveLength(3);
  expect(retries.every((part) => part.marker === 'retry' && String(part.text).startsWith('API error (status 429'))).toBe(true);
});

it('marks a recorded Claude Code retry and the model switch it made itself, and drops its title', async () => {
  const retried = await replayed('claude-retry');
  const switched = await replayed('claude-model');

  expect(retried.turns[0]!.parts).toEqual([
    { type: 'marker', marker: 'retry', text: 'Retrying Claude, attempt 1 of 10.' },
    { type: 'commands', count: 2 },
    { type: 'text', text: 'done' },
  ]);
  expect(switched.turns[0]!.parts).toEqual([
    { type: 'marker', marker: 'model', text: 'sonnet' },
    { type: 'text', text: expect.stringContaining('Sonnet') },
  ]);
});

it("keeps a Claude Code image block and drops its notice and another session's text, as claude-agent-acp maps them", async () => {
  const { hosted, turns } = await replayed('claude-image');

  expect(turns[0]).toEqual({
    parts: [
      { type: 'text', text: 'Working.' },
      { type: 'text', text: 'Done.' },
      { type: 'image', file: 'version-1', name: 'image-1.png', media_type: 'image/png' },
    ],
    context: { used: 1200, window: 200000 },
  });
  expect(hosted.uploads).toHaveLength(1);
});

it("marks an image House did not save with the Kit's cause in place of its image part", async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  hosted.house.route('POST', '/bytes/:grant', () => ({
    body: { version: 'version-1', save: { status: 'failed', failure: 'storage unavailable' } },
  }));
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  const image = recorded('claude-image').find((event) => event.params.update?.content?.type === 'image')!;

  hosted.input({ kind: 'message', text: `@emit ${JSON.stringify(image).split('session-recorded').join('$SESSION')}`, files: [], first: false });
  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));

  expect((ended.body as Ended).parts).toEqual([
    { type: 'marker', marker: 'retry', text: 'image-1.png was not saved: storage unavailable' },
  ]);
});

function switched(value: string): string {
  return `@emit ${JSON.stringify({
    method: 'session/update',
    params: {
      sessionId: '$SESSION',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: value, options: [] }],
      },
    },
  })}`;
}

it('marks every model switch Claude Code makes after the Kit asked for a model, a switch back to that model included', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  hosted.input({ kind: 'option', option: 'model', value: 'sonnet' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: `${switched('haiku')}\n${switched('sonnet')}`, files: [], first: false });
  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));

  expect((ended.body as Ended).parts).toEqual([
    { type: 'marker', marker: 'model', text: 'haiku' },
    { type: 'marker', marker: 'model', text: 'sonnet' },
  ]);
});

it('marks a model switch Claude Code makes to a model the Kit asked for and the CLI refused', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  await writeFile(join(hosted.home, 'refuse-model'), 'opus');
  hosted.input({ kind: 'option', option: 'model', value: 'opus' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', text: switched('opus'), files: [], first: false });
  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));

  expect((ended.body as Ended).parts).toEqual([{ type: 'marker', marker: 'model', text: 'opus' }]);
});

it('marks a recorded Codex retry and reroute and drops its warning and title', async () => {
  const { turns } = await replayed('codex-markers');

  expect(turns[0]!.parts).toEqual([
    { type: 'marker', marker: 'retry', text: 'Reconnecting... 1/5' },
    { type: 'marker', marker: 'model', text: 'Switched from gpt-5.6-sol to gpt-5.5-mini (highRiskCyberActivity).' },
    { type: 'text', text: 'ok' },
  ]);
});

it.each(['claude-web', 'codex-web'])(
  'counts the recorded web search, page fetch, MCP call and edit of %s and carries none of their titles, inputs or outputs',
  async (fixture) => {
    const { turns } = await replayed(fixture);

    const commands = turns[0]!.parts.filter((part) => part.type === 'commands');
    expect(commands.reduce((sum, part) => sum + Number(part.count), 0)).toBe(fixture === 'claude-web' ? 5 : 4);
    expect(turns[0]!.parts.every((part) => ['commands', 'text', 'reasoning'].includes(String(part.type)))).toBe(true);
    expect(JSON.stringify(commands)).not.toMatch(/example\.com|Agent Client Protocol|echo|notes\.txt/);
  },
);

it('counts a recorded Codex MCP call when it starts', async () => {
  const hosted = await hostKit([{ kind: 'codex-acp' }]);
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  const events = recorded('codex-web');
  const own = events.find((event) => event.params.sessionId !== undefined)!.params.sessionId;
  const started = events.find((event) => event.params.update?.sessionUpdate === 'tool_call' && event.params.update.rawInput?.server === 'echo')!;

  hosted.input({ kind: 'message', text: `@emit ${JSON.stringify(started).split(own).join('$SESSION')}\n@say after`, files: [], first: false });
  const ended = await until(() => hosted.turns.find((turn) => turn.path.endsWith('/ended')));

  expect((ended.body as Ended).parts).toEqual([
    { type: 'commands', count: 1 },
    { type: 'text', text: 'after' },
  ]);
});

it("marks a recorded Codex background terminal's start in its turn and its end, which came after that turn, first in the next", async () => {
  const { hosted, turns } = await replayed('codex-terminal');
  hosted.input({ kind: 'message', text: '@say ok', files: [], first: false });
  const next = await until(() => hosted.turns.filter((turn) => turn.path.endsWith('/ended'))[1]);

  expect(turns[0]!.parts.filter((part) => part.type === 'marker')).toEqual([
    { type: 'marker', marker: 'job', text: 'sleep 25: running' },
  ]);
  expect((next.body as Ended).parts[0]).toEqual({ type: 'marker', marker: 'job', text: 'sleep 25: completed' });
});

it.each(['claude-routines', 'codex-routines'])(
  'shows the recorded send_routine_request and cancel_routine_request of %s as one part each, naming what it targets',
  async (fixture) => {
    const { turns } = await replayed(fixture);

    expect(turns[0]!.parts.filter((part) => part.type === 'message')).toEqual([
      { type: 'message', command: 'send_routine_request', target: 'ra_123' },
      { type: 'message', command: 'cancel_routine_request', target: 'rr_456' },
    ]);
  },
);

it("shows Grok Build's recorded send_routine_request as one part and marks the retries its usage limit cut short", async () => {
  const { turns } = await replayed('grok-routines');

  const parts = turns[0]!.parts;
  expect(parts.filter((part) => part.type === 'message')).toEqual([
    { type: 'message', command: 'send_routine_request', target: 'ra_123' },
  ]);
  const retries = parts.filter((part) => part.type === 'marker');
  expect(retries.length).toBeGreaterThan(0);
  expect(retries.every((part) => part.marker === 'retry' && String(part.text).startsWith('API error (status 429'))).toBe(true);
});

it("marks Grok Build's model switch, reads the context window of the model it switched to, counts a statusless call as running, closes it at the turn's end and drops other sessions' updates", async () => {
  const { hosted, turns } = await replayed('grok-markers');
  await settle();

  expect(turns[0]).toEqual({
    parts: [
      { type: 'commands', count: 1 },
      { type: 'marker', marker: 'model', text: 'grok-4.7-fast' },
      { type: 'text', text: 'Done.' },
    ],
    context: { used: 3120, window: 2000000 },
  });
  expect(hosted.turns.filter((turn) => turn.path.endsWith('/started'))).toHaveLength(1);
});

it.each(['claude-tools', 'codex-tools', 'grok-tools'])(
  'writes the part operations of %s as it maps them, and its counts carry only their number, with no token count or cost',
  async (fixture) => {
    const { hosted, turns } = await replayed(fixture, fixture === 'claude-tools' ? 2 : 1);

    const operations = hosted.socket.frames.filter((frame) => frame.type === 'turn').map((frame) => frame.op);
    expect(operations).toEqual(expect.arrayContaining(['start', 'append', 'context']));
    expect(operations.every((op) => ['start', 'append', 'count', 'status', 'plan', 'context'].includes(String(op)))).toBe(true);
    for (const turn of turns) {
      expect(Object.keys(turn).sort()).toEqual(['context', 'parts']);
      expect(Object.keys(turn.context!).sort()).toEqual(['used', 'window']);
      for (const part of turn.parts.filter((candidate) => candidate.type === 'commands')) {
        expect(Object.keys(part).sort()).toEqual(['count', 'type']);
      }
    }
    expect(JSON.stringify(turns)).not.toMatch(/"cost"|"amount"|Tokens"|_tokens"/);
  },
);
