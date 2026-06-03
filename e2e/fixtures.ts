import {
  _electron,
  test as base,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

type TestFixtures = { page: Page }
type WorkerFixtures = { electronApp: ElectronApplication }

/**
 * Per-spec Electron instance. `electronApp` is worker-scoped → launched once per spec
 * file (workers:1 + one spec per worker run), so a spec's native-view/PTY churn can't
 * bleed into another spec. `page` resets the canvas before EACH test.
 */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  electronApp: [
    async ({}, use) => {
      const app = await _electron.launch({
        args: ['out/main/index.js'],
        env: { ...process.env, CANVAS_E2E: '1' }
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
      await use(app)
      await app.close()
    },
    { scope: 'worker' }
  ],
  // Override the built-in `page` fixture to reset canvas state before each test.
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.bringToFront() // sendInputEvent needs the window focused
    await page.evaluate(() => {
      const g = globalThis as unknown as {
        __canvasE2E: { reset: () => Promise<unknown> }
      }
      return g.__canvasE2E.reset()
    })
    await use(page)
  }
})

export { expect }
