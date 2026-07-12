import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
