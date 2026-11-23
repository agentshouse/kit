import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { BINS, RELEASES, linkUserCli, placeUserCli, updatesRun } from './cli.ts';
import { LOCATIONS } from './curl.ts';
import { idOf, settle, until } from './double.ts';
import { clocked, hostKit, lastCall, outcome, userBin, type Hosted } from './environment.ts';
import { accountOf, alive } from './kit.ts';

const KINDS = Object.keys(BINS);
const NEXT: Record<string, string> = { 'codex-acp': '0.167.0', 'claude-agent-acp': '2.1.318', 'grok-build': '1.0.48' };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FAST_DEADLINES = fileURLToPath(new URL('./fast-deadlines.ts', import.meta.url));
const EXECUTABLES: Record<string, string> = { 'codex-acp': 'HOUSE_KIT_CODEX', 'claude-agent-acp': 'CLAUDE_CODE_EXECUTABLE' };

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
  hosted.call({ kind: 'open', conversation_id: conversation, agent_id: agent });
  return hosted.result(lastCall());
}

async function answer(hosted: Hosted, conversation: string, text: string): Promise<unknown> {
  const before = hosted.turns.length;
  hosted.call({ kind: 'message', conversation_id: conversation, text, first: false });
  const ended = await until(() =>
    hosted.turns
      .slice(before)
      .find((turn) => turn.path === '/kit/turns/end' && idOf(turn, 'conversation') === conversation),
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

async function starts(hosted: Hosted, name: string): Promise<number> {
  const log = await readFile(join(hosted.home, 'started.log'), 'utf8').catch(() => '');
  return log.split('\n').filter((line) => line !== '' && (JSON.parse(line) as { name: string }).name === name).length;
}

async function versionReads(hosted: Hosted): Promise<number> {
  const log = await readFile(join(hosted.home, 'started.log'), 'utf8').catch(() => '');
  return log.split('\n').filter((line) => line !== '' && (JSON.parse(line) as { name: string }).name === 'version').length;
}

async function idled(hosted: Hosted, after: number): Promise<void> {
  await until(() => hosted.idles.length > after);
  await settle();
}

async function initialized(hosted: Hosted): Promise<Record<string, unknown>[]> {
  return (await hosted.adapterLog()).filter((entry) => entry.method === 'initialize');
}

it.each(KINDS)('runs the %s its login shell finds, through its adapter or itself, with no home or configuration variable of its own', async (kind) => {
  const hosted = await hostKit([{ kind }], {
    prepare: async (home) => {
      placeUserCli(join(accountOf(home), '.local', 'bin'), kind, '0.0.1');
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
    expect((entry!.argv as string[]).slice(2)).toEqual(['--sandbox', 'off', 'agent', '--always-approve', '--no-leader', 'stdio']);
  } else {
    expect(env[executable]).toBe(cli);
    expect(env.CLI_PATH).toBeUndefined();
  }
  expect(env.CODEX_PATH).toBe(kind === 'codex-acp' ? join(hosted.home, 'launchers', 'codex') : undefined);
  expect(env.CLAUDE_CODE_ENTRYPOINT).toBe(kind === 'claude-agent-acp' ? 'claude-agent-acp' : undefined);
  expect(env.HOME).toBe(accountOf(hosted.home));
  for (const variable of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'XAI_API_KEY', 'GROK_MODELS_BASE_URL']) expect(env[variable]).toBeUndefined();
});

it('opens and resumes Claude sessions under the adapter entrypoint instead of an inherited SDK entrypoint', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }], {
    environment: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
  });
  const opened = (await open(hosted, 'conversation-1')) as { provider_session_id: string };
  hosted.call({ kind: 'kill' });
  await hosted.result(lastCall());

  hosted.call({ kind: 'message', provider_session_id: opened.provider_session_id, text: '@say resumed', first: false });
  await hosted.result(lastCall());

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
      await writeFile(join(accountOf(home), '.profile'), `echo login-startup\nPATH="${bin}:/usr/bin:/bin"\n`);
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
    dirname(process.execPath),
    userBin(hosted.home),
    '/usr/bin',
    '/bin',
    join(accountOf(hosted.home), '.local', 'bin'),
  ]);
});

