import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { DEVICE_LOGINS } from './device-login.ts';
import { idOf, settle, until, without } from './double.ts';
import { hostKit, lastCall, userBin, type Hosted } from './environment.ts';
import { accountOf, alive, filesUnder, temporaryHome } from './kit.ts';

interface Hold {
  subject: string;
  body: unknown;
}

const HELD = { outcome: 'released', release: 'held' };

async function signingIn(
  kind: string,
  answer: (hold: number) => unknown = () => HELD,
  status = 200,
  home?: string,
) {
  const hosted = await hostKit([{ kind }], home === undefined ? {} : { home });
  const holds: Hold[] = [];
  hosted.house.route('POST', '/kit/secret-inputs/await', async (request) => {
    holds.push({ subject: idOf(request, 'subject'), body: without(request, 'subject') });
    // House holds the page a tenth of a second each time, so the ceremony is seen holding.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { status, body: answer(holds.length) };
  });
  hosted.call({ kind: 'sign_in', conversation_id: null, cli: kind, ends_in: 600 });
  return { hosted, holds, call: lastCall() };
}

async function finish(hosted: Hosted, kind: string, refusal = ''): Promise<void> {
  await mkdir(join(hosted.home, 'device-login'), { recursive: true });
  await writeFile(join(hosted.home, 'device-login', kind), refusal);
}

function returned(hosted: Hosted, call: string): number {
  return hosted.house.requests.findIndex((request) => request.path === '/kit/kit-calls/results/return' && idOf(request, 'call') === call);
}

function reportBeforeResult(hosted: Hosted, call: string): unknown {
  return hosted.house.requests
    .slice(0, returned(hosted, call))
    .filter((request) => request.path === '/kit/agents/report')
    .at(-1)?.body;
}

