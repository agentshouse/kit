import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostMac, lastCall } from './environment.ts';
import { alive } from './kit.ts';

it('reports macOS and its version as the operating system on a Mac', async () => {
  const hosted = await hostMac();

  const report = await until(() => hosted.house.requests.find((request) => request.path === '/kit/agents/report'));

  expect(report.body).toMatchObject({ os: 'macOS 27.0.1', form: 'laptop' });
});

it('kills the process and every process it started on a Mac', async () => {
  const hosted = await hostMac();
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  hosted.call({ kind: 'message', text: '@spawn\n@wait', first: true });
  const spawned = await until(async () => (await hosted.adapterLog()).find((entry) => entry.spawned));
  expect(alive(spawned.spawned as number)).toBe(true);

  hosted.call({ kind: 'kill' });

  expect(await hosted.result(lastCall())).toEqual({});
  expect(alive(spawned.pid as number)).toBe(false);
  await until(() => !alive(spawned.spawned as number) && !alive(spawned.clean as number));
});

it("opens a Claude Code session whose sandbox lets through its conversation's bridge socket alone on a Mac", async () => {
  const hosted = await hostMac({}, [{ kind: 'claude-agent-acp', model: 'default', effort: null }]);

  hosted.call({ kind: 'open' });

  await hosted.result(lastCall());
  const log = await hosted.adapterLog();
  const bridge = log
    .map((entry) => (entry.env as Record<string, string> | undefined)?.HOUSE_BRIDGE)
    .find((socket) => socket !== undefined);
  expect(log.find((entry) => entry.method === 'session/new')!.params).toMatchObject({
    _meta: { claudeCode: { options: { settings: { sandbox: { network: { allowUnixSockets: [bridge] } } } } } },
  });
});
