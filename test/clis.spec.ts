import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { BINS, RELEASES, placeUserCli } from './cli.ts';
import { LOCATIONS } from './curl.ts';
import { settle, until } from './double.ts';
import { hostKit, lastInput, outcome, userBin, type Hosted } from './environment.ts';

const KINDS = Object.keys(BINS);
const EXECUTABLES: Record<string, string> = { 'codex-acp': 'CODEX_PATH', 'claude-agent-acp': 'CLAUDE_CODE_EXECUTABLE' };

function reported(hosted: Hosted): Record<string, unknown>[] {
  return hosted.house.requests.filter((request) => request.path === '/kit/agents/report').map((request) => request.body as Record<string, unknown>);
}

async function report(hosted: Hosted, matches: (agents: Record<string, unknown>[]) => boolean): Promise<Record<string, unknown>[]> {
  return until(() => reported(hosted).map((body) => body.agents as Record<string, unknown>[]).find(matches));
}

async function reportOf(hosted: Hosted, agents: unknown[]): Promise<void> {
  await report(hosted, (reported) => JSON.stringify(reported) === JSON.stringify(agents));
}

async function open(hosted: Hosted, conversation: string, agent = 'agent-1'): Promise<unknown> {
  hosted.input({ kind: 'open', conversation_id: conversation, agent_id: agent });
  return hosted.ack(lastInput());
}

async function answer(hosted: Hosted, conversation: string, text: string): Promise<unknown> {
  const before = hosted.turns.length;
  hosted.input({ kind: 'message', conversation_id: conversation, text, files: [], first: false });
  const ended = await until(() =>
    hosted.turns
      .slice(before)
      .find((turn) => turn.path.endsWith('/ended') && turn.params.conversation === conversation),
  );
  return (outcome(ended.body) as { text: string }).text;
}

async function signIn(home: string, kind: string): Promise<void> {
  await mkdir(join(home, 'signed-in'), { recursive: true });
  await writeFile(join(home, 'signed-in', kind), '');
}

async function probes(hosted: Hosted): Promise<number> {
  return (await hosted.adapterLog()).filter((entry) => entry.method === 'session/new' && entry.params !== undefined && (entry.params as { cwd: string }).cwd === hosted.home).length;
}

async function initialized(hosted: Hosted): Promise<Record<string, unknown>[]> {
  return (await hosted.adapterLog()).filter((entry) => entry.method === 'initialize');
}

it.each(KINDS)('runs the %s its login shell finds, through its adapter or itself, with no home or configuration variable of its own', async (kind) => {
  const hosted = await hostKit([{ kind }], {
    prepare: async (home) => {
      placeUserCli(join(home, '.local', 'bin'), kind, '0.0.1');
    },
  });

  expect(await open(hosted, 'conversation-1')).toEqual({ provider_session_id: expect.any(String) });

  const [entry] = await initialized(hosted);
  const cli = join(userBin(hosted.home), BINS[kind]!);
  const env = entry!.env as Record<string, string | undefined>;
  expect(entry!.cli).toEqual({ path: cli, release: RELEASES[kind] });
  const executable = EXECUTABLES[kind];
  if (executable === undefined) {
    expect(env.CLI_PATH).toBe(cli);
    expect((entry!.argv as string[]).slice(2)).toEqual(['agent', '--always-approve', '--no-leader', 'stdio']);
  } else {
    expect(env[executable]).toBe(cli);
    expect(env.CLI_PATH).toBeUndefined();
  }
  expect(env.CLAUDE_CODE_ENTRYPOINT).toBe(kind === 'claude-agent-acp' ? 'claude-agent-acp' : undefined);
  expect(env.HOME).toBe(hosted.home);
  for (const variable of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) expect(env[variable]).toBeUndefined();
});

it('opens and resumes Claude sessions under the adapter entrypoint instead of an inherited SDK entrypoint', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }], {
    environment: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
  });
  const opened = (await open(hosted, 'conversation-1')) as { provider_session_id: string };
  hosted.input({ kind: 'kill' });
  await hosted.ack(lastInput());

  hosted.input({ kind: 'message', provider_session_id: opened.provider_session_id, text: '@say resumed', files: [], first: false });
  await hosted.ack(lastInput());

  const entries = await initialized(hosted);
  expect(entries).toHaveLength(2);
  expect(entries.map((entry) => (entry.env as Record<string, string>).CLAUDE_CODE_ENTRYPOINT)).toEqual([
    'claude-agent-acp',
    'claude-agent-acp',
  ]);
  expect((await hosted.adapterLog()).find((entry) => entry.method === 'session/resume')!.params).toMatchObject({
    sessionId: opened.provider_session_id,
  });
});