async function logins(hosted: Hosted): Promise<Record<string, unknown>[]> {
  const log = await readFile(join(hosted.home, 'login.log'), 'utf8');
  return log
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

it.each(['codex-acp', 'grok-build'])(
  'signs %s in through a ceremony with its link and code, reports it signed in and then returns its result',
  async (kind) => {
    const { hosted, holds, call } = await signingIn(kind);

    expect(await until(() => holds[0])).toEqual({
      subject: call,
      body: {
        steps: [
          { kind: 'visit', label: expect.any(String), url: DEVICE_LOGINS[kind]!.link },
          { kind: 'show', label: expect.any(String), text: DEVICE_LOGINS[kind]!.code },
        ],
      },
    });
    await until(() => holds[1]);
    expect(hosted.results).toEqual([]);

    await finish(hosted, kind);

    expect(await hosted.result(call)).toEqual({});
    expect(reportBeforeResult(hosted, call)).toMatchObject({ agents: [{ kind, signed_in: true }] });
    expect((await logins(hosted)).map((entry) => entry.argv)).toEqual([DEVICE_LOGINS[kind]!.argv]);
  },
);

it('reports a CLI signed out after a sign-in whose status check passes while its adapter still refuses a session as not signed in', async () => {
  const home = await temporaryHome();
  await writeFile(join(home, 'signed-out'), '');
  const { hosted, holds, call } = await signingIn('codex-acp', undefined, 200, home);
  await until(() => holds[1]);

  await finish(hosted, 'codex-acp');

  expect(await hosted.result(call)).toEqual({});
  expect(reportBeforeResult(hosted, call)).toMatchObject({ agents: [{ kind: 'codex-acp', signed_in: false }] });
});

it('signs Claude Code in with the code the page collects and keeps the code nowhere', async () => {
  const code = 'pasted-claude-code#4f1c9e2a';
  const { hosted, holds, call } = await signingIn('claude-agent-acp', (hold) =>
    hold === 1 ? HELD : { outcome: 'collected', content: { code } },
  );

  expect(await hosted.result(call)).toEqual({});

  const ceremony = {
    subject: call,
    body: {
      steps: [
        { kind: 'visit', label: expect.any(String), url: DEVICE_LOGINS['claude-agent-acp']!.link },
        { kind: 'collect', label: expect.any(String), name: 'code' },
      ],
    },
  };
  expect(holds).toEqual([ceremony, ceremony]);
  expect((await logins(hosted)).find((entry) => entry.pasted)!.pasted).toBe(createHash('sha256').update(code).digest('hex'));
  expect(reportBeforeResult(hosted, call)).toMatchObject({ agents: [{ kind: 'claude-agent-acp', signed_in: true }] });
  for (const file of await filesUnder(hosted.home)) {
    expect(await readFile(file, 'utf8')).not.toContain(code);
  }
  expect(hosted.kit.stdout() + hosted.kit.stderr()).not.toContain(code);
  expect(JSON.stringify(hosted.connection.oneWayCalls)).not.toContain(code);
  expect(JSON.stringify(hosted.house.requests)).not.toContain(code);
});

it('ends a Claude Code sign-in whose pasted code Claude rejects, names the cause in the log and returns its result', async () => {
  const { hosted, call } = await signingIn('claude-agent-acp', (hold) =>
    hold === 1 ? HELD : { outcome: 'collected', content: { code: 'pasted-claude-code' } },
  );

  expect(await hosted.result(call)).toEqual({});

  const [login] = await logins(hosted);
  await until(() => !alive(login!.pid as number));
  await until(() => hosted.kit.stderr().includes('Invalid code. Please make sure the full code was copied.'));
});

it('returns the result of a sign-in whose login fails and names the cause in the log', async () => {
  const { hosted, holds, call } = await signingIn('codex-acp');
  await until(() => holds[0]);

  await finish(hosted, 'codex-acp', 'device authorization was denied');

  expect(await hosted.result(call)).toEqual({});
  await until(() => hosted.kit.stderr().includes('device authorization was denied'));
});

it('ends the login and returns its result when the page releases the hold for good', async () => {
  const { hosted, holds, call } = await signingIn('grok-build', () => ({ outcome: 'released', release: 'withdrawn' }));

  expect(await hosted.result(call)).toEqual({});

  expect(holds).toHaveLength(1);
  const [login] = await logins(hosted);
  await until(() => !alive(login!.pid as number));
  await until(() => hosted.kit.stderr().includes('grok-build sign-in'));
});

it('ends the login and returns its result when House refuses its hold', async () => {
  const { hosted, holds, call } = await signingIn(
    'codex-acp',
    () => ({ error: { code: 'secret_input_not_found', retryable: false } }),
    404,
  );

  expect(await hosted.result(call)).toEqual({});

  expect(holds).toHaveLength(1);
  const [login] = await logins(hosted);
  await until(() => !alive(login!.pid as number));
});

it('holds the page again after House answers its hold with a refusal it marks retryable', async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }]);
  const answers = [
    { status: 429, body: { error: { code: 'rate_limited', retry_after: 1, retry_at: '2026-10-09T00:00:01.000Z', retryable: true } } },
    { body: { outcome: 'released', release: 'withdrawn' } },
  ];
  let holds = 0;
  hosted.house.route('POST', '/kit/secret-inputs/await', () => answers[holds++] ?? { body: HELD });
  hosted.call({ kind: 'sign_in', conversation_id: null, cli: 'grok-build', ends_in: 600 });

  expect(await hosted.result(lastCall())).toEqual({});

  expect(holds).toBe(2);
});

it('ends the hold at once when House answers it with a 500 refusal it does not mark retryable', async () => {
  const { hosted, holds, call } = await signingIn(
    'codex-acp',
    () => ({ error: { code: 'sync_failed', retryable: false } }),
    500,
  );

  expect(await hosted.result(call)).toEqual({});

  expect(holds).toHaveLength(1);
});

it('holds the page and returns the result of a finished sign-in while a model read of its CLI never ends', async () => {
  const home = await temporaryHome();
  await writeFile(join(home, 'hold-open'), '');
  const { hosted, holds, call } = await signingIn('codex-acp', () => HELD, 200, home);
  await until(() => holds[0]);

  await finish(hosted, 'codex-acp');

  expect(await hosted.result(call)).toEqual({});
  expect(reportBeforeResult(hosted, call)).toMatchObject({ agents: [{ kind: 'codex-acp', signed_in: true }] });
});

