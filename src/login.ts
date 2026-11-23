import {
  KIT_LOGIN_PATHS,
  type EnvironmentRooms,
  type KIT_LOGIN_ISSUED,
  type KIT_LOGIN_POLL,
  type KIT_LOGIN_START,
  type KIT_LOGIN_STARTED,
} from '@agentshouse/kit-wire';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { z } from 'zod';
import { HouseRefusal, post, retrying } from './api.ts';
import { placeAppGit } from './app-git.ts';
import { writeCodexRule } from './clis.ts';
import { forgetDisconnected, readDisconnected, readEnrolment, writeEnrolment } from './home.ts';
import { refusalOf } from './refusals.ts';
import { startService } from './supervisor.ts';
import { placeSkillSet } from './skills.ts';

export const DEFAULT_HOUSE = 'https://agents.house';
const OPENER = process.platform === 'darwin' ? 'open' : 'xdg-open';
// Polling every two seconds brings the User's confirmation to the waiting Kit moments after they give it.
const POLL_INTERVAL_MS = 2000;

type Started = z.output<typeof KIT_LOGIN_STARTED>;

type Issued = z.output<typeof KIT_LOGIN_ISSUED>;

function startLogin(house: string, request: z.input<typeof KIT_LOGIN_START>): Promise<Started> {
  return post(house, KIT_LOGIN_PATHS.start, request);
}

function pollLogin(house: string, request: z.input<typeof KIT_LOGIN_POLL>): Promise<Issued> {
  return post(house, KIT_LOGIN_PATHS.poll, request);
}

function open(link: string): void {
  spawn(OPENER, [link], { detached: true, stdio: 'ignore' })
    .on('error', () => undefined)
    .unref();
}

const USAGE = `usage: house login [--house <origin>] [--environment <id>] [--rooms <ref>[,<ref>...] | --no-private]
       house login [--house <origin>] --code <code>
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

function chosenRooms(rooms: string | undefined, noPrivate: boolean): { rooms?: EnvironmentRooms } {
  if (rooms !== undefined && noPrivate) throw new Error('--rooms and --no-private are two choices of Rooms; pass one');
  if (rooms !== undefined) return { rooms: { reach: 'selected', refs: rooms.split(',') } };
  return noPrivate ? { rooms: { reach: 'all_but_private' } } : {};
}

export interface Chosen {
  house?: string;
  environment?: string;
  rooms?: string;
  'no-private': boolean;
  code?: string;
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
  const house = await enrol(values);
  await placeConnection(house);
  try {
    startService();
  } catch (error) {
    process.stderr.write(`kit: ${(error as Error).message}\n`);
  }
}

export async function placeConnection(house: string): Promise<void> {
  await placeSkillSet(house);
  await writeCodexRule().catch((error: Error) => process.stderr.write(`kit: ${error.message}\n`));
  await placeAppGit(house).catch((error: Error) => process.stderr.write(`kit: ${error.message}\n`));
}

export async function enrol(values: Chosen): Promise<string> {
  if (values.code !== undefined && values.rooms !== undefined) throw new Error('--code cannot be used with --rooms');
  if (values.code !== undefined && values['no-private']) throw new Error('--code cannot be used with --no-private');
  if (values.code !== undefined && values.environment !== undefined) throw new Error('--code cannot be used with --environment');
  const rooms = chosenRooms(values.rooms, values['no-private']);
  const enrolled = (await readEnrolment()) ?? (await readDisconnected());
  if (values.code !== undefined && enrolled !== null) {
    throw new Error(`--code connects a new machine; this Kit home records Environment ${enrolled.environment}, so run house login to reconnect it`);
  }
  const house = values.house ?? enrolled?.house ?? DEFAULT_HOUSE;
  const remembered = values.environment === undefined && enrolled?.house === house ? enrolled.environment : undefined;
  const environment = values.environment ?? remembered;
  if (environment !== undefined && rooms.rooms !== undefined) {
    throw new Error(`Environment ${environment} keeps its Rooms; change them on its page in House`);
  }
  let named = environment;
  let exchanged: Issued;
  if (values.code !== undefined) {
    exchanged = await pollLogin(house, { code: values.code });
  } else {
    const verifier = randomBytes(32).toString('base64url');
    const start = () =>
      retrying(() =>
        startLogin(house, {
          ...(named === undefined ? { act: 'new_environment' } : { act: 'existing_environment', environment_id: named }),
          ...rooms,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
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
      () => pollLogin(house, { login: started.login, code_verifier: verifier }),
      undefined,
      () => POLL_INTERVAL_MS,
    );
  }
  await writeEnrolment({
    house,
    environment: exchanged.environment,
    credential: exchanged.credential,
  });
  process.stdout.write(connected(house, named, exchanged.environment));
  return house;
}
