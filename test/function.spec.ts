import { FUNCTION_RUN_META_KEY, type HouseOneWayCall, type KitCall, type KitCallOf } from '@agentshouse/kit-wire';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { idOf, settle, until, without, type Received } from './double.ts';
import { hostKit, lastCall, type Hosted, type McpCall } from './environment.ts';
import { accountOf, alive, filesUnder, stop } from './kit.ts';
import { serveRooms } from './rooms.ts';

interface Ran {
  exit_code?: number;
  timed_out?: true;
  output: string;
  cut: boolean;
}

const TREE = 'sleep 300 & echo "child $!"; echo "script $$"; wait';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION = 'agents.house/agent-operation';

function send(hosted: Hosted, frame: HouseOneWayCall | KitCall): void {
  hosted.house.connections.at(-1)!.send(frame);
}

type FunctionCall = Omit<KitCallOf<'run_function'>, 'type' | 'input_id' | 'provider_session_id'>;

function call(script: string, fields: Partial<FunctionCall> = {}): FunctionCall {
  return {
    kind: 'run_function',
    conversation_id: null,
    agent_id: null,
    script,
    input: null,
    terminal: false,
    time_cap: 60,
    output_cap: 65_536,
    ...fields,
  };
}

function run(hosted: Hosted, script: string, fields: Partial<FunctionCall> = {}): string {
  hosted.call(call(script, fields));
  return lastCall();
}

async function ended(hosted: Hosted, id: string): Promise<Ran> {
  return (await hosted.result(id)) as Ran;
}

function frames(hosted: Hosted, id: string): string {
  return hosted.house.connections
    .flatMap((connection) => connection.oneWayCalls)
    .filter((frame) => frame.type === 'wizard_output' && frame.wizard === id)
    .map((frame) => frame.data as string)
    .join('');
}

function shown(hosted: Hosted, id: string, text: string): Promise<string> {
  return until(() => {
    const seen = frames(hosted, id);
    return seen.includes(text) ? seen : undefined;
  });
}

function pidsIn(text: string): number[] {
  return [/child (\d+)/.exec(text), /script (\d+)/.exec(text)].map((found) => Number(found![1]));
}

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kit-function-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const metaOf = (received: Received) => (received.body as McpCall).params._meta;

function searched(hosted: Hosted): string[][] {
  return hosted.mcp
    .filter((received) => (received.body as McpCall).params.name === 'search')
    .map((received) => [String((received.body as McpCall).params.arguments!.query), received.headers.authorization!]);
}

async function keepsNothing(hosted: Hosted, texts: string[]): Promise<void> {
  const files = await filesUnder(hosted.home);
  for (const text of texts) {
    expect(hosted.kit.stdout() + hosted.kit.stderr()).not.toContain(text);
    for (const file of files) expect(await readFile(file, 'utf8')).not.toContain(text);
  }
}

it('runs a script with no terminal and empty standard input, which finds its JSON input in the file HOUSE_INPUT names, and reports its exit code with what it printed to both streams', async () => {
  const hosted = await hostKit([]);
  const id = run(
    hosted,
    '[ -t 0 ] || [ -t 1 ] || echo "no terminal"; echo "home=$HOME cwd=$(pwd)"; cat "$HOUSE_INPUT"; echo; echo "to error" >&2; if read line; then echo "read $line"; else echo "standard input empty"; fi; exit 3',
    { input: { marker: 'input-7d2e', list: [1, 2] } },
  );

  const result = await ended(hosted, id);

  expect(result).toEqual({ exit_code: 3, output: expect.any(String), cut: false });
  expect(result.output.split('\n').sort()).toEqual(
    ['no terminal', `home=${accountOf(hosted.home)} cwd=${process.cwd()}`, '{"marker":"input-7d2e","list":[1,2]}', 'to error', 'standard input empty', ''].sort(),
  );
  expect(frames(hosted, id)).toBe('');
  await keepsNothing(hosted, ['input-7d2e', 'to error', 'standard input empty']);
});

