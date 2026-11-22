import type { SecretCeremonyStep } from '@agentshouse/kit-wire';
import { finalRefusal, resendDelay, type House } from './api.ts';

export async function holdSecretInput(
  house: House,
  subject: string,
  steps: SecretCeremonyStep[],
  waiting: () => boolean,
): Promise<Record<string, string> | null> {
  for (let failures = 0; waiting(); ) {
    try {
      const held = await house.act('secret-inputs/await', { subject, steps });
      if (held.outcome === 'collected') return held.content;
      if (held.release !== 'held') return null;
      failures = 0;
    } catch (error) {
      if (finalRefusal(error)) return null;
      process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
      // A wait that did not reach House is held again after the wait House names, else on the jittered curve, for as long as its asker still waits.
      await new Promise((resolve) => setTimeout(resolve, resendDelay(error, failures++)));
    }
  }
  return null;
}
