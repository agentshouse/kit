import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, type Ran } from './git.ts';
import { kitHome, readOwnAgent, type OwnAgent } from './home.ts';
import { quoted } from './shell.ts';

function section(house: string): string {
  return `credential.${new URL('/app/', house).href}`;
}

function helper(): string {
  const main = fileURLToPath(new URL(`./kit-main${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  return `!HOUSE_KIT_HOME=${quoted(resolve(kitHome()))} ${quoted(process.execPath)} ${quoted(main)} git-credential`;
}

async function configured(args: string[]): Promise<Ran | null> {
  try {
    return await run(kitHome(), ['config', '--global', ...args]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function forget(house: string): Promise<void> {
  await configured(['--remove-section', section(house)]);
}

async function register(house: string): Promise<void> {
  await forget(house);
  for (const value of ['', helper()]) {
    const ran = await configured(['--add', `${section(house)}.helper`, value]);
    if (ran === null) return;
    if (ran.status !== 0) throw new Error(`git config failed: ${ran.stderr.trim()}`);
  }
}

export async function placeAppGit(before: OwnAgent | null, after: OwnAgent | null): Promise<void> {
  if (before !== null && before.house !== after?.house) await forget(before.house);
  if (after !== null) await register(after.house);
}

export async function forgetAppGit(): Promise<void> {
  const ownAgent = await readOwnAgent();
  if (ownAgent !== null) await forget(ownAgent.house);
}

export async function answerGitCredential(operation: string | undefined): Promise<void> {
  let asked = '';
  for await (const chunk of process.stdin) asked += String(chunk);
  if (operation !== 'get') return;
  const attributes = new Map(
    asked
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  const ownAgent = await readOwnAgent();
  if (ownAgent === null) return;
  const house = new URL(ownAgent.house);
  if (attributes.get('protocol') !== house.protocol.slice(0, -1) || attributes.get('host') !== house.host) return;
  process.stdout.write(`username=house\npassword=${ownAgent.credential}\n`);
}
