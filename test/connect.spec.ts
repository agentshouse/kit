import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHouse, type House } from './double.ts';
import { accountOf, runKit, temporaryHome } from './kit.ts';
import { serveLogin } from './login.ts';
import { DARWIN, ROOTED, supervision, type Supervision } from './supervision.ts';

const CODE = { credential: 'ahk_code_credential', environment: 'environment-one', user: 'user-one' };

function accepts(house: House, credential: string): void {
  house.route('POST', '/kit/agents/desired/list', ({ headers }) =>
    headers.authorization === `Bearer ${credential}`
      ? { body: { agents: [], routes: [], transcribe: true } }
      : { status: 401, body: { error: { code: 'authentication_required', retryable: false } } },
  );
}

function redeems(house: House, answer: Record<string, string> = CODE): void {
  house.route('POST', '/kit/token', () => ({ body: answer }));
}

async function connect(home: string, tools: Supervision, argv: string[], node: string[] = ROOTED, environment: Record<string, string> = {}) {
  const kit = runKit(['connect', ...argv], { HOME: accountOf(home), CODEX_HOME: join(accountOf(home), '.codex'), ...tools.environment, ...environment }, node);
  const status = await kit.exited;
  return { status, stdout: kit.stdout(), stderr: kit.stderr() };
}

function unit(home: string): Promise<string> {
  return readFile(join(accountOf(home), '.config', 'systemd', 'user', 'house-kit.service'), 'utf8');
}

function managed(tools: Supervision): string[] {
  return tools.calls('systemctl').filter((call) => !/is-(active|enabled)/.test(call));
}

it('connects a fresh Linux account with a login code, writes the absent settings, places the Skill set and runs Kit under one lingering user unit', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const tools = await supervision();
  await tools.systemd();
  redeems(house);

  const ran = await connect(home, tools, ['--house', house.origin, '--code', 'ahk_code_one']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n').at(-2)).toBe('Kit connected for Environment environment-one.');
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toEqual({ house: house.origin, environment: 'environment-one', credential: 'ahk_code_credential' });
  expect(JSON.parse(await readFile(join(home, 'kit.json'), 'utf8'))).toEqual({ skills: true, workspace: home });
  expect(JSON.parse(await readFile(join(home, 'skill-set.json'), 'utf8'))).toMatchObject({ origin: house.origin });
  expect((await unit(home)).split('\n')).toEqual([
    '[Unit]',
    'Description=Kit',
    '',
    '[Service]',
    `ExecStart="${join(home, 'bin', 'kit')}" resident`,
    'Restart=on-failure',
    'RestartSec=5',
    'Delegate=yes',
    'OOMPolicy=continue',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ]);
  expect(tools.calls('loginctl')).toEqual([`enable-linger ${process.getuid!()}`]);
  expect(managed(tools)).toEqual(['--user daemon-reload', '--user --quiet enable house-kit.service', '--user start house-kit.service']);
  expect(tools.calls('sudo')).toEqual([]);
});

it('keeps the credential House accepts on a rerun, leaves its login code unused and changes nothing of a running Kit', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const tools = await supervision();
  await tools.systemd();
  redeems(house);
  expect((await connect(home, tools, ['--house', house.origin, '--code', 'ahk_code_one'])).status).toBe(0);
  accepts(house, 'ahk_code_credential');
  const settings = await readFile(join(home, 'kit.json'), 'utf8');
  const defined = await unit(home);
  house.requests.length = 0;
  await writeFile(join(tools.fake, 'log'), '');

  const ran = await connect(home, tools, ['--house', house.origin, '--code', 'ahk_code_two']);

  expect(ran).toEqual({ status: 0, stdout: 'Kit connected for Environment environment-one.\n', stderr: '' });
  expect(house.requests.map((request) => request.path)).not.toContain('/kit/token');
  expect(await readFile(join(home, 'kit.json'), 'utf8')).toBe(settings);
  expect(await unit(home)).toBe(defined);
  expect(managed(tools)).toEqual(['--user --quiet enable house-kit.service']);
});

it("confirms through kit login's link when it carries no login code", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const tools = await supervision();
  await tools.systemd();
  serveLogin(house, 'environment-one', 'ahk_first');

  const ran = await connect(home, tools, ['--house', house.origin]);

  expect(ran.status).toBe(0);
  expect(ran.stdout).toContain(`Open this link and confirm: ${house.origin}/kit/ahk_login_one\n`);
  expect(ran.stdout).toContain('Kit connected for Environment environment-one.\n');
});

