import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CLIS, executable, writeCodexRule } from './clis.ts';
import { kitHome, readOwnAgent, writeOwnAgent } from './home.ts';
import { accepted, DEFAULT_HOUSE } from './login.ts';

const USAGE = `usage: kit codex [--key <key>] [--house <origin>] [<codex argument>...]
  --key <key>       a key from New key for a script on Connections, kept for later runs
  --house <origin>  the House of the key, ${DEFAULT_HOUSE} unless one is stored
`;
const VALUED = ['--key', '--house'];
const KEY_SOURCE = 'New key for a script on Connections';

function codexArgumentsStart(argv: string[]): number {
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (VALUED.includes(arg)) index += 2;
    else if (arg === '--help' || VALUED.some((option) => arg.startsWith(`${option}=`))) index += 1;
    else break;
  }
  return index;
}

async function onPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = resolve(directory, name);
    if (await executable(path)) return path;
  }
  throw new Error(`${name} is not on your PATH; install it with ${CLIS['codex-acp']!.install}`);
}

export async function codex(argv: string[]): Promise<void> {
  const start = codexArgumentsStart(argv);
  const { values } = parseArgs({
    args: argv.slice(0, start),
    options: { key: { type: 'string' }, house: { type: 'string' }, help: { type: 'boolean', default: false } },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  process.env.HOUSE_KIT_HOME = resolve(process.env.HOUSE_KIT_HOME || join(homedir(), '.house-kit-outside'));
  const stored = await readOwnAgent();
  if (values.key !== undefined) {
    const house = values.house ?? stored?.house ?? DEFAULT_HOUSE;
    if (!(await accepted(house, values.key))) throw new Error(`${house} does not accept this key; pass one from ${KEY_SOURCE}`);
    await writeOwnAgent({ house, credential: values.key });
  } else if (values.house !== undefined) {
    throw new Error('--house names the House of a --key; pass the key with it');
  } else if (stored === null) {
    throw new Error(`${kitHome()} holds no House key; pass --key with one from ${KEY_SOURCE}`);
  }
  await writeCodexRule();
  const path = await onPath('codex');
  process.execve!(path, [path, ...argv.slice(start)], process.env);
}
