import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * @chrome Running-projects switcher (Alt-Tab-style hotkey overlay). The window-scoped switch hotkey
 * (MAIN forwards a direction on `project:cycleHotkey` — exactly what the window before-input-event
 * sends) raises an overlay listing the RUNNING projects: active first, then backgrounded residents,
 * snapshotted once so the cycle is stable. This drives the REAL channel + the REAL running set and
 * asserts overlay membership, keyboard nav, and the single-project empty state (cold recents never
 * appear). It never commits the switch — that pipeline is covered by the motion/dialog specs.
 *
 * Mint→open interleaved (project:open approves only the current dir/recents; createTempProject flips
 * currentDir). keep=true rides the Phase-2 harness path (no ask-on-switch dialog).
 */

type MainGlobal = {
  __canvasE2EMain: {
    createTempProject(prefix: string, name: string): Promise<string>
    teardownProject(tmp: string): void
  }
}

type RendererGlobal = {
  __canvasE2E: {
    openProjectFromDisk(dir: string): Promise<{ status: string }>
    switchProjectFromDisk(
      dir: string,
      keep: boolean
    ): Promise<{ outcome: string; status: string; dir: string | null; boardCount: number }>
  }
  api: {
    project: {
      closeBackground(dir: string): Promise<boolean>
      forgetKeepPolicy(dir: string): Promise<boolean>
    }
  }
}

function mintProject(electronApp: ElectronApplication, prefix: string, name: string) {
  return electronApp.evaluate(
    ({}, arg) =>
      (globalThis as unknown as MainGlobal).__canvasE2EMain.createTempProject(arg.prefix, arg.name),
    { prefix, name }
  )
}

function teardownProjects(electronApp: ElectronApplication, dirs: string[]) {
  return electronApp.evaluate(({}, ds) => {
    const m = (globalThis as unknown as MainGlobal).__canvasE2EMain
    for (const d of ds) m.teardownProject(d)
  }, dirs)
}

async function openFromDisk(page: Page, dir: string): Promise<void> {
  const r = await page.evaluate(
    (d) => (globalThis as unknown as RendererGlobal).__canvasE2E.openProjectFromDisk(d),
    dir
  )
  if (r.status !== 'open') throw new Error(`openProjectFromDisk(${dir}) settled '${r.status}'`)
}

/** Keep-switch to `dir` (backgrounds the outgoing project as a resident). */
function switchKeep(page: Page, dir: string) {
  return page.evaluate(
    (d) => (globalThis as unknown as RendererGlobal).__canvasE2E.switchProjectFromDisk(d, true),
    dir
  )
}

function closeBackground(page: Page, dir: string) {
  return page.evaluate(
    (d) => (globalThis as unknown as RendererGlobal).api.project.closeBackground(d),
    dir
  )
}

/** Fire the REAL main→renderer cycle channel (what the window before-input-event does on the chord). */
function fireCycle(electronApp: ElectronApplication, dir: 1 | -1) {
  return electronApp.evaluate(({ BrowserWindow }, d) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.isDestroyed())
    w?.webContents.send('project:cycleHotkey', d)
  }, dir)
}

/** Decline the recap-consent prompt if up — a fresh temp project is always consent-undecided and
 *  its modal, though it never blocks the window-capture keydown nav, sits over the overlay. */
async function declineRecapConsent(page: Page): Promise<void> {
  try {
    await page.locator('[data-test="recap-decline"]').click({ timeout: 5_000 })
  } catch {
    /* prompt never showed (already decided) — fine */
  }
}

test.describe('@chrome running-projects switcher (hotkey overlay)', () => {
  test('opens over the running set, Tab advances the highlight, Esc dismisses; single project → empty state', async ({
    page,
    electronApp
  }) => {
    const dirB = await mintProject(electronApp, 'canvas-e2e-switch-b-', 'switch-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-switch-a-', 'switch-a')
    try {
      await openFromDisk(page, dirA) // active A
      // Keep-switch A→B while currentDir is A → A becomes a resident; running set = B (active) + A.
      expect((await switchKeep(page, dirB)).outcome).toBe('switched')
      await declineRecapConsent(page)

      const overlay = page.locator('[data-testid="running-switcher"]')

      // ── Two running projects ──
      await fireCycle(electronApp, 1)
      await expect(overlay).toBeVisible({ timeout: 8_000 })
      await expect(page.locator('.rps-card')).toHaveCount(2)
      await expect(page.locator('.rps-count')).toHaveText('2 running')
      // Active B is first and wears the "now" tag; the highlight starts on the neighbour (resident A).
      const first = page.locator('.rps-card').first()
      await expect(first).toContainText('switch-b')
      await expect(first.locator('.rps-tagnow')).toHaveText('now')
      await expect(page.locator('.rps-sel .rps-name')).toContainText('switch-a')

      // Tab advances the highlight onto the active card.
      await page.keyboard.press('Tab')
      await expect(page.locator('.rps-sel .rps-name')).toContainText('switch-b')

      // Esc dismisses with no switch.
      await page.keyboard.press('Escape')
      await expect(overlay).toHaveCount(0)

      // ── One running project → the empty state, never a cold recent ──
      expect(await closeBackground(page, dirA)).toBe(true)
      await fireCycle(electronApp, 1)
      await expect(overlay).toBeVisible({ timeout: 8_000 })
      await expect(page.locator('.rps-card')).toHaveCount(1)
      await expect(page.locator('.rps-empty')).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(overlay).toHaveCount(0)
    } finally {
      // Session keeps die with the run, but the worker's app is REUSED across specs — forget the
      // policy + close the resident so no later spec inherits leftover running state.
      await page
        .evaluate(
          (d) => (globalThis as unknown as RendererGlobal).api.project.forgetKeepPolicy(d),
          dirA
        )
        .catch(() => false)
      await closeBackground(page, dirA).catch(() => false)
      await teardownProjects(electronApp, [dirA, dirB])
    }
  })
})
