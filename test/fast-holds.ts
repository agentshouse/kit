import { CONNECTION_SILENCE_MS } from '../src/connection.ts';

const later = globalThis.setTimeout;

// A test-only Kit wakes from any wait longer than its connection's silence deadline within a third of a second and reads its moved clock again, so a spec ends a hold by moving the clock.
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
  later(callback, (delay ?? 0) > CONNECTION_SILENCE_MS ? 300 : delay, ...args)) as typeof setTimeout;
