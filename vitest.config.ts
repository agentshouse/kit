import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.claude/**', 'tmp/**'],
    // A spec starts real Kit and double processes, several in a row, so it gets thirty seconds before it counts as hung.
    testTimeout: 30_000,
  },
});
