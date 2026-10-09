import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DEVICE_LOGINS } from './device-login.ts';
import { settle, until } from './double.ts';
import { hostKit, lastInput, type Hosted } from './environment.ts';
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
  hosted.input({ kind: 'sign_in', conversation_id: null, cli: kind });
  return { hosted, holds, input: lastInput() };
}

async function finish(hosted: Hosted, kind: string, refusal = ''): Promise<void> {
  await mkdir(join(hosted.home, 'device-login'), { recursive: true });
  await writeFile(join(hosted.home, 'device-login', kind), refusal);
}

function at(hosted: Hosted, path: string): number {
  return hosted.house.requests.findIndex((request) => request.path === path);
}

function reportBeforeAck(hosted: Hosted, input: string): unknown {
  return hosted.house.requests
    .slice(0, at(hosted, `/kit/inputs/${input}/ack`))
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
  'signs %s in through a ceremony with its link and code, reports it signed in and then acknowledges the input',
  async (kind) => {
    const { hosted, holds, input } = await signingIn(kind);

    expect(await until(() => holds[0])).toEqual({
      subject: input,
      body: {
        steps: [
          { kind: 'visit', label: expect.any(String), url: DEVICE_LOGINS[kind]!.link },
          { kind: 'show', label: expect.any(String), text: DEVICE_LOGINS[kind]!.code },
        ],
      },
    });
    await until(() => holds[1]);
    expect(hosted.acks).toEqual([]);

    await finish(hosted, kind);

    expect(await hosted.ack(input)).toEqual({});
    expect(reportBeforeAck(hosted, input)).toMatchObject({ agents: [{ kind, signed_in: true }] });
    expect((await logins(hosted)).map((entry) => entry.argv)).toEqual([DEVICE_LOGINS[kind]!.argv]);
  },
);

it('signs Claude Code in with the code the page collects and keeps the code nowhere', async () => {
  const code = 'pasted-claude-code#4f1c9e2a';
  const { hosted, holds, input } = await signingIn('claude-agent-acp', (hold) =>
    hold === 1 ? HELD : { outcome: 'collected', content: { code } },
  );

  expect(await hosted.ack(input)).toEqual({});

  const ceremony = {
    subject: input,
    body: {
      steps: [
        { kind: 'visit', label: expect.any(String), url: DEVICE_LOGINS['claude-agent-acp']!.link },
        { kind: 'collect', label: expect.any(String), name: 'code' },
      ],
    },
  };
  expect(holds).toEqual([ceremony, ceremony]);
  expect((await logins(hosted)).find((entry) => entry.pasted)!.pasted).toBe(createHash('sha256').update(code).digest('hex'));
  expect(reportBeforeAck(hosted, input)).toMatchObject({ agents: [{ kind: 'claude-agent-acp', signed_in: true }] });
  for (const file of await filesUnder(hosted.home)) {
    expect(await readFile(file, 'utf8')).not.toContain(code);
  }
  expect(hosted.kit.stdout() + hosted.kit.stderr()).not.toContain(code);
  expect(JSON.stringify(hosted.socket.frames)).not.toContain(code);
  expect(JSON.stringify(hosted.house.requests)).not.toContain(code);
});

it('ends a Claude Code sign-in whose pasted code Claude rejects, names the cause in the log and acknowledges the input', async () => {
  const { hosted, input } = await signingIn('claude-agent-acp', (hold) =>
    hold === 1 ? HELD : { outcome: 'collected', content: { code: 'pasted-claude-code' } },
  );

  expect(await hosted.ack(input)).toEqual({});

  const [login] = await logins(hosted);
  await until(() => !alive(login!.pid as number));
  expect(hosted.kit.stderr()).toContain('Invalid code. Please make sure the full code was copied.');
});

it('acknowledges a sign-in whose login fails and names the cause in the log', async () => {
  const { hosted, holds, input } = await signingIn('codex-acp');
  await until(() => holds[0]);

  await finish(hosted, 'codex-acp', 'device authorization was denied');

  expect(await hosted.ack(input)).toEqual({});
  expect(hosted.kit.stderr()).toContain('device authorization was denied');
});

it('ends the login and acknowledges the input when the page releases the hold for good', async () => {
  const { hosted, holds, input } = await signingIn('grok-build', () => ({ outcome: 'released', release: 'withdrawn' }));

  expect(await hosted.ack(input)).toEqual({});

  expect(holds).toHaveLength(1);
  const [login] = await logins(hosted);
  await until(() => !alive(login!.pid as number));
  expect(hosted.kit.stderr()).toContain('grok-build sign-in');
});

it('ends the login and acknowledges the input when House refuses its hold', async () => {
  const { hosted, holds, input } = await signingIn(
    'codex-acp',
    () => ({ error: { code: 'secret_input_not_found', retryable: false } }),
    404,
  );

  expect(await hosted.ack(input)).toEqual({});

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
  hosted.input({ kind: 'sign_in', conversation_id: null, cli: 'grok-build' });

  expect(await hosted.ack(lastInput())).toEqual({});

  expect(holds).toBe(2);
});

it('ends the hold at once when House answers it with a 500 refusal it does not mark retryable', async () => {
  const { hosted, holds, input } = await signingIn(
    'codex-acp',
    () => ({ error: { code: 'sync_failed', retryable: false } }),
    500,
  );

  expect(await hosted.ack(input)).toEqual({});

  expect(holds).toHaveLength(1);
});

it('holds the page and acknowledges a finished sign-in while a model read of its CLI never ends', async () => {
  const home = await temporaryHome();
  await writeFile(join(home, 'hold-open'), '');
  const { hosted, holds, input } = await signingIn('codex-acp', () => HELD, 200, home);
  await until(() => holds[0]);

  await finish(hosted, 'codex-acp');

  expect(await hosted.ack(input)).toEqual({});
  expect(reportBeforeAck(hosted, input)).toMatchObject({ agents: [{ kind: 'codex-acp', signed_in: true }] });
});

it('starts no second login for a sign-in input sent again while it runs', async () => {
  const { hosted, holds, input } = await signingIn('codex-acp');
  await until(() => holds[0]);
  hosted.socket.close(1001, 'shutting_down');
  await until(() => hosted.house.sockets[1]);

  hosted.input({ input_id: input, kind: 'sign_in', conversation_id: null, cli: 'codex-acp' });
  await settle();
  await finish(hosted, 'codex-acp');

  await hosted.ack(input);
  await settle();
  expect(await logins(hosted)).toHaveLength(1);
  expect(hosted.acks).toHaveLength(1);
});

it('reports no idle while a sign-in runs and reports idle after its acknowledgement', async () => {
  const { hosted, holds, input } = await signingIn('codex-acp');
  await until(() => holds[0]);
  await settle();
  expect(hosted.idles).toHaveLength(1);

  await finish(hosted, 'codex-acp');

  await until(() => hosted.idles[1]);
  const idled = hosted.house.requests.lastIndexOf(hosted.idles[1]!);
  expect(idled).toBeGreaterThan(at(hosted, `/kit/inputs/${input}/ack`));
});
