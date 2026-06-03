import { defineConfig } from '@playwright/test'

// T4: drives the BUILT app (out/main/index.js) via @playwright/test _electron.
// workers:1 + no parallel — native WebContentsView + node-pty + GPU serialize cleanly
// and this dampens the known browser-trio capturePage contention flake
// (memory e2e-browser-trio-flake). This is NOT the Vitest gate (pnpm test stays 680).
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 }
})