it('starts no second login for a sign-in call sent again while it runs, and returns its one result for each arrival', async () => {
  const { hosted, holds, call } = await signingIn('codex-acp');
  await until(() => holds[0]);
  hosted.connection.close(1001, 'shutting_down');
  await until(() => hosted.house.connections[1]);

  hosted.call({ input_id: call, kind: 'sign_in', conversation_id: null, cli: 'codex-acp', ends_in: 600 });
  await settle();
  await finish(hosted, 'codex-acp');

  await until(() => hosted.results[1]);
  await settle();
  expect(await logins(hosted)).toHaveLength(1);
  expect(hosted.results.map((result) => [idOf(result, 'call'), without(result, 'call')])).toEqual([
    [call, {}],
    [call, {}],
  ]);
});

it('starts no second login for a sign-in its reopened Kit connection sends after the sign-in ended, and returns its result again', async () => {
  const { hosted, holds, call } = await signingIn('codex-acp');
  await until(() => holds[0]);
  hosted.connection.close(1001, 'shutting_down');
  await until(() => hosted.house.connections[1]);
  await finish(hosted, 'codex-acp');
  await hosted.result(call);
  await until(() => hosted.idles[1]);

  hosted.call({ input_id: call, kind: 'sign_in', conversation_id: null, cli: 'codex-acp', ends_in: 600 });

  await until(() => hosted.results[1]);
  await settle();
  expect(await logins(hosted)).toHaveLength(1);
  expect(hosted.results.map((result) => [idOf(result, 'call'), without(result, 'call')])).toEqual([
    [call, {}],
    [call, {}],
  ]);
});

it('reports no idle while a sign-in runs and reports idle after its result', async () => {
  const { hosted, holds, call } = await signingIn('codex-acp');
  await until(() => holds[0]);
  await settle();
  expect(hosted.idles).toHaveLength(1);

  await finish(hosted, 'codex-acp');

  await until(() => hosted.idles[1]);
  const idled = hosted.house.requests.lastIndexOf(hosted.idles[1]!);
  expect(idled).toBeGreaterThan(returned(hosted, call));
});

it('ends a login that never prints its link when the time House gave the sign-in runs out, and returns its result', async () => {
  const home = await temporaryHome();
  await writeFile(join(home, 'device-login-silent'), '');
  const hosted = await hostKit([{ kind: 'codex-acp' }], { home });

  hosted.call({ kind: 'sign_in', conversation_id: null, cli: 'codex-acp', ends_in: 5 });
  const [login] = await until(async () => {
    const started = await logins(hosted).catch(() => []);
    return started.length > 0 && started;
  });

  expect(await hosted.result(lastCall())).toEqual({});
  await until(() => !alive(login!.pid as number));
  await until(() => hosted.kit.stderr().includes('the codex-acp sign-in reached the end House set for it'));
});

it('reports a CLI its sign-in installs as installing until the install ends, then as the Kit held it while the CLI signs in', async () => {
  const hosted = await hostKit([{ kind: 'codex-acp' }]);
  const codex = (report: Record<string, unknown>) =>
    (report.agents as { kind: string }[]).find((agent) => agent.kind === 'codex-acp');
  await until(() => hosted.reports.some((report) => codex(report) !== undefined));
  await settle();
  const held = codex(hosted.reports.at(-1)!);
  const before = hosted.reports.length;
  await rm(join(userBin(hosted.home), 'codex'));
  const holds: unknown[] = [];
  hosted.house.route('POST', '/kit/secret-inputs/await', async (request) => {
    holds.push(request.body);
    // House holds the page a tenth of a second each time, so the ceremony is seen holding.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { body: HELD };
  });

  hosted.call({ kind: 'sign_in', conversation_id: null, cli: 'codex-acp', ends_in: 600 });

  await until(() => holds[0]);
  const installing = { kind: 'codex-acp', release: null, failure: null, installing: true, signed_in: false, models: [], modes: [], full_access: 'agent-full-access' };
  await until(() => JSON.stringify(hosted.reports.slice(before).map(codex)) === JSON.stringify([installing, held]));
});