it('keeps the settings kit.json holds and places no Skill set its person declined', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const tools = await supervision();
  await tools.systemd();
  const workspace = join(accountOf(home), 'Work');
  await writeFile(join(home, 'kit.json'), JSON.stringify({ skills: false, workspace }));
  redeems(house);

  expect((await connect(home, tools, ['--house', house.origin, '--code', 'ahk_code_one'])).status).toBe(0);

  expect(JSON.parse(await readFile(join(home, 'kit.json'), 'utf8'))).toEqual({ skills: false, workspace });
  await expect(readFile(join(home, 'skill-set.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it("refuses an install naming another Building on an account whose Kit serves one, changing nothing, and connects there after kit logout", async () => {
  const first = await startHouse();
  const second = await startHouse();
  const home = await temporaryHome();
  const tools = await supervision();
  await tools.systemd();
  redeems(first);
  expect((await connect(home, tools, ['--house', first.origin, '--code', 'ahk_code_one'])).status).toBe(0);
  const credential = await readFile(join(home, 'credential.json'), 'utf8');
  redeems(second, { ...CODE, environment: 'environment-two', credential: 'ahk_second' });

  const refused = await connect(home, tools, ['--house', second.origin, '--code', 'ahk_code_two']);

  expect(refused).toEqual({
    status: 1,
    stdout: '',
    stderr: `kit: this account's Kit serves ${first.origin}; kit logout disconnects it from there, then this command connects it to ${second.origin}\n`,
  });
  expect(second.requests).toEqual([]);
  expect(await readFile(join(home, 'credential.json'), 'utf8')).toBe(credential);
  first.route('POST', '/kit/kits/log-out', () => ({ body: {} }));
  expect(await runKit(['logout'], { HOME: accountOf(home), ...tools.environment }).exited).toBe(0);

  const moved = await connect(home, tools, ['--house', second.origin, '--code', 'ahk_code_two']);

  expect(moved).toMatchObject({ status: 0, stderr: '' });
  expect(moved.stdout).toContain('Kit connected for Environment environment-two.\n');
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toMatchObject({ house: second.origin, environment: 'environment-two' });
});

it('redeems the login code a run carries when House refuses the stored credential', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const tools = await supervision();
  await tools.systemd();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-old', credential: 'ahk_revoked' }));
  accepts(house, 'ahk_live');
  redeems(house);

  const ran = await connect(home, tools, ['--house', house.origin, '--code', 'ahk_code_one']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toMatchObject({ environment: 'environment-one', credential: 'ahk_code_credential' });
  await expect(readFile(join(home, 'held-enrolment', 'credential.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps the stored credential and leaves the login code unused when House does not answer', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const tools = await supervision();
  await tools.systemd();
  await writeFile(join(home, 'credential.json'), JSON.stringify({ house: house.origin, environment: 'environment-one', credential: 'ahk_held' }));
  house.route('POST', '/kit/agents/desired/list', () => ({ status: 503, body: { error: { code: 'unavailable', retryable: true } } }));
  redeems(house);

  const ran = await connect(home, tools, ['--house', house.origin, '--code', 'ahk_code_one']);

  expect(ran.status).toBe(0);
  expect(ran.stderr).toContain('kit: House did not answer, so the stored credential stands: ');
  expect(ran.stdout.split('\n').at(-2)).toBe('Kit connected for Environment environment-one.');
  expect(house.requests.map((request) => request.path)).not.toContain('/kit/token');
  expect(JSON.parse(await readFile(join(home, 'credential.json'), 'utf8'))).toMatchObject({ credential: 'ahk_held' });
});

it('starts nothing on a Linux without systemd and names the kit resident command to supervise', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const tools = await supervision();
  redeems(house);

  const ran = await connect(home, tools, ['--house', house.origin, '--code', 'ahk_code_one']);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(ran.stdout.split('\n').at(-2)).toBe(
    `Kit 0.2.1 is installed for Environment environment-one, but no systemd runs on this host to start it; run '${join(home, 'bin', 'kit')}' resident under your own service manager, restarting it whenever it ends with a failure.`,
  );
  expect(tools.calls('systemctl')).toEqual([]);
  expect(tools.calls('loginctl')).toEqual([]);
});

it("runs root's Kit under root's own lingering user unit, starting root's service manager", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const tools = await supervision();
  await tools.systemd();
  redeems(house);

  const ran = await connect(home, tools, ['--house', house.origin, '--code', 'ahk_code_one'], ROOTED, { KIT_TEST_UID0: '1' });

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  expect(tools.calls('loginctl')).toEqual(['enable-linger 0']);
  expect(managed(tools)).toEqual(['start user@0.service', '--user daemon-reload', '--user --quiet enable house-kit.service', '--user start house-kit.service']);
  expect(tools.calls('sudo')).toEqual([]);
});

it('stops with the error when lingering cannot be turned on, starting nothing for the session alone', async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const tools = await supervision();
  await tools.systemd();
  await tools.mark('linger-refused');
  redeems(house);

  const ran = await connect(home, tools, ['--house', house.origin, '--code', 'ahk_code_one']);

  expect(ran.status).toBe(1);
  expect(ran.stderr).toBe('kit: lingering could not be turned on for this account: Could not enable linger: Access denied\n');
  expect(managed(tools)).toEqual([]);
});

it("runs a Mac's Kit as one LaunchAgent naming the one folder's launcher and no Kit variable", async () => {
  const house = await startHouse();
  const home = await temporaryHome();
  const tools = await supervision();
  redeems(house);

  const ran = await connect(home, tools, ['--house', house.origin, '--code', 'ahk_code_one'], DARWIN);

  expect(ran).toMatchObject({ status: 0, stderr: '' });
  const agent = await readFile(join(accountOf(home), 'Library', 'LaunchAgents', 'house-kit.plist'), 'utf8');
  expect(agent).toContain(`<string>${join(home, 'bin', 'kit')}</string>\n\t\t<string>resident</string>`);
  expect(agent).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  expect(agent).not.toContain('HOUSE_KIT');
  expect(tools.calls('launchctl')).toEqual([
    `print gui/${process.getuid!()}/house-kit`,
    `enable gui/${process.getuid!()}/house-kit`,
    `bootstrap gui/${process.getuid!()} ${join(accountOf(home), 'Library', 'LaunchAgents', 'house-kit.plist')}`,
  ]);
  expect(tools.calls('loginctl')).toEqual([]);
});
