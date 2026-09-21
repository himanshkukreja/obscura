import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (n: string) =>
  fileURLToPath(new URL(`./packages/${n}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source, not dist, so `npm test` needs no build step.
    alias: {
      '@obscura/shared': pkg('shared'),
      '@obscura/storage': pkg('storage'),
      '@obscura/media': pkg('media'),
      '@obscura/encryption': pkg('encryption'),
      '@obscura/integrity': pkg('integrity'),
      '@obscura/db': pkg('db'),
      '@obscura/auth': pkg('auth'),
      '@obscura/delivery': pkg('delivery'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
