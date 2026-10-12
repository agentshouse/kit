import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { until } from './double.ts';
import { hostKit } from './environment.ts';

const WRITTEN_BY_0_2_1 = fileURLToPath(new URL('./fixtures/home/0.2.1', import.meta.url));
const RECORD = join('local-copies', 'rooms', 'r_ledger.json');

it('reads the Kit home release 0.2.1 wrote: it finishes the pending update and keeps every field of the Local copy record', async () => {
  const written = JSON.parse(await readFile(join(WRITTEN_BY_0_2_1, RECORD), 'utf8')) as Record<string, unknown>;
  const hosted = await hostKit([{}], { prepare: (home) => cp(WRITTEN_BY_0_2_1, home, { recursive: true }) });

  expect(await hosted.ack('update-0.2.1')).toEqual({});
  const record = await until(async () => {
    const read = JSON.parse(await readFile(join(hosted.home, RECORD), 'utf8')) as Record<string, unknown>;
    return read.active === false && read;
  });
  expect(record).toEqual({ ...written, active: false });
});