it.each([
  ['codex-acp', '0.167.0'],
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
      await writeFile(join(accountOf(home), '.profile'), `PATH="${join(home, 'bin')}:/usr/bin:/bin"\n`);
    },
  });

  expect(await open(hosted, 'conversation-1')).toEqual({ provider_session_id: expect.any(String) });
  await answer(hosted, 'conversation-1', `@sh command -v ${BINS[kind]}; ${BINS[kind]} --version`);

  const entry = (await initialized(hosted)).find((entry) => (entry.env as Record<string, string>).HOUSE_BRIDGE !== undefined)!;
  const cli = join(accountOf(hosted.home), LOCATIONS[kind]!, BINS[kind]!);
  expect(entry.cli).toEqual({ path: cli, release: RELEASES[kind] });
  expect((await hosted.adapterLog()).find((entry) => 'sh' in entry)).toMatchObject({
    status: 0,
    stdout: expect.stringContaining(`${cli}\n`),
    stderr: '',
  });
  expect((entry.env as Record<string, string>).PATH.split(':').filter((path) => path === join(accountOf(hosted.home), '.local', 'bin'))).toHaveLength(1);
});

it("runs a conversation on a CLI below its minimum, reported with the minimum and the CLI's update command, while a CLI that did not install refuses its own", async () => {
  const hosted = await hostKit([{ kind: 'codex-acp' }, { kind: 'claude-agent-acp' }], {
    prepare: async (home) => {
      placeUserCli(userBin(home), 'codex-acp', '0.150.0');
      await rm(join(userBin(home), 'claude'));
      await writeFile(join(home, 'install-fail'), 'claude-agent-acp\n');
    },
  });
  const reported = await report(hosted, (agents) => agents.some((agent) => agent.kind === 'codex-acp'));
  expect(reported.find((agent) => agent.kind === 'codex-acp')).toMatchObject({ kind: 'codex-acp', release: '0.150.0', minimum: '0.165.0', update: 'codex update', failure: null });

  expect(await open(hosted, 'conversation-1', 'agent-1')).toEqual({ provider_session_id: expect.any(String) });
  expect(await answer(hosted, 'conversation-1', '@version')).toBe(`${join(userBin(hosted.home), 'codex')} 0.150.0`);
  expect(await open(hosted, 'conversation-2', 'agent-2')).toEqual({ refused: "the Agent's CLI is not ready on this computer" });
});

it('reads a CLI once, its sign-in and models, when a conversation installs it after its install failed at Kit start', async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }], {
    prepare: async (home) => {
      await rm(join(userBin(home), 'claude'));
      await writeFile(join(home, 'install-fail'), 'claude-agent-acp\n');
      await signIn(home, 'claude-agent-acp');
    },
  });
  await report(hosted, (agents) => agents.some((agent) => typeof agent.failure === 'string'));
  await rm(join(hosted.home, 'install-fail'));

  expect(await open(hosted, 'conversation-1')).toEqual({ provider_session_id: expect.any(String) });

  await report(hosted, (agents) =>
    agents.some((agent) => agent.release === RELEASES['claude-agent-acp'] && agent.signed_in === true && (agent.models as unknown[]).length > 0),
  );
  await settle();
  expect(await probes(hosted)).toBe(1);
});

it('starts no second CLI and reads nothing when a conversation opens on a CLI the Kit read, though its sign-in and models changed since', async () => {
  const hosted = await hostKit([{ kind: 'codex-acp' }]);
  await report(hosted, (agents) => agents.length === 1);
  await idled(hosted, 0);
  const reports = reported(hosted).length;
  const adapters = await starts(hosted, 'adapter');
  await signIn(hosted.home, 'codex-acp');
  await mkdir(join(hosted.home, 'models'));
  await writeFile(join(hosted.home, 'models', 'codex-acp'), JSON.stringify([{ id: 'gpt-6', name: '6', efforts: ['high'] }]));

  await open(hosted, 'conversation-1');
  expect(await answer(hosted, 'conversation-1', '@say answered')).toBe('answered');
  // Three seconds give a read the conversation started time to reach the logs on a loaded runner.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  expect(await starts(hosted, 'adapter')).toBe(adapters + 1);
  expect(await probes(hosted)).toBe(0);
  expect(reported(hosted)).toHaveLength(reports);
});

