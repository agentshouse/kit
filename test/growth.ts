import { runInNewContext } from 'node:vm';

export const GROWTH_BOUND = 8;

const ATTEMPTS = 3;

function spent(work: () => unknown, limit = Infinity): number {
  const before = process.threadCpuUsage();
  try {
    runInNewContext('work()', { work }, Number.isFinite(limit) ? { timeout: limit } : {});
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return Infinity;
    throw error;
  }
  const after = process.threadCpuUsage(before);
  return after.user + after.system;
}

export function growth(quarter: () => unknown, whole: () => unknown): number {
  quarter();
  let base = Infinity;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) base = Math.min(base, spent(quarter));
  // Work four times larger is stopped once it has run far past what linear growth from the quarter allows.
  const timeout = Math.ceil((4 * GROWTH_BOUND * base) / 1_000);
  let ratio = Infinity;
  for (let attempt = 0; attempt < ATTEMPTS && ratio >= GROWTH_BOUND; attempt += 1) {
    ratio = Math.min(ratio, spent(whole, timeout) / base);
  }
  return ratio;
}