it('keeps reporting a CLI installing when a sign-in queued behind its install runs out of time', async () => {
  const hosted = await hostKit([{ kind: 'codex-acp' }]);
  const codex = (report: Record<string, unknown>) =>
    (report.agents as { kind: string }[]).find((agent) => agent.kind === 'codex-acp');
  await until(() => hosted.reports.some((report) => codex(report) !== undefined));
  await rm(join(userBin(hosted.home), 'codex'));
  await writeFile(join(hosted.home, 'install-stall-codex-acp'), '');
  const installing = { kind: 'codex-acp', release: null, failure: null, installing: true, signed_in: false, models: [], modes: [], full_access: 'agent-full-access' };
  hosted.call({ kind: 'sign_in', conversation_id: null, cli: 'codex-acp', ends_in: 600 });
  await until(() => JSON.stringify(codex(hosted.reports.at(-1)!)) === JSON.stringify(installing));

  hosted.call({ kind: 'sign_in', conversation_id: null, cli: 'codex-acp', ends_in: 1 });

  expect(await hosted.result(lastCall())).toEqual({});
  await until(() => hosted.kit.stderr().includes('the codex-acp sign-in reached the end House set for it'));
  await settle();
  expect(codex(hosted.reports.at(-1)!)).toEqual(installing);
});

it('ends the install a sign-in started when the time House gave the sign-in runs out, and returns its result', async () => {
  const hosted = await hostKit([{ kind: 'codex-acp' }]);
  const hold = join(hosted.home, 'install-hold-claude-agent-acp');
  await writeFile(hold, '');
  onTestFinished(() => rm(hold, { force: true }));
  await rm(join(userBin(hosted.home), 'claude'));

  hosted.call({ kind: 'sign_in', conversation_id: null, cli: 'claude-agent-acp', ends_in: 2 });

  expect(await hosted.result(lastCall())).toEqual({});
  await until(() => hosted.kit.stderr().includes('the claude-agent-acp sign-in reached the end House set for it'));
  await rm(hold);
  await settle();
  await expect(access(join(accountOf(hosted.home), '.local', 'bin', 'claude'))).rejects.toThrow();
  await expect(access(join(hosted.home, 'login.log'))).rejects.toThrow();
  expect(hosted.kit.stderr()).not.toContain('claude-agent-acp did not install');
});

const STAND_IN_KEY = 'stand-in-api-key-0000';

const ENDPOINT = 'https://openrouter.ai/api/v1';

function keyCeremony(name: string) {
  return {
    steps: [
      { kind: 'collect', label: 'API key', name: 'key' },
      {
        kind: 'collect',
        label: 'Endpoint, for another provider',
        name: 'endpoint',
        description: `Leave Endpoint empty for ${name}’s own. Both stay on this computer.`,
        optional: true,
      },
    ],
  };
}

async function signingInByKey(kind: string, endpoint: string, prepare: (account: string) => Promise<void> = async () => undefined) {
  const hosted = await hostKit([{ kind }], { prepare: (home) => prepare(accountOf(home)) });
  const holds: Hold[] = [];
  hosted.house.route('POST', '/kit/secret-inputs/await', (request) => {
    holds.push({ subject: idOf(request, 'subject'), body: without(request, 'subject') });
    return { body: { outcome: 'collected', content: { key: STAND_IN_KEY, endpoint } } };
  });
  hosted.call({ kind: 'sign_in', conversation_id: null, cli: kind, ends_in: 600, api_key: true });
  return { hosted, holds, call: lastCall() };
}

