import { parseArgs } from 'node:util';
import { placeAppGit } from './app-git.ts';
import { kitHome, readOwnAgent, writeOwnAgent } from './home.ts';
import { accepted, DEFAULT_HOUSE } from './login.ts';

const KEY_SOURCE = 'New key for a script on Connections';
const USAGE = `usage: kit chatgpt --key <key> [--house <origin>]
  --key <key>       a key from ${KEY_SOURCE}
  --house <origin>  the House of the key, ${DEFAULT_HOUSE} unless one is stored
`;

export async function chatgpt(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { key: { type: 'string' }, house: { type: 'string' }, help: { type: 'boolean', default: false } },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.key === undefined) throw new Error(`pass --key with a key from ${KEY_SOURCE}`);
  const before = await readOwnAgent();
  const house = values.house ?? before?.house ?? DEFAULT_HOUSE;
  if (!(await accepted(house, values.key))) throw new Error(`${house} does not accept this key; pass one from ${KEY_SOURCE}`);
  const relay = process.env.HOUSE_KIT_RELAY || undefined;
  await writeOwnAgent({ house, ...(relay === undefined ? {} : { relay }), credential: values.key });
  await placeAppGit(before, await readOwnAgent()).catch((error: Error) =>
    process.stderr.write(`kit: ${error.message}\n`),
  );
  process.stdout.write(`house now calls ${house} as you, with the key kept in ${kitHome()}.\n`);
}
