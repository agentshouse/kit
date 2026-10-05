import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit, lastInput, type Hosted } from './environment.ts';
import { alive, temporaryHome } from './kit.ts';

async function onMac(): Promise<Hosted> {
  const home = await temporaryHome();
  const bin = join(home, 'macos');
  await mkdir(bin);
  await writeFile(join(bin, 'ps'), `#!/bin/sh\nexec env -u NODE_OPTIONS ${process.execPath} ${fileURLToPath(new URL('./ps.ts', import.meta.url))} "$@"\n`);
  await writeFile(join(bin, 'sw_vers'), '#!/bin/sh\n[ "$*" = -productVersion ] && echo 27.0.1\n');
  await Promise.all(['ps', 'sw_vers'].map((tool) => chmod(join(bin, tool), 0o755)));
  return hostKit([{}], {
    home,
    skills: false,
    environment: {
      PATH: `${bin}:${join(home, 'bin')}:${process.env.PATH}`,
      NODE_OPTIONS: `--import=${fileURLToPath(new URL('./darwin.ts', import.meta.url))}`,
    },
  });
}

it('reports macOS and its version as the operating system on a Mac', async () => {
  const hosted = await onMac();

  const report = await until(() => hosted.house.requests.find((request) => request.path === '/kit/agents/report'));

  expect(report.body).toMatchObject({ os: 'macOS 27.0.1' });
});

it('kills the process and every process it started on a Mac', async () => {
  const hosted = await onMac();
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
