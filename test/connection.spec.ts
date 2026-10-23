import { expect, it } from 'vitest';
import { CONNECTION_SILENCE_MS } from '../src/connection.ts';
import { Silence, type SilenceClock } from '../src/silence.ts';

interface Timer {
  delay: number;
  callback: () => void;
  cleared: boolean;
}

function clock(): { clock: SilenceClock; timers: Timer[] } {
  const timers: Timer[] = [];
  return {
    clock: {
      later: (delay, callback) => {
        const timer = { delay, callback, cleared: false };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clear: (timer) => {
        (timer as unknown as Timer).cleared = true;
      },
    },
    timers,
  };
}

function fire(timer: Timer): void {
  if (!timer.cleared) timer.callback();
}

it('drops the Kit connection only after two missed House beats, and each received notification restarts that deadline', () => {
  const fake = clock();
  let dropped = 0;
  const silence = new Silence(
    CONNECTION_SILENCE_MS,
    () => {
      dropped += 1;
    },
    fake.clock,
  );

  silence.heard();
  expect(fake.timers).toHaveLength(1);
  expect(fake.timers[0]).toMatchObject({ delay: CONNECTION_SILENCE_MS, cleared: false });

  silence.heard();
  expect(fake.timers[0]!.cleared).toBe(true);
  expect(fake.timers[1]).toMatchObject({ delay: CONNECTION_SILENCE_MS, cleared: false });
  fire(fake.timers[0]!);
  expect(dropped).toBe(0);

  fire(fake.timers[1]!);
  expect(dropped).toBe(1);
});
