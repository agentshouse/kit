import { run, type Ran } from './git.ts';
import { kitHome, readEnrolment } from './home.ts';

export const HELPER = '!house git-credential';

function section(house: string): string {
  return `credential.${new URL('/app/', house).href}`;
}

export async function configured(args: string[]): Promise<Ran | null> {
  try {
    return await run(kitHome(), ['config', '--global', ...args]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function placeAppGit(house: string): Promise<void> {
  await configured(['--remove-section', section(house)]);
  for (const value of ['', HELPER]) {
    const ran = await configured(['--add', `${section(house)}.helper`, value]);
    if (ran === null) return;
    if (ran.status !== 0) throw new Error(`git config failed: ${ran.stderr.trim()}`);
  }
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
  const enrolment = await readEnrolment();
  if (enrolment === null) {
    process.stderr.write(`kit: Kit home ${kitHome()} is not signed in; run house login\n`);
    return;
  }
  const house = new URL(enrolment.house);
  if (attributes.get('protocol') !== house.protocol.slice(0, -1) || attributes.get('host') !== house.host) return;
  process.stdout.write(`username=house\npassword=${enrolment.credential}\n`);
}