it("reports the read of a CLI's latest link change when an earlier read of the same CLI ends after it", async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }], {
    prepare: async (home) => {
      linkUserCli(home, userBin(home), 'grok-build');
      await signIn(home, 'grok-build');
    },
  });
  await report(hosted, (agents) => agents.some((agent) => agent.signed_in === true));
  const offer = async (model: string) =>
    writeFile(join(hosted.home, 'models', 'grok-build'), JSON.stringify([{ id: model, name: model, efforts: ['high'] }]));
  await mkdir(join(hosted.home, 'models'));
  await offer('grok-older');
  await writeFile(join(hosted.home, 'probe-hold'), 'grok-older');
  linkUserCli(hosted.home, userBin(hosted.home), 'grok-build', NEXT['grok-build']);
  await until(async () => (await hosted.adapterLog()).some((entry) => entry.heldProbe === 'grok-older'));

  await offer('grok-newer');
  linkUserCli(hosted.home, userBin(hosted.home), 'grok-build', '1.0.49');
  await report(hosted, (agents) => (agents[0]!.models as { model: string }[])[0]!.model === 'grok-newer');
  await rm(join(hosted.home, 'probe-hold'));
  await until(async () => (await hosted.adapterLog()).some((entry) => entry.releasedProbe === 'grok-older'));
  await settle();

  expect(reported(hosted).at(-1)!.agents).toMatchObject([{ release: '1.0.49', models: [{ model: 'grok-newer', name: 'grok-newer', efforts: ['high'] }] }]);
});

it.each(KINDS)("runs a %s whose link the update command at Kit start moved at the new version in the next conversation, while the running one keeps its own and Kit runs on", async (kind) => {
  const hosted = await hostKit([{ kind }], {
    untilIdle: false,
    prepare: async (home) => {
      linkUserCli(home, userBin(home), kind);
      await writeFile(join(home, `update-${kind}`), NEXT[kind]!);
      await writeFile(join(home, 'update-hold'), '');
    },
  });
  const cli = join(userBin(hosted.home), BINS[kind]!);
  await until(() => updatesRun(hosted.home).findLast((update) => update.held));

  await open(hosted, 'conversation-1');
  expect(await answer(hosted, 'conversation-1', '@version')).toBe(`${cli} ${RELEASES[kind]}`);
  await rm(join(hosted.home, 'update-hold'));
  await report(hosted, (agents) => agents.some((agent) => agent.release === NEXT[kind]));
  await open(hosted, 'conversation-2');

  expect(await readlink(cli)).toBe(join(hosted.home, 'versions', NEXT[kind]!, BINS[kind]!));
  expect(await answer(hosted, 'conversation-2', '@version')).toBe(`${cli} ${NEXT[kind]}`);
  expect(await answer(hosted, 'conversation-1', '@version')).toBe(`${cli} ${RELEASES[kind]}`);
  expect(alive(hosted.kit.pid)).toBe(true);
  expect(hosted.house.requests.filter((request) => request.path === '/kit/kits/report-restart')).toHaveLength(1);
});

it("runs each chosen CLI's own update command once when Kit starts, through the CLI its login shell finds, before it first reports idle", async () => {
  const hosted = await hostKit(KINDS.map((kind) => ({ kind })));

  await until(() => hosted.idles[0]);
  await settle();

  const ran = KINDS.flatMap((kind) => {
    const path = join(userBin(hosted.home), BINS[kind]!);
    return [{ kind, path }, { kind, path, ended: true }];
  });
  expect(updatesRun(hosted.home)).toHaveLength(ran.length);
  expect(updatesRun(hosted.home)).toEqual(expect.arrayContaining(ran));
});

