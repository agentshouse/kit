import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastCall, outcome, type Hosted, type Hosting } from './environment.ts';

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path === '/kit/turns/end');

const CLAUDE = 'claude-agent-acp';

const CODEX = 'codex-acp';

const UNABLE = { claudeCode: { options: { disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'], permissionPrompts: 'none' } } };

const KIT_FEATURE = { features: { shell_zsh_fork: true } };

const NO_QUESTION_TOOL = { tools: { experimental_request_user_input: { enabled: false } } };

const NO_PLAN = 'an AFK conversation cannot enter Plan mode, since it cannot ask';

const ASKS_ANYWAY: Hosting = { prepare: (home) => writeFile(join(home, 'asks-anyway'), '') };

async function opened(kind: string, afk = true, hosting: Hosting = {}, fields: Record<string, unknown> = {}): Promise<Hosted> {
  const hosted = await hostKit([{ kind }], hosting);
  hosted.call({ kind: 'open', ...fields, ...(afk ? { afk: true } : {}) });
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

function launch(log: Record<string, unknown>[], method: string): { _meta: unknown; capabilities: Record<string, unknown>; config: unknown; thread: unknown } {
  const started = log.find((entry) => entry.method === method)!;
  const initialized = log.find((entry) => entry.method === 'initialize' && entry.pid === started.pid)!;
  const config = (initialized.env as Record<string, string | undefined>).CODEX_CONFIG;
  return {
    _meta: (started.params as { _meta: unknown })._meta,
    capabilities: (initialized.params as { clientCapabilities: Record<string, unknown> }).clientCapabilities,
    config: config === undefined ? undefined : JSON.parse(config),
    thread: log.find((entry) => entry.threadOpened !== undefined && entry.pid === started.pid)?.approvalPolicy,
  };
}

function turnSettings(log: Record<string, unknown>[]): Record<string, unknown>[] {
  return log.flatMap((entry) => (entry.settingsUpdated === undefined ? [] : [(entry.settingsUpdated as { threadSettings: Record<string, unknown> }).threadSettings]));
}

function unasked(log: Record<string, unknown>[]): unknown[] {
  return log.flatMap((entry) => ('unasked' in entry ? [entry.unasked] : []));
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

it.each([
  ['Claude Code', CLAUDE, 'claude'],
  ['Codex', CODEX, 'codex'],
])('runs an AFK %s turn to its end with nothing asked, since its CLI starts unable to ask', async (_, kind, prefix) => {
  const hosted = await opened(kind);
  hosted.call({ kind: 'message', text: `@asked ${prefix}-permission\n@asked ${prefix}-question\n@asked ${prefix}-mcp-form\n@say went on`, first: true, afk: true });

  expect(outcome((await until(() => ended(hosted)[0])).body)).toEqual({ text: 'went on' });
  expect(unasked(await hosted.adapterLog())).toEqual(['session/request_permission', 'elicitation/create', 'elicitation/create']);
  expect(await answersOf(hosted)).toEqual([]);
  expect(reachedHouse(hosted)).toEqual([]);
  expect(hosted.kit.stderr()).not.toContain('AFK session');
});

it.each([
  ['Claude Code', CLAUDE, 'claude-permission', 'session/request_permission'],
  ['Claude Code', CLAUDE, 'claude-question', 'elicitation/create'],
  ['Claude Code', CLAUDE, 'claude-mcp-form', 'elicitation/create'],
  ['Codex', CODEX, 'codex-permission', 'session/request_permission'],
  ['Codex', CODEX, 'persistent-permission', 'session/request_permission'],
  ['Codex', CODEX, 'codex-question', 'elicitation/create'],
  ['Codex', CODEX, 'codex-secret', 'elicitation/create'],
  ['Codex', CODEX, 'codex-mcp-form', 'elicitation/create'],
])('fails what still reaches an AFK %s session from %s as a Fault naming the conversation, the CLI and %s, and tells House nothing', async (name, kind, fixture, method) => {
  const { hosted, answer } = await asked(kind, fixture, true, ASKS_ANYWAY);

  expect(answer).toEqual({ code: -32603 });
  expect(hosted.kit.stderr()).toContain(`kit: conversation conversation-1: ${name} sent ${method} from an AFK session, which starts unable to ask\n`);
  expect(reachedHouse(hosted)).toEqual([]);
  expect(hosted.interactions).toEqual([]);
});

it.each([
  ['Claude Code', CLAUDE, 'claude-permission', { code: -32603 }],
  ['Codex', CODEX, 'codex-permission', { code: -32603 }],
  ['Grok Build', 'grok-build', 'codex-permission', { outcome: { outcome: 'selected', optionId: 'allow_once' } }],
])('holds AFK for a %s session from the call that launched it, so a later message without it asks House nothing', async (_, kind, fixture, answer) => {
  const hosted = await opened(kind, true, ASKS_ANYWAY);

  hosted.call({ kind: 'message', text: `@asked ${fixture}\n@say went on`, first: true });

  expect(outcome((await until(() => ended(hosted)[0])).body)).toEqual({ text: 'went on' });
  expect(await answersOf(hosted)).toEqual([answer]);
  expect(reachedHouse(hosted)).toEqual([]);
});

it.each([
  ['Claude Code', CLAUDE],
  ['Codex', CODEX],
  ['Grok Build', 'grok-build'],
])('holds a %s session launched without AFK able to ask, so a later message marking it still asks and waits', async (_, kind) => {
  const hosted = await opened(kind, false);

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

it.each([
  ['opens', { kind: 'open', afk: true }, 'session/new'],
  ['resumes', { kind: 'message', provider_session_id: 'session-stored', text: '@say ok', first: false, afk: true }, 'session/resume'],
])('%s an AFK Codex session with its question tool off beside the Kit’s own feature, its thread under approvals never and its adapter told the client shows no form', async (_, call, method) => {
  const hosted = await hostKit([{ kind: CODEX }]);

  hosted.call(call);

  await hosted.result(lastCall());
  const { config, thread, capabilities } = launch(await hosted.adapterLog(), method);
  expect(config).toEqual({ ...KIT_FEATURE, ...NO_QUESTION_TOOL });
  expect(thread).toBe('never');
  expect(capabilities).not.toHaveProperty('elicitation');
});

it('starts a Codex session that is not AFK with none of it, its adapter told the client shows forms', async () => {
  const hosted = await opened(CODEX, false);

  const { config, thread, capabilities } = launch(await hosted.adapterLog(), 'session/new');
  expect(config).toEqual(KIT_FEATURE);
  expect(thread).toBe('on-request');
  expect(capabilities).toMatchObject({ elicitation: { form: {} } });
});

it.each([
  ['an AFK', 'read-only', 'never', true, 'user', { type: 'readOnly', networkAccess: false }],
  ['an AFK', 'workspace-write', 'never', true, 'user', { type: 'workspaceWrite', networkAccess: false }],
  ['an AFK', 'agent', 'never', true, 'auto_review', { type: 'workspaceWrite', networkAccess: false }],
  ['an AFK', 'agent-full-access', 'never', true, 'user', { type: 'dangerFullAccess' }],
  ['a', 'read-only', 'on-request', false, 'user', { type: 'readOnly', networkAccess: false }],
])('runs %s Codex conversation’s turn in %s under approvals %s, in the sandbox and with the reviewer its mode names', async (_, mode, approvalPolicy, afk, approvalsReviewer, sandboxPolicy) => {
  const hosted = await opened(CODEX, afk, {}, { mode });

  hosted.call({ kind: 'message', text: '@say went on', first: true, ...(afk ? { afk: true } : {}) });

  expect(outcome((await until(() => ended(hosted)[0])).body)).toEqual({ text: 'went on' });
  expect(turnSettings(await hosted.adapterLog())).toEqual([{ approvalPolicy, approvalsReviewer, sandboxPolicy }]);
});

async function planned(afk: boolean): Promise<{ hosted: Hosted; turn: { body: unknown } }> {
  const hosted = await opened(CODEX, afk, {}, { mode: 'read-only' });
  hosted.call({ kind: 'message', text: '@say ok', first: true, ...(afk ? { afk: true } : {}) });
  await until(() => ended(hosted)[0]);

  hosted.call({ kind: 'message', text: '/plan', first: false, ...(afk ? { afk: true } : {}) });

  return { hosted, turn: await until(() => ended(hosted)[1]) };
}

it('refuses an AFK Codex conversation’s switch into Plan mode, so /plan fails as a refused setting and nothing reaches Codex', async () => {
  const { hosted, turn } = await planned(true);

  expect(outcome(turn.body)).toEqual({ failed: 'error' });
  expect(JSON.stringify(turn.body)).toContain(NO_PLAN);
  expect(turnSettings(await hosted.adapterLog()).filter((settings) => 'collaborationMode' in settings)).toEqual([]);
});

it('passes a Codex conversation’s switch into Plan mode while it is not AFK', async () => {
  const { hosted, turn } = await planned(false);

  expect(outcome(turn.body)).toEqual({ text: '' });
  expect(turnSettings(await hosted.adapterLog()).filter((settings) => 'collaborationMode' in settings)).toEqual([{ collaborationMode: expect.objectContaining({ mode: 'plan' }) }]);
});

it('starts an AFK Codex thread under approvals never, so a prompt Codex would raise in a turn of its own before any message is never asked', async () => {
  const hosted = await hostKit([{ kind: CODEX }], {
    prepare: (home) => writeFile(join(home, 'ask-unprompted'), ''),
  });
  hosted.call({ kind: 'open', afk: true });

  expect(await until(async () => unasked(await hosted.adapterLog())[0])).toBe('session/request_permission');
  expect(await answersOf(hosted)).toEqual([]);
  expect(reachedHouse(hosted)).toEqual([]);
});

it('answers no question Grok Build raises anyway, declining it, and the turn goes on with nothing reported to House', async () => {
  const { hosted, answer } = await asked('grok-build', 'grok-question');

  expect(answer).toEqual({ outcome: 'cancelled' });
  expect(reachedHouse(hosted)).toEqual([]);
});

it('allows a permission prompt on Grok Build at once', async () => {
  const { hosted, answer } = await asked('grok-build', 'codex-permission');

  expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  expect(reachedHouse(hosted)).toEqual([]);
});

it('approves a Grok plan at once', async () => {
  const { hosted, answer } = await asked('grok-build', 'grok-plan-exit');

  expect(answer).toEqual({ outcome: 'approved' });
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
