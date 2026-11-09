import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { House } from '../src/api.ts';
import { Calls } from '../src/calls.ts';
import { idOf, settle, until, without } from './double.ts';
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
  expect(hosted.results.map((result) => [idOf(result, 'call'), without(result, 'call')])).toEqual([
    [call, answer],
    [call, answer],
  ]);
  expect((await hosted.adapterLog()).filter((entry) => entry.method === 'session/new')).toHaveLength(1);
});
