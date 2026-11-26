import { afterEach, expect, it, vi } from 'vitest';
import { SaveTimer } from '../src/saves.ts';

const SECOND = 1000;

interface Timed {
  timer: SaveTimer;
  saves: number[];
}

function timed(): Timed {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const start = Date.now();
  const saves: number[] = [];
  const timer: SaveTimer = new SaveTimer(() => {
    saves.push(Date.now() - start);
    timer.taken();
  });
  return { timer, saves };
}

async function changedEverySecond(timer: SaveTimer, seconds: number): Promise<void> {
  for (let second = 0; second < seconds; second++) {
    timer.changed();
    await vi.advanceTimersByTimeAsync(SECOND);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

it('saves once, 3 seconds after the last of changes that land within a few seconds of each other', async () => {
  const { timer, saves } = timed();
  timer.changed();
  await vi.advanceTimersByTimeAsync(SECOND);
  timer.changed();
  await vi.advanceTimersByTimeAsync(1.5 * SECOND);
  timer.changed();

  await vi.advanceTimersByTimeAsync(3 * SECOND - 1);
  expect(saves).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(saves).toEqual([5.5 * SECOND]);

  await vi.advanceTimersByTimeAsync(60 * SECOND);
  expect(saves).toEqual([5.5 * SECOND]);
});

it('saves 30 seconds after the first change no save sent while changes go on every second, then 3 seconds after the last one', async () => {
  const { timer, saves } = timed();
  await changedEverySecond(timer, 41);

  expect(saves).toEqual([30 * SECOND]);
  await vi.advanceTimersByTimeAsync(3 * SECOND);
  expect(saves).toEqual([30 * SECOND, 43 * SECOND]);
});

it('saves at the time House named for admitting writes again, with no change', async () => {
  const { timer, saves } = timed();
  timer.admitted(Date.now() + 90 * SECOND);
  await vi.advanceTimersByTimeAsync(90 * SECOND - 1);
  expect(saves).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(saves).toEqual([90 * SECOND]);
});