it.each(KINDS)('gives a %s conversation its login shell PATH with Kit shims and binaries first', async (kind) => {
  const hosted = await hostKit([{ kind }], {
    prepare: async (home) => {
      const bin = userBin(home);
      await writeFile(join(bin, 'user-tool'), '#!/bin/sh\necho from-login-shell\n');
      await chmod(join(bin, 'user-tool'), 0o755);
      await writeFile(join(home, '.profile'), `echo login-startup\nPATH="${bin}:/usr/bin:/bin"\n`);
    },
  });

  expect(await open(hosted, 'conversation-1')).toEqual({ provider_session_id: expect.any(String) });
  await answer(hosted, 'conversation-1', `@sh command -v ${BINS[kind]}; user-tool`);
  const ran = (await hosted.adapterLog()).find((entry) => 'sh' in entry);
  expect(ran).toMatchObject({
    status: 0,
    stdout: `${join(userBin(hosted.home), BINS[kind]!)}\nfrom-login-shell\n`,
    stderr: '',
  });

  const entry = (await initialized(hosted)).find((entry) => (entry.env as Record<string, string>).HOUSE_BRIDGE !== undefined)!;
  expect((entry.env as Record<string, string>).PATH.split(':')).toEqual([
    join(hosted.home, 'shim'),
    dirname(process.execPath),
    userBin(hosted.home),
    '/usr/bin',
    '/bin',
    join(hosted.home, '.local', 'bin'),
  ]);
});

it.each([
  ['codex-acp', '0.161.0'],
  ['grok-build', '1.0.48'],
])('runs a %s replaced between two conversations at its new version in the second while the first keeps its own', async (kind, next) => {
  const hosted = await hostKit([{ kind }]);
  const cli = join(userBin(hosted.home), BINS[kind]!);
  await open(hosted, 'conversation-1');

  placeUserCli(userBin(hosted.home), kind, next);
  await open(hosted, 'conversation-2');

  expect(await answer(hosted, 'conversation-2', '@version')).toBe(`${cli} ${next}`);
  expect(await answer(hosted, 'conversation-1', '@version')).toBe(`${cli} ${RELEASES[kind]}`);
});

it.each(KINDS)('runs a %s its official installer placed beneath the home when the login profile lacks a user binary directory', async (kind) => {
  const hosted = await hostKit([{ kind }], {
    prepare: async (home) => {
      await rm(join(userBin(home), BINS[kind]!));
      await writeFile(join(home, '.profile'), 'PATH="$HOME/bin:/usr/bin:/bin"\n');
    },
  });

  expect(await open(hosted, 'conversation-1')).toEqual({ provider_session_id: expect.any(String) });
  await answer(hosted, 'conversation-1', `@sh command -v ${BINS[kind]}; ${BINS[kind]} --version`);

  const entry = (await initialized(hosted)).find((entry) => (entry.env as Record<string, string>).HOUSE_BRIDGE !== undefined)!;
  const cli = join(hosted.home, LOCATIONS[kind]!, BINS[kind]!);
  expect(entry.cli).toEqual({ path: cli, release: RELEASES[kind] });
  expect((await hosted.adapterLog()).find((entry) => 'sh' in entry)).toMatchObject({
    status: 0,
    stdout: expect.stringContaining(`${cli}\n`),
    stderr: '',
  });
  expect((entry.env as Record<string, string>).PATH.split(':').filter((path) => path === join(hosted.home, '.local', 'bin'))).toHaveLength(1);
});

