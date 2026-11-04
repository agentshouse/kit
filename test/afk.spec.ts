import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastCall, outcome, type Hosted } from './environment.ts';

const NOBODY_THERE = 'Nobody is there to answer. Decide for yourself and go on.';

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path === '/kit/turns/end');

async function opened(kind: string, afk = true): Promise<Hosted> {
  const hosted = await hostKit([{ kind }]);
  hosted.call({ kind: 'open', ...(afk ? { afk: true } : {}) });
  await hosted.result(lastCall());
  return hosted;
}

async function answersOf(hosted: Hosted): Promise<unknown[]> {
  return (await hosted.adapterLog()).flatMap((entry) => ('replayed' in entry ? [entry.answered] : []));
}

async function asked(kind: string, fixture: string, afk = true): Promise<{ hosted: Hosted; answer: unknown }> {
  const hosted = await opened(kind, afk);
  hosted.call({ kind: 'message', text: `@asked ${fixture}\n@say went on`, first: true, ...(afk ? { afk: true } : {}) });
  const turn = await until(() => ended(hosted)[0]);
  expect(outcome(turn.body)).toEqual({ text: 'went on' });
  return { hosted, answer: (await answersOf(hosted))[0] };
}

function reachedHouse(hosted: Hosted): string[] {
  return hosted.house.requests.flatMap((request) => (/\/kit\/conversations\/interaction\/ask$|\/kit\/secret-inputs\/await$/.test(request.path) ? [request.path] : []));
}

it.each([
  ['claude-agent-acp', 'claude-question', { action: 'accept', content: { question_0_custom: NOBODY_THERE, question_1_custom: NOBODY_THERE } }],
  ['codex-acp', 'codex-question', { action: 'accept', content: { colour: NOBODY_THERE, size: NOBODY_THERE } }],
  [
    'grok-build',
    'grok-question',
    { outcome: 'accepted', answers: { 'Which colour?': NOBODY_THERE, 'Which size?': NOBODY_THERE } },
  ],
])('tells a question on %s that nobody is there, and the turn goes on with nothing reported to House', async (kind, fixture, told) => {
  const { hosted, answer } = await asked(kind, fixture);

  expect(answer).toEqual(told);
  expect(reachedHouse(hosted)).toEqual([]);
});

it('tells a secret prompt that nobody is there and neither holds nor fetches a secret', async () => {
  const { hosted, answer } = await asked('codex-acp', 'codex-secret');

  expect(answer).toEqual({ action: 'accept', content: { token: NOBODY_THERE } });
  expect(reachedHouse(hosted)).toEqual([]);
});

it.each([
  ['claude-agent-acp', 'claude-mcp-form'],
  ['codex-acp', 'codex-mcp-form'],
])('declines an MCP server form on %s, whose fields the Agent never reads', async (kind, fixture) => {
  const { hosted, answer } = await asked(kind, fixture);

  expect(answer).toEqual({ action: 'decline' });
  expect(reachedHouse(hosted)).toEqual([]);
});

it.each([
  ['claude-agent-acp', 'claude-permission', 'allow-once'],
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

it('goes by the word of the latest call, so a message without the field asks again', async () => {
  const hosted = await opened('codex-acp');
  hosted.call({ kind: 'message', text: '@ask', first: true, afk: true });
  await until(() => ended(hosted)[0]);
  expect(hosted.interactions).toEqual([]);

  hosted.call({ kind: 'message', text: '@ask', first: false });

  await until(() => hosted.interactions[0]);
  expect(ended(hosted)).toHaveLength(1);
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
