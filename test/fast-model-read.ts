import { MODEL_READ_MS } from '../src/agents.ts';

const timeout = AbortSignal.timeout.bind(AbortSignal);

// A test-only Kit ends a model read after five seconds, longer than a test CLI takes to answer one on a loaded runner.
AbortSignal.timeout = (delay: number) => timeout(delay === MODEL_READ_MS ? 5_000 : delay);
