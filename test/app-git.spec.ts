import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHouse, type House } from './double.ts';
import { appRemote, conversationCredential, directed, hostKit, opened, runs } from './environment.ts';
import { accountOf, filesUnder, placeKit, runKit, temporaryHome } from './kit.ts';
import { answerOwnAgent, logIn, serveLogin } from './login.ts';

const COMMIT = 'a'.repeat(40);

function gitOf(home: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const account = accountOf(home);
  const child = spawn('git', args, {
    cwd: account,
    env: {
      ...environment,
      HOME: account,
      PATH: `${join(account, 'kit-bin')}:${process.env.PATH}`,
      GIT_CONFIG_SYSTEM: join(account, 'system.gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
}

async function storingHelpers(home: string): Promise<void> {
  const account = accountOf(home);
  await placeKit(join(account, 'kit-bin'));
  await writeFile(join(account, 'system.gitconfig'), `[credential]\n\thelper = store --file=${join(account, 'system-store')}\n`);
  await writeFile(join(account, '.gitconfig'), `[credential]\n\thelper = store --file=${join(account, 'global-store')}\n`);
}

async function loggedIn(): Promise<{ house: House; home: string; credentials: string[] }> {
  const house = await startHouse();
  const home = await temporaryHome();
  await storingHelpers(home);
  serveLogin(house, 'environment-one', 'ahk_first', { own: 'ahp_own' });
  expect((await logIn(house, home)).exit).toBe(0);
  return { house, home, credentials: appRemote(house, COMMIT) };
}

async function holding(home: string, secret: string): Promise<string[]> {
  const holders: string[] = [];
  for (const file of await filesUnder(accountOf(home))) {
    if ((await readFile(file)).includes(secret)) holders.push(file);
  }
  return holders;
}

it("lets git reach House's App sources as the User's own agent outside a conversation, and no other helper keeps the credential", async () => {
  const { house, home, credentials } = await loggedIn();

  const listed = await gitOf(home, 'ls-remote', `${house.origin}/app/a_app.git`);

  expect(listed).toMatchObject({ status: 0, stdout: `${COMMIT}\tHEAD\n${COMMIT}\trefs/heads/main\n` });
  expect(credentials).toEqual(['', 'ahp_own']);
  await expect(access(join(accountOf(home), 'system-store'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(accountOf(home), 'global-store'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await holding(home, 'ahp_own')).toEqual([join(home, 'own-agent.json')]);
});

async function twoHomes(): Promise<{ house: House; user: string; tester: string; credentials: string[] }> {
  const house = await startHouse();
  const user = await temporaryHome();
  await storingHelpers(user);
  serveLogin(house, 'environment-one', 'ahk_first', { own: 'ahp_own' });
  expect((await logIn(house, user)).exit).toBe(0);
  const tester = await temporaryHome();
  await storingHelpers(tester);
  serveLogin(house, 'environment-two', 'ahk_second', { own: 'ahp_tester', user: 'user-two' });
  expect((await logIn(house, tester)).exit).toBe(0);
  return { house, user, tester, credentials: appRemote(house, COMMIT) };
}

it("registers git's helper for House's App sources naming no Kit home, so git signs in as the own agent of the Kit home its HOME holds", async () => {
  const { house, user, tester, credentials } = await twoHomes();

  const plain = await gitOf(user, 'ls-remote', `${house.origin}/app/a_app.git`);
  const testing = await gitOf(tester, 'ls-remote', `${house.origin}/app/a_app.git`);

  expect(plain.status).toBe(0);
  expect(testing.status).toBe(0);
  expect(credentials).toEqual(['', 'ahp_own', '', 'ahp_tester']);
  expect((await gitOf(user, 'config', '--global', '--get-all', `credential.${house.origin}/app/.helper`)).stdout).toBe('\n!kit git-credential\n');
});

it("leaves one HOME's git signing in when the Kit home another HOME holds logs out", async () => {
  const { house, user, tester, credentials } = await twoHomes();
  house.route('POST', '/kit/kits/log-out', () => ({ body: {} }));

  expect(await runKit(['logout'], { HOME: accountOf(tester) }).exited).toBe(0);
  const plain = await gitOf(user, 'ls-remote', `${house.origin}/app/a_app.git`);

  expect(plain.status).toBe(0);
  expect(credentials).toEqual(['', 'ahp_own']);
});

it("stops answering for git once kit logout disconnects the computer, says this Kit home is not signed in, and leaves the User's other helpers", async () => {
  const { house, home, credentials } = await loggedIn();
  house.route('POST', '/kit/kits/log-out', () => ({ body: {} }));

  expect(await runKit(['logout'], { HOME: accountOf(home) }).exited).toBe(0);
  const listed = await gitOf(home, 'ls-remote', `${house.origin}/app/a_app.git`);

  expect(listed.status).not.toBe(0);
  expect(listed.stderr).toContain(`kit: Kit home ${home} is not signed in; run kit login\n`);
  expect(listed.stderr).toContain('could not read Username');
  expect(credentials).toEqual(['']);
  expect((await gitOf(home, 'config', '--global', '--get-all', 'credential.helper')).stdout).toBe(`store --file=${join(accountOf(home), 'global-store')}\n`);
});

it("stops answering for git when another User's login drops the own agent", async () => {
  const { house, home, credentials } = await loggedIn();
  answerOwnAgent(house, 'ahp_own');
  serveLogin(house, 'environment-one', 'ahk_second', { user: 'user-two' });

  expect((await logIn(house, home)).exit).toBe(0);
  const listed = await gitOf(home, 'ls-remote', `${house.origin}/app/a_app.git`);

  expect(listed.stderr).toContain('could not read Username');
  expect(credentials).toEqual(['']);
});

it("answers git for no other House than the own agent's", async () => {
  const home = await temporaryHome();
  await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: 'https://house.example', user: 'user-one', credential: 'ahp_own' }));
  const ask = (host: string) => {
    const helper = runKit(['git-credential', 'get'], { HOME: accountOf(home) });
    helper.input.end(`protocol=https\nhost=${host}\n\n`);
    return helper;
  };

  const elsewhere = ask('elsewhere.example');
  const here = ask('house.example');

  expect(await elsewhere.exited).toBe(0);
  expect(elsewhere.stdout()).toBe('');
  expect(elsewhere.stderr()).toBe('');
  expect(await here.exited).toBe(0);
  expect(here.stdout()).toBe('username=house\npassword=ahp_own\n');
  expect(here.stderr()).toBe('');
});

it("keeps a conversation's Git under its own credential while the own agent answers git outside it", async () => {
  const hosted = await hostKit();
  await placeKit(join(accountOf(hosted.home), 'kit-bin'));
  await writeFile(join(hosted.home, 'own-agent.json'), JSON.stringify({ house: hosted.house.origin, user: 'user-one', credential: 'ahp_own' }));
  serveLogin(hosted.house, 'environment-one', 'ahk_held');
  expect((await logIn(hosted.house, hosted.home)).exit).toBe(0);
  const credentials = appRemote(hosted.house, COMMIT);
  await opened(hosted);

  directed(hosted, `@git ls-remote ${hosted.house.origin}/app/a_app.git`);

  const [ran] = await runs(hosted, 1);
  expect(ran).toMatchObject({ status: 0 });
  expect(credentials).toEqual([conversationCredential('conversation-1')]);
  expect((await gitOf(hosted.home, 'ls-remote', `${hosted.house.origin}/app/a_app.git`)).status).toBe(0);
  expect(credentials.at(-1)).toBe('ahp_own');
});
