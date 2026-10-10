import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { post, retrying } from './api.ts';
import { placeAppGit } from './app-git.ts';
import { forgetOwnAgent, readDisconnected, readEnrolment, readOwnAgent, writeEnrolment, writeOwnAgent } from './home.ts';
import { callHouse, rpc } from './mcp.ts';

const DEFAULT_HOUSE = 'https://agents.house';
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

async function accepted(house: string, credential: string): Promise<boolean> {
  const checked = await callHouse(house, credential, rpc('tools/list', {}));
  if (checked.status === 200) return true;
  if (checked.status === 401) return false;
  throw new Error(`House answered ${checked.status} when Kit checked this computer's own agent's connection: ${checked.text}`);
}

export async function login(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      house: { type: 'string' },
      environment: { type: 'string' },
    },
  });
  const enrolled = (await readEnrolment()) ?? (await readDisconnected());
  const house = values.house ?? enrolled?.house ?? DEFAULT_HOUSE;
  const replaces = process.env.HOUSE_KIT_REPLACES;
  const environment =
    replaces === undefined ? (values.environment ?? (enrolled?.house === house ? enrolled.environment : undefined)) : undefined;
  const ownAgent = await readOwnAgent();
  const held = ownAgent !== null && ownAgent.house === house && (await accepted(house, ownAgent.credential));
  const verifier = randomBytes(32).toString('base64url');
  const started = await retrying(() =>
    post<Started>(house, '/kit', {
      ...(environment === undefined
        ? { act: 'new_environment', label: hostname(), ...(replaces === undefined ? {} : { replaces }) }
        : { act: 'existing_environment', environment_id: environment }),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      ...(held ? {} : { headless: true }),
    }),
  );
  process.stdout.write(`Open this link and confirm: ${started.start_url}\n`);
  open(started.start_url);

  const exchanged = await retrying(
    () => post<Exchanged>(house, '/kit/token', { login: started.login, code_verifier: verifier }),
    undefined,
    () => POLL_INTERVAL_MS,
  );
  await writeEnrolment({ house, environment: exchanged.environment, credential: exchanged.credential });
  process.stdout.write(`Environment ${exchanged.environment} is connected to ${house}.\n`);
  if (exchanged.headless_credential !== undefined) {
    await writeOwnAgent({ house, user: exchanged.user, credential: exchanged.headless_credential });
  } else if (held && ownAgent.user !== exchanged.user) {
    await forgetOwnAgent();
    process.stdout.write("This computer's own agent was another User's; run kit login again to connect it to you.\n");
  }
  await placeAppGit(ownAgent, await readOwnAgent());
}
