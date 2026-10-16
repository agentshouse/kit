import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHouse, type House } from './double.ts';
import { appRemote, conversationCredential, directed, hostKit, opened, runs } from './environment.ts';
import { filesUnder, placeKit, runKit, temporaryHome } from './kit.ts';
import { answerOwnAgent, logIn, serveLogin } from './login.ts';

const COMMIT = 'a'.repeat(40);

function gitOf(home: string, kitHome: string | null, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && name !== 'HOUSE_KIT_HOME'));
  const child = spawn('git', args, {
    cwd: home,
    env: {
      ...environment,
      ...(kitHome === null ? {} : { HOUSE_KIT_HOME: kitHome }),
      HOME: home,
      PATH: `${join(home, 'kit-bin')}:${process.env.PATH}`,
      GIT_CONFIG_SYSTEM: join(home, 'system.gitconfig'),
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
  await placeKit(join(home, 'kit-bin'));
  await writeFile(join(home, 'system.gitconfig'), `[credential]\n\thelper = store --file=${join(home, 'system-store')}\n`);
  await writeFile(join(home, '.gitconfig'), `[credential]\n\thelper = store --file=${join(home, 'global-store')}\n`);
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
  for (const file of await filesUnder(home)) {
    if ((await readFile(file)).includes(secret)) holders.push(file);
  }
  return holders;
}

it("lets git reach House's App sources as the User's own agent outside a conversation, and no other helper keeps the credential", async () => {
  const { house, home, credentials } = await loggedIn();

  const listed = await gitOf(home, home, 'ls-remote', `${house.origin}/app/a_app.git`);

  expect(listed).toMatchObject({ status: 0, stdout: `${COMMIT}\tHEAD\n${COMMIT}\trefs/heads/main\n` });
  expect(credentials).toEqual(['', 'ahp_own']);
  await expect(access(join(home, 'system-store'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(home, 'global-store'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await holding(home, 'ahp_own')).toEqual([join(home, 'own-agent.json')]);
});

async function twoHomes(): Promise<{ house: House; user: string; second: string; credentials: string[] }> {
  const house = await startHouse();
  const user = await temporaryHome();
  await storingHelpers(user);
  serveLogin(house, 'environment-one', 'ahk_first', { own: 'ahp_own' });
  expect((await logIn(house, join(user, '.house-kit'), { HOME: user })).exit).toBe(0);
  const second = join(user, '.hk-tester');
  serveLogin(house, 'environment-two', 'ahk_second', { own: 'ahp_tester', user: 'user-two' });
  expect((await logIn(house, second, { HOME: user })).exit).toBe(0);
  return { house, user, second, credentials: appRemote(house, COMMIT) };
}

it("registers git's helper for House's App sources naming no Kit home, so another Kit home's login leaves git signing in as the default Kit home's own agent", async () => {
  const { house, user, second, credentials } = await twoHomes();

  const plain = await gitOf(user, null, 'ls-remote', `${house.origin}/app/a_app.git`);
  const tester = await gitOf(user, second, 'ls-remote', `${house.origin}/app/a_app.git`);

  expect(plain.status).toBe(0);
  expect(tester.status).toBe(0);
  expect(credentials).toEqual(['', 'ahp_own', '', 'ahp_tester']);
  expect((await gitOf(user, null, 'config', '--global', '--get-all', `credential.${house.origin}/app/.helper`)).stdout).toBe('\n!kit git-credential\n');
});

it("leaves the default Kit home's git signing in when another Kit home logs out", async () => {
  const { house, user, second, credentials } = await twoHomes();
  house.route('POST', '/kit/logout', () => ({ body: {} }));

  expect(await runKit(['logout'], { HOUSE_KIT_HOME: second, HOME: user }).exited).toBe(0);
  const plain = await gitOf(user, null, 'ls-remote', `${house.origin}/app/a_app.git`);

  expect(plain.status).toBe(0);
  expect(credentials).toEqual(['', 'ahp_own']);
});

it("stops answering for git once kit logout disconnects the computer, says this Kit home is not signed in, and leaves the User's other helpers", async () => {
  const { house, home, credentials } = await loggedIn();
  house.route('POST', '/kit/logout', () => ({ body: {} }));

  expect(await runKit(['logout'], { HOUSE_KIT_HOME: home }).exited).toBe(0);
  const listed = await gitOf(home, home, 'ls-remote', `${house.origin}/app/a_app.git`);

  expect(listed.status).not.toBe(0);
  expect(listed.stderr).toContain(`kit: Kit home ${home} is not signed in; run kit login\n`);
  expect(listed.stderr).toContain('could not read Username');
  expect(credentials).toEqual(['']);
  expect((await gitOf(home, home, 'config', '--global', '--get-all', 'credential.helper')).stdout).toBe(`store --file=${join(home, 'global-store')}\n`);
});

it("stops answering for git when another User's login drops the own agent", async () => {
  const { house, home, credentials } = await loggedIn();
  answerOwnAgent(house, 'ahp_own');
  serveLogin(house, 'environment-one', 'ahk_second', { user: 'user-two' });

  expect((await logIn(house, home)).exit).toBe(0);
  const listed = await gitOf(home, home, 'ls-remote', `${house.origin}/app/a_app.git`);

  expect(listed.stderr).toContain('could not read Username');
  expect(credentials).toEqual(['']);
});

it("answers git for no other House than the own agent's", async () => {
  const home = await temporaryHome();
  await writeFile(join(home, 'own-agent.json'), JSON.stringify({ house: 'https://house.example', user: 'user-one', credential: 'ahp_own' }));
  const ask = (host: string) => {
    const helper = runKit(['git-credential', 'get'], { HOUSE_KIT_HOME: home });
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
  await placeKit(join(hosted.home, 'kit-bin'));
  await writeFile(join(hosted.home, 'own-agent.json'), JSON.stringify({ house: hosted.house.origin, user: 'user-one', credential: 'ahp_own' }));
  serveLogin(hosted.house, 'environment-one', 'ahk_held');
  expect((await logIn(hosted.house, hosted.home)).exit).toBe(0);
  const credentials = appRemote(hosted.house, COMMIT);
  await opened(hosted);

  directed(hosted, `@git ls-remote ${hosted.house.origin}/app/a_app.git`);

  const [ran] = await runs(hosted, 1);
  expect(ran).toMatchObject({ status: 0 });
  expect(credentials).toEqual([conversationCredential('conversation-1')]);
  expect((await gitOf(hosted.home, hosted.home, 'ls-remote', `${hosted.house.origin}/app/a_app.git`)).status).toBe(0);
  expect(credentials.at(-1)).toBe('ahp_own');
});
