import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { hostKit } from './environment.ts';

const WRITTEN_BY_0_2_1 = fileURLToPath(new URL('./fixtures/home/0.2.1', import.meta.url));

it('reads the Kit home release 0.2.1 wrote: it finishes the pending update', async () => {
  const hosted = await hostKit([{}], { prepare: (home) => cp(WRITTEN_BY_0_2_1, home, { recursive: true }) });

  expect(await hosted.ack('update-0.2.1')).toEqual({});
});