async function placeFile(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

async function keptNowhere(hosted: Hosted): Promise<void> {
  for (const file of await filesUnder(hosted.home)) {
    expect(await readFile(file, 'utf8')).not.toContain(STAND_IN_KEY);
  }
  expect(hosted.kit.stdout() + hosted.kit.stderr()).not.toContain(STAND_IN_KEY);
  expect(JSON.stringify(hosted.connection.oneWayCalls)).not.toContain(STAND_IN_KEY);
  expect(JSON.stringify(hosted.house.requests)).not.toContain(STAND_IN_KEY);
}

const CLAUDE_SETTINGS = {
  model: 'opus',
  env: { DISABLE_TELEMETRY: '1', ANTHROPIC_AUTH_TOKEN: 'stand-in-earlier-token', ANTHROPIC_BASE_URL: 'https://earlier.example/api' },
  permissions: { allow: ['Bash(ls:*)'] },
};

const CODEX_CONFIG = ['# kept as it was', 'model = "gpt-5.5"', '', '[mcp_servers.docs]', 'command = "docs-mcp"', ''].join('\n');

it('writes the API key a sign-in by key collects as the bearer token for the endpoint it collects into Claude Code’s user settings, keeping its other settings, and reports it on a key and another provider', async () => {
  const settings = (account: string) => join(account, '.claude', 'settings.json');
  const { hosted, holds, call } = await signingInByKey('claude-agent-acp', ENDPOINT, (account) =>
    placeFile(settings(account), JSON.stringify(CLAUDE_SETTINGS)),
  );

  expect(await hosted.result(call)).toEqual({});

  expect(holds).toEqual([{ subject: call, body: keyCeremony('Claude Code') }]);
  expect(JSON.parse(await readFile(settings(accountOf(hosted.home)), 'utf8'))).toEqual({
    ...CLAUDE_SETTINGS,
    env: { DISABLE_TELEMETRY: '1', ANTHROPIC_AUTH_TOKEN: STAND_IN_KEY, ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: ENDPOINT },
  });
  expect(reportBeforeResult(hosted, call)).toMatchObject({
    agents: [{ kind: 'claude-agent-acp', signed_in: true, api_key: true, provider: 'openrouter.ai' }],
  });
  await keptNowhere(hosted);
});

it('writes a key with an empty endpoint into Claude Code’s user settings for Claude’s own endpoint, and reports it on a key and no other provider', async () => {
  const settings = (account: string) => join(account, '.claude', 'settings.json');
  const { hosted, call } = await signingInByKey('claude-agent-acp', '', (account) => placeFile(settings(account), JSON.stringify(CLAUDE_SETTINGS)));

  expect(await hosted.result(call)).toEqual({});

  expect(JSON.parse(await readFile(settings(accountOf(hosted.home)), 'utf8'))).toEqual({
    ...CLAUDE_SETTINGS,
    env: { DISABLE_TELEMETRY: '1', ANTHROPIC_API_KEY: STAND_IN_KEY },
  });
  const report = reportBeforeResult(hosted, call) as { agents: Record<string, unknown>[] };
  expect(report.agents[0]).toMatchObject({ kind: 'claude-agent-acp', signed_in: true, api_key: true });
  expect(report.agents[0]).not.toHaveProperty('provider');
});

it('writes the endpoint and the key a sign-in by key collects into a Codex model provider it selects, keeping every other line, and reports Codex signed in with its models on a key and another provider', async () => {
  const config = (account: string) => join(account, '.codex', 'config.toml');
  const { hosted, holds, call } = await signingInByKey('codex-acp', ENDPOINT, (account) => placeFile(config(account), CODEX_CONFIG));

  expect(await hosted.result(call)).toEqual({});

  expect(holds).toEqual([{ subject: call, body: keyCeremony('Codex') }]);
  expect(await readFile(config(accountOf(hosted.home)), 'utf8')).toBe(
    [
      '# kept as it was',
      'model = "gpt-5.5"',
      'model_provider = "openrouter.ai"',
      '',
      '[mcp_servers.docs]',
      'command = "docs-mcp"',
      '',
      '[model_providers."openrouter.ai"]',
      'name = "openrouter.ai"',
      `base_url = "${ENDPOINT}"`,
      `experimental_bearer_token = "${STAND_IN_KEY}"`,
      '',
    ].join('\n'),
  );
  expect(reportBeforeResult(hosted, call)).toMatchObject({
    agents: [
      {
        kind: 'codex-acp',
        signed_in: true,
        api_key: true,
        provider: 'openrouter.ai',
        models: expect.arrayContaining([expect.objectContaining({ model: 'gpt-5.5' })]),
      },
    ],
  });
  await keptNowhere(hosted);
});

it("saves a key with an empty endpoint through Codex's own login by key, selects Codex's own provider again, and reports it on a key and no other provider", async () => {
  const config = (account: string) => join(account, '.codex', 'config.toml');
  const earlier = ['model_provider = "openrouter.ai"', 'model = "gpt-5.5"', '', '[model_providers."openrouter.ai"]', 'name = "openrouter.ai"', `base_url = "${ENDPOINT}"`, ''];
  const { hosted, call } = await signingInByKey('codex-acp', '', (account) => placeFile(config(account), earlier.join('\n')));

  expect(await hosted.result(call)).toEqual({});

  const account = accountOf(hosted.home);
  expect(await readFile(config(account), 'utf8')).toBe(earlier.slice(1).join('\n'));
  expect(JSON.parse(await readFile(join(account, '.codex', 'auth.json'), 'utf8'))).toEqual({ auth_mode: 'apikey', OPENAI_API_KEY: STAND_IN_KEY });
  expect((await logins(hosted)).map((entry) => entry.argv)).toEqual([['login', '--with-api-key']]);
  const report = reportBeforeResult(hosted, call) as { agents: Record<string, unknown>[] };
  expect(report.agents[0]).toMatchObject({ kind: 'codex-acp', signed_in: true, api_key: true });
  expect(report.agents[0]).not.toHaveProperty('provider');
});

const GROK_CONFIG = ['# kept as it was', 'theme = "dark"', '', '[features]', 'telemetry = false', ''].join('\n');

const SHELL_FILES = ['.profile', '.bashrc', '.zshrc', '.config/fish/config.fish'];

function grokAndShell(account: string): Promise<Record<string, string>> {
  return Promise.all(
    [join('.grok', 'config.toml'), ...SHELL_FILES].map(async (file) => [file, await readFile(join(account, file), 'utf8')] as const),
  ).then(Object.fromEntries);
}

async function placeGrokAndShell(account: string): Promise<Record<string, string>> {
  await placeFile(join(account, '.grok', 'config.toml'), GROK_CONFIG);
  for (const file of SHELL_FILES.slice(1)) await placeFile(join(account, file), `# ${file} kept as it was\n`);
  return grokAndShell(account);
}

async function grokEnvironment(hosted: Hosted, cwd: string): Promise<Record<string, string | undefined>> {
  const log = await hosted.adapterLog();
  const opened = log.findLast((entry) => entry.method === 'session/new' && (entry.params as { cwd: string }).cwd === cwd)!;
  return log.find((entry) => entry.method === 'initialize' && entry.pid === opened.pid)!.env as Record<string, string | undefined>;
}

async function grokAgentEnvironment(hosted: Hosted): Promise<Record<string, string | undefined>> {
  hosted.call({ kind: 'open', conversation_id: 'conversation-1', agent_id: 'agent-1' });
  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
  return grokEnvironment(hosted, hosted.workingDirectory);
}

it('keeps the API key and the endpoint a Grok Build sign-in by key collects in Kit home alone, reports it on a key and another provider, and starts every Grok Agent with them', async () => {
  let placed: Record<string, string> = {};
  const { hosted, holds, call } = await signingInByKey('grok-build', ENDPOINT, async (account) => {
    placed = await placeGrokAndShell(account);
  });

  expect(await hosted.result(call)).toEqual({});

  expect(holds).toEqual([{ subject: call, body: keyCeremony('Grok Build') }]);
  const kept = join(hosted.home, 'grok-key.json');
  expect(JSON.parse(await readFile(kept, 'utf8'))).toEqual({ key: STAND_IN_KEY, endpoint: ENDPOINT });
  expect((await stat(kept)).mode & 0o777).toBe(0o600);
  expect(reportBeforeResult(hosted, call)).toMatchObject({
    agents: [{ kind: 'grok-build', signed_in: true, api_key: true, provider: 'openrouter.ai' }],
  });
  expect(await grokEnvironment(hosted, hosted.home)).toMatchObject({ XAI_API_KEY: STAND_IN_KEY, GROK_MODELS_BASE_URL: ENDPOINT });
  expect(await grokAgentEnvironment(hosted)).toMatchObject({ XAI_API_KEY: STAND_IN_KEY, GROK_MODELS_BASE_URL: ENDPOINT });
  const account = accountOf(hosted.home);
  expect(await grokAndShell(account)).toEqual(placed);
  for (const file of await filesUnder(account)) {
    if (file !== kept && file !== join(hosted.home, 'adapter.log')) expect(await readFile(file, 'utf8')).not.toContain(STAND_IN_KEY);
  }
  expect(hosted.kit.stdout() + hosted.kit.stderr()).not.toContain(STAND_IN_KEY);
  expect(JSON.stringify(hosted.connection.oneWayCalls)).not.toContain(STAND_IN_KEY);
  expect(JSON.stringify(hosted.house.requests)).not.toContain(STAND_IN_KEY);
});

it('replaces the key and endpoint Kit home holds for Grok Build with a key and an empty endpoint, reports it on a key and no other provider, and starts its Grok Agents on xAI with no endpoint', async () => {
  let placed: Record<string, string> = {};
  const { hosted, call } = await signingInByKey('grok-build', '', async (account) => {
    placed = await placeGrokAndShell(account);
    await placeFile(join(account, '.agents', 'house', 'grok-key.json'), JSON.stringify({ key: 'stand-in-earlier-key', endpoint: 'https://earlier.example/v1' }));
  });

  expect(await hosted.result(call)).toEqual({});

  expect(JSON.parse(await readFile(join(hosted.home, 'grok-key.json'), 'utf8'))).toEqual({ key: STAND_IN_KEY });
  const report = reportBeforeResult(hosted, call) as { agents: Record<string, unknown>[] };
  expect(report.agents[0]).toMatchObject({ kind: 'grok-build', signed_in: true, api_key: true });
  expect(report.agents[0]).not.toHaveProperty('provider');
  const environment = await grokAgentEnvironment(hosted);
  expect(environment.XAI_API_KEY).toBe(STAND_IN_KEY);
  expect(environment).not.toHaveProperty('GROK_MODELS_BASE_URL');
  expect(await grokAndShell(accountOf(hosted.home))).toEqual(placed);
});

it('names a Grok Build key Kit home holds as no JSON in its log, quoting none of it', async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }], { prepare: (home) => writeFile(join(home, 'grok-key.json'), STAND_IN_KEY) });

  await until(() => hosted.kit.stderr().includes('kit: grok-build did not offer its models: grok-key.json in Kit home holds no JSON'));
  expect(hosted.kit.stdout() + hosted.kit.stderr()).not.toContain(STAND_IN_KEY);
});

