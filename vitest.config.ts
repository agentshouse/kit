import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.claude/**', 'tmp/**'],
    testTimeout: 30_000,
  },
});
