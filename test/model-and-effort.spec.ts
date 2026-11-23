import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { settle, until } from './double.ts';
import { hostKit, lastCall, type Hosted } from './environment.ts';

type Entry = Record<string, unknown>;

interface Kind {
  kind: string;
  mode: string[];
  effort: string;
  agent: { model: string; effort: string };
  chosen: { model: string; effort: string };
}

const KINDS: Kind[] = [
  {
    kind: 'codex-acp',
    mode: ['mode=agent-full-access'],
    effort: 'reasoning_effort',
    agent: { model: 'gpt-5.5', effort: 'high' },
    chosen: { model: 'gpt-5.5-mini', effort: 'low' },
  },
  {
    kind: 'claude-agent-acp',
    mode: ['mode=bypassPermissions'],
    effort: 'effort',
    agent: { model: 'opus', effort: 'high' },
    chosen: { model: 'sonnet', effort: 'max' },
  },
  {
    kind: 'grok-build',
    mode: [],
    effort: 'reasoning_effort',
    agent: { model: 'grok-4.6', effort: 'high' },
    chosen: { model: 'grok-4.5', effort: 'low' },
  },
];

const STARTS = new Set(['session/new', 'session/resume']);

const SESSION = new Set([...STARTS, 'session/set_config_option', 'session/prompt']);

function setting(entry: Entry): string {
  const { configId, value } = entry.params as { configId: string; value: unknown };
  return `${configId}=${String(value)}`;
}

function beforePrompt(entries: Entry[], index: number): string[] {
  const prompt = entries.flatMap((entry, at) => (entry.method === 'session/prompt' ? [at] : []))[index]!;
  const start = entries.findLastIndex((entry, at) => at < prompt && STARTS.has(entry.method as string));
  return entries.slice(start, prompt).flatMap((entry) => {
    if (STARTS.has(entry.method as string)) return [entry.method as string];
    return entry.method === 'session/set_config_option' ? [setting(entry)] : [];
  });
}

function settings(entries: Entry[], after = 0): string[] {
  return entries.slice(after).flatMap((entry) => (entry.method === 'session/set_config_option' ? [setting(entry)] : []));
}

function launched(case_: Kind, model: string, effort: string): string[] {
  return [...case_.mode, `model=${model}`, `${case_.effort}=${effort}`];
}

function expected(case_: Kind, start: string, model: string, effort: string): string[] {
  return [start, ...launched(case_, model, effort)];
}

async function host(case_: Kind): Promise<Hosted> {
  return hostKit([{ kind: case_.kind, ...case_.agent }]);
}

async function turnsEnded(hosted: Hosted, count: number): Promise<void> {
  await until(() => hosted.turns.filter((turn) => turn.path === '/kit/turns/end').length === count);
}

async function prompted(hosted: Hosted): Promise<string> {
  hosted.call({ kind: 'open' });
  const { provider_session_id: session } = (await hosted.result(lastCall())) as { provider_session_id: string };
  hosted.call({ kind: 'message', text: '@say first', first: true });
  await turnsEnded(hosted, 1);
  return session;
}

async function optionsRelayed(hosted: Hosted): Promise<void> {
  await until(() => hosted.connection.oneWayCalls.find((oneWayCall) => oneWayCall.type === 'options'));
}

it.each(KINDS)('runs a session $kind opens for `open` with the model and the effort the call names', async (case_) => {
  const hosted = await host(case_);

  hosted.call({ kind: 'open', ...case_.chosen });
  hosted.call({ kind: 'message', text: '@say first', first: true });

  await turnsEnded(hosted, 1);
  expect(beforePrompt(await hosted.adapterLog(), 0)).toEqual(expected(case_, 'session/new', case_.chosen.model, case_.chosen.effort));
});

it.each(KINDS)("runs a session $kind opens for an `open` that names neither with the Agent's model and effort", async (case_) => {
  const hosted = await host(case_);

  hosted.call({ kind: 'open' });
  hosted.call({ kind: 'message', text: '@say first', first: true });

  await turnsEnded(hosted, 1);
  expect(beforePrompt(await hosted.adapterLog(), 0)).toEqual(expected(case_, 'session/new', case_.agent.model, case_.agent.effort));
});

it.each(KINDS)("takes the Agent's model and effort for each one an `open` to $kind leaves out", async (case_) => {
  const hosted = await host(case_);

  hosted.call({ kind: 'open', model: case_.chosen.model });
  await hosted.result(lastCall());
  hosted.call({ kind: 'open', effort: case_.chosen.effort });
  await hosted.result(lastCall());

  const entries = await hosted.adapterLog();
  const second = entries.findLastIndex((entry) => entry.method === 'session/new');
  expect(settings(entries.slice(0, second))).toEqual(launched(case_, case_.chosen.model, case_.agent.effort));
  expect(settings(entries, second)).toEqual(launched(case_, case_.agent.model, case_.chosen.effort));
});