it("runs no CLI's update command when the Kit goes idle after a turn, however long after its start", async () => {
  const clock = await clocked();
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }], clock.hosting);
  const path = join(userBin(hosted.home), 'claude');
  const run = [{ kind: 'claude-agent-acp', path }, { kind: 'claude-agent-acp', path, ended: true }];
  expect(updatesRun(hosted.home)).toEqual(run);
  await open(hosted, 'conversation-1');

  await clock.shift(25 * HOUR);
  const later = hosted.idles.length;
  await answer(hosted, 'conversation-1', '@say later');
  await idled(hosted, later);

  expect(updatesRun(hosted.home)).toEqual(run);
});

it("runs a CLI's update command at Kit start beside a conversation, and no message waits for one", async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }], {
    untilIdle: false,
    prepare: (home) => writeFile(join(home, 'update-hold'), ''),
  });
  const held = await until(() => updatesRun(hosted.home).findLast((update) => update.held));
  await open(hosted, 'conversation-1');

  expect(await answer(hosted, 'conversation-1', '@say answered')).toBe('answered');
  expect(updatesRun(hosted.home).at(-1)).toEqual(held);

  await rm(join(hosted.home, 'update-hold'));
  await until(() => updatesRun(hosted.home).at(-1)?.ended);
  expect(updatesRun(hosted.home).every((update) => update.kind === 'claude-agent-acp' && update.path === join(userBin(hosted.home), 'claude'))).toBe(true);
});

it("reads a CLI whose link is repointed to another version, and reports that version with the models it offers", async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }], {
    prepare: async (home) => {
      linkUserCli(home, userBin(home), 'grok-build');
      await signIn(home, 'grok-build');
    },
  });
  await report(hosted, (agents) => agents.some((agent) => agent.signed_in === true));
  await mkdir(join(hosted.home, 'models'));
  await writeFile(join(hosted.home, 'models', 'grok-build'), JSON.stringify([{ id: 'grok-5', name: 'Grok 5', efforts: ['high'] }]));

  linkUserCli(hosted.home, userBin(hosted.home), 'grok-build', NEXT['grok-build']);

  await reportOf(hosted, [
    {
      kind: 'grok-build',
      release: NEXT['grok-build'],
      failure: null,
      signed_in: true,
      models: [{ model: 'grok-5', name: 'Grok 5', efforts: ['high'] }],
      modes: [],
      full_access: null,
      default_model: 'grok-5',
      default_effort: 'medium',
    },
  ]);
});

it('reads the sign-in and models of a CLI whose link is repointed while a conversation opening on it looks the CLI up', async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }], {
    prepare: async (home) => {
      linkUserCli(home, userBin(home), 'grok-build');
      await signIn(home, 'grok-build');
    },
  });
  await report(hosted, (agents) => agents.some((agent) => agent.signed_in === true));
  await idled(hosted, 0);
  const looking = join(hosted.home, 'profile-looking');
  const gate = join(hosted.home, 'profile-gate');
  const profile = join(accountOf(hosted.home), '.profile');
  // The login profile looks for its gate every twentieth of a second, so the conversation's lookup of its CLI waits only as long as the spec holds it.
  await writeFile(profile, `${await readFile(profile, 'utf8')}: > "${looking}"\nwhile [ ! -e "${gate}" ]; do sleep 0.05; done\n`);
  await mkdir(join(hosted.home, 'models'));
  await writeFile(join(hosted.home, 'models', 'grok-build'), JSON.stringify([{ id: 'grok-5', name: 'Grok 5', efforts: ['high'] }]));
  hosted.call({ kind: 'open', conversation_id: 'conversation-1', agent_id: 'agent-1' });
  const opening = lastCall();
  await until(() => existsSync(looking));

  linkUserCli(hosted.home, userBin(hosted.home), 'grok-build', NEXT['grok-build']);
  await settle();
  await writeFile(gate, '');

  expect(await hosted.result(opening)).toEqual({ provider_session_id: expect.any(String) });
  await report(hosted, (agents) => agents.some((agent) => agent.release === NEXT['grok-build'] && (agent.models as { model: string }[])[0]?.model === 'grok-5'));
  expect(await probes(hosted)).toBe(2);
});