it('reports a CLI below its minimum, starts no conversation of that kind but one of another, and starts it once the login shell finds a newer one', async () => {
  const minimum = '0.159.1';
  const hosted = await hostKit([{ kind: 'codex-acp' }, { kind: 'grok-build' }], {
    prepare: async (home) => {
      placeUserCli(userBin(home), 'codex-acp', '0.150.0');
    },
  });
  await report(hosted, (agents) => agents.some((agent) => agent.minimum === minimum));

  expect(await open(hosted, 'conversation-1', 'agent-1')).toEqual({
    refused: `codex 0.150.0 is older than ${minimum}, the oldest this Kit runs`,
  });
  expect(await open(hosted, 'conversation-2', 'agent-2')).toEqual({ provider_session_id: expect.any(String) });
  expect((await initialized(hosted)).map((entry) => (entry.cli as { path: string }).path)).not.toContain(
    join(userBin(hosted.home), 'codex'),
  );

  placeUserCli(userBin(hosted.home), 'codex-acp', '0.160.0');

  expect(await open(hosted, 'conversation-1', 'agent-1')).toEqual({ provider_session_id: expect.any(String) });
  const current = await report(hosted, (agents) => agents.some((agent) => agent.release === '0.160.0'));
  expect(current.find((agent) => agent.kind === 'codex-acp')).not.toHaveProperty('minimum');
});

it('reads the CLI again at every Conversation process start, its sign-in and every model with its efforts, and reports it only when it changed', async () => {
  const hosted = await hostKit([{ kind: 'codex-acp' }]);
  const [signedOut] = await report(hosted, (agents) => agents.length === 1);
  await signIn(hosted.home, 'codex-acp');
  await mkdir(join(hosted.home, 'models'));
  await writeFile(
    join(hosted.home, 'models', 'codex-acp'),
    JSON.stringify([
      { id: 'gpt-6', name: '6', efforts: ['high', 'max'] },
      { id: 'gpt-5.5', name: '5.5', efforts: ['medium'] },
    ]),
  );

  await open(hosted, 'conversation-1');

  await reportOf(hosted, [
    {
      ...signedOut,
      signed_in: true,
      models: [
        { model: 'gpt-6', efforts: ['high', 'max'] },
        { model: 'gpt-5.5', efforts: ['medium'] },
      ],
      modes: [
        { mode: 'read-only', name: 'Read-only' },
        { mode: 'workspace-write', name: 'Workspace access' },
        { mode: 'agent', name: 'Auto review' },
        { mode: 'agent-full-access', name: 'Full access' },
      ],
    },
  ]);
  const count = reported(hosted).length;
  await open(hosted, 'conversation-2');
  await until(async () => (await probes(hosted)) === 2);
  await settle();
  expect(reported(hosted)).toHaveLength(count);
});

it('reports the read of the latest Conversation process start when an earlier read of the same CLI ends after it', async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }], { prepare: (home) => signIn(home, 'grok-build') });
  await report(hosted, (agents) => agents.some((agent) => agent.signed_in === true));
  const offer = async (model: string) =>
    writeFile(join(hosted.home, 'models', 'grok-build'), JSON.stringify([{ id: model, name: model, efforts: ['high'] }]));
  await mkdir(join(hosted.home, 'models'));
  await offer('grok-older');
  await writeFile(join(hosted.home, 'probe-hold'), 'grok-older');
  await open(hosted, 'conversation-1');
  await until(async () => (await hosted.adapterLog()).some((entry) => entry.heldProbe === 'grok-older'));

  await offer('grok-newer');
  await open(hosted, 'conversation-2');
  await report(hosted, (agents) => (agents[0]!.models as { model: string }[])[0]!.model === 'grok-newer');
  await rm(join(hosted.home, 'probe-hold'));
  await until(async () => (await hosted.adapterLog()).some((entry) => entry.releasedProbe === 'grok-older'));
  await settle();

  expect((reported(hosted).at(-1)!.agents as { models: unknown[] }[])[0]!.models).toEqual([{ model: 'grok-newer', efforts: ['high'] }]);
});

it('hands a conversation the binary its CLI link resolves to, so an update that moves the link leaves that conversation on its own binary', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }], {
    prepare: async (home) => {
      const binary = placeUserCli(join(home, 'versions', RELEASES['claude-agent-acp']!), 'claude-agent-acp');
      await rm(join(userBin(home), 'claude'));
      await symlink(binary, join(userBin(home), 'claude'));
    },
  });

  await open(hosted, 'conversation-1');

  const [entry] = await initialized(hosted);
  expect((entry!.env as Record<string, string>).CLAUDE_CODE_EXECUTABLE).toBe(
    join(hosted.home, 'versions', RELEASES['claude-agent-acp']!, 'claude'),
  );
});

