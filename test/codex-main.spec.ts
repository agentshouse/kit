import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { placeUserCli } from './cli.ts';
import { until } from './double.ts';

const LAUNCHER = fileURLToPath(new URL('../src/codex-main.ts', import.meta.url));

it('passes on whole a character the CLI writes across two chunks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-main-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const first = `${JSON.stringify({ jsonrpc: '2.0', method: 'thread/started', params: {} })}\n`;
  const split = `${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'Привет' } })}\n`;
  const cli = join(home, 'codex');
  await writeFile(
    cli,
    [
      '#!/usr/bin/env node',
      `const bytes = Buffer.from(${JSON.stringify(first + split)});`,
      "const at = bytes.indexOf(Buffer.from('П')) + 1;",
      'process.stdout.write(bytes.subarray(0, at));',
      "process.stdin.once('data', () => process.stdout.write(bytes.subarray(at)));",
    ].join('\n'),
  );
  await chmod(cli, 0o755);

  const launcher = spawn(process.execPath, [LAUNCHER], { env: { ...process.env, HOUSE_KIT_CODEX: cli } });
  onTestFinished(() => void launcher.kill('SIGKILL'));
  let written = '';
  launcher.stdout.setEncoding('utf8').on('data', (chunk: string) => (written += chunk));
  await until(() => written === first);
  launcher.stdin.end('\n');
  await once(launcher, 'exit');

  expect(written).toBe(first + split);
});

interface Wrapped {
  send(message: Record<string, unknown>): void;
  answered(id: number): Promise<Record<string, any>>;
  heard(): Record<string, any>[];
}

async function wrapped(afk: boolean): Promise<Wrapped> {
  const home = await mkdtemp(join(tmpdir(), 'codex-main-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.agents', 'house'), { recursive: true });
  const cli = placeUserCli(join(home, 'bin'), 'codex-acp');
  const socket = join(home, 'stream.sock');
  const server = createServer(() => undefined).listen(socket);
  onTestFinished(() => void server.close());
  await once(server, 'listening');
  const launcher = spawn(process.execPath, [LAUNCHER, 'app-server'], {
    env: { ...process.env, HOME: home, HOUSE_KIT_CODEX: cli, HOUSE_KIT_CODEX_STREAM: socket, ...(afk ? { HOUSE_KIT_AFK: '1' } : {}) },
  });
  onTestFinished(() => void launcher.kill('SIGKILL'));
  const heard: Record<string, any>[] = [];
  createInterface({ input: launcher.stdout }).on('line', (line) => heard.push(JSON.parse(line) as Record<string, any>));
  return {
    send: (message) => launcher.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`),
    answered: (id) => until(() => heard.find((message) => message.id === id)),
    heard: () => heard,
  };
}

const SANDBOX = { type: 'workspaceWrite', writableRoots: [], networkAccess: false };

const settingsUpdated = (codex: Wrapped) =>
  codex.heard().flatMap((message) => (message.method === 'thread/settings/updated' ? [message.params.threadSettings as Record<string, unknown>] : []));

it.each([
  ['gives', 'an AFK', 'never', true],
  ['leaves', 'a', 'on-request', false],
])('%s each thread and turn of %s Codex conversation the approval policy %s, its sandbox untouched', async (_, __, approvalPolicy, afk) => {
  const codex = await wrapped(afk);

  for (const [id, method] of ['thread/start', 'thread/resume', 'thread/fork'].entries()) codex.send({ id, method, params: { threadId: 'thread-1', cwd: '/work' } });
  codex.send({ id: 3, method: 'turn/start', params: { threadId: 'thread-1', input: [], approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: SANDBOX } });

  for (const id of [0, 1, 2]) expect((await codex.answered(id)).result.approvalPolicy).toBe(approvalPolicy);
  await codex.answered(3);
  expect(settingsUpdated(codex)).toEqual([{ approvalPolicy, approvalsReviewer: 'user', sandboxPolicy: SANDBOX }]);
});

it('refuses a switch into Plan mode while a Codex conversation is AFK, answering it itself so it never reaches Codex, and passes a switch out of it', async () => {
  const codex = await wrapped(true);

  codex.send({ id: 1, method: 'thread/settings/update', params: { threadId: 'thread-1', collaborationMode: { mode: 'plan', settings: {} } } });
  codex.send({ id: 2, method: 'thread/settings/update', params: { threadId: 'thread-1', collaborationMode: { mode: 'default', settings: {} } } });

  expect(await codex.answered(1)).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'an AFK conversation cannot enter Plan mode, since it cannot ask' } });
  expect(await codex.answered(2)).toMatchObject({ result: {} });
  expect(settingsUpdated(codex)).toEqual([{ collaborationMode: { mode: 'default', settings: {} } }]);
});

it('passes a switch into Plan mode while a Codex conversation is not AFK', async () => {
  const codex = await wrapped(false);

  codex.send({ id: 1, method: 'thread/settings/update', params: { threadId: 'thread-1', collaborationMode: { mode: 'plan', settings: {} } } });

  expect(await codex.answered(1)).toMatchObject({ result: {} });
  expect(settingsUpdated(codex)).toEqual([{ collaborationMode: { mode: 'plan', settings: {} } }]);
});
