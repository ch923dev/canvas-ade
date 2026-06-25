import { defineConfig } from '@playwright/test'

// P2 load-test harness (terminal-crisp umbrella). DELIBERATELY separate from the gate
// config (playwright.config.ts, testMatch '**/*.e2e.ts'): bench files are '**/*.bench.ts'
// so they NEVER join the pre-push/pre-merge e2e suite. A benchmark with timing thresholds
// would be flaky as a gate — this is a measurement tool, run on demand:
//   pnpm exec playwright test --config playwright.bench.config.ts
// It drives the BUILT app (out/main/index.js) via the same _electron fixtures.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.bench.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // Each test streams for ~12s across three camera phases × several N values.
  timeout: 240_000,
  expect: { timeout: 15_000 }
})
