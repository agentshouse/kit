import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastInput } from './environment.ts';

const STORED: Record<string, { name: string; content: Buffer }> = {
  'version-1': { name: 'notes.txt', content: Buffer.from('first file\n') },
  'version-2': { name: 'data.bin', content: Buffer.from([0, 1, 2, 255]) },
  'version-3': { name: 'notes.txt', content: Buffer.from('second file of the same name\n') },
};

it("places a message's files under .house/files/<message id>/ with their stored bytes, each its own, and lists their paths", async () => {
  const hosted = await hostKit();
  hosted.house.route('POST', '/kit/conversation/originals/get', (received) => {
    const { version } = received.body as { version: string };
    return {
      body: {
        version,
        message: 'message-1',
        name: STORED[version]!.name,
        download: { method: 'GET', url: `${hosted.house.origin}/bytes/${version}`, expires_at: '2026-10-03T12:00:00Z' },
      },
    };
  });
  hosted.house.route('GET', '/bytes/:version', (received) => ({
    bytes: { type: 'application/octet-stream', content: STORED[received.params.version!]!.content },
  }));
  hosted.input({ kind: 'open' });
  await hosted.ack(lastInput());

  hosted.input({
    kind: 'message',
    text: 'read these',
    files: Object.entries(STORED).map(([version, file]) => ({
      version,
      name: file.name,
      media_type: 'application/octet-stream',
      bytes: file.content.length,
      sha256: createHash('sha256').update(file.content).digest('hex'),
    })),
    first: false,
  });

  expect(await hosted.ack(lastInput())).toEqual({});
  const paths = Object.entries(STORED).map(([version, file]) =>
    join(hosted.workingDirectory, '.house', 'files', 'message-1', version, file.name),
  );
  const prompted = await until(async () => (await hosted.adapterLog()).find((entry) => entry.method === 'session/prompt'));
  expect((prompted.params as { prompt: unknown }).prompt).toEqual([
    { type: 'text', text: 'read these' },
    { type: 'text', text: paths.join('\n') },
  ]);
  for (const [index, file] of Object.values(STORED).entries()) expect(await readFile(paths[index]!)).toEqual(file.content);
  expect(
    hosted.house.requests
      .filter((received) => received.path === '/kit/conversation/originals/get')
      .map((received) => [received.headers.authorization, received.body]),
  ).toEqual([
    ['Bearer ahk_held', { version: 'version-1', download: true }],
    ['Bearer ahk_held', { version: 'version-2', download: true }],
    ['Bearer ahk_held', { version: 'version-3', download: true }],
  ]);
});