it('writes the input to a file only the Kit user reads, which no process argument carries and which is gone once the run ends', async () => {
  const hosted = await hostKit([]);
  const id = run(
    hosted,
    'echo "file $HOUSE_INPUT"; stat -c "mode %a owner %u" "$HOUSE_INPUT"; for listed in /proc/[0-9]*/cmdline; do echo "argv $(tr "\\0" " " < "$listed")"; done 2>/dev/null',
    { input: 'input-5b8e' },
  );

  const { output } = await ended(hosted, id);

  expect(output).toContain(`mode 600 owner ${process.getuid!()}`);
  expect(output).toMatch(/argv .*bash -c/);
  expect(output.split('\n').filter((line) => line.includes('input-5b8e'))).toEqual([]);
  expect(existsSync(/file (.+)/.exec(output)![1]!)).toBe(false);
});

it('runs a script with a terminal at once at the default size, sends its output in terminal frames under its run id, types an input frame into its read and applies a size frame', async () => {
  const hosted = await hostKit([]);
  const id = run(
    hosted,
    '[ -t 0 ] && [ -t 1 ] && echo "in a terminal"; stty size; read -p "Name: " name; stty size; echo "hello $name"; exit 4',
    { terminal: true },
  );

  await shown(hosted, id, 'Name: ');
  send(hosted, { type: 'wizard_size', wizard: id, cols: 132, rows: 50 });
  send(hosted, { type: 'wizard_input', wizard: id, data: 'typed-9a1b\r' });

  expect(await ended(hosted, id)).toEqual({ exit_code: 4, output: 'in a terminal\r\n24 80\r\n50 132\r\n', cut: false });
  expect(frames(hosted, id)).toMatch(/in a terminal\r\n24 80\r\nName: typed-9a1b\r\n50 132\r\nhello typed-9a1b\r\n/);
});

it('strikes from the kept output every line holding a line the owner typed, as the terminal echoed it or the script printed it again, and keeps the rest', async () => {
  const hosted = await hostKit([]);
  const id = run(
    hosted,
    'read -p "Account: " account; read -s -p "Password: " password; echo; echo "kept before"; echo "signed in as $account with $password!"; echo "$password"; echo "kept after"; echo "output-6e0f"',
    { terminal: true },
  );

  await shown(hosted, id, 'Account: ');
  for (const key of 'account-2f7a\r') send(hosted, { type: 'wizard_input', wizard: id, data: key });
  await shown(hosted, id, 'Password: ');
  send(hosted, { type: 'wizard_input', wizard: id, data: 'secret-8c3d\r' });

  expect(await ended(hosted, id)).toEqual({
    exit_code: 0,
    output: 'Password: \r\nkept before\r\nkept after\r\noutput-6e0f\r\n',
    cut: false,
  });
  expect(frames(hosted, id)).toContain('signed in as account-2f7a with secret-8c3d!');
  await keepsNothing(hosted, ['account-2f7a', 'secret-8c3d', 'output-6e0f', 'kept before']);
});

it('keeps the last part of output longer than its cap, from the first whole line in it, and marks it cut', async () => {
  const hosted = await hostKit([]);
  const id = run(hosted, 'for line in $(seq 1 100); do echo "line $line"; done', { output_cap: 30 });

  expect(await ended(hosted, id)).toEqual({ exit_code: 0, output: 'line 98\nline 99\nline 100\n', cut: true });
});

it('strikes typed lines before it cuts to the cap, so what survives striking is kept whole and uncut', async () => {
  const hosted = await hostKit([]);
  const id = run(hosted, 'read -s -p "Code: " code; echo keep-a; for line in $(seq 1 40); do echo "has $code $line"; done', {
    terminal: true,
    output_cap: 30,
  });

  await shown(hosted, id, 'Code: ');
  send(hosted, { type: 'wizard_input', wizard: id, data: 'zz-41\r' });

  expect(await ended(hosted, id)).toEqual({ exit_code: 0, output: 'Code: keep-a\r\n', cut: false });
});

it('drops whole a line longer than its cap that arrives in parts, keeping no fragment of it', async () => {
  const hosted = await hostKit([]);
  const id = run(hosted, "printf '%080d' 0; read -s go; echo tail-of-long; echo last", { terminal: true, output_cap: 30 });

  await shown(hosted, id, '0'.repeat(80));
  send(hosted, { type: 'wizard_input', wizard: id, data: '+\r' });

  expect(await ended(hosted, id)).toEqual({ exit_code: 0, output: 'last\r\n', cut: true });
});

