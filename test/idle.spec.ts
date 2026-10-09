import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { settle, until } from './double.ts';
import { hostKit, lastInput, type Hosted } from './environment.ts';

const ended = (hosted: Hosted) => hosted.turns.filter((turn) => turn.path.endsWith('/ended'));

async function opened(hosted: Hosted): Promise<void> {
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());
}

it('reports idle once no turn runs and not while a turn runs without waiting on a question', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  await opened(hosted);
  await until(() => hosted.idles[1]);

  // The turn holds a second and a half, outlasting the half second the spec watches for an idle report.
  hosted.input({ kind: 'message', text: '@hold 1500\n@say done', files: [], first: true });
  await until(() => hosted.turns.find((turn) => turn.path.endsWith('/started')));
  await settle();
  expect(hosted.idles).toHaveLength(2);

  await until(() => ended(hosted)[0]);
  await until(() => hosted.idles[2]);
});

it('reports idle only after it acknowledges the input it carried out', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  hosted.house.route('POST', '/kit/inputs/:input/ack', async (request) => {
    // The acknowledgement takes three tenths of a second, so an idle report sent before it would show.
    await new Promise((resolve) => setTimeout(resolve, 300));
    hosted.acks.push(request);
    return { body: {} };
  });

  hosted.input({ kind: 'open' });

  await hosted.ack(lastInput());
  const paths = (await until(() => hosted.idles[1] && hosted.house.requests)).map((request) => request.path);
  expect(paths.lastIndexOf('/kit/idle')).toBeGreaterThan(paths.indexOf(`/kit/inputs/${lastInput()}/ack`));
  expect(paths.filter((path) => path === '/kit/idle')).toHaveLength(2);
});

it('counts a turn waiting on a non-secret question as idle', async () => {
  const hosted = await hostKit();
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.input({ kind: 'message', text: '@ask', files: [], first: true });
  await until(() => hosted.interactions[0]);

  await until(() => hosted.idles[2]);
});

it('does not count a turn waiting on a secret question as idle', async () => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/kit/secret-input/:subject', async () => {
    // House holds the secret question two tenths of a second each time, so the Kit keeps holding it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { body: { outcome: 'released', release: 'held' } };
  });
  await opened(hosted);
  await until(() => hosted.idles[1]);

  hosted.input({ kind: 'message', text: `@secret ${createHash('sha256').update('x').digest('hex')}`, files: [], first: true });
  await until(() => hosted.interactions[0]);
  await settle();

  expect(hosted.idles).toHaveLength(2);
});

it.each(['codex-acp', 'claude-agent-acp', 'grok-build'])('does not report idle while %s reports a running background job', async (kind) => {
  const hosted = await hostKit([{ kind }]);
  await opened(hosted);
  await until(() => hosted.idles[1]);
  expect(
    ((await hosted.adapterLog()).find((entry) => entry.method === 'initialize')!.params as {
      clientCapabilities: { _meta: unknown };
    }).clientCapabilities._meta,
  ).toEqual({ jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } });

  hosted.input({ kind: 'message', text: '@job job-1\n@say started', files: [], first: true });
  await until(() => ended(hosted)[0]);
  await settle();
  expect(hosted.idles).toHaveLength(2);

  hosted.input({ kind: 'message', text: '@jobdone job-1', files: [], first: false });
  await until(() => ended(hosted)[1]);
  await until(() => hosted.idles[2]);
});

it('drops an idle report House did not take once the CLI reports a running background job', async () => {
  const hosted = await hostKit();
  await until(() => hosted.idles[0]);
  const endedAtReport: number[] = [];
  hosted.house.route('POST', '/kit/idle', (request) => {
    endedAtReport.push(ended(hosted).length);
    if (endedAtReport.length === 1) return { status: 503, body: { error: { code: 'house_unavailable', retryable: true } } };
    hosted.idles.push(request);
    return { body: {} };
  });
  await opened(hosted);
  await until(() => endedAtReport.length > 0);

  hosted.input({ kind: 'message', text: '@job job-1\n@say started', files: [], first: true });
  await until(() => ended(hosted)[0]);
  // A second outlasts the first retry of the refused idle report, which the running job must drop.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  hosted.input({ kind: 'message', text: '@jobdone job-1', files: [], first: false });
  await until(() => ended(hosted)[1]);
  await until(() => hosted.idles[1]);

  expect(endedAtReport).toEqual([0, 2]);
});
