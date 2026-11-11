import type { HouseOneWayCall, KitCall } from '@agentshouse/kit-wire';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { settle, until } from './double.ts';
import { hostKit, lastCall, type Hosted } from './environment.ts';
import { alive, filesUnder } from './kit.ts';

const TREE = 'sleep 300 & echo "child $!"; echo "script $$"; wait';

function send(hosted: Hosted, frame: HouseOneWayCall | KitCall): void {
  hosted.house.connections.at(-1)!.send(frame);
}

function called(hosted: Hosted, script: string): string {
  hosted.call({ kind: 'run_wizard', conversation_id: null, agent_id: null, script });
  return lastCall();
}

function run(hosted: Hosted, script: string): string {
  const wizard = called(hosted, script);
  send(hosted, { type: 'wizard_size', wizard, cols: 80, rows: 24 });
  return wizard;
}

function output(hosted: Hosted, wizard: string): string {
  return hosted.house.connections
    .flatMap((connection) => connection.oneWayCalls)
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

it('starts the script only once the page sends its first size, at that size, and applies each later size', async () => {
  const hosted = await hostKit([]);
  const wizard = called(hosted, 'echo started; stty size; read -p "ready " line; stty size');
  await settle();
  expect(output(hosted, wizard)).toBe('');

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

it('keeps the script through a dropped connection and, once House takes the run on again with its size on the next connection, sends what it wrote meanwhile there and types what House sends', async () => {
  const hosted = await hostKit([]);
  const wizard = run(hosted, 'read -r -p "First: " first; sleep 0.5; echo "printed while away"; read -r -p "Second: " second; echo "got $first and $second"; exit 4');
  await shown(hosted, wizard, 'First: ');
  send(hosted, { type: 'wizard_input', wizard, data: 'one\r' });
  await shown(hosted, wizard, 'one');

  hosted.connection.transport.terminate();
  const again = await until(() => hosted.house.connections[1]);
  again.send({ type: 'wizard_size', wizard, cols: 80, rows: 24 });
  await shown(hosted, wizard, 'Second: ');
  again.send({ type: 'wizard_input', wizard, data: 'two\r' });

  expect(await hosted.result(wizard)).toEqual({ exit_code: 4 });
  const sentAgain = again.oneWayCalls
    .filter((frame) => frame.type === 'wizard_output' && frame.wizard === wizard)
    .map((frame) => frame.data as string)
    .join('');
  expect(sentAgain).toContain('printed while away');
  expect(sentAgain).toContain('got one and two');
});

it("ends the script's whole process group and reports the run lost when House sends nothing for it once the Kit connects again", async () => {
  const hosted = await hostKit([]);
  const wizard = run(hosted, TREE);
  const pids = await tree(hosted, wizard);

  hosted.connection.transport.terminate();
  await until(() => hosted.house.connections[1]);

  expect(await hosted.result(wizard)).toEqual({ refused: 'the Kit lost its connection to House' });
  await until(() => !pids.some(alive));
});

it("reports a script that cannot start with the Kit's reason", async () => {
  const hosted = await hostKit([], {
    prepare: (home) => writeFile(join(home, '.profile'), 'PATH="$HOME/bin"\n'),
  });
  const wizard = called(hosted, 'echo never');

  const reason = "the script could not start: bash is not on the login shell's PATH";
  expect(await hosted.result(wizard)).toEqual({ refused: reason });
  expect(output(hosted, wizard)).toBe('');
  expect(hosted.kit.stderr()).toContain("a Web Wizard could not start: bash is not on the login shell's PATH");
});