it("ends the script's whole process group, its child included, at its time cap and reports the time cap with what it printed", async () => {
  const hosted = await hostKit([]);
  const id = run(hosted, TREE, { time_cap: 1 });

  const result = await ended(hosted, id);

  expect(result).toEqual({ timed_out: true, output: expect.stringMatching(/^child \d+\nscript \d+\n$/), cut: false });
  await until(() => !pidsIn(result.output).some(alive));
});

it('ends a run at its time cap though a process outside its group still holds its output', async () => {
  const hosted = await hostKit([]);
  const id = run(hosted, 'setsid sleep 300 & echo "holder $!"', { time_cap: 1 });

  const result = await ended(hosted, id);
  onTestFinished(() => stop(Number(/holder (\d+)/.exec(result.output)![1])));

  expect(result).toEqual({ timed_out: true, output: expect.stringMatching(/^holder \d+\n$/), cut: false });
});

it("reports a script that cannot start with the Kit's cause", async () => {
  const hosted = await hostKit([], {
    prepare: (home) => writeFile(join(accountOf(home), '.profile'), `PATH="${join(home, 'bin')}"\n`),
  });
  const id = run(hosted, 'echo never', { input: 'input-0c4a' });

  expect(await ended(hosted, id)).toEqual({ refused: "the script could not start: bash is not on the login shell's PATH" });
  expect(hosted.kit.stderr()).toContain("an Environment function could not start: bash is not on the login shell's PATH");
  await keepsNothing(hosted, ['input-0c4a']);
});

it('reports 128 plus the signal for a script a signal ended', async () => {
  const hosted = await hostKit([]);
  const id = run(hosted, 'echo before; kill -KILL $$');

  expect(await ended(hosted, id)).toEqual({ exit_code: 137, output: 'before\n', cut: false });
});

it("ends every function run's whole process group when the Kit connection drops and reports each run lost", async () => {
  const hosted = await hostKit([]);
  const directory = await scratch();
  const piped = run(hosted, `sleep 300 & echo "child $!" > ${directory}/piped; echo "script $$" >> ${directory}/piped; wait`);
  const terminal = run(hosted, TREE, { terminal: true });
  const pids = [
    ...pidsIn(await until(async () => (await readFile(join(directory, 'piped'), 'utf8').catch(() => '')).match(/script \d+/)?.input)),
    ...pidsIn(await shown(hosted, terminal, 'script ')),
  ];
  expect(pids.every(alive)).toBe(true);

  hosted.connection.transport.terminate();

  for (const id of [piped, terminal]) expect(await hosted.result(id)).toEqual({ refused: 'the Kit lost its connection to House' });
  await until(() => !pids.some(alive));
});

it('starts a run id once however often House delivers it, answering each delivery that arrives while it holds the result', async () => {
  const hosted = await hostKit([]);
  const directory = await scratch();
  const frame: KitCall = {
    type: 'input',
    input_id: 'run-delivered-again',
    provider_session_id: null,
    ...call(`echo ran >> ${directory}/runs; echo once`),
  };
  const answered = () => hosted.results.filter((result) => idOf(result, 'call') === 'run-delivered-again');

  send(hosted, frame);
  send(hosted, frame);
  await until(() => answered().length === 2);
  send(hosted, frame);
  await settle();

  expect(answered().map((result) => without(result, 'call'))).toEqual(Array(2).fill({ exit_code: 0, output: 'once\n', cut: false }));
  expect(await readFile(join(directory, 'runs'), 'utf8')).toBe('ran\n');
});

it("gives a run its own house bridge under the Kit credential for the script and every process it starts, each call naming the run with an operation id, asking House for no credential and reading no own agent's file", async () => {
  const hosted = await hostKit([]);
  await writeFile(join(hosted.home, 'own-agent.json'), JSON.stringify({ house: hosted.house.origin, user: 'user-one', credential: 'ahp_own' }));
  const id = run(
    hosted,
    `echo "bridge \${HOUSE_BRIDGE:-none}"; house search '{"query":"from-script"}'; sh -c 'house search "{\\"query\\":\\"from-child\\"}"'; env`,
  );

  const { output, ...ending } = await ended(hosted, id);

  expect(ending).toEqual({ exit_code: 0, cut: false });
  expect(output).toMatch(/^bridge \/.+\.sock$/m);
  expect(output).toMatch(/^PATH=/m);
  expect(output).not.toMatch(/^PATH=.*\/shim[:\n]/m);
  expect(output).toContain('search answered\nsearch answered\n');
  expect(hosted.house.requests.filter((received) => received.path.startsWith('/kit/agent_update.credentials'))).toEqual([]);
  expect(searched(hosted)).toEqual([
    ['from-script', 'Bearer ahk_held'],
    ['from-child', 'Bearer ahk_held'],
  ]);
  for (const received of hosted.mcp) expect(metaOf(received)[FUNCTION_RUN_META_KEY]).toBe(id);
  for (const received of hosted.mcp.filter((one) => (one.body as McpCall).method === 'tools/call')) {
    expect(metaOf(received)[OPERATION]).toMatch(UUID_V7);
  }
  expect(output).not.toContain('ahk_held');
});

