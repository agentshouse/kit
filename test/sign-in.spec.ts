import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { DEVICE_LOGINS } from './device-login.ts';
import { settle, until } from './double.ts';
import { CLIS } from '../src/clis.ts';
import { hostKit, lastCall, userBin, type Hosted } from './environment.ts';
import { alive, filesUnder, temporaryHome } from './kit.ts';

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
  hosted.house.route('POST', '/kit/secret-input/:subject', async (request) => {
    holds.push({ subject: request.params.subject!, body: request.body });
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

function at(hosted: Hosted, path: string): number {
  return hosted.house.requests.findIndex((request) => request.path === path);
}

function reportBeforeResult(hosted: Hosted, call: string): unknown {
  return hosted.house.requests
    .slice(0, at(hosted, `/kit/inputs/${call}/ack`))
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
  expect(JSON.stringify(hosted.connection.notifications)).not.toContain(code);
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
  hosted.house.route('POST', '/kit/secret-input/:subject', () => answers[holds++] ?? { body: HELD });
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
  expect(hosted.results.map((result) => [result.params.input, result.body])).toEqual([
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
  expect(hosted.results.map((result) => [result.params.input, result.body])).toEqual([
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
  expect(idled).toBeGreaterThan(at(hosted, `/kit/inputs/${call}/ack`));
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
  hosted.house.route('POST', '/kit/secret-input/:subject', async (request) => {
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
  const hold = join(hosted.home, 'npm-hold');
  await writeFile(hold, '');
  onTestFinished(() => rm(hold, { force: true }));

  hosted.call({ kind: 'sign_in', conversation_id: null, cli: 'claude-agent-acp', ends_in: 2 });

  expect(await hosted.result(lastCall())).toEqual({});
  await until(() => hosted.kit.stderr().includes('the claude-agent-acp sign-in reached the end House set for it'));
  const child = Number(await readFile(join(hosted.home, 'npm-child'), 'utf8'));
  await until(() => !alive(child));
  await rm(hold);
  await settle();
  const adapter = CLIS['claude-agent-acp']!.adapter!.package;
  await expect(access(join(hosted.home, 'agents', 'claude-agent-acp', 'node_modules', adapter, 'package.json'))).rejects.toThrow();
  await expect(access(join(hosted.home, 'login.log'))).rejects.toThrow();
  expect(hosted.kit.stderr()).not.toContain('claude-agent-acp did not install');
});
