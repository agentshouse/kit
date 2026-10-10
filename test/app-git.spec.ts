import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startHouse, type House } from './double.ts';
import { appRemote, conversationCredential, directed, hostKit, opened, runs } from './environment.ts';
import { filesUnder, runKit, temporaryHome } from './kit.ts';
import { answerOwnAgent, confirm, serveLogin } from './login.ts';

const COMMIT = 'a'.repeat(40);

function gitOf(home: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const child = spawn('git', args, {
    cwd: home,
    env: { ...environment, HOME: home, GIT_CONFIG_SYSTEM: join(home, 'system.gitconfig'), GIT_TERMINAL_PROMPT: '0' },
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
  await writeFile(join(home, 'system.gitconfig'), `[credential]\n\thelper = store --file=${join(home, 'system-store')}\n`);
  await writeFile(join(home, '.gitconfig'), `[credential]\n\thelper = store --file=${join(home, 'global-store')}\n`);
}

async function loggedIn(): Promise<{ house: House; home: string; credentials: string[] }> {
  const house = await startHouse();
  const home = await temporaryHome();
  await storingHelpers(home);
  serveLogin(house, 'environment-one', 'ahk_first', 'ahp_own');
  expect((await confirm(house, home)).exit).toBe(0);
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

  const listed = await gitOf(home, 'ls-remote', `${house.origin}/app/a_app.git`);

  expect(listed).toMatchObject({ status: 0, stdout: `${COMMIT}\tHEAD\n${COMMIT}\trefs/heads/main\n` });
  expect(credentials).toEqual(['', 'ahp_own']);
  await expect(access(join(home, 'system-store'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(home, 'global-store'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await holding(home, 'ahp_own')).toEqual([join(home, 'own-agent.json')]);
});

it("stops answering for git once kit logout disconnects the computer, and leaves the User's other helpers", async () => {
  const { house, home, credentials } = await loggedIn();
  house.route('POST', '/kit/logout', () => ({ body: {} }));

  expect(await runKit(['logout'], { HOUSE_KIT_HOME: home }).exited).toBe(0);
  const listed = await gitOf(home, 'ls-remote', `${house.origin}/app/a_app.git`);

  expect(listed.status).not.toBe(0);
  expect(listed.stderr).toContain('could not read Username');
  expect(credentials).toEqual(['']);
  expect((await gitOf(home, 'config', '--global', '--get-all', 'credential.helper')).stdout).toBe(`store --file=${join(home, 'global-store')}\n`);
  expect((await gitOf(home, 'config', '--global', '--get-regexp', 'app')).stdout).toBe('');
});

it("stops answering for git when another User's login drops the own agent", async () => {
  const { house, home, credentials } = await loggedIn();
  answerOwnAgent(house, 'ahp_own');
  serveLogin(house, 'environment-one', 'ahk_second', undefined, 'user-two');

  expect((await confirm(house, home)).exit).toBe(0);
  const listed = await gitOf(home, 'ls-remote', `${house.origin}/app/a_app.git`);

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
  expect(await here.exited).toBe(0);
  expect(here.stdout()).toBe('username=house\npassword=ahp_own\n');
});

it("keeps a conversation's Git under its own credential while the own agent answers git outside it", async () => {
  const hosted = await hostKit();
  await writeFile(join(hosted.home, 'own-agent.json'), JSON.stringify({ house: hosted.house.origin, user: 'user-one', credential: 'ahp_own' }));
  serveLogin(hosted.house, 'environment-one', 'ahk_held');
  expect((await confirm(hosted.house, hosted.home)).exit).toBe(0);
  const credentials = appRemote(hosted.house, COMMIT);
  await opened(hosted);

  directed(hosted, `@git ls-remote ${hosted.house.origin}/app/a_app.git`);

  const [ran] = await runs(hosted, 1);
  expect(ran).toMatchObject({ status: 0 });
  expect(credentials).toEqual([conversationCredential('conversation-1')]);
  expect((await gitOf(hosted.home, 'ls-remote', `${hosted.house.origin}/app/a_app.git`)).status).toBe(0);
  expect(credentials.at(-1)).toBe('ahp_own');
});