it('refuses house login, logout, connect, resident and settings in one line each inside a run, ending no connection', async () => {
  const hosted = await hostKit([]);
  hosted.house.route('POST', '/kit/kits/log-out', () => ({ body: {} }));
  const before = await readFile(join(hosted.home, 'credential.json'), 'utf8');
  const id = run(hosted, 'for verb in login logout connect resident settings; do house $verb 2>&1; echo "exit $?"; done');

  expect(await ended(hosted, id)).toEqual({
    exit_code: 0,
    output: ['login', 'logout', 'connect', 'resident', 'settings']
      .map((verb) => `house: house ${verb} does not run inside an Agent conversation or a function run; run it in your own terminal\nexit 1\n`)
      .join(''),
    cut: false,
  });
  expect(hosted.house.requests.filter((received) => received.path === '/kit/kits/log-out')).toEqual([]);
  expect(await readFile(join(hosted.home, 'credential.json'), 'utf8')).toBe(before);
});

it("closes a run's bridge as the run ends, so a house call its process makes after the run reaches nothing", async () => {
  const hosted = await hostKit([]);
  const directory = await scratch();
  const id = run(
    hosted,
    `house search '{"query":"in-run"}'; setsid sh -c 'for wait in $(seq 600); do [ -e ${directory}/go ] && break; sleep 0.1; done; house search "{\\"query\\":\\"too-late\\"}" > ${directory}/late 2>&1; echo "exit $?" >> ${directory}/late' < /dev/null > /dev/null 2>&1 &`,
  );

  expect(await ended(hosted, id)).toEqual({ exit_code: 0, output: 'search answered\n', cut: false });
  await writeFile(join(directory, 'go'), '');
  const late = await until(async () => {
    const text = await readFile(join(directory, 'late'), 'utf8').catch(() => '');
    return text.includes('exit ') ? text : undefined;
  });

  expect(late).toBe('house: this House connection is closed; nothing to do from here\nexit 1\n');
  expect(searched(hosted)).toEqual([['in-run', 'Bearer ahk_held']]);
});

it("answers a run's house call House refuses for its Kit credential at once by saying House no longer accepts this computer", async () => {
  const hosted = await hostKit([]);
  hosted.house.route('POST', '/', () => ({ status: 401, body: { error: 'invalid_token', error_description: 'A valid access token is required' } }));
  const id = run(hosted, `house search '{"query":"rejected"}' 2>&1; echo "exit $?"`);

  expect(await ended(hosted, id)).toEqual({
    exit_code: 0,
    output: 'house: House no longer accepts this computer; run house login\nexit 1\n',
    cut: false,
  });
  expect(hosted.house.requests.filter((received) => received.path === '/' && (received.body as McpCall).params.name === 'search')).toHaveLength(1);
});

it("uploads a run's Local copy with house upload through the run's bridge, naming the run, and takes no --owner", async () => {
  const hosted = await hostKit([]);
  const rooms = serveRooms(hosted);
  const room = rooms.room('notes');
  room.put('ROOM.md', 'The notes Room\n');
  await rooms.download([room]);
  const id = run(hosted, `cd ${room.repository} && echo added > added.md && house upload 2>&1; echo "exit $?"; house upload --owner 2>&1; echo "exit $?"`);

  const { output } = await ended(hosted, id);

  expect(output).toMatch(/^House accepted 1 file of \/rooms\/notes\.\nexit 0\nhouse: unexpected argument --owner; usage: house upload, .*\nexit 1\n$/);
  expect(hosted.house.requests.filter((received) => received.path === '/kit/door/update')).toEqual([]);
  expect(rooms.edits().map((received) => [received.headers.authorization, metaOf(received)[FUNCTION_RUN_META_KEY]])).toEqual([['Bearer ahk_held', id]]);
});

