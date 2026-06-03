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
  // Bounded CI retries: browser-trio / whiteboard-fullview-add are documented ENV
  // capturePage/determinism flakes on contended runners (memory e2e-browser-trio-flake),
  // not bugs. 0 locally so a real local failure is loud. workers:1 stays.
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 }
})
