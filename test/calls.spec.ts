import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { House } from '../src/api.ts';
import { Calls } from '../src/calls.ts';
import { settle, until } from './double.ts';
import { hostKit, lastCall } from './environment.ts';
import { temporaryHome } from './kit.ts';

it('keeps a pending Kit call Result in the current call-results store', async () => {
  const home = await temporaryHome();
  vi.stubEnv('HOUSE_KIT_HOME', home);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const calls = new Calls({} as House, () => undefined);

  calls.keepResult('call-1', { refused: 'not carried out' });

  expect(JSON.parse(await readFile(join(home, 'call-results.json'), 'utf8'))).toEqual({
    'call-1': { refused: 'not carried out' },
  });
});

it('refuses a Kit call whose method it does not know, naming the method, and returns its refusal once', async () => {
  const hosted = await hostKit();

  hosted.call({ kind: 'rewind', turn_id: 'turn-1' });

  expect(await hosted.result(lastCall())).toEqual({ refused: 'This Kit does not know rewind; install it again.' });
  await settle();
  expect(hosted.results.map((result) => result.params.input)).toEqual([lastCall()]);
  expect(hosted.connection.notifications.filter((notification) => notification.type === 'process')).toEqual([]);
});

it('refuses a Kit call whose method it does not know with the install command its bootstrap recorded, which updates it', async () => {
  const home = await temporaryHome();
  const command = `sh -c 'kit=$(curl -fsSL "$0") || exit 1; eval "$kit"' https://dev.agents.house/kit --linux`;
  await writeFile(join(home, 'install-command'), `${command}\n`);
  const hosted = await hostKit([{}], { home, skills: false });

  hosted.call({ kind: 'rewind', turn_id: 'turn-1' });

  expect(await hosted.result(lastCall())).toEqual({ refused: `This Kit does not know rewind. Update it: ${command}` });
});

it('carries a Kit call of a method it knows though the call names a field it does not know', async () => {
  const hosted = await hostKit();

  hosted.call({ kind: 'open', resumed_from: 'a later House' });

  expect(await hosted.result(lastCall())).toEqual({ provider_session_id: expect.any(String) });
});

it('opens no second session for an open its reopened connection sends after it returned its result, and returns the same result again', async () => {
  const hosted = await hostKit();
  hosted.call({ kind: 'open' });
  const call = lastCall();
  const answer = await hosted.result(call);
  hosted.connection.close(1001, 'shutting_down');
  await until(() => hosted.house.connections[1]);

  hosted.call({ input_id: call, kind: 'open' });

  await until(() => hosted.results[1]);
  await settle();
  expect(hosted.results.map((result) => [result.params.input, result.body])).toEqual([
    [call, answer],
    [call, answer],
  ]);
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/new')).toHaveLength(1);
});
