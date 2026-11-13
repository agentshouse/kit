import {
  applied,
  DIFF_CHARACTERS,
  firstPart,
  FIRST_PART_CHARACTERS,
  isOperation,
  isState,
  isTurn,
  lastLines,
  OUTPUT_LINES,
  type Operation,
  type Part,
  type SessionState,
  type Turn,
} from '@agentshouse/session-content';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { idOf, settle, until, type Received } from './double.ts';
import { emit, hostKit, lastCall, type Hosted, type RouteOverrides } from './environment.ts';

const KINDS: Record<string, string> = { claude: 'claude-agent-acp', codex: 'codex-acp', grok: 'grok-build' };

interface Ended {
  content: Turn;
  failed?: string;
}

interface Replayed {
  hosted: Hosted;
  turns: Ended[];
}

function recorded(fixture: string): { method: string; params: Record<string, any> }[] {
  return readFileSync(new URL(`./fixtures/events/${fixture}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((line) => line.method !== undefined);
}

interface Recording {
  route?: RouteOverrides;
  options?: [string, string][];
  questions?: number;
  responses?: unknown[];
}

function endedOf(received: Received): Ended {
  return received.body as Ended;
}

async function replayed(fixture: string, count = 1, recording: Recording = {}): Promise<Replayed> {
  const hosted = await hostKit([{ kind: KINDS[fixture.split('-')[0]!]!, ...recording.route }]);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  for (const [option, value] of recording.options ?? []) {
    hosted.call({ kind: 'option', option, value });
    await hosted.result(lastCall());
  }
  hosted.watch(true);
  hosted.call({ kind: 'message', text: `@gate admitted\n@replay ${fixture}`, first: false });
  await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/start'));
  await writeFile(join(hosted.home, 'admitted'), '');
  for (let index = 0; index < (recording.questions ?? 0); index++) {
    const { interaction_id, request } = (await until(() => hosted.interactions[index])).body as {
      interaction_id: string;
      request: { params: { options: { optionId: string; kind: string }[] } };
    };
    const response =
      recording.responses?.[index] ??
      { outcome: { outcome: 'selected', optionId: request.params.options.find((option) => option.kind.startsWith('allow'))!.optionId } };
    hosted.call({ kind: 'answer', interaction_id, response });
  }
  const ended = await until(() => {
    const found = hosted.turns.filter((turn) => turn.path === '/kit/turns/end');
    return found.length === count ? found : undefined;
  });
  const order = hosted.turns.filter((turn) => turn.path === '/kit/turns/start').map((turn) => idOf(turn, 'turn'));
  const byTurn = new Map(ended.map((turn): [string, Received] => [idOf(turn, 'turn'), turn]));
  return { hosted, turns: order.map((turn) => endedOf(byTurn.get(turn)!)) };
}

function partsOf(turns: Ended[]): readonly Part[] {
  return turns.flatMap((turn) => turn.content.parts);
}

function own(parts: readonly Part[]): Part[] {
  return parts.filter((part) => part.parent === null);
}

function written(turns: Ended[]): string {
  return own(partsOf(turns))
    .flatMap((part) => (part.type === 'text' || part.type === 'reasoning' ? [part.text] : []))
    .join('');
}

function chunks(fixture: string): string {
  const events = recorded(fixture);
  const session = events.find((event) => event.params.sessionId !== undefined)!.params.sessionId;
  return events
    .filter((event) => event.method === 'session/update' && event.params.sessionId === session)
    .map((event) => event.params.update)
    .filter((update) => ['agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate) && update.content.type === 'text')
    .filter((update) => update._meta?.claudeCode?.parentToolUseId === undefined)
    .map((update) => update.content.text)
    .join('');
}

function kinds(parts: readonly Part[]): string[] {
  return parts.map((part) => ('kind' in part ? `${part.type}:${part.kind}` : part.type));
}

function untimed(part: Part): Part {
  if (part.type !== 'call' && part.type !== 'subagent') return part;
  const { duration: _duration, ...rest } = part;
  return rest as Part;
}

function states(hosted: Hosted): SessionState[] {
  return hosted.connection.oneWayCalls.filter((oneWayCall) => oneWayCall.type === 'state').map((oneWayCall) => oneWayCall.state as SessionState);
}

function streamed(hosted: Hosted, type: string): boolean {
  return hosted.connection.oneWayCalls.some(
    (oneWayCall) => oneWayCall.type === 'turn' && (oneWayCall.operation as Operation).op === 'start' && ((oneWayCall.operation as { part: Part }).part.type === type),
  );
}

function emittedImage(): string {
  const image = recorded('claude-image').find((event) => event.params.update?.content?.type === 'image')!;
  return `@emit ${JSON.stringify(image).split('session-recorded').join('$SESSION')}`;
}

function update(update: Record<string, unknown>): string {
  return emit('session/update', { update });
}

function sdk(message: Record<string, unknown>): string {
  return emit('_claude/sdkMessage', { message });
}

async function said(kind: string, text: string): Promise<Ended> {
  const hosted = await hostKit([{ kind }]);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  hosted.watch(true);
  hosted.call({ kind: 'message', text, first: false });
  return endedOf(await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end')));
}

it.each(['claude-tools', 'codex-tools', 'grok-tools'])(
  'maps the work recorded in %s into Session content its parser accepts, the same parts for the same work and no field of one CLI alone',
  async (fixture) => {
    const { turns } = await replayed(fixture, fixture === 'claude-tools' ? 2 : 1);

    for (const turn of turns) expect(isTurn(turn.content)).toBe(true);
    const parts = own(partsOf(turns)).map(untimed);
    expect(parts).toContainEqual({ type: 'call', parent: null, kind: 'command', line: 'echo hello', status: 'done', exit: 0, output: expect.stringMatching(/^hello\n?$/) });
    expect(parts).toContainEqual(expect.objectContaining({ type: 'call', kind: 'read', status: 'done', line: expect.stringContaining('notes.txt'), returned: expect.any(Number) }));
    expect(parts).toContainEqual({ type: 'message', parent: null, command: 'agent-functions/send', target: 'digest' });
    expect(parts).toContainEqual(expect.objectContaining({ type: 'subagent', kind: 'agent', task: expect.stringMatching(/^Count files/) }));
    expect(written(turns)).toBe(chunks(fixture));
  },
);

it('keeps the shell output, exit code and duration of a recorded Codex turn, which Codex sends now that the Kit asks for it', async () => {
  const { turns } = await replayed('codex-tools');

  expect(turns[0]!.content.parts).toContainEqual({ type: 'call', parent: null, kind: 'command', line: 'echo hello', status: 'done', exit: 0, output: 'hello\n', duration: 0 });
});

it("keeps a recorded sub-agent's own calls and text under it, its kind, task, report and the figures its CLI reports", async () => {
  const codex = (await replayed('codex-tools')).turns[0]!.content.parts;
  const grok = (await replayed('grok-tools')).turns[0]!.content.parts;
  const claude = (await replayed('claude-subagents', 2)).turns[0]!.content.parts;

  const counted = codex.findIndex((part) => part.type === 'subagent');
  expect(codex[counted]).toEqual({
    type: 'subagent',
    parent: null,
    kind: 'agent',
    name: null,
    task: 'Count files',
    status: 'done',
    step: 'List files',
    report: '`ls` returned one file: `notes.txt`.',
    tokens: null,
    calls: null,
    duration: null,
  });
  expect(kinds(codex.filter((part) => part.parent === counted))).toEqual(['reasoning', 'call:read', 'text']);
  const listed = grok.findIndex((part) => part.type === 'subagent');
  expect(grok[listed]).toEqual({
    type: 'subagent',
    parent: null,
    kind: 'agent',
    name: 'general-purpose',
    task: 'Count files with ls',
    status: 'done',
    step: null,
    report: '1',
    tokens: 11371,
    calls: 1,
    duration: 2633,
  });
  expect(grok.filter((part) => part.parent === listed).map(untimed)).toEqual([
    { type: 'call', parent: listed, kind: 'command', line: 'ls -1 | wc -l', status: 'done', exit: 0, output: '1\n' },
    { type: 'text', parent: listed, text: '1' },
  ]);
  expect(claude[0]).toEqual({
    type: 'subagent',
    parent: null,
    kind: 'agent',
    name: 'general-purpose',
    task: 'Count files',
    status: 'done',
    step: 'Running List files and count them',
    report: 'There is 1 file in the directory: `notes.txt`.',
    tokens: 27214,
    calls: 1,
    duration: 3793,
  });
  expect(claude.filter((part) => part.parent === 0).map(untimed)).toEqual([
    { type: 'call', parent: 0, kind: 'command', line: 'ls | wc -l; ls', status: 'done', exit: 0, output: '1\nnotes.txt' },
  ]);
});

it.each([
  ['claude-subagents', 'Sleep and list', '`sleep 5; ls` listed one file: `notes.txt`.'],
  ['grok-subagent', 'Sleep then list files', '`sleep 5; ls` finished successfully in the current working directory and listed one entry: **notes.txt**.'],
])("shows the background sub-agent recorded in %s running in its turn and in the session's state, then done with its report in the turn running then", async (fixture, task, report) => {
  const { hosted, turns } = await replayed(fixture, 2);

  expect(turns[0]!.content.parts).toContainEqual(expect.objectContaining({ type: 'subagent', parent: null, task, status: 'running', report: null }));
  expect(turns[0]!.content.state.running).toEqual([{ kind: 'subagent', count: 1 }]);
  expect(turns[1]!.content.parts[0]).toEqual(expect.objectContaining({ type: 'subagent', parent: null, task, status: 'done', report }));
  expect(turns[1]!.content.state.running).toEqual([]);
  expect(states(hosted).at(-1)!.running).toEqual([]);
});

it.each([
  ['claude-background', 'Sleep for 8 seconds in background'],
  ['grok-background', 'Run sleep 8 without waiting'],
])("shows the background shell recorded in %s running in its turn and in the session's state, and its end first in the next turn", async (fixture, label) => {
  const { turns } = await replayed(fixture, 2);

  expect(turns[0]!.content.parts).toContainEqual({ type: 'background', parent: null, kind: 'shell', label, status: 'running' });
  expect(turns[0]!.content.state.running).toEqual([{ kind: 'shell', count: 1 }]);
  expect(turns[1]!.content.parts[0]).toEqual({ type: 'background', parent: null, kind: 'shell', label, status: 'done' });
  expect(turns[1]!.content.state.running).toEqual([]);
});

it("closes a recorded Codex command its background terminal took over, shows the terminal running and its end, which came after that turn, first in the next", async () => {
  const { hosted, turns } = await replayed('codex-terminal');
  hosted.call({ kind: 'message', text: '@say ok', first: false });
  const next = endedOf(await until(() => hosted.turns.filter((turn) => turn.path === '/kit/turns/end')[1]));

  expect(turns[0]!.content.parts.map(untimed)).toContainEqual({ type: 'call', parent: null, kind: 'command', line: 'sleep 25', status: 'done', exit: null, output: '' });
  expect(turns[0]!.content.parts).toContainEqual({ type: 'background', parent: null, kind: 'shell', label: 'sleep 25', status: 'running' });
  expect(next.content.parts[0]).toEqual({ type: 'background', parent: null, kind: 'shell', label: 'sleep 25', status: 'done' });
});

it.each(['claude-schedule', 'grok-schedule'])("shows the native schedule recorded in %s as background work, and in the session's state as one schedule until it is deleted", async (fixture) => {
  const { hosted, turns } = await replayed(fixture);

  expect(turns[0]!.content.parts).toContainEqual({ type: 'background', parent: null, kind: 'schedule', label: 'say hi', status: 'stopped' });
  expect(states(hosted).map((state) => state.running)).toContainEqual([{ kind: 'schedule', count: 1 }]);
  expect(turns[0]!.content.state.running).toEqual([]);
});

function events(fixture: string): string {
  return fileURLToPath(new URL(`./fixtures/events/${fixture}.jsonl`, import.meta.url));
}

function linesOf(fixture: string): Record<string, any>[] {
  return readFileSync(events(fixture), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function renamed(line: Record<string, any>, renames: [string, string][]): Record<string, any> {
  let text = JSON.stringify(line);
  for (const [from, to] of renames) text = text.split(from).join(to);
  return JSON.parse(text);
}

async function derived(hosted: Hosted, name: string, lines: Record<string, any>[]): Promise<string> {
  const path = join(hosted.home, `${name}.jsonl`);
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

async function sessionOf(hosted: Hosted): Promise<string> {
  const opened = (await hosted.adapterLog()).find((entry) => entry.method === 'session/new');
  return opened!.sessionId as string;
}

const COMPOSED: Record<string, (hosted: Hosted) => Promise<string[]>> = {
  'claude-agent-acp': async (hosted) => {
    const edit = linesOf('claude-retry').slice(17, 25);
    const other = edit.map((line) => renamed(line, [['toolu_01NBDhKngHkVZFa2MATnxChC', 'toolu_01NBDhKngHkVZFa2MATnxChD'], ['notes.txt', 'todo.txt']]));
    return [
      `@play ${events('claude-retry')} 17 25`,
      `@play ${await derived(hosted, 'todo', other)}`,
      `@play ${events('claude-background')} 8 21`,
      `@play ${events('claude-subagents')} 28 37`,
    ];
  },
  'codex-acp': async (hosted) => {
    const { tap } = linesOf('codex-web').findLast((line) => line.tap?.method === 'turn/diff/updated')!;
    const diff = tap.params.diff as string;
    const turnDiff = { ...tap, params: { ...tap.params, threadId: await sessionOf(hosted), diff: `${diff}${diff.split('notes.txt').join('todo.txt')}` } };
    return [
      `@stream ${await derived(hosted, 'diff', [turnDiff])}`,
      `@play ${events('codex-terminal')} 15 25`,
      `@play ${events('codex-tools')} 113 114`,
    ];
  },
  'grok-build': async (hosted) => {
    const edit = linesOf('grok-edit').filter((_line, index) => [39, 40, 41, 42, 47].includes(index));
    const other = edit.map((line) => renamed(line, [['8360-1', '8360-9'], ['notes.txt', 'todo.txt']]));
    return [
      `@play ${events('grok-edit')} 39 49`,
      `@play ${await derived(hosted, 'todo', other)}`,
      `@play ${events('grok-background')} 37 44`,
      `@play ${events('grok-subagent')} 15 21`,
    ];
  },
};

it.each([
  ['claude-agent-acp', { count: 2, added: 2, removed: 2 }],
  ['codex-acp', { count: 2, added: 2, removed: 0 }],
  ['grok-build', { count: 2, added: 3, removed: 3 }],
])(
  "counts in the session's state the two files a turn %s recorded edits with their lines, and the background shell and sub-agent it leaves running by kind, with no path or label",
  async (kind, files) => {
    const hosted = await hostKit([{ kind }]);
    hosted.call({ kind: 'open' });
    await hosted.result(lastCall());
    hosted.watch(true);
    hosted.call({ kind: 'message', text: (await COMPOSED[kind]!(hosted)).join('\n'), first: false });
    await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end'));
    const state = await until(() => states(hosted).findLast((one) => one.files.count > 0 && one.running.length > 0));

    expect(state.files).toEqual(files);
    expect(state.running).toEqual([
      { kind: 'shell', count: 1 },
      { kind: 'subagent', count: 1 },
    ]);
    expect(states(hosted).every(isState)).toBe(true);
  },
);

it('keeps each recorded call with its kind: a web search with how much it found, a fetched page, an MCP call and its result, a command and an edit with its diff', async () => {
  const claude = (await replayed('claude-web')).turns[0]!.content.parts.map(untimed);
  const { turns } = await replayed('codex-web');
  const codex = turns[0]!.content.parts.map(untimed);
  const edited = (await replayed('claude-retry')).turns[0]!.content;

  expect(kinds(claude)).toEqual(['call:other', 'call:search', 'call:fetch', 'call:tool', 'call:command', 'text']);
  expect(claude.slice(1, 4)).toEqual([
    { type: 'call', parent: null, kind: 'search', line: 'Search "Agent Client Protocol"', status: 'done', returned: 7 },
    { type: 'call', parent: null, kind: 'fetch', line: 'Fetch https://example.com', status: 'done', output: 'The page title is "Example Domain."' },
    { type: 'call', parent: null, kind: 'tool', line: 'mcp__echo__echo', status: 'done', output: 'hi' },
  ]);
  expect(kinds(codex).filter((kind) => kind.startsWith('call:'))).toEqual(['call:search', 'call:fetch', 'call:tool', 'call:edit']);
  expect(codex).toContainEqual({ type: 'call', parent: null, kind: 'tool', line: 'mcp.echo.echo', status: 'done', output: 'hi' });
  expect(codex).toContainEqual({
    type: 'call',
    parent: null,
    kind: 'edit',
    line: 'Editing files',
    status: 'done',
    files: [{ path: '/work/notes.txt', added: 1, removed: 0, diff: '@@ -3 +3,2 @@\n gamma\n+beta\n' }],
  });
  expect(turns[0]!.content.state.files).toEqual({ count: 1, added: 1, removed: 0 });
  expect(edited.parts.map(untimed)).toContainEqual({
    type: 'call',
    parent: null,
    kind: 'edit',
    line: 'Edit notes.txt',
    status: 'done',
    files: [{ path: '/work/notes.txt', added: 1, removed: 1, diff: '@@ -1,3 +1,3 @@\n alpha\n beta\n-gamma\n+delta\n' }],
  });
  expect(edited.state.files).toEqual({ count: 1, added: 1, removed: 1 });
});

it("keeps each recorded Grok Build edit of an existing file with its diff at the lines it changed, and a write over the whole file with what it replaced", async () => {
  const edited = (await replayed('grok-edit')).turns[0]!.content;
  const written = (await replayed('grok-write')).turns[0]!.content;
  const edits = (content: Turn) => content.parts.filter((part) => part.type === 'call' && part.kind === 'edit').map(untimed);
  const notes = (added: number, removed: number, diff: string) => [{ path: '/work/notes.txt', added, removed, diff }];

  expect(edits(edited)).toEqual([
    { type: 'call', parent: null, kind: 'edit', line: 'Edit `/work/notes.txt`', status: 'done', files: notes(1, 1, '@@ -2,1 +2,1 @@\n-two\n+TWO\n') },
    { type: 'call', parent: null, kind: 'edit', line: 'Edit `/work/notes.txt`', status: 'done', files: notes(1, 1, '@@ -9,1 +9,1 @@\n-nine\n+NINE\n') },
  ]);
  expect(edited.state.files).toEqual({ count: 1, added: 2, removed: 2 });
  const before = ['one', 'TWO', 'three', 'four', 'five', 'six', 'seven', 'eight', 'NINE', 'ten'].map((line) => `-${line}\n`).join('');
  expect(edits(written)).toEqual([
    { type: 'call', parent: null, kind: 'edit', line: 'Write `/work/notes.txt`', status: 'done', files: notes(2, 10, `@@ -1,10 +1,2 @@\n${before}+alpha\n+beta\n`) },
  ]);
});

it("starts a recorded Grok Build edit that begins inside a line at that line's start, the text before the edit included", async () => {
  const { content } = (await replayed('grok-midline')).turns[0]!;

  expect(content.parts.filter((part) => part.type === 'call' && part.kind === 'edit').map(untimed)).toEqual([
    {
      type: 'call',
      parent: null,
      kind: 'edit',
      line: 'Edit `/work/notes.txt`',
      status: 'done',
      files: [{ path: '/work/notes.txt', added: 3, removed: 3, diff: '@@ -2,3 +2,3 @@\n-the TWO dogs\n-beta\n-nine\n+the TWO cats\n+gamma\n+ten\n' }],
    },
  ]);
});

it.each(['claude-retry', 'codex-web', 'grok-edit'])("clears the last turn's files in the session's state when the turn after %s edits nothing", async (fixture) => {
  const { hosted } = await replayed(fixture);
  await until(() => states(hosted).at(-1)!.files.count > 0);

  hosted.call({ kind: 'message', text: '@say done', first: false });
  const next = await until(() => hosted.turns.filter((turn) => turn.path === '/kit/turns/end')[1]);
  expect(endedOf(next).content.state.files).toEqual({ count: 0, added: 0, removed: 0 });
});

it("cuts a command's output to its last lines, a fetched page to its first part and an edit's diff beyond its size to its line counts", async () => {
  const output = Array.from({ length: OUTPUT_LINES + 10 }, (_, index) => `line ${index + 1}`).join('\n');
  const page = 'p'.repeat(FIRST_PART_CHARACTERS + 50);
  const added = Array.from({ length: 400 }, (_, index) => `+${'x'.repeat(40)} ${index}`);
  const bash = { claudeCode: { toolName: 'Bash' } };
  const ended = await said(
    'claude-agent-acp',
    [
      update({ sessionUpdate: 'tool_call', toolCallId: 'bash-1', title: 'Terminal', kind: 'execute', status: 'pending', _meta: bash }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'bash-1', rawInput: { command: 'seq 30' } }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'bash-1', _meta: { terminal_output: { terminal_id: 'bash-1', data: output } } }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'bash-1', status: 'completed', _meta: { terminal_exit: { terminal_id: 'bash-1', exit_code: 0 } } }),
      update({ sessionUpdate: 'tool_call', toolCallId: 'fetch-1', title: 'Fetch https://example.com', kind: 'fetch', status: 'pending', _meta: { claudeCode: { toolName: 'WebFetch' } } }),
      sdk({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fetch-1', content: page }] }, tool_use_result: { result: page } }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'fetch-1', status: 'completed' }),
      update({ sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Edit big.txt', kind: 'edit', status: 'pending', _meta: { claudeCode: { toolName: 'Edit' } } }),
      sdk({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'edited' }] },
        tool_use_result: { filePath: '/work/big.txt', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 401, lines: [' kept', ...added] }] },
      }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'completed' }),
      '@say ok',
    ].join('\n'),
  );

  expect(added.join('\n').length).toBeGreaterThan(DIFF_CHARACTERS);
  const parts = ended.content.parts.map(untimed);
  expect(parts).toEqual([
    { type: 'call', parent: null, kind: 'command', line: 'seq 30', status: 'done', exit: 0, output: lastLines(output) },
    { type: 'call', parent: null, kind: 'fetch', line: 'Fetch https://example.com', status: 'done', output: firstPart(page) },
    { type: 'call', parent: null, kind: 'edit', line: 'Edit big.txt', status: 'done', files: [{ path: '/work/big.txt', added: 400, removed: 0, diff: null }] },
    { type: 'text', parent: null, text: 'ok' },
  ]);
  expect((parts[0] as { output: string }).output.split('\n')).toHaveLength(OUTPUT_LINES);
});

it("reads a recorded Claude Code session's title, limits, cost and turn duration into its state, and the context breakdown of its /context", async () => {
  const { hosted, turns } = await replayed('claude-tools', 2);
  const context = await replayed('claude-context');

  expect(turns[0]!.content.state).toEqual(
    expect.objectContaining({
      title: 'Sequential tool steps and background sub-agent',
      limits: [{ name: null, minutes: 10_080, percent: 63, resets: '2026-11-07T11:00:00.000Z' }],
      cost: { amount: 0.16141699999999998, currency: 'USD' },
      duration: 18_282,
      model: 'route-model',
      effort: 'route-effort',
      mode: 'bypassPermissions',
    }),
  );
  expect(states(hosted).map((state) => state.suggestion)).toContain('what did the sub-agent report?');
  expect(context.turns[0]!.content.state.context).toEqual({
    used: 32_387,
    window: 1_000_000,
    breakdown: [
      { name: 'System prompt', tokens: 2019 },
      { name: 'System tools', tokens: 22_181 },
      { name: 'System tools (deferred)', tokens: 22_609 },
      { name: 'Skills', tokens: 2660 },
      { name: 'Messages', tokens: 5527 },
      { name: 'Autocompact buffer', tokens: 33_000 },
      { name: 'Free space', tokens: 934_613 },
    ],
  });
  for (const part of own(context.turns[0]!.content.parts)) expect(part).toEqual({ type: 'text', parent: null, text: expect.stringMatching(/^## Context Usage\n/) });
});

it("reads a recorded Codex session's limits, its turn's duration and diff and its suggested next prompt into its state", async () => {
  const { hosted } = await replayed('codex-web');

  await until(() => states(hosted).at(-1)?.duration === 22_836);
  expect(states(hosted).at(-1)).toEqual(
    expect.objectContaining({
      limits: [
        { name: null, minutes: 300, percent: 14, resets: '2026-11-04T22:04:21.000Z' },
        { name: null, minutes: 10_080, percent: 18, resets: '2026-11-08T17:13:19.000Z' },
      ],
      duration: 22_836,
      files: { count: 1, added: 1, removed: 0 },
      mode: 'agent-full-access',
    }),
  );
  await until(() => states(hosted).at(-1)?.suggestion === 'Show me the updated contents of notes.txt.');
  expect(states(hosted).at(-1)!.title).toBe('Agent Client Protocol request');
});

it.each(['claude-tools', 'grok-tools'])(
  "sends the session's state of %s whole whenever it changes, and the turn's end carries the latest it sent",
  async (fixture) => {
    const { hosted, turns } = await replayed(fixture, fixture === 'claude-tools' ? 2 : 1);
    await settle();

    const sent = states(hosted);
    expect(sent.length).toBeGreaterThan(2);
    for (const state of sent) expect(isState(state)).toBe(true);
    for (let index = 1; index < sent.length; index++) expect(sent[index]).not.toEqual(sent[index - 1]);
    expect(sent).toContainEqual(turns.at(-1)!.content.state);
  },
);

it.each(['claude-tools', 'grok-tools', 'claude-web'])(
  'writes the Session content operations of %s as it maps them, and they fold into the turn it saves',
  async (fixture) => {
    const { hosted } = await replayed(fixture, fixture === 'claude-tools' ? 2 : 1);

    const written = hosted.connection.oneWayCalls.filter((oneWayCall) => oneWayCall.type === 'turn');
    for (const oneWayCall of written) expect(Object.keys(oneWayCall).sort()).toEqual(['conversation_id', 'operation', 'turn_id', 'type']);
    for (const ended of hosted.turns.filter((turn) => turn.path === '/kit/turns/end')) {
      const operations = written.filter((oneWayCall) => oneWayCall.turn_id === idOf(ended, 'turn')).map((oneWayCall) => oneWayCall.operation);
      let parts: readonly Part[] = [];
      for (const operation of operations) {
        expect(isOperation(operation)).toBe(true);
        parts = applied(parts, operation as Operation)!;
      }
      expect(parts).toEqual(endedOf(ended).content.parts);
    }
  },
);

it.each(['claude-compact', 'codex-compact', 'grok-compact'])('marks the compaction recorded in %s once', async (fixture) => {
  const { turns } = await replayed(fixture);

  expect(turns[0]!.content.parts).toEqual([{ type: 'notice', parent: null, kind: 'compaction', text: '' }]);
});

it.each([
  ['claude-plan', { questions: 1, route: { mode: 'plan', model: 'haiku', effort: null } }, ['default'], 1],
  ['codex-plan', { questions: 1, options: [['collaboration_mode', 'plan']] }, ['Implement this plan?', 'default'], 2],
  ['grok-plan', { questions: 1, responses: ['approved'] }, ['plan', 'default'], 1],
] as const)('marks the plan approval recorded in %s and the mode it left plan mode for', async (fixture, recording, modes, count) => {
  const { turns } = await replayed(fixture, count, recording as Recording);

  const notices = partsOf(turns).filter((part) => part.type === 'notice');
  expect(notices).toEqual(modes.map((text) => ({ type: 'notice', parent: null, kind: 'mode', text })));
  expect(JSON.stringify(own(partsOf(turns)).filter((part) => part.type === 'text'))).not.toContain('# Plan: create hello.txt');
});

it("marks each of Grok Build's recorded retries with its reason", async () => {
  const { turns } = await replayed('grok-schedule');

  const retries = turns[0]!.content.parts.filter((part) => part.type === 'notice' && part.kind === 'retry');
  expect(retries).toHaveLength(3);
  expect(retries.every((part) => part.type === 'notice' && part.text.startsWith('API error (status 429'))).toBe(true);
});

it('marks a recorded Claude Code retry and the model switch it made itself', async () => {
  const retried = await replayed('claude-retry');
  const switched = await replayed('claude-model');

  expect(retried.turns[0]!.content.parts[0]).toEqual({ type: 'notice', parent: null, kind: 'retry', text: 'Retrying Claude, attempt 1 of 10.' });
  expect(switched.turns[0]!.content.parts).toEqual([
    { type: 'notice', parent: null, kind: 'model', text: 'sonnet' },
    { type: 'text', parent: null, text: expect.stringContaining('Sonnet') },
  ]);
});

it("keeps a recorded Codex retry and each of its notices with its severity, its reroute and its warning included", async () => {
  const { turns } = await replayed('codex-markers');

  expect(turns[0]!.content.parts).toEqual([
    { type: 'notice', parent: null, kind: 'retry', text: 'Reconnecting... 1/5' },
    { type: 'notice', parent: null, kind: 'info', text: 'Model rerouted\nSwitched from gpt-5.6-sol to gpt-5.5-mini (highRiskCyberActivity).' },
    { type: 'notice', parent: null, kind: 'warning', text: expect.stringMatching(/^Your account was flagged for potentially high-risk cyber activity/) },
    { type: 'text', parent: null, text: 'ok' },
  ]);
});

it("keeps a Claude Code image block where its upload ends and the hook's notice, and drops another session's text", async () => {
  const { hosted, turns } = await replayed('claude-image');

  expect(turns[0]!.content.parts).toEqual([
    { type: 'text', parent: null, text: 'Working.' },
    { type: 'notice', parent: null, kind: 'warning', text: 'Stop hook feedback\nRun the tests first.' },
    { type: 'text', parent: null, text: 'Done.' },
    { type: 'image', parent: null, file: 'version-1', name: 'image-1.png', media_type: 'image/png' },
  ]);
  expect(turns[0]!.content.state).toEqual(expect.objectContaining({ title: 'A title the CLI made', cost: { amount: 0.5, currency: 'USD' } }));
  expect(hosted.finishes).toHaveLength(2);
});

it('saves the image Codex generated in the recording and the call that generated it', async () => {
  const { hosted, turns } = await replayed('codex-tools');

  const parts = turns[0]!.content.parts;
  expect(parts).toContainEqual({ type: 'image', parent: null, file: 'version-1', name: 'image-1.png', media_type: 'image/png' });
  expect(parts.map(untimed)).toContainEqual(
    expect.objectContaining({ type: 'call', kind: 'other', line: 'Image generation', status: 'done', output: expect.stringMatching(/^Revised prompt: /) }),
  );
  expect(hosted.images.map((image) => idOf(image, 'name'))).toEqual(['image-1.png']);
  expect(hosted.store.requests.map((request) => [request.method, request.part, request.bytes, request.status])).toEqual([
    ['PUT', 1, 32, 200],
    ['PUT', 2, 32, 200],
    ['PUT', 3, 5, 200],
  ]);
  const image = Buffer.from(/"type":"image","data":"([^"]+)"/.exec(JSON.stringify(recorded('codex-tools')))![1]!, 'base64');
  const partSha256 = [image.subarray(0, 32), image.subarray(32, 64), image.subarray(64)].map((part) => createHash('sha256').update(part).digest('hex'));
  expect(hosted.finishes.map((finish) => finish.body)).toEqual(Array(2).fill({ upload: expect.any(String), part_sha256: partSha256 }));
});

it("marks an image House did not save with House's refusal as an error notice", async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  hosted.house.route('POST', '/kit/uploads/finish', () => ({
    status: 410,
    body: { error: { code: 'upload_expired', message: 'upload_expired: this upload is gone; run the same command again to start a new one', retryable: false } },
  }));
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());

  hosted.call({ kind: 'message', text: emittedImage(), first: false });
  const ended = endedOf(await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end')));

  expect(ended.content.parts).toEqual([
    { type: 'notice', parent: null, kind: 'error', text: 'image-1.png was not saved: upload_expired: this upload is gone; run the same command again to start a new one' },
  ]);
});

it('streams the text after an image and declares the next image while the first one uploads, and saves each image as its upload ends', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  const declared = new Map<string, string>();
  let first = false;
  hosted.house.route('POST', '/kit/turns/images/declare', (request) => {
    hosted.images.push(request);
    const { bytes, sha256 } = request.body as { bytes: number; sha256: string };
    const answer = hosted.store.declare({ bytes, sha256, path: `version-${hosted.images.length}` }, 1024);
    declared.set(answer.upload.id, `version-${hosted.images.length}`);
    return { body: answer };
  });
  hosted.house.route('POST', '/kit/uploads/finish', async (request) => {
    const { upload, part_sha256 } = request.body as { upload: string; part_sha256: unknown };
    if (declared.get(upload) === 'version-1') await until(() => hosted.images[1] && streamed(hosted, 'text'));
    else await until(() => first);
    const finished = await hosted.store.finish(upload, part_sha256);
    first = true;
    return { body: finished };
  });
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  hosted.watch(true);

  hosted.call({ kind: 'message', text: `${emittedImage()}\n${emittedImage()}\n@say Done.\n@gate streamed`, first: false });
  await until(() => streamed(hosted, 'image'));
  await writeFile(join(hosted.home, 'streamed'), '');
  const ended = endedOf(await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end')));

  expect(ended.content.parts).toEqual([
    { type: 'text', parent: null, text: 'Done.' },
    { type: 'image', parent: null, file: 'version-1', name: 'image-1.png', media_type: 'image/png' },
    { type: 'image', parent: null, file: 'version-2', name: 'image-2.png', media_type: 'image/png' },
  ]);
});

it('keeps writing the text an image was saved in the middle of', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  hosted.house.route('POST', '/kit/uploads/finish', async (request) => {
    await until(() => streamed(hosted, 'text'));
    const { upload, part_sha256 } = request.body as { upload: string; part_sha256: unknown };
    return { body: await hosted.store.finish(upload, part_sha256) };
  });
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  hosted.watch(true);

  hosted.call({ kind: 'message', text: `${emittedImage()}\n@say All nine\n@gate saved\n@say  steps completed.`, first: false });
  await until(() => streamed(hosted, 'image'));
  await writeFile(join(hosted.home, 'saved'), '');
  const ended = endedOf(await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end')));

  expect(ended.content.parts).toEqual([
    { type: 'text', parent: null, text: 'All nine steps completed.' },
    { type: 'image', parent: null, file: 'version-1', name: 'image-1.png', media_type: 'image/png' },
  ]);
});

function switched(value: string): string {
  return update({
    sessionUpdate: 'config_option_update',
    configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: value, options: [] }],
  });
}

it("marks every model switch Claude Code makes after the Kit asked for a model, a switch back to that model included, and carries the model in the session's state", async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  hosted.call({ kind: 'option', option: 'model', value: 'sonnet' });
  await hosted.result(lastCall());

  hosted.call({ kind: 'message', text: `${switched('haiku')}\n${switched('sonnet')}`, first: false });
  const ended = endedOf(await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end')));

  expect(ended.content.parts).toEqual([
    { type: 'notice', parent: null, kind: 'model', text: 'haiku' },
    { type: 'notice', parent: null, kind: 'model', text: 'sonnet' },
  ]);
  expect(states(hosted).map((state) => state.model)).toEqual(expect.arrayContaining(['haiku', 'sonnet']));
});

it('marks a model switch Claude Code makes to a model the Kit asked for and the CLI refused', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }]);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  await writeFile(join(hosted.home, 'refuse-model'), 'opus');
  hosted.call({ kind: 'option', option: 'model', value: 'opus' });
  await hosted.result(lastCall());

  hosted.call({ kind: 'message', text: switched('opus'), first: false });
  const ended = endedOf(await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end')));

  expect(ended.content.parts).toEqual([{ type: 'notice', parent: null, kind: 'model', text: 'opus' }]);
});

it.each(['claude-agent-functions', 'codex-agent-functions'])(
  "shows the recorded agent-functions/send and agent-functions/cancel of %s as one message part each, naming the Agent function's card and the request they target",
  async (fixture) => {
    const { turns } = await replayed(fixture);

    expect(turns[0]!.content.parts.filter((part) => part.type === 'message')).toEqual([
      { type: 'message', parent: null, command: 'agent-functions/send', target: 'digest' },
      { type: 'message', parent: null, command: 'agent-functions/cancel', target: 'rr_456' },
    ]);
  },
);

function emitted(fixture: string, rewrites: [string, string][] = [], call?: string): string {
  const events = recorded(fixture);
  const session = events.find((event) => event.params.sessionId !== undefined)!.params.sessionId;
  const id =
    call === undefined
      ? undefined
      : events.find((event) => event.params.update?.toolCallId !== undefined && JSON.stringify(event).includes(call))!.params.update.toolCallId;
  return events
    .filter((event) => id === undefined || event.params.update?.toolCallId === id)
    .map((event) => {
      let line = JSON.stringify(event).split(session).join('$SESSION');
      for (const [from, to] of rewrites) line = line.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
      return `@emit ${line}`;
    })
    .join('\n');
}

const SEARCHED = `house search '{"query":"alpha"}'`;
const AGENT_FUNCTION_SENT = '{"command":"agent-functions/send","arguments":{"room_ref":null,"agent_function":"digest","payload":"hi"}}';
const AGENT_FUNCTION_CANCELLED = '{"command":"agent-functions/cancel","arguments":{"room_ref":null,"request":"rr_456"}}';
const MAILED = '{"command":"agent-functions/mail/send","arguments":{"text":"Here is the summary.","request":"rr_789"}}';
const ANSWERED = '{"command":"agent-functions/mail/send","arguments":{"text":"Done."}}';
const LISTED = `house run_command '{"command":"conversations/active/list","arguments":{}}'`;
const AGENT_ASKED = '{"command":"agent-functions/send","arguments":{"room_ref":null,"agent":"ag_321","payload":"Sum up the week."}}';
const CONVERSATION_MAILED = '{"command":"agent-functions/mail/send","arguments":{"text":"Over to you.","conversation":"cv_654"}}';

async function shown(cli: string, text: string): Promise<Part[]> {
  const ended = await said(KINDS[cli]!, text);
  return ended.content.parts.filter((part) => part.type === 'message' || (part.type === 'call' && part.kind === 'command')).map(untimed);
}

function command(line: string): Part {
  return expect.objectContaining({ type: 'call', kind: 'command', line });
}

it.each(['claude', 'codex'])(
  "shows %s's house agent-functions/mail/send as one message part naming the request it names, or no target when it names none, and keeps the house call beside it as a command",
  async (cli) => {
    const searched = emitted(`${cli}-tools`, [], "house search '");
    const mailed = emitted(`${cli}-agent-functions`, [
      [AGENT_FUNCTION_SENT, MAILED],
      [AGENT_FUNCTION_CANCELLED, ANSWERED],
    ]);

    expect(await shown(cli, `${searched}\n${mailed}`)).toEqual([
      command(SEARCHED),
      { type: 'message', parent: null, command: 'agent-functions/mail/send', target: 'rr_789' },
      { type: 'message', parent: null, command: 'agent-functions/mail/send', target: null },
    ]);
  },
);

it.each(['claude', 'codex'])(
  "shows %s's house agent-functions/send naming an Agent and agent-functions/mail/send naming a conversation as one message part each naming it, and keeps its conversations/active/list as a command",
  async (cli) => {
    const listed = emitted(`${cli}-tools`, [[SEARCHED, LISTED]], "house search '");
    const sent = emitted(`${cli}-agent-functions`, [
      [AGENT_FUNCTION_SENT, AGENT_ASKED],
      [AGENT_FUNCTION_CANCELLED, CONVERSATION_MAILED],
    ]);

    expect(await shown(cli, `${listed}\n${sent}`)).toEqual([
      command(LISTED),
      { type: 'message', parent: null, command: 'agent-functions/send', target: 'ag_321' },
      { type: 'message', parent: null, command: 'agent-functions/mail/send', target: 'cv_654' },
    ]);
  },
);

it('keeps a house run_command naming a key every object inherits, or carrying null, as a command, and the turn goes on to its end', async () => {
  const keyed = emitted('claude-tools', [[SEARCHED, `house run_command '{"command":"__proto__","arguments":{}}'`]], "house search '");
  const odd = emitted('claude-agent-functions', [
    [AGENT_FUNCTION_SENT, '{"command":"constructor","arguments":{}}'],
    [AGENT_FUNCTION_CANCELLED, 'null'],
  ]);

  const parts = await shown('claude', `${keyed}\n${odd}`);

  expect(parts.filter((part) => part.type === 'message')).toEqual([]);
  expect(parts).toHaveLength(3);
});

it("shows Grok Build's recorded agent-functions/send as one message part and marks the retries its usage limit cut short", async () => {
  const { turns } = await replayed('grok-agent-functions');

  const parts = turns[0]!.content.parts;
  expect(parts.filter((part) => part.type === 'message')).toEqual([{ type: 'message', parent: null, command: 'agent-functions/send', target: 'digest' }]);
  const retries = parts.filter((part) => part.type === 'notice');
  expect(retries.length).toBeGreaterThan(0);
  expect(retries.every((part) => part.type === 'notice' && part.kind === 'retry' && part.text.startsWith('API error (status 429'))).toBe(true);
});

it("marks Grok Build's model switch, reads the context window of the model it switched to, closes a statusless call at the turn's end as stopped and drops other sessions' updates", async () => {
  const { hosted, turns } = await replayed('grok-markers');
  await settle();

  expect(turns[0]!.content.parts).toEqual([
    { type: 'call', parent: null, kind: 'command', line: 'npm test', status: 'stopped', exit: null, output: '', duration: null },
    { type: 'notice', parent: null, kind: 'model', text: 'grok-4.7-fast' },
    { type: 'text', parent: null, text: 'Done.' },
  ]);
  expect(turns[0]!.content.state.context).toEqual({ used: 3120, window: 2_000_000, breakdown: [] });
  expect(hosted.turns.filter((turn) => turn.path === '/kit/turns/start')).toHaveLength(1);
});

async function spent(kind: string, usage: Record<string, unknown>): Promise<Ended> {
  const hosted = await hostKit([{ kind }]);
  hosted.call({ kind: 'message', text: `@spent ${JSON.stringify(usage)}\n@say ok`, first: true });
  return endedOf(await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end')));
}

it("carries Claude Code's tokens by kind from every model of the turn, so a sub-agent's tokens count, and adds them to the session's", async () => {
  const row = (model: string, input: number, read: number, write: number, output: number) => ({
    model,
    token_count: {
      totalTokens: input + read + write + output,
      inputTokens: input,
      cachedInputTokens: read,
      cachedWriteTokens: write,
      outputTokens: output,
      reasoningOutputTokens: 0,
    },
  });
  const body = await spent('claude-agent-acp', {
    usage: { inputTokens: 5, outputTokens: 7, cachedReadTokens: 11, cachedWriteTokens: 13, totalTokens: 36 },
    _meta: { quota: { model_usage: [row('claude-main', 5, 11, 13, 7), row('claude-subagent', 100, 200, 300, 400)] } },
  });
  expect(body.content.tokens).toEqual({ input: 105, output: 407, cache_read: 211, cache_write: 313 });
  expect(body.content.state.tokens).toEqual({ input: 105, output: 407, cache_read: 211, cache_write: 313 });
});

it("carries Codex's tokens by kind, its reasoning already inside its output", async () => {
  const body = await spent('codex-acp', {
    usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 30, cachedWriteTokens: 40, thoughtTokens: 15, totalTokens: 100 },
  });
  expect(body.content.tokens).toEqual({ input: 10, output: 20, cache_read: 30, cache_write: 40 });
});

it("carries Grok's tokens by kind: its input holds its cache reads, its reasoning sits inside its output, and a sub-agent that finished within the turn is already in its parent's", async () => {
  const { turns } = await replayed('grok-tools');
  expect(turns[0]!.content.tokens).toEqual({ input: 147625 - 120448, output: 580, cache_read: 120448, cache_write: 0 });
});

it("leaves out a Grok sub-agent that outlives its turn, which its parent and the turn after it leave out too, and the session's tokens sum its turns", async () => {
  const { turns } = await replayed('grok-subagent', 2);
  const total = { input: 34955 - 18944 + (17878 - 17536), output: 89 + 70, cache_read: 18944 + 17536, cache_write: 0 };
  expect(turns[1]!.content.state.tokens).toEqual(total);
});

it.each([
  [{ outputTokens: 20 }],
  [{ inputTokens: 5, outputTokens: 20, cacheCreationTokens: 0 }],
  [{ inputTokens: 5, outputTokens: 20, cachedReadTokens: 9, cacheCreationTokens: 0 }],
  [null],
])('carries no tokens on a Grok turn whose usage is %j, and the turn still ends', async (usage) => {
  const hosted = await hostKit([{ kind: 'grok-build' }]);
  hosted.call({ kind: 'message', text: `@say ok\n@completed ${JSON.stringify(usage)}`, first: true });
  const ended = endedOf(await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end')));
  expect(ended.content.tokens).toBeNull();
  expect(kinds(ended.content.parts)).toContain('text');
});

it.each([
  ['claude-agent-acp', { _meta: { quota: { model_usage: [] } } }],
  ['claude-agent-acp', { _meta: { quota: { model_usage: [{ model: 'renamed', tokens: {} }] } } }],
  [
    'claude-agent-acp',
    {
      _meta: {
        quota: {
          model_usage: [
            { model: 'whole', token_count: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3, cachedWriteTokens: 4 } },
            { model: 'renamed', token_count: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3 } },
          ],
        },
      },
    },
  ],
  ['codex-acp', { usage: null }],
  ['codex-acp', {}],
  ['codex-acp', { usage: { outputTokens: 20 } }],
  ['codex-acp', { usage: { inputTokens: 10, outputTokens: 20, cachedWriteTokens: 0 } }],
  ['grok-build', {}],
])('carries no tokens on a %s turn whose usage is absent or incomplete, and the turn still ends', async (kind, usage) => {
  const body = await spent(kind, usage);
  expect(body.content.tokens).toBeNull();
  expect(kinds(body.content.parts)).toContain('text');
});
