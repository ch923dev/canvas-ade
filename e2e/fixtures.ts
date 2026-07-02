import {
  _electron,
  test as base,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

type TestFixtures = { page: Page }
type WorkerFixtures = { electronApp: ElectronApplication }

// Whether `tracing.start` succeeded for the current worker's app context. workers:1 +
// one app per worker ⇒ this module-level flag is per-worker-process safe. If the Electron
// context ever refuses tracing, we degrade to "no trace" rather than failing every test.
let tracingStarted = false

/**
 * Worker-scoped Electron instance. With workers:1 Playwright runs ALL spec files in ONE
 * worker and REUSES this app across them (it discards + relaunches the worker only after
 * a test FAILS). So state can leak between specs within a worker — the per-test `reset()`
 * (page fixture, below) is what guarantees each test a clean slate, including re-mounting
 * the canvas if a prior spec drove the app to the error WelcomeScreen (reset-isolation.e2e.ts).
 *
 * Evidence capture (E1): every test runs inside a Playwright trace chunk. On FAILURE the
 * chunk + a renderer screenshot are written to the test's output dir and attached to the
 * HTML report (`pnpm exec playwright show-report`); on success the chunk is discarded so
 * green runs stay cheap. Set `E2E_VIDEO=1` to also record a `.webm` per spec into
 * `test-results/videos` (best-effort — video under xvfb on the Linux leg is unreliable,
 * Playwright #8936, so trace is the canonical artifact). The renderer screenshot now captures the
 * full DOM, including each Browser board's OSR `<canvas>`; a MAIN-side PNG of one board's offscreen
 * page is available via the `captureOsrToFile` helper.
 */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  electronApp: [
    async ({}, use) => {
      // Headless Linux CI: Electron's SUID chrome-sandbox helper is misconfigured on
      // unprivileged runners (Electron #42510) + Ubuntu 24.04 AppArmor restricts user
      // namespaces → a sandboxed launch aborts/times out. --no-sandbox is a flag on the
      // TEST launch ONLY; it does NOT change the app's webPreferences.sandbox:true.
      // --disable-dev-shm-usage avoids the small /dev/shm on runners. Both are
      // research-confirmed (docs/research/2026-06-03-electron-playwright-linux-ci.md).
      // A software-GL flag may be appended after the T5a spike if capturePage is blank.
      const launchArgs = ['out/main/index.js']
      if (process.env.CI && process.platform === 'linux') {
        launchArgs.push('--no-sandbox', '--disable-dev-shm-usage')
      }
      const app = await _electron.launch({
        args: launchArgs,
        // CANVAS_FAKE_MEDIA: MAIN translates this into Chromium's fake capture-device
        // switch (voiceIpc.applyFakeMediaSwitches — env-gated in MAIN, not a launch arg:
        // playwright#16621). Only getUserMedia consumers see it (the @voice spec); it
        // replaces any real mic with a deterministic generated tone on every leg.
        env: { ...process.env, CANVAS_E2E: '1', CANVAS_FAKE_MEDIA: '1' },
        // Opt-in full-session video (one .webm per spec). Off by default so green runs
        // stay fast; turn on for a repro session with `E2E_VIDEO=1`.
        ...(process.env.E2E_VIDEO ? { recordVideo: { dir: 'test-results/videos' } } : {})
      })
      const pg = await app.firstWindow()
      // The hook installs after React mounts — wait for it (mirrors runE2ESmoke's 8s gate).
      await expect
        .poll(
          () =>
            pg.evaluate(() => {
              const g = globalThis as unknown as { __canvasE2E?: unknown }
              return !!g.__canvasE2E
            }),
          { timeout: 10_000 }
        )
        .toBe(true)
      // Start one trace recording on the context; per-test chunks (below) carve out one
      // trace per test. Guarded: if the Electron context refuses tracing, degrade
      // gracefully (run the tests, just without traces) rather than red-screen the suite.
      tracingStarted = false
      try {
        await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
        tracingStarted = true
      } catch {
        /* tracing unavailable on this context — continue without it */
      }
      await use(app)
      await app.close()
    },
    { scope: 'worker' }
  ],
  // Override the built-in `page` fixture to reset canvas state before each test and to
  // capture evidence (trace chunk + screenshot) when the test fails.
  page: async ({ electronApp }, use, testInfo) => {
    const page = await electronApp.firstWindow()
    await page.bringToFront() // sendInputEvent needs the window focused
    await page.evaluate(() => {
      const g = globalThis as unknown as {
        __canvasE2E: { reset: () => Promise<unknown> }
      }
      return g.__canvasE2E.reset()
    })
    const context = electronApp.context()
    if (tracingStarted) {
      await context.tracing.startChunk({ title: testInfo.title }).catch(() => {})
    }

    await use(page)

    const failed = testInfo.status !== testInfo.expectedStatus
    if (tracingStarted) {
      if (failed) {
        const tracePath = testInfo.outputPath('trace.zip')
        await context.tracing.stopChunk({ path: tracePath }).catch(() => {})
        await testInfo
          .attach('trace', { path: tracePath, contentType: 'application/zip' })
          .catch(() => {})
      } else {
        await context.tracing.stopChunk().catch(() => {}) // discard on success
      }
    }
    if (failed) {
      // Full renderer DOM, including each Browser board's OSR <canvas>. For a board's offscreen
      // page on its own, the MAIN captureOsrToFile helper grabs it directly.
      const shotPath = testInfo.outputPath('failure.png')
      try {
        await page.screenshot({ path: shotPath })
        await testInfo.attach('failure-screenshot', { path: shotPath, contentType: 'image/png' })
      } catch {
        /* page may already be gone */
      }
    }
  }
})

export { expect }