it.each(KINDS)('runs the new session of a cold `open` to $kind with the model and the effort that `open` names', async (case_) => {
  const hosted = await host(case_);
  await prompted(hosted);

  hosted.call({ kind: 'open', ...case_.chosen });
  hosted.call({ kind: 'message', text: '@say again', first: true, recent: 'Earlier: first' });

  await turnsEnded(hosted, 2);
  expect(beforePrompt(await hosted.adapterLog(), 1)).toEqual(expected(case_, 'session/new', case_.chosen.model, case_.chosen.effort));
});

it.each(KINDS)("runs the new session $kind opens after it refused a resume with the model and the effort of the `open` that follows", async (case_) => {
  const hosted = await host(case_);
  const session = await prompted(hosted);
  await hosted.restart();
  await writeFile(join(hosted.home, 'refuse-resume'), '');
  hosted.call({ kind: 'message', text: '@say lost', first: false, provider_session_id: session, ...case_.chosen });
  expect(await hosted.result(lastCall())).toEqual({ refused: "the Agent's CLI could not resume this conversation", resume_refused: true });
  await rm(join(hosted.home, 'refuse-resume'));

  hosted.call({ kind: 'open', provider_session_id: session, ...case_.chosen });
  hosted.call({ kind: 'message', text: '@say again', first: true, provider_session_id: session, recent: 'Earlier: first' });

  await turnsEnded(hosted, 2);
  expect(beforePrompt(await hosted.adapterLog(), 1)).toEqual(expected(case_, 'session/new', case_.chosen.model, case_.chosen.effort));
});

it.each(KINDS.filter((case_) => case_.kind !== 'grok-build'))(
  'runs the session $kind opens in place of one it never wrote with the model and the effort of the first message',
  async (case_) => {
    const hosted = await host(case_);
    hosted.call({ kind: 'open' });
    const { provider_session_id: stored } = (await hosted.result(lastCall())) as { provider_session_id: string };
    await hosted.restart();

    hosted.call({ kind: 'message', text: '@say first', first: true, provider_session_id: stored, ...case_.chosen });

    await turnsEnded(hosted, 1);
    const entries = await hosted.adapterLog();
    expect(entries.filter((entry) => STARTS.has(entry.method as string)).map((entry) => entry.method)).toEqual([
      'session/new',
      'session/resume',
      'session/new',
    ]);
    expect(beforePrompt(entries, 0)).toEqual(expected(case_, 'session/new', case_.chosen.model, case_.chosen.effort));
  },
);

it.each(KINDS)('resumes a session whose $kind process ended with the model and the effort the message names', async (case_) => {
  const hosted = await host(case_);
  const session = await prompted(hosted);
  hosted.call({ kind: 'kill' });
  await hosted.result(lastCall());
  await until(() => hosted.connection.oneWayCalls.find((oneWayCall) => oneWayCall.type === 'process' && oneWayCall.running === false));

  hosted.call({ kind: 'message', text: '@say back', first: false, provider_session_id: session, ...case_.chosen });

  await turnsEnded(hosted, 2);
  expect(beforePrompt(await hosted.adapterLog(), 1)).toEqual(expected(case_, 'session/resume', case_.chosen.model, case_.chosen.effort));
});

it.each(KINDS)('resumes a $kind session after a Kit restart with the model and the effort the message names', async (case_) => {
  const hosted = await host(case_);
  const session = await prompted(hosted);
  await hosted.restart();

  hosted.call({ kind: 'message', text: '@say back', first: false, provider_session_id: session, ...case_.chosen });

  await turnsEnded(hosted, 2);
  expect(beforePrompt(await hosted.adapterLog(), 1)).toEqual(expected(case_, 'session/resume', case_.chosen.model, case_.chosen.effort));
});

it.each(KINDS)('resumes a $kind session for an answer the Kit holds no question for with the model and the effort the answer names', async (case_) => {
  const hosted = await host(case_);
  const request = { method: 'session/request_permission', params: { sessionId: 'session-stored' } };
  const response = { outcome: { outcome: 'selected', optionId: 'allow' } };

  hosted.call({ kind: 'answer', provider_session_id: 'session-stored', interaction_id: 'interaction-1', request, response, ...case_.chosen });

  await turnsEnded(hosted, 1);
  expect(beforePrompt(await hosted.adapterLog(), 0)).toEqual(expected(case_, 'session/resume', case_.chosen.model, case_.chosen.effort));
});

it.each(KINDS)("sets only what a typed `option` carries on the running $kind process, by the option of the CLI's category", async (case_) => {
  const hosted = await host(case_);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  await optionsRelayed(hosted);
  const started = (await hosted.adapterLog()).length;

  hosted.call({ kind: 'option', effort: case_.chosen.effort });
  await hosted.result(lastCall());
  hosted.call({ kind: 'option', model: case_.chosen.model });
  await hosted.result(lastCall());

  expect(settings(await hosted.adapterLog(), started)).toEqual([`${case_.effort}=${case_.chosen.effort}`, `model=${case_.chosen.model}`]);
  const states = hosted.connection.oneWayCalls
    .filter((oneWayCall) => oneWayCall.type === 'state')
    .map((oneWayCall) => {
      const { model, effort } = oneWayCall.state as { model: string; effort: string };
      return { model, effort };
    });
  expect(states.at(-1)).toEqual(case_.chosen);
  expect(states).toContainEqual({ model: case_.agent.model, effort: case_.chosen.effort });
});

