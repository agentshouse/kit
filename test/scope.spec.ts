import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { linkUserCli } from './cli.ts';
import { settle, until } from './double.ts';
import { hostKit, lastCall, macOS, userBin, type Hosted, type Hosting, type RouteOverrides } from './environment.ts';
import { alive, stop, temporaryDirectory, temporaryHome } from './kit.ts';

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path === '/kit/turns/end');

async function spawned(hosted: Hosted): Promise<{ spawned: number; clean: number }> {
  return (await until(async () => (await hosted.adapterLog()).find((entry) => entry.spawned))) as unknown as {
    spawned: number;
    clean: number;
  };
}

async function serving(prepare: (home: string) => void = () => undefined): Promise<Hosted> {
  const hosted = await hostKit([{}], {
    prepare: async (home) => {
      prepare(home);
      await writeFile(join(home, 'start-server'), '');
    },
  });
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  await until(() => hosted.idles[1]);
  return hosted;
}

it('stays busy while a process the conversation started runs, double-forked into a new session included, while the CLI and the servers it starts do not', async () => {
  const hosted = await serving();
  const servers = (await hosted.adapterLog()).filter((entry) => entry.server !== undefined);
  expect(servers.map((entry) => alive(entry.server as number))).toEqual([true]);

  hosted.call({ kind: 'message', text: '@spawn\n@say started', first: true });
  await until(() => ended(hosted)[0]);
  const job = await spawned(hosted);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  stop(job.clean);
  stop(job.spawned);

  await until(() => hosted.idles[2]);
});

it("stays busy while a process started after the session started runs, while a helper the CLI ships beside the file its link names does not", async () => {
  const hosted = await serving((home) => {
    linkUserCli(home, userBin(home), 'codex-acp');
  });
  hosted.call({ kind: 'message', text: '@host\n@say hosted', first: true });
  await until(() => ended(hosted)[0]);
  await until(() => hosted.idles[2]);
  const host = (await hosted.adapterLog()).find((entry) => entry.host !== undefined)!.host as number;
  expect(alive(host)).toBe(true);

  hosted.call({ kind: 'message', text: '@server\n@say started', first: false });
  await until(() => ended(hosted)[1]);
  const later = (await hosted.adapterLog()).filter((entry) => entry.server !== undefined).at(-1)!.server as number;
  await settle();
  expect(hosted.idles).toHaveLength(3);

  stop(later);

  await until(() => hosted.idles[3]);
});

it('stays busy while a process a server started after the session started runs', async () => {
  const hosted = await serving();
  hosted.call({ kind: 'message', text: '@serve\n@say served', first: true });
  await until(() => ended(hosted)[0]);
  const child = (await until(async () => (await hosted.adapterLog()).find((entry) => entry.served))).served as number;
  await settle();
  expect(hosted.idles).toHaveLength(2);

  stop(child);

  await until(() => hosted.idles[2]);
});

it('stays busy while the processes of a conversation cannot be read', async () => {
  const switches = await mkdtemp(join(tmpdir(), 'kit-unreadable-'));
  onTestFinished(() => rm(switches, { recursive: true, force: true }));
  const unreadable = join(switches, 'unreadable');
  const hosted = await hostKit([{}], {
    environment: { KIT_UNREADABLE: unreadable, NODE_OPTIONS: `--import=${fileURLToPath(new URL('./unreadable.ts', import.meta.url))}` },
  });
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  await until(() => hosted.idles[1]);

  await writeFile(unreadable, '');
  hosted.call({ kind: 'message', text: '@say read', first: true });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  await rm(unreadable);

  await until(() => hosted.idles[2]);
});

it('stays busy while a process its crashed Conversation process left behind runs', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  hosted.call({ kind: 'message', text: '@spawn\n@exit 1', first: true });
  const job = await spawned(hosted);
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(1);

  stop(job.clean);
  stop(job.spawned);

  await until(() => hosted.idles[1]);
});

