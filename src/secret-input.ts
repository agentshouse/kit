import { finalRefusal, retryDelay, type House } from './api.ts';

export type Step =
  | { kind: 'visit'; label: string; url: string }
  | { kind: 'show'; label: string; text: string }
  | { kind: 'collect'; label: string; name: string; description?: string };

type Held = { outcome: 'collected'; content: Record<string, string> } | { outcome: 'released'; release: string };

export async function holdSecretInput(
  house: House,
  subject: string,
  steps: Step[],
  waiting: () => boolean,
): Promise<Record<string, string> | null> {
  for (let failures = 0; waiting(); ) {
    try {
      const held = await house.post<Held>(`/kit/secret-input/${subject}`, { steps });
      if (held.outcome === 'collected') return held.content;
      if (held.release !== 'held') return null;
      failures = 0;
    } catch (error) {
      if (finalRefusal(error)) return null;
      process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
      // A wait that did not reach House is held again on the jittered curve for as long as its asker still waits.
      await new Promise((resolve) => setTimeout(resolve, retryDelay(failures++)));
    }
  }
  return null;
}
