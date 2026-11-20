import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    // Windows runners start hosts and subprocesses more slowly; the Linux gate
    // keeps the tighter limits so a real hang still fails quickly there.
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
    hookTimeout: process.platform === 'win32' ? 30_000 : 10_000,
  },
})
