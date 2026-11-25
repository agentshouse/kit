import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostMac, lastCall } from './environment.ts';
import { alive } from './kit.ts';

it('reports macOS and its version as the operating system on a Mac', async () => {
  const hosted = await hostMac();

  const report = await until(() => hosted.house.requests.find((request) => request.path === '/kit/agents/report'));

  expect(report.body).toMatchObject({ os: 'macOS 27.0.1', form: 'laptop' });
});

it('kills the process and every process still descending from it on a Mac, and leaves running what has left it', async () => {
  const hosted = await hostMac();
  hosted.call({ kind: 'open' });
  await hosted.result(lastCall());
  hosted.call({ kind: 'message', text: '@server\n@background\n@spawn\n@wait', first: true });
  const log = await until(async () => {
    const entries = await hosted.adapterLog();
    return entries.some((entry) => entry.spawned) ? entries : undefined;
  });
  const one = (field: string) => log.find((entry) => entry[field] !== undefined)!;
  const descending = [one('spawned').pid, one('server').server, one('background').background] as number[];
  const left = [one('spawned').spawned, one('spawned').clean] as number[];
  expect([...descending, ...left].map(alive)).toEqual([true, true, true, true, true]);

  hosted.call({ kind: 'kill' });

  expect(await hosted.result(lastCall())).toEqual({});
  await until(() => descending.every((pid) => !alive(pid)));
  expect(left.map(alive)).toEqual([true, true]);
});

it("opens a Claude Code session whose sandbox lets through its conversation's bridge socket alone on a Mac", async () => {
  const hosted = await hostMac({}, [{ kind: 'claude-agent-acp', model: 'default', effort: 'high' }]);

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
