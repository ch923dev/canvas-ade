import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * @chrome Background project sessions (Phase 4c) — the switch-transition overlay
 * (PHASE4C-MOTION-MOCK). During a real project switch the overlay stands in for the
 * outgoing canvas (OUT → HOLD → IN) and the welcome/picker surface never mounts — killing
 * the mid-switch picker flash is the point. Assertions are presence/absence only (the
 * documented rule: never pixel/frame counts on animation timing).
 *
 * The switch is fired WITHOUT awaiting (the overlay lives only mid-switch); its minimum
 * on-screen window is OUT+IN (~560ms normal, ~300ms reduced) plus the load, which is
 * plenty for locator polling. Reduced motion is driven via page.emulateMedia — the store
 * samples prefers-reduced-motion at arm time, so no relaunch is needed.
 *
 * Mint→open interleaved (project:open approves only the current dir/recents); explicit
 * keep=true rides the Phase-2 harness path so no ask-on-switch dialog is involved.
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

/** Fire the REAL switch pipeline and return its (unawaited) settle promise. */
function startSwitch(page: Page, dir: string) {
  return page.evaluate(
    (d) => (globalThis as unknown as RendererGlobal).__canvasE2E.switchProjectFromDisk(d, true),
    dir
  )
}

test.describe('@chrome background project sessions — switch-transition motion', () => {
  test('overlay covers the switch; the welcome picker never mounts; overlay self-clears', async ({
    page,
    electronApp
  }) => {
    // Mint→open INTERLEAVED, destination first (the projectDock pattern): createTempProject
    // flips MAIN's currentDir, so minting B after opening A would fail A's pinned
    // flush-save ('save-failed' — the R2 dir-pin) and the overlay would never arm.
    const dirB = await mintProject(electronApp, 'canvas-e2e-motion-b-', 'motion-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-motion-a-', 'motion-a')
    await openFromDisk(page, dirA)
    try {
      const switchP = startSwitch(page, dirB)
      const overlay = page.locator('[data-testid="switch-transition"]')
      await expect(overlay).toBeVisible({ timeout: 10_000 })
      // Non-reduced leg: the minidock peek strip rides along inside the overlay.
      await expect(page.locator('[data-testid="st-minidock"]')).toBeVisible()
      // THE phase-4c invariant: while the overlay is up, the welcome/picker surface does
      // not exist at all — not occluded, UNMOUNTED (App.tsx suppresses it mid-transition).
      await expect(page.locator('.welcome')).toHaveCount(0)
      await expect(page.locator('.welcome-actions')).toHaveCount(0)

      const r = await switchP
      expect(r.outcome).toBe('switched')
      expect(r.status).toBe('open')
      expect(r.dir).toBe(dirB)
      // IN completes → the overlay unmounts on its own (workers:1 — nothing may leak into
      // the next spec) and the landing is the open canvas, still never the picker.
      await expect(overlay).toHaveCount(0, { timeout: 10_000 })
      await expect(page.locator('.welcome')).toHaveCount(0)
    } finally {
      await teardownProjects(electronApp, [dirA, dirB])
    }
  })

  test('reduced motion: overlay still covers the switch, but with no dock peek', async ({
    page,
    electronApp
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    // Destination minted+opened FIRST (see the leg above — the R2 dir-pin save gotcha).
    const dirB = await mintProject(electronApp, 'canvas-e2e-motionrm-b-', 'motionrm-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-motionrm-a-', 'motionrm-a')
    await openFromDisk(page, dirA)
    try {
      const switchP = startSwitch(page, dirB)
      const overlay = page.locator('[data-testid="switch-transition"]')
      await expect(overlay).toBeVisible({ timeout: 10_000 })
      // REDUCED (spec row 4): plain cross-fade, no dock peek — the strip never renders.
      await expect(page.locator('[data-testid="st-minidock"]')).toHaveCount(0)
      await expect(page.locator('.welcome')).toHaveCount(0)

      const r = await switchP
      expect(r.outcome).toBe('switched')
      expect(r.status).toBe('open')
      await expect(overlay).toHaveCount(0, { timeout: 10_000 })
    } finally {
      // emulateMedia persists on the reused page — restore for later specs (workers:1).
      await page.emulateMedia({ reducedMotion: null })
      await teardownProjects(electronApp, [dirA, dirB])
    }
  })
})
