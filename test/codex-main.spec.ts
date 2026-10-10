import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
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
