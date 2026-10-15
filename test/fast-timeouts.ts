const later = globalThis.setTimeout;

// A test-only Kit reaches its two-beat silence deadline in one third of a second.
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
  later(callback, Math.min(delay ?? 0, 300), ...args)) as typeof setTimeout;
