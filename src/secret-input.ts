import type { House } from './api.ts';

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
  while (waiting()) {
    try {
      const held = await house.post<Held>(`/kit/secret-input/${subject}`, { steps });
      if (held.outcome === 'collected') return held.content;
      if (held.release !== 'held') return null;
    } catch (error) {
      process.stderr.write(`kit: ${error instanceof Error ? error.message : String(error)}\n`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return null;
}
