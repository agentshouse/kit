import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { HouseRefusal, post, retrying } from './api.ts';
import { placeAppGit } from './app-git.ts';
import { writeCodexRule } from './clis.ts';
import {
  forgetDisconnected,
  forgetOwnAgent,
  readDisconnected,
  readEnrolment,
  readOwnAgent,
  writeEnrolment,
  writeOwnAgent,
} from './home.ts';
import { callHouse, rpc } from './mcp.ts';
import { refusalOf } from './refusals.ts';
import { selectRelay } from './relay.ts';
import { startService } from './service.ts';
import { placeSkillSet } from './skills.ts';

export const DEFAULT_HOUSE = 'https://agents.house';
const OPENER = process.platform === 'darwin' ? 'open' : 'xdg-open';
// Polling every two seconds brings the User's confirmation to the waiting Kit moments after they give it.
const POLL_INTERVAL_MS = 2000;

interface Started {
  start_url: string;
  login: string;
}

interface Exchanged {
  credential: string;
  environment: string;
  user: string;
  headless_credential?: string;
}

function open(link: string): void {
  spawn(OPENER, [link], { detached: true, stdio: 'ignore' })
    .on('error', () => undefined)
    .unref();
}

export async function accepted(house: string, credential: string): Promise<boolean> {
  const checked = await callHouse(house, credential, rpc('tools/list', {}));
  if (checked.status === 200) return true;
  if (checked.status === 401) return false;
  throw new Error(`House answered ${checked.status} when Kit checked this computer's own agent's connection: ${checked.text}`);
}

const USAGE = `usage: kit login [--house <origin>] [--environment <id>] [--rooms <ref>[,<ref>...] | --no-private]
       kit login [--house <origin>] --code <code>
  --house <origin>          the House to connect to, ${DEFAULT_HOUSE} unless one is stored
  --environment <id>        reconnect this Environment
  --rooms <ref>[,<ref>...]  give this Environment only these Rooms
  --no-private              give this Environment every Room but your Private Room
  --code <code>             connect this machine with a login code
`;

function connected(house: string, named: string | undefined, environment: string): string {
  if (named === undefined) return `Environment ${environment} is connected to ${house}.\n`;
  if (named === environment) return `Environment ${environment} is reconnected to ${house}.\n`;
  return `Environment ${named} stays with its account; this computer is connected to ${house} as new Environment ${environment} of the account that confirmed.\n`;
}

function gone(error: unknown): boolean {
  return error instanceof HouseRefusal && refusalOf(error.text)?.code === 'kit_environment_not_found';
}

function chosenRooms(rooms: string | undefined, noPrivate: boolean): object {
  if (rooms !== undefined && noPrivate) throw new Error('--rooms and --no-private are two choices of Rooms; pass one');
  if (rooms !== undefined) return { rooms: { reach: 'selected', refs: rooms.split(',') } };
  return noPrivate ? { rooms: { reach: 'all_but_private' } } : {};
}

export async function login(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      house: { type: 'string' },
      environment: { type: 'string' },
      rooms: { type: 'string' },
      'no-private': { type: 'boolean', default: false },
      code: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.code !== undefined && values.rooms !== undefined) throw new Error('--code cannot be used with --rooms');
  if (values.code !== undefined && values['no-private']) throw new Error('--code cannot be used with --no-private');
  if (values.code !== undefined && values.environment !== undefined) throw new Error('--code cannot be used with --environment');
  const rooms = chosenRooms(values.rooms, values['no-private']);
  const enrolled = (await readEnrolment()) ?? (await readDisconnected());
  if (values.code !== undefined && enrolled !== null) {
    throw new Error(`--code connects a new machine; this Kit home records Environment ${enrolled.environment}, so run kit login to reconnect it`);
  }
  const relay = process.env.HOUSE_KIT_RELAY || undefined;
  selectRelay(relay);
  const house = values.house ?? enrolled?.house ?? DEFAULT_HOUSE;
  const replaces = process.env.HOUSE_KIT_REPLACES;
  const remembered =
    replaces === undefined && values.environment === undefined && enrolled?.house === house ? enrolled.environment : undefined;
  const environment = replaces === undefined ? (values.environment ?? remembered) : undefined;
  const ownAgent = await readOwnAgent();
  let held = false;
  let named = environment;
  let exchanged: Exchanged;
  if (values.code !== undefined) {
    exchanged = await post<Exchanged>(house, '/kit/token', { code: values.code, label: hostname() });
  } else {
    held = ownAgent !== null && ownAgent.house === house && (await accepted(house, ownAgent.credential));
    const verifier = randomBytes(32).toString('base64url');
    const start = () =>
      retrying(() =>
        post<Started>(house, '/kit', {
          label: hostname(),
          ...(named === undefined
            ? { act: 'new_environment', ...(replaces === undefined ? {} : { replaces }) }
            : { act: 'existing_environment', environment_id: named }),
          ...rooms,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          ...(held ? {} : { headless: true }),
        }),
      );
    let started: Started;
    try {
      started = await start();
    } catch (error) {
      if (remembered === undefined || !gone(error)) throw error;
      await forgetDisconnected();
      process.stdout.write(`House no longer holds Environment ${remembered}; connecting this computer as a new one.\n`);
      named = undefined;
      started = await start();
    }
    process.stdout.write(`Open this link and confirm: ${started.start_url}\n`);
    open(started.start_url);

    exchanged = await retrying(
      () => post<Exchanged>(house, '/kit/token', { login: started.login, code_verifier: verifier }),
      undefined,
      () => POLL_INTERVAL_MS,
    );
  }
  await placeSkillSet();
  await writeCodexRule().catch((error: Error) => process.stderr.write(`kit: ${error.message}\n`));
  const relayRecord = relay === undefined ? {} : { relay };
  await writeEnrolment({
    house,
    ...relayRecord,
    environment: exchanged.environment,
    credential: exchanged.credential,
  });
  process.stdout.write(connected(house, named, exchanged.environment));
  if (exchanged.headless_credential !== undefined) {
    await writeOwnAgent({ house, ...relayRecord, user: exchanged.user, credential: exchanged.headless_credential });
  } else if (held && ownAgent !== null && ownAgent.user !== exchanged.user) {
    await forgetOwnAgent();
    process.stdout.write("This computer's own agent was another User's; run kit login again to connect it to you.\n");
  } else if (held && ownAgent !== null) {
    await writeOwnAgent({ house, ...relayRecord, user: ownAgent.user, credential: ownAgent.credential });
  }
  await placeAppGit(await readOwnAgent()).catch((error: Error) => process.stderr.write(`kit: ${error.message}\n`));
  try {
    startService();
  } catch (error) {
    process.stderr.write(`kit: ${(error as Error).message}\n`);
  }
}
