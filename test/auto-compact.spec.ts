import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DesiredAgentRoute } from '@agentshouse/kit-wire';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastCall, type Hosted } from './environment.ts';
import { accountOf } from './kit.ts';

type Setting = NonNullable<DesiredAgentRoute['auto_compact']>;

const CLAUDE = 'claude-agent-acp';

const CODEX = 'codex-acp';

const GROK = 'grok-build';

const TOKENS = 150_000;

const HANDED: Record<string, (setting: Setting) => Record<string, unknown>> = {
  [CLAUDE]: (setting) =>
    setting === 'off' ? { DISABLE_AUTO_COMPACT: '1' } : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(setting), autoCompactEnabled: true },
  [CODEX]: (setting) => ({ model_auto_compact_token_limit: setting }),
};

const OWN_SETTINGS: Record<string, Setting[]> = {
  [CLAUDE]: [TOKENS, 'off', 90_000],
  [CODEX]: [TOKENS, 120_000, 90_000],
};

const CHANGED: Record<string, Setting> = { [CLAUDE]: 'off', [CODEX]: 90_000 };

const SHARED_FILES = [join('.claude', 'settings.json'), join('.codex', 'config.toml')];

const USER_SETTINGS: Record<string, string> = {
  [join('.claude', 'settings.json')]: '{\n  "model": "opus"\n}\n',
  [join('.codex', 'config.toml')]: 'model = "gpt-5.5"\n',
};

interface SessionParams {
  cwd: string;
  _meta?: { claudeCode?: { options?: { settings?: { autoCompactEnabled?: unknown } } } };
}

function handed(env: Record<string, string | undefined>, session: SessionParams): Record<string, unknown> {
  const config = env.CODEX_CONFIG === undefined ? {} : (JSON.parse(env.CODEX_CONFIG) as Record<string, unknown>);
  const values = {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    DISABLE_AUTO_COMPACT: env.DISABLE_AUTO_COMPACT,
    autoCompactEnabled: session._meta?.claudeCode?.options?.settings?.autoCompactEnabled,
    model_auto_compact_token_limit: config.model_auto_compact_token_limit,
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

async function processes(hosted: Hosted): Promise<Record<string, unknown>[]> {
  const log = await hosted.adapterLog();
  return log
    .filter((entry) => ['session/new', 'session/resume'].includes(entry.method as string))
    .filter((entry) => (entry.params as SessionParams).cwd === hosted.workingDirectory)
    .map((started) => {
      const initialized = log.find((entry) => entry.method === 'initialize' && entry.pid === started.pid)!;
      return handed(initialized.env as Record<string, string | undefined>, started.params as SessionParams);
    });
}

async function openEach(hosted: Hosted, agents: number): Promise<void> {
  for (let index = 1; index <= agents; index++) {
    hosted.call({ kind: 'open', conversation_id: `conversation-${index}`, agent_id: `agent-${index}` });
    await hosted.result(lastCall());
  }
}

async function turnsEnded(hosted: Hosted, count: number): Promise<void> {
  await until(() => hosted.turns.filter((turn) => turn.path === '/kit/turns/end').length === count);
}

function desiredReads(hosted: Hosted): number {
  return hosted.house.requests.filter((request) => request.path === '/kit/agents/desired/list').length;
}

it.each([
  [CLAUDE, TOKENS],
  [CLAUDE, 'off'],
  [CODEX, TOKENS],
] as const)("hands the %s process of an Agent's conversation its auto-compact setting %s as the CLI's own auto-compact, a number's on above the user's own", async (kind, setting) => {
  const hosted = await hostKit([{ kind, auto_compact: setting }]);

  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  hosted.call({ kind: 'message', text: '@say first', first: true });
  await turnsEnded(hosted, 1);

  expect(await processes(hosted)).toEqual([HANDED[kind]!(setting)]);
});

it.each([CLAUDE, CODEX])("hands the %s process of an Agent whose auto-compact setting is unset nothing, so the CLI keeps its own", async (kind) => {
  const hosted = await hostKit([{ kind }]);

  await openEach(hosted, 1);

  expect(await processes(hosted)).toEqual([{}]);
});

it.each([CLAUDE, CODEX])(
  "runs each of an Environment's %s Agents on its own setting and an unset one on the CLI's own, writing none into settings.json or config.toml",
  async (kind) => {
    const own = OWN_SETTINGS[kind]!;
    const hosted = await hostKit([...own.map((auto_compact) => ({ kind, auto_compact })), { kind }], {
      prepare: async (home) => {
        for (const [file, text] of Object.entries(USER_SETTINGS)) {
          await mkdir(dirname(join(accountOf(home), file)), { recursive: true });
          await writeFile(join(accountOf(home), file), text);
        }
      },
    });

    await openEach(hosted, 4);

    expect(await processes(hosted)).toEqual([...own.map((setting) => HANDED[kind]!(setting)), {}]);
    for (const file of SHARED_FILES) {
      expect(await readFile(join(accountOf(hosted.home), file), 'utf8')).not.toMatch(/auto.?compact/i);
    }
  },
);

it.each([CLAUDE, CODEX])("starts the next %s process of an Agent's conversation on its changed setting", async (kind) => {
  const hosted = await hostKit([{ kind, auto_compact: TOKENS }]);
  hosted.call({ kind: 'open' });
  const { provider_session_id: session } = (await hosted.result(lastCall())) as { provider_session_id: string };
  hosted.call({ kind: 'message', text: '@say first', first: true });
  await turnsEnded(hosted, 1);
  const read = desiredReads(hosted);
  const changed: DesiredAgentRoute = {
    agent_id: 'agent-1',
    kind,
    base_instructions: 'Be useful.',
    working_directory: hosted.workingDirectory,
    model: 'route-model',
    effort: 'route-effort',
    auto_compact: CHANGED[kind],
  };
  hosted.house.route('POST', '/kit/agents/desired/list', () => ({ body: { agents: [kind], routes: [changed], transcribe: false } }));
  hosted.connection.send({ type: 'work_available', subject: 'agents' });
  await until(() => desiredReads(hosted) > read);
  hosted.call({ kind: 'kill' });
  await hosted.result(lastCall());
  await until(() => hosted.connection.oneWayCalls.find((oneWayCall) => oneWayCall.type === 'process' && oneWayCall.running === false));

  hosted.call({ kind: 'message', text: '@say back', first: false, provider_session_id: session });

  await turnsEnded(hosted, 2);
  expect(await processes(hosted)).toEqual([HANDED[kind]!(TOKENS), HANDED[kind]!(CHANGED[kind]!)]);
});

it("hands a Grok Build process nothing of its Agent's setting", async () => {
  const hosted = await hostKit([{ kind: GROK, auto_compact: TOKENS }, { kind: GROK, auto_compact: 'off' }]);

  await openEach(hosted, 2);

  expect(await processes(hosted)).toEqual([{}, {}]);
});
