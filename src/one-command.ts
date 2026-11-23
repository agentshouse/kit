import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configured, HELPER } from './app-git.ts';
import { earlierPrefix, kitHome, oneFolder } from './home.ts';
import { quoted } from './shell.ts';
import { defineSupervisor, launchAgent, launcher, reloadLaunchAgent, required, systemd, userUnit } from './supervisor.ts';

const STARTED_AS = 'HOUSE_KIT_COMMAND';
const KIT_HELPER = '!kit git-credential';
const OWN_AGENT = 'own-agent.json';

function kitLauncher(): string {
  return join(oneFolder(), 'bin', 'kit');
}

async function renameHelpers(): Promise<void> {
  const listed = await configured(['--get-regexp', '^credential\\..*\\.helper$']);
  if (listed === null || listed.status !== 0) return;
  for (const line of listed.stdout.toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0 || line.slice(space + 1) !== KIT_HELPER) continue;
    const ran = await configured(['--replace-all', line.slice(0, space), HELPER, `^${KIT_HELPER}$`]);
    if (ran?.status !== 0) throw new Error(`git config failed: ${ran?.stderr.trim()}`);
  }
}

async function rewritten(): Promise<boolean> {
  if (!existsSync(process.platform === 'darwin' ? launchAgent() : userUnit())) return false;
  if ((await defineSupervisor()) && process.platform !== 'darwin') {
    required('systemctl', ['--user', 'daemon-reload'], 'systemd could not read the Kit service');
  }
  return true;
}

async function folded(asKit: boolean): Promise<void> {
  await rm(join(kitHome(), OWN_AGENT), { force: true });
  await renameHelpers();
  if (!existsSync(kitLauncher())) return;
  const sandbox = process.env.HOUSE_KIT_SANDBOX === '1';
  const supervised = !sandbox && (process.platform === 'darwin' || systemd()) && (await rewritten());
  if (supervised && asKit && process.platform === 'darwin') {
    await reloadLaunchAgent('the LaunchAgent was not reloaded; its next start runs house resident');
  }
  if (asKit && sandbox) return;
  if (asKit && !supervised) {
    process.stderr.write(`kit: kit resident is now house resident; make your service manager run ${quoted(launcher())} resident\n`);
    process.exit(0);
  }
  await rm(kitLauncher(), { force: true });
}

export async function foldKitIntoHouse(): Promise<void> {
  const asKit = process.env[STARTED_AS] === 'kit';
  delete process.env[STARTED_AS];
  if (earlierPrefix() !== null) return;
  await folded(asKit).catch((error: unknown) => {
    process.stderr.write(`kit: the kit command could not be folded into house; Kit tries again at its next start: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}
