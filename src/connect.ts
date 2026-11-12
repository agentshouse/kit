import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { HouseRefusal, kitAct } from './api.ts';
import { KIT_RELEASE } from './clis.ts';
import { takeOverEarlier } from './earlier.ts';
import { kitHome, readEnrolment, storedConfiguration, writeConfiguration } from './home.ts';
import { DEFAULT_HOUSE, enrol, placeConnection } from './login.ts';
import { runningRelease } from './resident.ts';
import { quoted } from './shell.ts';
import { defineSupervisor, launcher, supervise, systemd } from './supervisor.ts';

const USAGE = `usage: kit connect [--house <origin>] [--code <code>]
  --house <origin>  the Building this account's Kit serves, ${DEFAULT_HOUSE} unless one is stored
  --code <code>     connect this computer with a login code when Kit holds no credential House accepts
`;

const HELD = 'held-enrolment';
const RECORDS = ['credential.json', 'disconnected.json'];
const ENDS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;

function unanswered(error: unknown): boolean {
  return error instanceof HouseRefusal ? error.status >= 500 : error instanceof TypeError && error.message === 'fetch failed';
}

async function standing(house: string, credential: string): Promise<boolean> {
  try {
    await kitAct(house, 'agents/desired/list', {}, credential);
    return true;
  } catch (error) {
    if (!unanswered(error)) return false;
    process.stderr.write(`kit: House did not answer, so the stored credential stands: ${(error as Error).message}\n`);
    return true;
  }
}

function settleHeld(): void {
  const held = join(kitHome(), HELD);
  if (!existsSync(held)) return;
  if (!existsSync(join(kitHome(), RECORDS[0]!))) {
    for (const record of RECORDS) if (existsSync(join(held, record))) renameSync(join(held, record), join(kitHome(), record));
  }
  rmSync(held, { recursive: true, force: true });
}

async function heldWhile(work: () => Promise<unknown>): Promise<void> {
  const held = join(kitHome(), HELD);
  mkdirSync(held, { mode: 0o700 });
  const ended = () => {
    settleHeld();
    process.exit(130);
  };
  for (const signal of ENDS) process.once(signal, ended);
  try {
    for (const record of RECORDS) if (existsSync(join(kitHome(), record))) renameSync(join(kitHome(), record), join(held, record));
    await work();
  } finally {
    for (const signal of ENDS) process.off(signal, ended);
    settleHeld();
  }
}

export async function connect(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { house: { type: 'string' }, code: { type: 'string' }, help: { type: 'boolean', default: false } },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  await takeOverEarlier();
  settleHeld();
  const stored = await readEnrolment();
  const house = values.house ?? stored?.house ?? DEFAULT_HOUSE;
  if (stored !== null && stored.house !== house) {
    throw new Error(`this account's Kit serves ${stored.house}; kit logout disconnects it from there, then this command connects it to ${house}`);
  }
  const install = process.env.HOUSE_KIT_INSTALL_COMMAND;
  if (install !== undefined && install !== '') await writeFile(join(kitHome(), 'install-command'), `${install}\n`, { mode: 0o600 });
  if (stored === null || !(await standing(stored.house, stored.credential))) {
    if (values.code === undefined) await enrol({ house, 'no-private': false });
    else await heldWhile(() => enrol({ house, code: values.code, 'no-private': false }));
    if ((await readEnrolment()) === null) throw new Error('kit login connected no Environment');
  }
  const settings = await storedConfiguration();
  if (settings.skills === undefined || settings.workspace === undefined) {
    await writeConfiguration({ skills: true, workspace: kitHome(), ...settings });
  }
  await placeConnection(house);
  const { environment } = (await readEnrolment())!;
  if (process.platform !== 'darwin' && !systemd()) {
    process.stdout.write(
      `Kit ${KIT_RELEASE} is installed for Environment ${environment}, but no systemd runs on this host to start it; run ${quoted(launcher())} resident under your own service manager, restarting it whenever it ends with a failure.\n`,
    );
    return;
  }
  const changed = await defineSupervisor();
  const running = await runningRelease();
  supervise(changed, running !== null && running !== KIT_RELEASE);
  process.stdout.write(`Kit connected for Environment ${environment}.\n`);
}
