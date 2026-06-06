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
  // Bounded retries: browser-trio / whiteboard-fullview-add are documented ENV
  // capturePage/determinism flakes (memory e2e-browser-trio-flake), not bugs. On in
  // CI and in the pre-commit hook (E2E_PRECOMMIT) so the flake can't false-block a
  // commit; 0 for a plain local run so a real failure is loud. workers:1 stays.
  retries: process.env.CI || process.env.E2E_PRECOMMIT ? 2 : 0,
  // `list` streams to the console; `html` (never auto-open) collects the per-test
  // evidence wired in e2e/fixtures.ts — a trace zip + failure screenshot attached on
  // failure, browsable with `pnpm exec playwright show-report`. The Linux Docker leg
  // overrides the reporter to `line` (Dockerfile.e2e) so a non-TTY pipe doesn't block.
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 15_000 }
})
