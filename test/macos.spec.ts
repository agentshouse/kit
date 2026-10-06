import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostMac, lastInput } from './environment.ts';
import { alive } from './kit.ts';

it('reports macOS and its version as the operating system on a Mac', async () => {
  const hosted = await hostMac();

  const report = await until(() => hosted.house.requests.find((request) => request.path === '/kit/agents/report'));

  expect(report.body).toMatchObject({ os: 'macOS 27.0.1' });
});

it('kills the process and every process it started on a Mac', async () => {
  const hosted = await hostMac();
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
  hosted.input({ kind: 'message', text: '@spawn\n@wait', files: [], first: true });
  const spawned = await until(async () => (await hosted.adapterLog()).find((entry) => entry.spawned));
  expect(alive(spawned.spawned as number)).toBe(true);

  hosted.input({ kind: 'kill' });

  expect(await hosted.ack(lastInput())).toEqual({});
  expect(alive(spawned.pid as number)).toBe(false);
  await until(() => !alive(spawned.spawned as number) && !alive(spawned.clean as number));
});