it.each([
  ['its file is replaced at the same version', async (hosted: Hosted) => {
    placeUserCli(userBin(hosted.home), 'grok-build');
  }],
  ['another file in its folder changes', (hosted: Hosted) => writeFile(join(userBin(hosted.home), 'other-tool'), '')],
])("reads only a CLI's version when %s, as the one models read once its link is repointed shows, and sends no second idle report", async (_case, change) => {
  const hosted = await hostKit([{ kind: 'grok-build' }], { prepare: (home) => signIn(home, 'grok-build') });
  await report(hosted, (agents) => agents.some((agent) => agent.signed_in === true));
  await until(() => hosted.idles[0]);
  await settle();
  const reads = await versionReads(hosted);
  const probed = await probes(hosted);
  const idles = hosted.idles.length;

  await change(hosted);
  await until(async () => (await versionReads(hosted)) > reads);
  await settle();
  linkUserCli(hosted.home, userBin(hosted.home), 'grok-build', NEXT['grok-build']);
  await report(hosted, (agents) => agents.some((agent) => agent.release === NEXT['grok-build']));
  await settle();

  expect(await probes(hosted)).toBe(probed + 1);
  expect(hosted.idles).toHaveLength(idles);
});

it("reads a CLI whose --version named no version again once a reinstall changes its folder, and reports its version with its models", async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }], {
    prepare: async (home) => {
      await writeFile(join(userBin(home), BINS['grok-build']!), '#!/bin/sh\necho unreadable\n');
      await signIn(home, 'grok-build');
    },
  });
  const cli = join(userBin(hosted.home), BINS['grok-build']!);
  await report(hosted, (agents) => agents.some((agent) => agent.failure === `${cli} --version names no version`));

  placeUserCli(userBin(hosted.home), 'grok-build');

  await report(hosted, (agents) => agents.some((agent) => agent.release === RELEASES['grok-build'] && agent.failure === null && agent.signed_in === true));
});

it("reads no CLI's version or models while its link's folder stays unchanged and no conversation opens, however long the Kit waits", async () => {
  const clock = await clocked();
  const hosted = await hostKit([{ kind: 'grok-build' }], { ...clock.hosting, prepare: (home) => signIn(home, 'grok-build') });
  await report(hosted, (agents) => agents.some((agent) => agent.signed_in === true));
  await settle();
  const reads = await versionReads(hosted);
  const probed = await probes(hosted);

  await clock.shift(6 * HOUR);
  // Two seconds of a Kit six hours past its start show no timer reads the CLI.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  expect(await versionReads(hosted)).toBe(reads);
  expect(await probes(hosted)).toBe(probed);
});

it("ends a CLI's update command still running at its deadline, with every process it started, and reports idle with the CLI as it was", async () => {
  const hosted = await hostKit([{ kind: 'claude-agent-acp' }], {
    environment: { NODE_OPTIONS: `--import=${FAST_DEADLINES}` },
    prepare: (home) => writeFile(join(home, 'update-hold'), ''),
  });

  const held = updatesRun(hosted.home).find((update) => update.held)!;
  expect(updatesRun(hosted.home).some((update) => update.ended)).toBe(false);
  expect(alive(held.pid!)).toBe(false);
  expect(hosted.kit.stderr()).toContain('kit: claude-agent-acp did not update: the update did not end within 900 seconds');
  expect(hosted.reports.at(-1)!.agents).toEqual([expect.objectContaining({ kind: 'claude-agent-acp', release: RELEASES['claude-agent-acp'], failure: null })]);
});

it('runs a CLI the login shell finds through a relative PATH entry from any working directory', async () => {
  const hosted = await hostKit([{ kind: 'grok-build' }], {
    prepare: (home) => writeFile(join(accountOf(home), '.profile'), `PATH="${relative(process.cwd(), userBin(home))}:$PATH"\n`),
  });

  expect(await open(hosted, 'conversation-1')).toEqual({ provider_session_id: expect.any(String) });
  expect(hosted.workingDirectory).not.toBe(process.cwd());
});