it('reports idle once the process its crashed Conversation process left behind ends, while a helper the CLI ships outlives it', async () => {
  const hosted = await serving((home) => {
    linkUserCli(home, userBin(home), 'codex-acp');
  });
  hosted.call({ kind: 'message', text: '@host\n@spawn\n@say started', first: true });
  await until(() => ended(hosted)[0]);
  const job = await spawned(hosted);
  const host = (await until(async () => (await hosted.adapterLog()).find((entry) => entry.host !== undefined))).host as number;
  hosted.call({ kind: 'message', text: '@exit 1', first: false });
  await until(() => ended(hosted)[1]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  stop(job.clean);
  stop(job.spawned);

  await until(() => hosted.idles[2]);
  expect(alive(host)).toBe(true);
});

it('kill stops what a crashed Conversation process left behind', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  hosted.call({ kind: 'message', text: '@spawn\n@exit 1', first: true });
  const job = await spawned(hosted);
  await until(() => ended(hosted)[0]);

  hosted.call({ kind: 'kill' });
  await hosted.result(lastCall());

  await until(() => !alive(job.spawned) && !alive(job.clean));
  await until(() => hosted.idles[1]);
});

const CONTROL_GROUP = process.env.KIT_TEST_CGROUP === '1';

const COUNTED = ['./fast-intervals.ts', './process-reads.ts'].flatMap((module) => ['--import', fileURLToPath(new URL(module, import.meta.url))]);

// A second and a half lets any look the Kit kept, capped at 300 ms under fast-intervals, run several times.
const LOOKS_MS = 1_500;

interface Counted {
  hosted: Hosted;
  reads: (kind?: 'table' | 'process') => Promise<number>;
}

async function counted(routes: RouteOverrides[] = [{}], hosting: Hosting = {}): Promise<Counted> {
  const log = join(await temporaryDirectory(), 'process-reads');
  const hosted = await hostKit(routes, {
    ...hosting,
    environment: { ...hosting.environment, KIT_PROCESS_READS: log },
    node: COUNTED,
  });
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  await until(() => hosted.idles[1]);
  return {
    hosted,
    reads: async (kind) => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '' && (kind === undefined || line === kind)).length,
  };
}

async function onMac(): Promise<Hosting> {
  const home = await temporaryHome();
  return { home, skills: [], environment: await macOS(home) };
}

it.runIf(CONTROL_GROUP).each([
  ['a turn left beyond the running CLI', '@spawn\n@say started'],
  ['its crashed Conversation process left behind', '@spawn\n@exit 1'],
])('reports idle once the last process %s ends, told by its control group, reading no process table', async (_, text) => {
  const { hosted, reads } = await counted();
  hosted.call({ kind: 'message', text, first: true });
  await until(() => ended(hosted)[0]);
  const job = await spawned(hosted);
  await settle();
  const running = await reads();
  await new Promise((resolve) => setTimeout(resolve, LOOKS_MS));
  expect(await reads()).toBe(running);
  expect(hosted.idles).toHaveLength(2);
  const tables = await reads('table');

  stop(job.clean);
  stop(job.spawned);

  await until(() => hosted.idles[2]);
  expect(await reads('table')).toBe(tables);
});

for (const [platform, hosting] of [
  ['Linux', async (): Promise<Hosting> => ({})],
  ['a Mac', onMac],
] as const) {
  it.skipIf(CONTROL_GROUP)(`looks at the processes on ${platform} with no control group only while a process a turn left runs, and reports idle once it ends`, async () => {
    const { hosted, reads } = await counted([{}], await hosting());
    hosted.call({ kind: 'message', text: '@spawn\n@say started', first: true });
    await until(() => ended(hosted)[0]);
    const job = await spawned(hosted);
    const started = await reads('table');
    await until(async () => (await reads('table')) > started);
    expect(hosted.idles).toHaveLength(2);

    stop(job.clean);
    stop(job.spawned);

    await until(() => hosted.idles[2]);
    const idle = await reads();
    await new Promise((resolve) => setTimeout(resolve, LOOKS_MS));
    expect(await reads()).toBe(idle);
  });
}

it('reads no process table between turns with no background work, and a durable schedule written after a turn keeps it busy until it goes', async () => {
  const { hosted, reads } = await counted([{ kind: 'claude-agent-acp' }]);
  hosted.call({ kind: 'message', text: '@say done', first: true });
  await until(() => ended(hosted)[0]);
  await until(() => hosted.idles[2]);
  const idle = await reads();
  await new Promise((resolve) => setTimeout(resolve, LOOKS_MS));
  expect(await reads()).toBe(idle);

  await mkdir(join(hosted.workingDirectory, '.claude'));
  const tasks = join(hosted.workingDirectory, '.claude', 'scheduled_tasks.json');
  await writeFile(tasks, JSON.stringify({ tasks: [{ id: '7b99af94', cron: '0 3 1 1 *', prompt: 'say hi', createdAt: 1791648534000, recurring: true }] }));
  await settle();
  await rm(tasks);

  await until(() => hosted.idles[3]);
});