it('ends a sign-in by key whose CLI settings it cannot read with their cause, writing nothing and naming no key', async () => {
  const settings = (account: string) => join(account, '.claude', 'settings.json');
  const { hosted, call } = await signingInByKey('claude-agent-acp', ENDPOINT, (account) => placeFile(settings(account), '{ "model": "opus", '));

  expect(await hosted.result(call)).toEqual({});

  expect(await readFile(settings(accountOf(hosted.home)), 'utf8')).toBe('{ "model": "opus", ');
  await until(() => hosted.kit.stderr().includes('settings.json holds no JSON object'));
  expect(reportBeforeResult(hosted, call)).toMatchObject({ agents: [{ kind: 'claude-agent-acp', signed_in: false }] });
  await keptNowhere(hosted);
});

it('ends a sign-in by key whose Codex settings name its provider in a way it cannot extend with their cause, changing nothing', async () => {
  const config = (account: string) => join(account, '.codex', 'config.toml');
  const inline = 'model_providers = { "openrouter.ai" = { name = "Router" } }\n';
  const { hosted, call } = await signingInByKey('codex-acp', ENDPOINT, (account) => placeFile(config(account), inline));

  expect(await hosted.result(call)).toEqual({});

  expect(await readFile(config(accountOf(hosted.home)), 'utf8')).toBe(inline);
  await until(() => hosted.kit.stderr().includes('config.toml could not take the key without changing its other settings'));
  await keptNowhere(hosted);
});

it('ends a sign-in by key whose endpoint is no web address with that cause, writing nothing', async () => {
  const { hosted, call } = await signingInByKey('codex-acp', 'openrouter.ai/api/v1');

  expect(await hosted.result(call)).toEqual({});

  await expect(access(join(accountOf(hosted.home), '.codex', 'config.toml'))).rejects.toThrow();
  await until(() => hosted.kit.stderr().includes('kit: the codex-acp sign-in failed: the endpoint is no http or https address'));
});
