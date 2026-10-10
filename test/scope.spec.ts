import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { settle, until } from './double.ts';
import { hostKit, lastInput, type Hosted } from './environment.ts';
import { alive, stop } from './kit.ts';

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/ended'));

async function spawned(hosted: Hosted): Promise<{ spawned: number; clean: number }> {
  return (await until(async () => (await hosted.adapterLog()).find((entry) => entry.spawned))) as unknown as {
    spawned: number;
    clean: number;
  };
}

async function serving(): Promise<Hosted> {
  const hosted = await hostKit([{}], { prepare: (home) => writeFile(join(home, 'start-server'), '') });
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  await until(() => hosted.idles[1]);
  return hosted;
}

it('stays busy while a process the conversation started runs, double-forked into a new session included, while the CLI and the servers it starts do not', async () => {
  const hosted = await serving();
  const servers = (await hosted.adapterLog()).filter((entry) => entry.server !== undefined);
  expect(servers.map((entry) => alive(entry.server as number))).toEqual([true]);

  hosted.input({ kind: 'message', text: '@spawn\n@say started', files: [], first: true });
  await until(() => ended(hosted)[0]);
  const job = await spawned(hosted);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  stop(job.clean);
  stop(job.spawned);

  await until(() => hosted.idles[2]);
});

it("stays busy while a process started after the session started runs, while a helper the CLI ships beside its executable does not", async () => {
  const hosted = await serving();
  hosted.input({ kind: 'message', text: '@host\n@say hosted', files: [], first: true });
  await until(() => ended(hosted)[0]);
  await until(() => hosted.idles[2]);
  const host = (await hosted.adapterLog()).find((entry) => entry.host !== undefined)!.host as number;
  expect(alive(host)).toBe(true);

  hosted.input({ kind: 'message', text: '@server\n@say started', files: [], first: false });
  await until(() => ended(hosted)[1]);
  const later = (await hosted.adapterLog()).filter((entry) => entry.server !== undefined).at(-1)!.server as number;
  await settle();
  expect(hosted.idles).toHaveLength(3);

  stop(later);

  await until(() => hosted.idles[3]);
});

it('stays busy while a process a server started after the session started runs', async () => {
  const hosted = await serving();
  hosted.input({ kind: 'message', text: '@serve\n@say served', files: [], first: true });
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
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  await until(() => hosted.idles[1]);

  await writeFile(unreadable, '');
  hosted.input({ kind: 'message', text: '@say read', files: [], first: true });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  await rm(unreadable);

  await until(() => hosted.idles[2]);
});

it('stays busy while a process its crashed Conversation process left behind runs', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  hosted.input({ kind: 'message', text: '@spawn\n@exit 1', files: [], first: true });
  const job = await spawned(hosted);
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(1);

  stop(job.clean);
  stop(job.spawned);

  await until(() => hosted.idles[1]);
});

it('kill stops what a crashed Conversation process left behind', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  hosted.input({ kind: 'message', text: '@spawn\n@exit 1', files: [], first: true });
  const job = await spawned(hosted);
  await until(() => ended(hosted)[0]);

  hosted.input({ kind: 'kill' });
  await hosted.ack(lastInput());

  await until(() => !alive(job.spawned) && !alive(job.clean));
  await until(() => hosted.idles[1]);
});
