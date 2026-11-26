import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastCall, outcome, type Hosted, type Hosting } from './environment.ts';

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path === '/kit/turns/end');

const CLAUDE = 'claude-agent-acp';

const UNABLE = { claudeCode: { options: { disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'], permissionPrompts: 'none' } } };

const ASKS_ANYWAY: Hosting = { prepare: (home) => writeFile(join(home, 'asks-anyway'), '') };

async function opened(kind: string, afk = true, hosting: Hosting = {}): Promise<Hosted> {
  const hosted = await hostKit([{ kind }], hosting);
  hosted.call({ kind: 'open', ...(afk ? { afk: true } : {}) });
  await hosted.result(lastCall());
  return hosted;
}

async function answersOf(hosted: Hosted): Promise<unknown[]> {
  return (await hosted.adapterLog()).flatMap((entry) => ('replayed' in entry ? [entry.answered] : []));
}

async function asked(kind: string, fixture: string, afk = true, hosting: Hosting = {}): Promise<{ hosted: Hosted; answer: unknown }> {
  const hosted = await opened(kind, afk, hosting);
  hosted.call({ kind: 'message', text: `@asked ${fixture}\n@say went on`, first: true, ...(afk ? { afk: true } : {}) });
  const turn = await until(() => ended(hosted)[0]);
  expect(outcome(turn.body)).toEqual({ text: 'went on' });
  return { hosted, answer: (await answersOf(hosted))[0] };
}

function reachedHouse(hosted: Hosted): string[] {
  return hosted.house.requests.flatMap((request) => (/\/kit\/conversations\/interaction\/ask$|\/kit\/secret-inputs\/await$/.test(request.path) ? [request.path] : []));
}

function launch(log: Record<string, unknown>[], method: string): { _meta: unknown; capabilities: Record<string, unknown> } {
  const started = log.find((entry) => entry.method === method)!;
  const initialized = log.find((entry) => entry.method === 'initialize' && entry.pid === started.pid)!;
  return {
    _meta: (started.params as { _meta: unknown })._meta,
    capabilities: (initialized.params as { clientCapabilities: Record<string, unknown> }).clientCapabilities,
  };
}

it.each([
  ['opens', { kind: 'open', afk: true }, 'session/new'],
  ['resumes', { kind: 'message', provider_session_id: 'session-stored', text: '@say ok', first: false, afk: true }, 'session/resume'],
])('%s an AFK Claude Code session unable to ask, its adapter told the client shows no form', async (_, call, method) => {
  const hosted = await hostKit([{ kind: CLAUDE }]);

  hosted.call(call);

  await hosted.result(lastCall());
  const { _meta, capabilities } = launch(await hosted.adapterLog(), method);
  expect(_meta).toMatchObject(UNABLE);
  expect(capabilities).not.toHaveProperty('elicitation');
});

it('starts a Claude Code session that is not AFK with none of it, its adapter told the client shows forms', async () => {
  const hosted = await opened(CLAUDE, false);

  const { _meta, capabilities } = launch(await hosted.adapterLog(), 'session/new');
  expect(JSON.stringify(_meta)).not.toMatch(/AskUserQuestion|EnterPlanMode|ExitPlanMode|permissionPrompts/);
  expect(capabilities).toMatchObject({ elicitation: { form: {} } });
});

it('runs an AFK Claude Code turn to its end with nothing asked, since its CLI starts unable to ask', async () => {
  const hosted = await opened(CLAUDE);
  hosted.call({ kind: 'message', text: '@asked claude-permission\n@asked claude-question\n@asked claude-mcp-form\n@say went on', first: true, afk: true });

  expect(outcome((await until(() => ended(hosted)[0])).body)).toEqual({ text: 'went on' });
  const log = await hosted.adapterLog();
  expect(log.flatMap((entry) => ('unasked' in entry ? [entry.unasked] : []))).toEqual(['session/request_permission', 'elicitation/create', 'elicitation/create']);
  expect(await answersOf(hosted)).toEqual([]);
  expect(reachedHouse(hosted)).toEqual([]);
  expect(hosted.kit.stderr()).not.toContain('AFK session');
});

it.each([
  ['claude-permission', 'session/request_permission'],
  ['claude-question', 'elicitation/create'],
  ['claude-mcp-form', 'elicitation/create'],
])('fails %s that still reaches an AFK Claude Code session as a Fault naming the conversation, the CLI and %s, and tells House nothing', async (fixture, method) => {
  const { hosted, answer } = await asked(CLAUDE, fixture, true, ASKS_ANYWAY);

  expect(answer).toEqual({ code: -32603 });
  expect(hosted.kit.stderr()).toContain(`kit: conversation conversation-1: Claude Code sent ${method} from an AFK session, which starts unable to ask\n`);
  expect(reachedHouse(hosted)).toEqual([]);
  expect(hosted.interactions).toEqual([]);
});

it('holds AFK for the provider session from the call that launched it, so a later message without it asks nothing', async () => {
  const hosted = await opened(CLAUDE, true, ASKS_ANYWAY);

  hosted.call({ kind: 'message', text: '@asked claude-permission\n@say went on', first: true });

  expect(outcome((await until(() => ended(hosted)[0])).body)).toEqual({ text: 'went on' });
  expect(await answersOf(hosted)).toEqual([{ code: -32603 }]);
  expect(reachedHouse(hosted)).toEqual([]);
});

it('holds a session launched without AFK able to ask, so a later message marking it still asks and waits', async () => {
  const hosted = await opened(CLAUDE, false);

  hosted.call({ kind: 'message', text: '@ask', first: true, afk: true });

  const question = await until(() => hosted.interactions[0]);
  expect(question.body).toMatchObject({ request: { method: 'session/request_permission' } });
  expect(ended(hosted)).toEqual([]);
});

it('starts Grok Build with its question tool off', async () => {
  const hosted = await opened('grok-build');
  const plain = await opened('grok-build', false);

  const meta = async (of: Hosted) => ((await of.adapterLog()).find((entry) => entry.method === 'session/new')!.params as { _meta: unknown })._meta;
  expect(await meta(hosted)).toMatchObject({ askUserQuestion: false });
  expect(JSON.stringify(await meta(plain))).not.toMatch(/askUserQuestion/);
});

it('starts Codex as its own settings give it, whose question tool is off outside plan mode', async () => {
  const hosted = await opened('codex-acp');

  const opening = (await hosted.adapterLog()).find((entry) => entry.method === 'session/new')!;
  expect((opening.params as { _meta?: unknown })._meta).toEqual({});
});

it.each([
  ['codex-acp', 'codex-question', { action: 'decline' }],
  ['grok-build', 'grok-question', { outcome: 'cancelled' }],
])('answers no question %s raises anyway, declining it, and the turn goes on with nothing reported to House', async (kind, fixture, declined) => {
  const { hosted, answer } = await asked(kind, fixture);

  expect(answer).toEqual(declined);
  expect(reachedHouse(hosted)).toEqual([]);
});

it('declines a secret prompt and neither holds nor fetches a secret', async () => {
  const { hosted, answer } = await asked('codex-acp', 'codex-secret');

  expect(answer).toEqual({ action: 'decline' });
  expect(reachedHouse(hosted)).toEqual([]);
});

it('declines an MCP server form on Codex, whose fields the Agent never reads', async () => {
  const { hosted, answer } = await asked('codex-acp', 'codex-mcp-form');

  expect(answer).toEqual({ action: 'decline' });
  expect(reachedHouse(hosted)).toEqual([]);
});

it.each([
  ['codex-acp', 'codex-permission', 'allow_once'],
  ['grok-build', 'codex-permission', 'allow_once'],
  ['codex-acp', 'persistent-permission', 'allow_for_session'],
])('allows a permission prompt on %s from %s at once', async (kind, fixture, optionId) => {
  const { hosted, answer } = await asked(kind, fixture);

  expect(answer).toEqual({ outcome: { outcome: 'selected', optionId } });
  expect(reachedHouse(hosted)).toEqual([]);
});

it('approves a Grok plan at once', async () => {
  const { hosted, answer } = await asked('grok-build', 'grok-plan-exit');

  expect(answer).toEqual({ outcome: 'approved' });
  expect(reachedHouse(hosted)).toEqual([]);
});

it('allows a prompt a CLI raises before any message, on the word of the call that opened it', async () => {
  const hosted = await hostKit([{ kind: 'codex-acp' }], {
    prepare: (home) => writeFile(join(home, 'ask-unprompted'), ''),
  });
  hosted.call({ kind: 'open', afk: true });

  expect(await until(async () => (await answersOf(hosted))[0])).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  expect(reachedHouse(hosted)).toEqual([]);
});

it.each(['claude-agent-acp', 'codex-acp', 'grok-build'])('asks and waits on %s while no call marks the conversation', async (kind) => {
  const hosted = await opened(kind, false);
  hosted.call({ kind: 'message', text: '@ask', first: true });

  const question = await until(() => hosted.interactions[0]);
  expect(ended(hosted)).toEqual([]);
  expect(question.body).toMatchObject({ request: { method: 'session/request_permission' }, secret: false });
  const response = { outcome: { outcome: 'selected', optionId: 'deny' } };

  hosted.call({ kind: 'answer', interaction_id: (question.body as { interaction_id: string }).interaction_id, response });

  expect(outcome((await until(() => ended(hosted)[0])).body)).toEqual({ text: JSON.stringify(response) });
});

async function answeredByOwner(fixture: string, response: object): Promise<{ question: unknown; answer: unknown }> {
  const hosted = await opened('grok-build', false);
  hosted.call({ kind: 'message', text: `@asked ${fixture}\n@say went on`, first: true });
  const { body } = await until(() => hosted.interactions[0]);
  expect(ended(hosted)).toEqual([]);
  hosted.call({ kind: 'answer', interaction_id: (body as { interaction_id: string }).interaction_id, response });
  await until(() => ended(hosted)[0]);
  return { question: body, answer: (await answersOf(hosted))[0] };
}

it.each([
  [
    'an answer',
    { action: 'accept', content: { 'Which colour?': 'Red', 'Which size?': ['S', 'L'] } },
    { outcome: 'accepted', answers: { 'Which colour?': 'Red', 'Which size?': 'S, L' } },
  ],
  ['a decline', { action: 'decline' }, { outcome: 'cancelled' }],
])("asks a Grok question in a form with the CLI's own options while no call marks the conversation, and gives Grok %s in its own words", async (_, response, told) => {
  const { question, answer } = await answeredByOwner('grok-question', response);

  expect(question).toMatchObject({
    secret: false,
    request: {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Which colour?\n\nWhich size?',
        requestedSchema: {
          properties: {
            'Which colour?': {
              type: 'string',
              title: 'Which colour?',
              oneOf: [
                { const: 'Red', title: 'Red', description: 'The red one' },
                { const: 'Blue', title: 'Blue', description: 'The blue one' },
              ],
            },
            'Which size?': {
              type: 'array',
              title: 'Which size?',
              items: {
                anyOf: [
                  { const: 'S', title: 'S', description: 'small' },
                  { const: 'L', title: 'L', description: 'large' },
                ],
              },
            },
          },
        },
      },
    },
  });
  expect(answer).toEqual(told);
});

it.each([
  ['approved', { action: 'accept', content: { plan: 'approved' } }, 'approved'],
  ['abandoned', { action: 'accept', content: { plan: 'abandoned' } }, 'abandoned'],
  ['declined', { action: 'decline' }, 'abandoned'],
])('asks for a Grok plan in a form naming the plan while no call marks the conversation, and gives Grok a plan %s in its own words', async (_, response, told) => {
  const { question, answer } = await answeredByOwner('grok-plan-exit', response);

  expect(question).toMatchObject({
    secret: false,
    request: {
      method: 'elicitation/create',
      params: {
        message: '# Create hello.txt\n\n## Goal\nCreate a file named `hello.txt` in the workspace root whose entire contents are the word `hi`.\n\n## Steps\n1. Write `hello.txt` with the single word `hi` and no extra content.\n2. Read the file back to confirm the contents.\n',
        requestedSchema: {
          properties: {
            plan: {
              oneOf: [
                { const: 'approved', title: 'Approve' },
                { const: 'abandoned', title: 'Abandon' },
              ],
            },
          },
        },
      },
    },
  });
  expect(answer).toEqual({ outcome: told });
});
