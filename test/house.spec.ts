import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('refuses a house command outside an Agent conversation', () => {
  const ran = spawnSync(process.execPath, [fileURLToPath(new URL('../src/house.ts', import.meta.url)), 'tools'], {
    encoding: 'utf8',
  });

  expect(ran.status).toBe(1);
  expect(ran.stderr).toBe('house: house runs inside an Agent conversation\n');
});
