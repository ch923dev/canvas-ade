import { defineConfig } from '@playwright/test'

// T4: drives the BUILT app (out/main/index.js) via @playwright/test _electron.
// workers:1 + no parallel — native WebContentsView + node-pty + GPU serialize cleanly
// and this dampens the known browser-trio capturePage contention flake
// (memory e2e-browser-trio-flake). This is NOT the Vitest gate (pnpm test stays 680).
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  // Files still run whole (fullyParallel:false) — E2E_WORKERS only decides how many
  // Electron apps run side by side. Default 1: the Linux Docker leg is CPU-capped and
  // UNMEASURED at 2, and CI likewise, so neither may silently inherit it. The local
  // Windows push leg opts in via .githooks/pre-push.
  //
  // Measured 2026-07-28 on this box, 342 specs: workers:1 = 10.1m; workers:2 = 6.8/5.4/6.5m
  // across three runs (~39% faster). Cross-worker state leakage is a non-issue — each
  // worker gets its OWN Electron process, so stores are already isolated. What DOES
  // contend is OS-level: window focus, ConPTY, GPU. That surfaced as 4 hard failures in
  // one of three retries:0 runs (boardKeyboard:58, terminal:62, terminalCrisp:155/:200),
  // and zero in another — probabilistic, not a fixed incompatible set. Under the real
  // gate config (retries:2) the suite is green with those absorbed as flaky-retried.
  // The trade is explicit: ~3.4 min/run bought with MORE reliance on retries.
  workers: Number(process.env.E2E_WORKERS ?? 1),
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
