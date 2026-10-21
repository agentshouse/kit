import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastCall, type Hosted } from './environment.ts';
import { alive, filesUnder } from './kit.ts';

const TREE = 'sleep 300 & echo "child $!"; echo "script $$"; wait';

function run(hosted: Hosted, script: string): string {
  hosted.call({ kind: 'run_wizard', conversation_id: null, agent_id: null, script });
  return lastCall();
}

function send(hosted: Hosted, frame: Record<string, unknown>): void {
  hosted.house.connections.at(-1)!.send(frame);
}

function output(hosted: Hosted, wizard: string): string {
  return hosted.house.connections
    .flatMap((connection) => connection.notifications)
    .filter((frame) => frame.type === 'wizard_output' && frame.wizard === wizard)
    .map((frame) => frame.data as string)
    .join('');
}

function shown(hosted: Hosted, wizard: string, text: string): Promise<string> {
  return until(() => {
    const seen = output(hosted, wizard);
    return seen.includes(text) ? seen : undefined;
  });
}

async function tree(hosted: Hosted, wizard: string): Promise<number[]> {
  const seen = await shown(hosted, wizard, 'script ');
  const pids = [/child (\d+)/.exec(seen), /script (\d+)/.exec(seen)].map((found) => Number(found![1]));
  expect(pids.every(alive)).toBe(true);
  return pids;
}

it('runs a script in a terminal in the Kit home and working directory, forwards its output, types the owner input into it and reports its exit code, keeping none of it', async () => {
  const hosted = await hostKit([]);
  const wizard = run(
    hosted,
    '[ -t 0 ] && [ -t 1 ] && echo "in a terminal"; echo "home=$HOME cwd=$(pwd)"; read -p "Account: " account; echo "signed in as $account"; exit 7',
  );

  await shown(hosted, wizard, 'Account: ');
  send(hosted, { type: 'wizard_input', wizard, data: 'owner-typed-4f1c\r' });

  expect(await hosted.result(wizard)).toEqual({ exit_code: 7 });
  const seen = output(hosted, wizard);
  expect(seen).toContain('in a terminal');
  expect(seen).toContain(`home=${hosted.home} cwd=${process.cwd()}`);
  expect(seen).toContain('signed in as owner-typed-4f1c');
  for (const kept of ['owner-typed-4f1c', 'signed in as', 'in a terminal']) {
    expect(hosted.kit.stdout() + hosted.kit.stderr()).not.toContain(kept);
    for (const file of await filesUnder(hosted.home)) expect(await readFile(file, 'utf8')).not.toContain(kept);
  }
});

it('opens the terminal at the size the page sent first and applies each later size', async () => {
  const hosted = await hostKit([]);
  const wizard = run(hosted, 'stty size; read -p "ready " line; stty size');
  send(hosted, { type: 'wizard_size', wizard, cols: 100, rows: 30 });

  await shown(hosted, wizard, 'ready ');
  send(hosted, { type: 'wizard_size', wizard, cols: 132, rows: 50 });
  send(hosted, { type: 'wizard_input', wizard, data: '\r' });

  expect(await hosted.result(wizard)).toEqual({ exit_code: 0 });
  expect(output(hosted, wizard)).toMatch(/30 100[\s\S]*50 132/);
});

it("ends the script's whole process group, its child included, when House cancels the run and reports the cancellation", async () => {
  const hosted = await hostKit([]);
  const wizard = run(hosted, TREE);
  const pids = await tree(hosted, wizard);

  send(hosted, { type: 'wizard_end', wizard });

  expect(await hosted.result(wizard)).toEqual({});
  await until(() => !pids.some(alive));
});

it("ends the script's whole process group when the Kit connection that started it drops and reports the run lost", async () => {
  const hosted = await hostKit([]);
  const wizard = run(hosted, TREE);
  const pids = await tree(hosted, wizard);

  hosted.connection.transport.terminate();

  expect(await hosted.result(wizard)).toEqual({ refused: 'the Kit lost its connection to House' });
  await until(() => !pids.some(alive));
});

it("reports a script that cannot start with the Kit's reason", async () => {
  const hosted = await hostKit([], {
    prepare: (home) => writeFile(join(home, '.profile'), 'PATH="$HOME/bin"\n'),
  });
  const wizard = run(hosted, 'echo never');

  const reason = "the script could not start: bash is not on the login shell's PATH";
  expect(await hosted.result(wizard)).toEqual({ refused: reason });
  expect(output(hosted, wizard)).toBe('');
  expect(hosted.kit.stderr()).toContain("a Web Wizard could not start: bash is not on the login shell's PATH");
});
