import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * @chrome Background project sessions (Phase 4b) — the bottom-edge project dock
 * (PHASE4-UX-DESIGN §4). Real mouse to the window-bottom hot zone (synthetic dispatchEvent
 * bypasses hit-testing — documented gotcha) → the dock reveals with one card per SESSION
 * project (active + backgrounded resident, never cold recents) → clicking the resident's
 * card switches through the REAL pipeline riding the remembered keep policy (silent — no
 * ask-on-switch modal) → thumbnails are a data URL or the dot-grid placeholder (capturePage
 * is env-flaky; both are green).
 *
 * Mint→open interleaved: project:open only approves the CURRENT dir (or recents), and
 * createTempProject flips currentDir — so each project is opened right after its mint.
 */

type MainGlobal = {
  __canvasE2EMain: {
    createTempProject(prefix: string, name: string): Promise<string>
    teardownProject(tmp: string): void
    terminalPid(id: string): number | null
    ptySessionCounts(): { live: number; parked: number }
  }
}

type RendererGlobal = {
  __canvasE2E: {
    seedBoard(type: string, patch?: Record<string, unknown>): string
    openProjectFromDisk(dir: string): Promise<{ status: string }>
    switchProjectFromDisk(
      dir: string,
      keep: boolean
    ): Promise<{ outcome: string; status: string; dir: string | null; boardCount: number }>
  }
  // The preload bridge (window.api ≡ globalThis.api in the page) — the keep-policy IPCs.
  api: {
    project: {
      setKeepPolicy(forever: boolean): Promise<boolean>
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

function switchTo(page: Page, dir: string) {
  return page.evaluate(
    (d) => (globalThis as unknown as RendererGlobal).__canvasE2E.switchProjectFromDisk(d, true),
    dir
  )
}

function pidOf(electronApp: ElectronApplication, id: string) {
  return electronApp.evaluate(
    ({}, bid) => (globalThis as unknown as MainGlobal).__canvasE2EMain.terminalPid(bid),
    id
  )
}

function sessionCounts(electronApp: ElectronApplication) {
  return electronApp.evaluate(({}) =>
    (globalThis as unknown as MainGlobal).__canvasE2EMain.ptySessionCounts()
  )
}

/** Seed a terminal board and wait for its PTY to actually spawn. */
async function seedLiveTerminal(page: Page, electronApp: ElectronApplication): Promise<string> {
  const id = await page.evaluate(() =>
    (globalThis as unknown as RendererGlobal).__canvasE2E.seedBoard('terminal')
  )
  await expect
    .poll(async () => ((await pidOf(electronApp, id)) ?? 0) > 0, { timeout: 20_000 })
    .toBe(true)
  return id
}

/** Dismiss the recap-consent prompt if it's up — its scrim intercepts every UI click, and
 *  a freshly-minted temp project is always consent-undecided. */
async function declineRecapConsent(page: Page): Promise<void> {
  const decline = page.locator('[data-test="recap-decline"]')
  try {
    await decline.click({ timeout: 5_000 })
  } catch {
    /* prompt never showed (already decided) — fine */
  }
}

/** Park the REAL mouse on the window's bottom edge until the dock reveals (~150ms intent). */
async function revealDock(page: Page): Promise<void> {
  // e2e tsconfig has no DOM lib — reach the window globals via a cast (documented pattern).
  const size = await page.evaluate(() => {
    const g = globalThis as unknown as { innerWidth: number; innerHeight: number }
    return { w: g.innerWidth, h: g.innerHeight }
  })
  // Approach in two hops so the final event lands IN the 2px edge zone as a fresh move.
  await page.mouse.move(Math.round(size.w / 2), Math.round(size.h / 2))
  await page.mouse.move(Math.round(size.w / 2), size.h - 1)
  await expect(page.locator('[data-testid="project-dock"]')).toBeVisible({ timeout: 5_000 })
}

test.describe('@chrome background project sessions — bottom project dock', () => {
  test('edge-hover reveals session cards; resident card click rides the remembered keep silently', async ({
    page,
    electronApp
  }) => {
    const dirB = await mintProject(electronApp, 'canvas-e2e-dock-b-', 'bgdock-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-dock-a-', 'bgdock-a')
    try {
      await openFromDisk(page, dirA)
      await seedLiveTerminal(page, electronApp)

      // Background A (explicit keep — the Phase-2 harness path), landing on B.
      const toB = await switchTo(page, dirB)
      expect(toB.outcome).toBe('switched')
      await expect.poll(() => sessionCounts(electronApp)).toEqual({ live: 0, parked: 1 })

      // Give B a live terminal + a REMEMBERED session keep (setKeepPolicy targets the
      // ACTIVE dir MAIN-side) so the dock click below must switch away silently.
      await seedLiveTerminal(page, electronApp)
      expect(
        await page.evaluate(() =>
          (globalThis as unknown as RendererGlobal).api.project.setKeepPolicy(false)
        )
      ).toBe(true)

      // The undecided temp project raises the recap-consent modal — its scrim would
      // swallow the card click below; decline it first (UI-click spec, unlike the
      // harness-driven bg specs).
      await declineRecapConsent(page)

      // Real mouse into the bottom-edge hot zone → the dock reveals.
      await revealDock(page)
      const dock = page.locator('[data-testid="project-dock"]')

      // Membership: exactly the two SESSION projects — active B (ACTIVE tag) + resident A
      // (dot/badge grammar). Both wear a thumbnail slot: data URL or dot-grid placeholder.
      // Card names are the DIR basenames (registry `basename(dir)` / store display name of
      // the temp dir), so match on the unique mint prefixes, not the doc names.
      await expect(dock.locator('[data-testid="pd-card"]')).toHaveCount(2)
      const cardA = dock.locator('[data-testid="pd-card"]', { hasText: 'canvas-e2e-dock-a-' })
      const cardB = dock.locator('[data-testid="pd-card"]', { hasText: 'canvas-e2e-dock-b-' })
      await expect(cardA).toBeVisible()
      await expect(cardB).toBeVisible()
      await expect(cardB.locator('.pd-active-tag')).toHaveText('ACTIVE')
      await expect(cardA.locator('.pd-active-tag')).toHaveCount(0)
      await expect(cardA.locator('.ps-badge')).toHaveText('1 term')
      await expect(dock.locator('.pd-thumb')).toHaveCount(2)
      const imgs = dock.locator('img.pd-thumb')
      for (let i = 0; i < (await imgs.count()); i++) {
        expect(await imgs.nth(i).getAttribute('src')).toMatch(/^data:image\/png;base64,/)
      }

      // Click the resident card → dock closes, the switch rides B's remembered keep
      // SILENTLY (no ask-on-switch modal), and A's terminal live-reattaches.
      await cardA.locator('[data-testid="pd-shot"]').click()
      await expect(dock).toHaveCount(0)
      await expect(page.locator('[data-testid="ask-switch-modal"]')).toHaveCount(0)
      await expect(page.locator('.project-switcher-trigger')).toContainText('canvas-e2e-dock-a-', {
        timeout: 20_000
      })
      await expect
        .poll(() => sessionCounts(electronApp), { timeout: 20_000 })
        .toEqual({ live: 1, parked: 1 })
      await expect(page.locator('[data-testid="ask-switch-modal"]')).toHaveCount(0)
    } finally {
      // Session keeps die with the run, but this worker's app is REUSED across specs —
      // forget both policies so no later spec inherits a silent keep.
      for (const d of [dirA, dirB]) {
        await page
          .evaluate(
            (dir) => (globalThis as unknown as RendererGlobal).api.project.forgetKeepPolicy(dir),
            d
          )
          .catch(() => false)
      }
      await teardownProjects(electronApp, [dirA, dirB])
    }
  })
})
