import { configDefaults, defineConfig } from 'vitest/config';

const TRANSCRIPTION = 'test/transcription.spec.ts';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.claude/**', 'tmp/**'],
    // A spec starts real Kit and double processes, several in a row, so it gets thirty seconds before it counts as hung.
    testTimeout: 30_000,
    projects: [
      { extends: true, test: { name: 'kit', exclude: [TRANSCRIPTION], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'transcription', include: [TRANSCRIPTION], sequence: { groupOrder: 1 } } },
    ],
  },
});
