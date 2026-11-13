import { applied, isOperation, isState, isTurn, type Operation, type Part, type PartOf, type SessionState, type Turn } from '@agentshouse/session-content';
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

function written(turns: Ended[]): string {
  return partsOf(turns)
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('');
}

function chunks(fixture: string): string {
  const events = recorded(fixture);
  const session = events.find((event) => event.params.sessionId !== undefined)!.params.sessionId;
  return events
    .filter((event) => event.method === 'session/update' && event.params.sessionId === session)
    .map((event) => event.params.update)
    .filter((update) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text')
    .filter((update) => update._meta?.claudeCode?.parentToolUseId === undefined)
    .map((update) => update.content.text)
    .join('');
}

function types(parts: readonly Part[]): string[] {
  return parts.map((part) => part.type);
}

function counts(counted: Partial<Omit<PartOf<'counts'>, 'type'>>): PartOf<'counts'> {
  return { type: 'counts', commands: 0, edited: 0, other: 0, added: 0, removed: 0, failed: 0, ...counted };
}

function text(said: string | RegExp): Part {
  return { type: 'text', text: typeof said === 'string' ? said : expect.stringMatching(said) };
}

function states(hosted: Hosted): SessionState[] {
  return hosted.connection.oneWayCalls.filter((oneWayCall) => oneWayCall.type === 'state').map((oneWayCall) => oneWayCall.state as SessionState);
}

function operationsOf(hosted: Hosted, turn: string): Operation[] {
  return hosted.connection.oneWayCalls
    .filter((oneWayCall) => oneWayCall.type === 'turn' && oneWayCall.turn_id === turn)
    .map((oneWayCall) => oneWayCall.operation as Operation);
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

async function said(kind: string, text: string): Promise<Ended> {
  const hosted = await hostKit([{ kind }]);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  hosted.watch(true);
  hosted.call({ kind: 'message', text, first: false });
  return endedOf(await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end')));
}

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

function emitted(fixture: string, lines: readonly Record<string, any>[]): string {
  const session = linesOf(fixture).find((line) => line.params?.sessionId !== undefined)!.params.sessionId as string;
  return lines.map((line) => `@emit ${JSON.stringify({ method: line.method, params: line.params }).split(session).join('$SESSION')}`).join('\n');
}

async function composed(kind: string, script: (hosted: Hosted) => Promise<string[]>): Promise<{ hosted: Hosted; ended: Ended }> {
  const hosted = await hostKit([{ kind }]);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  hosted.watch(true);
  hosted.call({ kind: 'message', text: (await script(hosted)).join('\n'), first: false });
  return { hosted, ended: endedOf(await until(() => hosted.turns.find((turn) => turn.path === '/kit/turns/end'))) };
}

it.each([
  ['claude-tools', [[counts({ commands: 2, other: 1 }), text(/^I have no TodoWrite tool/), counts({ commands: 2, other: 1 }), text(/^All steps ran/)], [text(/^The "Count files" sub-agent has finished/)]]],
  [
    'codex-tools',
    [
      [
        text(/^I’ll carry out the requested sequence/),
        counts({ commands: 4, other: 5 }),
        { type: 'notice', kind: 'warning', text: expect.stringContaining('shell_zsh_fork') },
        text(/^The delegated count has completed/),
        counts({ other: 3 }),
        text(/^Completed all requested steps/),
        { type: 'image', file: 'version-1', name: 'image-1.png', media_type: 'image/png' },
      ],
    ],
  ],
  ['grok-tools', [[text(/^I'll do the seven steps in order/), counts({ commands: 3, other: 3 }), text('There is 1 file in this folder.')]]],
] as [string, Part[][]][])(
  "counts each stretch of the work recorded in %s in one part of counts where its first call starts, commands, edits and other calls by kind, and sends the Agent's text between them and nothing else of the work",
  async (fixture, expected) => {
    const { turns } = await replayed(fixture, expected.length);

    for (const turn of turns) expect(isTurn(turn.content)).toBe(true);
    expect(turns.map((turn) => turn.content.parts)).toEqual(expected);
    expect(written(turns)).toBe(chunks(fixture));
  },
);

it.each([
  ['claude-web', [counts({ commands: 1, other: 4 }), text('done')]],
  ['codex-web', [counts({ edited: 1, other: 3, added: 1 }), text('done')]],
  ['claude-retry', [{ type: 'notice', kind: 'retry', text: 'Retrying Claude, attempt 1 of 10.' }, counts({ edited: 1, other: 1, added: 1, removed: 1 }), text('done')]],
  ['grok-edit', [text(/^I'll update those two lines/), counts({ edited: 1, other: 1, added: 2, removed: 2 }), text('done')]],
  ['grok-write', [text(/^I'll overwrite `notes.txt`/), counts({ edited: 1, added: 2, removed: 10 }), text('done')]],
  ['grok-midline', [counts({ edited: 1, added: 3, removed: 3 }), text('done')]],
] as [string, Part[]][])(
  'counts every call recorded in %s by its kind, a web search, a fetched page and an MCP tool as other calls, and each edited file once with the lines its edits added and removed',
  async (fixture, expected) => {
    const { turns } = await replayed(fixture);

    expect(turns[0]!.content.parts).toEqual(expected);
  },
);

const ONCE: Record<string, (hosted: Hosted) => Promise<string[]>> = {
  'claude-agent-acp': async (hosted) => {
    const edit = linesOf('claude-retry').slice(17, 25);
    const again = edit.map((line) => renamed(line, [['toolu_01NBDhKngHkVZFa2MATnxChC', 'toolu_01NBDhKngHkVZFa2MATnxChD']]));
    return [`@play ${events('claude-retry')} 17 25`, '@say Edited it once.', `@play ${await derived(hosted, 'again', again)}`, '@say done'];
  },
  'codex-acp': async (hosted) => {
    const edit = linesOf('codex-web').slice(61, 65);
    const again = edit.map((line) => renamed(line, [['85ec525b', '85ec525c']]));
    return [`@play ${await derived(hosted, 'edit', edit)}`, '@say Edited it once.', `@play ${await derived(hosted, 'again', again)}`, '@say done'];
  },
  'grok-build': async (hosted) => {
    const edit = linesOf('grok-edit').filter((_line, index) => [39, 40, 41, 42, 47].includes(index));
    const again = edit.map((line) => renamed(line, [['8360-1', '8360-9']]));
    return [`@play ${await derived(hosted, 'edit', edit)}`, '@say Edited it once.', `@play ${await derived(hosted, 'again', again)}`, '@say done'];
  },
};

it.each([
  ['claude-agent-acp', { added: 1, removed: 1 }],
  ['codex-acp', { added: 1, removed: 0 }],
  ['grok-build', { added: 1, removed: 1 }],
])(
  "counts a file %s's recording edits again after the Agent wrote once in the turn, in the stretch that first edited it, and each edit's lines in its own stretch",
  async (kind, lines) => {
    const { ended } = await composed(kind, ONCE[kind]!);

    expect(ended.content.parts).toEqual([counts({ edited: 1, ...lines }), text('Edited it once.'), counts(lines), text('done')]);
  },
);

function failedCall(fixture: string, call: string, failed: (line: Record<string, any>) => Record<string, any>): string {
  const id = linesOf(fixture).find((line) => line.params?.update?.sessionUpdate === 'tool_call' && JSON.stringify(line).includes(call))!.params.update.toolCallId;
  const lines = linesOf(fixture).filter((line) => line.params?.update?.toolCallId === id);
  return emitted(fixture, lines.map(failed));
}

const FAILED: Record<string, () => string> = {
  'claude-agent-acp': () =>
    failedCall('claude-tools', 'o63RGgKt', (line) => {
      const update = line.params.update;
      if (update.status !== 'completed') return line;
      return { ...line, params: { ...line.params, update: { ...update, status: 'failed', _meta: { ...update._meta, terminal_exit: { ...update._meta?.terminal_exit, exit_code: 1 } } } } };
    }),
  'codex-acp': () =>
    failedCall('codex-tools', 'echo hello', (line) => {
      const update = line.params.update;
      if (update.status !== 'completed') return line;
      return { ...line, params: { ...line.params, update: { ...update, status: 'failed', _meta: { ...update._meta, terminal_exit: { ...update._meta?.terminal_exit, exit_code: 1 } } } } };
    }),
  'grok-build': () =>
    failedCall('grok-tools', 'ce5a2b-0', (line) => {
      const update = line.params.update;
      if (update.status !== 'completed') return line;
      return { ...line, params: { ...line.params, update: { ...update, rawOutput: { ...update.rawOutput, exit_code: 1 } } } };
    }),
};

it.each(Object.keys(FAILED))(
  "counts a recorded %s command one failure when it ends as its adapter reports a command that exits with an error, from the call's status or its exit code",
  async (kind) => {
    const ended = await said(kind, `${FAILED[kind]!()}\n@say done`);

    expect(ended.content.parts).toEqual([counts({ commands: 1, failed: 1 }), text('done')]);
  },
);

it.each([
  ['claude-agent-functions', [counts({ commands: 2 }), text('done')]],
  ['codex-agent-functions', [counts({ commands: 2 }), text('done')]],
  [
    'grok-agent-functions',
    [
      { type: 'notice', kind: 'retry', text: expect.stringMatching(/^API error \(status 429/) },
      text(/^I'll run the two house commands in order/),
      counts({ commands: 1 }),
      { type: 'notice', kind: 'retry', text: expect.stringMatching(/^API error \(status 429/) },
      { type: 'notice', kind: 'retry', text: expect.stringMatching(/^API error \(status 429/) },
    ],
  ],
] as [string, Part[]][])(
  "counts the house agent-functions/send and agent-functions/cancel recorded in %s as the commands the Agent ran, naming no target",
  async (fixture, expected) => {
    const { turns } = await replayed(fixture);

    expect(turns[0]!.content.parts).toEqual(expected);
  },
);

const FOLDED: Record<string, () => string[]> = {
  'claude-agent-acp': () => [`@play ${events('claude-subagents')} 28 48`, `@play ${events('claude-subagents')} 51 64`],
  'codex-acp': () => {
    const lines = linesOf('codex-tools');
    const said = lines.slice(190, 200).filter((line) => line.params?.update?.sessionUpdate === 'agent_message_chunk');
    return [emitted('codex-tools', [lines[113]!, ...said, lines[142]!, lines[143]!])];
  },
  'grok-build': () => {
    const lines = linesOf('grok-subagent');
    return [emitted('grok-subagent', lines.slice(15, 28).filter((line) => line.method !== undefined)), emitted('grok-subagent', lines.slice(41, 48).filter((line) => line.params?.update?.sessionUpdate?.startsWith('tool_call')))];
  },
};

it.each([
  ['claude-agent-acp', counts({ commands: 1, other: 1 }), /^The first sub-agent found/],
  ['codex-acp', counts({ other: 2 }), /^The/],
  ['grok-build', counts({ commands: 1, other: 1 }), /^started$/],
] as [string, PartOf<'counts'>, RegExp][])(
  "counts a recorded %s sub-agent as the other call that started it and its own calls in that call's stretch, also once the Agent wrote again, and nothing else of it",
  async (kind, folded, words) => {
    const { hosted, ended } = await composed(kind, async () => FOLDED[kind]!());

    expect(ended.content.parts).toEqual([folded, text(words)]);
    expect(states(hosted).map((state) => state.running)).toContainEqual([{ kind: 'subagent', count: 1 }]);
  },
);

it.each(['claude-subagents', 'grok-subagent'])(
  "counts the background sub-agent recorded in %s only in the turn that started it, while the session's state shows it running, and none of what it does after that turn",
  async (fixture) => {
    const { hosted, turns } = await replayed(fixture, 2);

    expect(types(turns[0]!.content.parts)).toEqual(['counts', 'text']);
    expect(turns[0]!.content.state.running).toEqual([{ kind: 'subagent', count: 1 }]);
    expect(types(turns[1]!.content.parts)).toEqual(['text']);
    expect(turns[1]!.content.state.running).toEqual([]);
    expect(states(hosted).at(-1)!.running).toEqual([]);
  },
);

it.each([
  ['claude-background', 2, [{ kind: 'shell', count: 1 }]],
  ['grok-background', 2, [{ kind: 'shell', count: 1 }]],
  ['codex-terminal', 1, [{ kind: 'shell', count: 1 }]],
] as const)(
  "counts the call that hands its work to the background in %s as the command it is, and shows the work only in the session's state while it runs",
  async (fixture, count, running) => {
    const { hosted, turns } = await replayed(fixture, count);

    expect(turns[0]!.content.parts.filter((part) => part.type === 'counts')).toEqual([counts({ commands: 1 })]);
    expect(turns[0]!.content.state.running).toEqual(running);
    for (const turn of turns.slice(1)) expect(types(turn.content.parts)).toEqual(['text']);
    if (count === 2) expect(states(hosted).at(-1)!.running).toEqual([]);
  },
);

it.each(['claude-schedule', 'grok-schedule'])("shows the native schedule recorded in %s in the session's state as one schedule until it is deleted, and no part of it", async (fixture) => {
  const { hosted, turns } = await replayed(fixture);

  expect(types(turns[0]!.content.parts).filter((type) => type !== 'notice')).toEqual(fixture === 'claude-schedule' ? ['counts', 'text'] : ['text', 'counts', 'text']);
  expect(states(hosted).map((state) => state.running)).toContainEqual([{ kind: 'schedule', count: 1 }]);
  expect(turns[0]!.content.state.running).toEqual([]);
});

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

it.each(['claude-retry', 'codex-web', 'grok-edit'])("clears the last turn's files in the session's state when the turn after %s edits nothing", async (fixture) => {
  const { hosted } = await replayed(fixture);
  await until(() => states(hosted).at(-1)!.files.count > 0);

  hosted.call({ kind: 'message', text: '@say done', first: false });
  const next = await until(() => hosted.turns.filter((turn) => turn.path === '/kit/turns/end')[1]);
  expect(endedOf(next).content.state.files).toEqual({ count: 0, added: 0, removed: 0 });
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
  for (const part of context.turns[0]!.content.parts) expect(part).toEqual(text(/^## Context Usage\n/));
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

it.each(['claude-tools', 'grok-tools', 'claude-web', 'codex-web'])(
  'writes the Session content operations of %s as it counts, a set only when a part of counts changed, and they fold into the turn it saves',
  async (fixture) => {
    const { hosted } = await replayed(fixture, fixture === 'claude-tools' ? 2 : 1);

    const written = hosted.connection.oneWayCalls.filter((oneWayCall) => oneWayCall.type === 'turn');
    for (const oneWayCall of written) expect(Object.keys(oneWayCall).sort()).toEqual(['conversation_id', 'operation', 'turn_id', 'type']);
    for (const ended of hosted.turns.filter((turn) => turn.path === '/kit/turns/end')) {
      let parts: readonly Part[] = [];
      for (const operation of operationsOf(hosted, idOf(ended, 'turn'))) {
        expect(isOperation(operation)).toBe(true);
        if (operation.op === 'set') expect(operation.part).not.toEqual(parts[operation.index]);
        parts = applied(parts, operation)!;
      }
      expect(parts).toEqual(endedOf(ended).content.parts);
    }
  },
);

it.each(['claude-compact', 'codex-compact', 'grok-compact'])('marks the compaction recorded in %s once', async (fixture) => {
  const { turns } = await replayed(fixture);

  expect(turns[0]!.content.parts).toEqual([{ type: 'notice', kind: 'compaction', text: '' }]);
});

it.each([
  ['claude-plan', { questions: 1, route: { mode: 'plan', model: 'haiku', effort: null } }, ['default'], 1],
  ['codex-plan', { questions: 1, options: [['collaboration_mode', 'plan']] }, ['Implement this plan?', 'default'], 2],
  ['grok-plan', { questions: 1, responses: ['approved'] }, ['plan', 'default'], 1],
] as const)("marks the plan approval recorded in %s and the mode it left plan mode for, and sends no plan, reasoning or plan update", async (fixture, recording, modes, count) => {
  const { turns } = await replayed(fixture, count, recording as Recording);

  expect(partsOf(turns).filter((part) => part.type === 'notice')).toEqual(modes.map((text) => ({ type: 'notice', kind: 'mode', text })));
  expect(new Set(types(partsOf(turns)))).toEqual(new Set(['counts', 'notice', 'text']));
  expect(JSON.stringify(partsOf(turns).filter((part) => part.type === 'text'))).not.toContain('# Plan: create hello.txt');
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

  expect(retried.turns[0]!.content.parts[0]).toEqual({ type: 'notice', kind: 'retry', text: 'Retrying Claude, attempt 1 of 10.' });
  expect(switched.turns[0]!.content.parts).toEqual([{ type: 'notice', kind: 'model', text: 'sonnet' }, text(/Sonnet/)]);
});

it("keeps a recorded Codex retry and each of its notices with its severity, its reroute and its warning included", async () => {
  const { turns } = await replayed('codex-markers');

  expect(turns[0]!.content.parts).toEqual([
    { type: 'notice', kind: 'retry', text: 'Reconnecting... 1/5' },
    { type: 'notice', kind: 'info', text: 'Model rerouted\nSwitched from gpt-5.6-sol to gpt-5.5-mini (highRiskCyberActivity).' },
    { type: 'notice', kind: 'warning', text: expect.stringMatching(/^Your account was flagged for potentially high-risk cyber activity/) },
    text('ok'),
  ]);
});

it("marks Grok Build's model switch, reads the context window of the model it switched to, counts a call left without status at the turn's end as a command that did not fail, and drops other sessions' updates", async () => {
  const { hosted, turns } = await replayed('grok-markers');
  await settle();

  expect(turns[0]!.content.parts).toEqual([counts({ commands: 1 }), { type: 'notice', kind: 'model', text: 'grok-4.7-fast' }, text('Done.')]);
  expect(turns[0]!.content.state.context).toEqual({ used: 3120, window: 2_000_000, breakdown: [] });
  expect(hosted.turns.filter((turn) => turn.path === '/kit/turns/start')).toHaveLength(1);
});

it("keeps a Claude Code image block where its upload ends and the hook's notice, and drops another session's text", async () => {
  const { hosted, turns } = await replayed('claude-image');

  expect(turns[0]!.content.parts).toEqual([
    text('Working.'),
    { type: 'notice', kind: 'warning', text: 'Stop hook feedback\nRun the tests first.' },
    text('Done.'),
    { type: 'image', file: 'version-1', name: 'image-1.png', media_type: 'image/png' },
  ]);
  expect(turns[0]!.content.state).toEqual(expect.objectContaining({ title: 'A title the CLI made', cost: { amount: 0.5, currency: 'USD' } }));
  expect(hosted.finishes).toHaveLength(2);
});

it('saves the image Codex generated in the recording and counts the call that generated it as an other call', async () => {
  const { hosted, turns } = await replayed('codex-tools');

  const parts = turns[0]!.content.parts;
  expect(parts.at(-1)).toEqual({ type: 'image', file: 'version-1', name: 'image-1.png', media_type: 'image/png' });
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
    { type: 'notice', kind: 'error', text: 'image-1.png was not saved: upload_expired: this upload is gone; run the same command again to start a new one' },
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
    text('Done.'),
    { type: 'image', file: 'version-1', name: 'image-1.png', media_type: 'image/png' },
    { type: 'image', file: 'version-2', name: 'image-2.png', media_type: 'image/png' },
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

  expect(ended.content.parts).toEqual([text('All nine steps completed.'), { type: 'image', file: 'version-1', name: 'image-1.png', media_type: 'image/png' }]);
});

it.each([
  ['claude-agent-acp', '@think Where is the height set?'],
  ['codex-acp', '@think Where is the height set?'],
  ['grok-build', '@plan Run the tests|Fix the order page'],
])("sends none of the reasoning or plan %s reports, only the Agent's text", async (kind, step) => {
  const ended = await said(kind, `${step}\n@say Hello there`);

  expect(ended.content.parts).toEqual([text('Hello there')]);
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
    { type: 'notice', kind: 'model', text: 'haiku' },
    { type: 'notice', kind: 'model', text: 'sonnet' },
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

  expect(ended.content.parts).toEqual([{ type: 'notice', kind: 'model', text: 'opus' }]);
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
  expect(types(ended.content.parts)).toContain('text');
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
  expect(types(body.content.parts)).toContain('text');
});