it.each([
  [
    'a relative entry from a linked directory it ends its profile in',
    async (home: string) => {
      await mkdir(join(home, 'physical', 'work'), { recursive: true });
      await symlink(join(home, 'physical', 'work'), join(home, 'link'));
      placeUserCli(join(home, 'elsewhere'), 'grok-build', '1.0.49');
      placeUserCli(join(home, 'physical', 'elsewhere'), 'grok-build', '1.0.50');
      await writeFile(join(accountOf(home), '.profile'), `cd "${join(home, 'link')}"\nPATH="../elsewhere"\n`);
    },
  ],
  [
    'an empty entry in the directory it ends its profile in',
    async (home: string) => {
      placeUserCli(join(home, 'there'), 'grok-build', '1.0.50');
      await writeFile(join(accountOf(home), '.profile'), `cd "${join(home, 'there')}"\nPATH=":$PATH"\n`);
    },
  ],
])('runs the CLI the login shell runs through %s', async (_case, prepare) => {
  const hosted = await hostKit([{ kind: 'grok-build' }], {
    prepare: async (home) => {
      await rm(join(userBin(home), 'grok'));
      await prepare(home);
    },
  });

  expect(await open(hosted, 'conversation-1')).toEqual({ provider_session_id: expect.any(String) });
  expect((await initialized(hosted)).find((entry) => (entry.env as Record<string, string>).HOUSE_BRIDGE !== undefined)!.cli).toMatchObject({ release: '1.0.50' });
});

it.each([
  ['its CLI session does not open', 'refuse-new', 'the session did not open'],
  ['its CLI does not initialize', 'refuse-initialize', 'the CLI did not initialize'],
])('keeps the sign-in and models the Kit last read for a CLI it reads again while %s', async (_, refusal, cause) => {
  const hosted = await hostKit([{ kind: 'grok-build' }], { prepare: (home) => signIn(home, 'grok-build') });
  const [known] = await report(hosted, (agents) => agents.some((agent) => agent.signed_in === true));
  await writeFile(join(hosted.home, refusal), '');

  placeUserCli(userBin(hosted.home), 'grok-build', '1.0.48');

  await until(() => hosted.kit.stderr().includes(`grok-build did not offer its models: ${cause}`));
  await settle();
  expect(reported(hosted).at(-1)!.agents).toEqual([{ ...known, release: '1.0.48' }]);
});

it.each(KINDS)('reports %s signed out when its sign-in check passes but its adapter refuses a session as not signed in', async (kind) => {
  const hosted = await hostKit([{ kind }], {
    prepare: async (home) => {
      await signIn(home, kind);
      await writeFile(join(home, 'signed-out'), '');
    },
  });

  await until(() => hosted.kit.stderr().includes(`${kind} did not offer its models: Authentication required`));
  await settle();
  expect(reported(hosted).at(-1)!.agents).toEqual([expect.objectContaining({ kind, signed_in: false })]);
});

it('ends the CLI an adapter started when the Kit reads that CLI and the adapter does not initialize', async () => {
  const hosted = await hostKit([{ kind: 'codex-acp' }], {
    prepare: async (home) => {
      await signIn(home, 'codex-acp');
      await writeFile(join(home, 'refuse-initialize'), '');
      await writeFile(join(home, 'hung-app-server'), '');
    },
  });

  await until(() => hosted.kit.stderr().includes('codex-acp did not offer its models: the CLI did not initialize'));

  const started = (await hosted.adapterLog()).filter((entry) => entry.appServer !== undefined);
  expect(started).toHaveLength(1);
  await until(() => !alive(started[0]!.appServer as number));
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

  placeUserCli(userBin(hosted.home), 'claude-agent-acp', '2.1.318');

  await reportOf(hosted, [
    {
      kind: 'claude-agent-acp',
      release: '2.1.318',
      failure: null,
      signed_in: true,
      models: [{ model: 'sonnet', name: 'Sonnet', efforts: ['low', 'medium', 'high', 'max'] }],
      modes: [
        { mode: 'default', name: 'Manual' },
        { mode: 'acceptEdits', name: 'Accept edits' },
        { mode: 'plan', name: 'Plan' },
        { mode: 'auto', name: 'Auto' },
        { mode: 'bypassPermissions', name: 'Bypass permissions' },
      ],
      full_access: 'bypassPermissions',
      default_effort: 'medium',
    },
  ]);
  await until(() => hosted.kit.stderr().includes('claude-agent-acp refused its model sonnet'));
});
