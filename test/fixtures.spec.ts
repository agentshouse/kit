import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const HOST_PATH = /\/Users\/|%2FUsers%2F|\/home\/(?!agent\/)/;
const RECORDED = ['events', 'work'].flatMap((folder) => readdirSync(new URL(folder, FIXTURES)).map((name) => `${folder}/${name}`));

function bytesAsText(_key: string, value: unknown): unknown {
  const bytes = Array.isArray(value) && value.length > 0 && value.every((item) => Number.isInteger(item) && item >= 0 && item < 256);
  return bytes ? Buffer.from(value).toString('utf8') : value;
}

it.each(RECORDED)("keeps the recording host's path out of %s, in its lines, its byte arrays' text and its text joined across chunks", (fixture) => {
  const entries = readFileSync(new URL(fixture, FIXTURES), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const chunks = entries.map((entry) => entry.params?.update?.content?.text ?? '').join('');
  const deltas = entries.map((entry) => entry.tap?.params?.delta ?? '').join('');
  expect([JSON.stringify(entries, bytesAsText), chunks, deltas].join('\n')).not.toMatch(HOST_PATH);
});
