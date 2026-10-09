const every = globalThis.setInterval;

// Capping every Kit interval at 300 ms makes any timer fire several times within the second and a half a spec watches for one.
globalThis.setInterval = ((handler: () => void, timeout?: number) =>
  every(handler, Math.min(timeout ?? 0, 300))) as typeof setInterval;