it('sets an `option` sent behind an `open` on the process that `open` starts, before its first prompt', async () => {
  const [case_] = KINDS;
  const hosted = await host(case_!);

  hosted.call({ kind: 'open' });
  hosted.call({ kind: 'option', model: case_!.chosen.model });
  hosted.call({ kind: 'option', effort: case_!.chosen.effort });
  hosted.call({ kind: 'message', text: '@say first', first: true });

  await turnsEnded(hosted, 1);
  expect(beforePrompt(await hosted.adapterLog(), 0)).toEqual([
    ...expected(case_!, 'session/new', case_!.agent.model, case_!.agent.effort),
    `model=${case_!.chosen.model}`,
    `${case_!.effort}=${case_!.chosen.effort}`,
  ]);
});

it('sets an `option` sent behind a message that starts a process on the process that message starts', async () => {
  const [case_] = KINDS;
  const hosted = await host(case_!);
  await writeFile(join(hosted.home, 'hold-new'), '');

  hosted.call({ kind: 'message', text: '@say first', first: true });
  hosted.call({ kind: 'option', model: case_!.chosen.model });
  await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/new'));
  await settle();
  await rm(join(hosted.home, 'hold-new'));

  await turnsEnded(hosted, 1);
  const expectedSettings = [...launched(case_!, case_!.agent.model, case_!.agent.effort), `model=${case_!.chosen.model}`];
  await until(async () => settings(await hosted.adapterLog()).length === expectedSettings.length);
  const entries = await hosted.adapterLog();
  expect(settings(entries)).toEqual(expectedSettings);
  expect(new Set(entries.filter((entry) => SESSION.has(entry.method as string)).map((entry) => entry.pid)).size).toBe(1);
});

it('changes nothing for an `option` that reaches a conversation with no process, and starts none', async () => {
  const [case_] = KINDS;
  const hosted = await host(case_!);

  hosted.call({ kind: 'option', model: case_!.chosen.model, effort: case_!.chosen.effort });

  expect(await hosted.result(lastCall())).toEqual({});
  await settle();
  expect((await hosted.adapterLog()).filter((entry) => SESSION.has(entry.method as string))).toEqual([]);
  hosted.call({ kind: 'message', text: '@say back', first: false, provider_session_id: 'session-stored' });
  await turnsEnded(hosted, 1);
  expect(beforePrompt(await hosted.adapterLog(), 0)).toEqual(expected(case_!, 'session/resume', case_!.agent.model, case_!.agent.effort));
});

it.each([
  ['codex-acp', { model: 'codex-instant', effort: 'high' }, {}, ['mode=agent-full-access', 'model=codex-instant']],
  ['codex-acp', { model: 'gpt-5.5', effort: 'high' }, { model: 'codex-instant', effort: 'low' }, ['mode=agent-full-access', 'model=codex-instant']],
  ['claude-agent-acp', { model: 'opus', effort: 'high' }, { model: 'haiku' }, ['mode=bypassPermissions', 'model=haiku']],
] as const)('opens a %s session on a model that offers no effort with none, whatever effort the Agent or the call names', async (kind, agent, chosen, set) => {
  const hosted = await hostKit([{ kind, ...agent }]);

  hosted.call({ kind: 'open', ...chosen });

  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
  expect(settings(await hosted.adapterLog())).toEqual(set);
});

it('sets no effort through an `option` on a running process whose model offers none', async () => {
  const hosted = await hostKit([{ kind: 'codex-acp', model: 'gpt-5.5', effort: 'high' }]);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  await optionsRelayed(hosted);
  const started = (await hosted.adapterLog()).length;

  hosted.call({ kind: 'option', model: 'codex-instant', effort: 'low' });
  await hosted.result(lastCall());
  hosted.call({ kind: 'option', effort: 'medium' });
  await hosted.result(lastCall());

  await settle();
  expect(settings(await hosted.adapterLog(), started)).toEqual(['model=codex-instant']);
});

it('leaves the model and the effort of a running process as they are for a message that names others', async () => {
  const [case_] = KINDS;
  const hosted = await host(case_!);
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  const started = (await hosted.adapterLog()).length;

  hosted.call({ kind: 'message', text: '@say first', first: true, ...case_!.chosen });

  await turnsEnded(hosted, 1);
  expect(settings(await hosted.adapterLog(), started)).toEqual([]);
});

it("refuses an `open` whose model the CLI refuses as it refuses the Agent's, and logs the CLI's words", async () => {
  const hosted = await host(KINDS[0]!);
  await writeFile(join(hosted.home, 'refuse-model'), 'gpt-refused');

  hosted.call({ kind: 'open', model: 'gpt-refused' });

  expect(await hosted.result(lastCall())).toEqual({ refused: "the Agent's CLI refused the Agent's model, mode or effort" });
  expect(hosted.kit.stderr()).toContain('Model switch blocked by a PreModelSwitch hook: gpt-refused is not allowed');
});