it('runs a CLI the login shell finds through a relative PATH entry from any working directory', async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }], {
    prepare: (home) => writeFile(join(home, '.profile'), `PATH="${relative(process.cwd(), userBin(home))}:$PATH"\n`),
  });

  expect(await open(hosted, 'conversation-1')).toEqual({ provider_session_id: expect.any(String) });
  expect(hosted.workingDirectory).not.toBe(process.cwd());
});

it('reads a CLI a conversation finds at a new version again, its sign-in and every model with its efforts', async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }], { prepare: (home) => signIn(home, 'grok-build') });
  await report(hosted, (agents) => agents.some((agent) => agent.signed_in === true));
  await mkdir(join(hosted.home, 'models'));
  await writeFile(
    join(hosted.home, 'models', 'grok-build'),
    JSON.stringify([
      { id: 'grok-5', name: 'Grok 5', efforts: ['high'] },
      { id: 'grok-4.6', name: 'Grok 4.6', efforts: ['low'] },
    ]),
  );
  placeUserCli(userBin(hosted.home), 'grok-build', '1.0.48');

  await open(hosted, 'conversation-1');

  await reportOf(hosted, [
    {
      kind: 'grok-build',
      release: '1.0.48',
      failure: null,
      signed_in: true,
      models: [
        { model: 'grok-5', efforts: ['high'] },
        { model: 'grok-4.6', efforts: ['low'] },
      ],
      modes: [],
      full_access: null,
    },
  ]);
  expect(await probes(hosted)).toBe(2);
});

it.each([
  ['its CLI session does not open', 'refuse-new', 'the session did not open'],
  ['its CLI does not initialize', 'refuse-initialize', 'the CLI did not initialize'],
])('keeps the sign-in and models the Kit last read for a CLI it reads again while %s', async (_, refusal, cause) => {
  const hosted = await hostKit([{ kind: 'grok-build' }], { prepare: (home) => signIn(home, 'grok-build') });
  const [known] = await report(hosted, (agents) => agents.some((agent) => agent.signed_in === true));
  await writeFile(join(hosted.home, refusal), '');
  placeUserCli(userBin(hosted.home), 'grok-build', '1.0.48');

  await open(hosted, 'conversation-1');

  await until(() => hosted.kit.stderr().includes(`grok-build did not offer its models: ${cause}`));
  await settle();
  expect(reported(hosted).at(-1)!.agents).toEqual([{ ...known, release: '1.0.48' }]);
});

it('reports a model its CLI refuses to select, when it reads that CLI again, with the efforts the Kit last read for it', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }], { prepare: (home) => signIn(home, 'claude-agent-acp') });
  await report(hosted, (agents) => agents.some((agent) => agent.signed_in === true));
  await writeFile(join(hosted.home, 'refuse-model'), 'sonnet');
  await mkdir(join(hosted.home, 'models'));
  await writeFile(
    join(hosted.home, 'models', 'claude-agent-acp'),
    JSON.stringify([
      { id: 'default', name: 'Default (recommended)', efforts: ['high'] },
      { id: 'sonnet', name: 'Sonnet', efforts: ['low'] },
    ]),
  );
  placeUserCli(userBin(hosted.home), 'claude-agent-acp', '2.1.291');

  await open(hosted, 'conversation-1');

  await reportOf(hosted, [
    {
      kind: 'claude-agent-acp',
      release: '2.1.291',
      failure: null,
      signed_in: true,
      models: [
        { model: 'default', efforts: ['default', 'high'] },
        { model: 'sonnet', efforts: ['default', 'low', 'medium', 'high', 'max'] },
      ],
      modes: [
        { mode: 'default', name: 'Manual' },
        { mode: 'acceptEdits', name: 'Accept edits' },
        { mode: 'plan', name: 'Plan' },
        { mode: 'auto', name: 'Auto' },
        { mode: 'bypassPermissions', name: 'Bypass permissions' },
      ],
      full_access: 'bypassPermissions',
    },
  ]);
  await until(() => hosted.kit.stderr().includes('claude-agent-acp refused its model sonnet'));
});
