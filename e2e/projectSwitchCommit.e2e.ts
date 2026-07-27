import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * @chrome Commit-on-release (audit R16) — the hotkey→overlay→COMMIT path, end to end.
 *
 * This is the coverage gap PS-3 named: `projectSwitcher.e2e.ts` states outright that it "never
 * commits the switch", so until now every automated run stopped at the overlay and the last step —
 * the one that actually tears down a project and brings up another — was exercised by nothing.
 * It is also the phase gate for Phase 1: *one e2e that commits a hotkey switch*.
 *
 * What makes it a real test of R16 rather than of `performProjectSwitch`:
 *   • the switch is triggered by RELEASING the modifier, not by Enter or a click. The keyup is a
 *     real OS-level key event, and it reaches the page only because MAIN's chord matcher is
 *     keyDown-only (`matchesAccel`) and therefore never swallows it — the mechanism the whole
 *     feature rests on. If someone later `preventDefault`s keyup in MAIN, this spec fails.
 *   • the cycle is fired on the REAL `project:cycleHotkey` channel with the hold argument MAIN
 *     now sends, so the payload contract between the two processes is covered too.
 *
 * Kept in its own file rather than appended to `projectSwitcher.e2e.ts`: that spec has a known
 * full-run flake (filed by PR #389 as unhidden-not-caused), and a commit assertion has no business
 * sharing a fate with it.
 *
 * Mint→open interleaved (project:open approves only the current dir/recents; createTempProject
 * flips currentDir). keep=true rides the harness path so no ask-on-switch dialog intercedes.
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
    lastSwitchMetrics(): { outcome: string; at: number } | null
    runningSwitcher(): {
      open: boolean
      names: string[]
      index: number
      holdKey: string | null
      holdReleased: boolean
      opening: boolean
      queuedSteps: number
    }
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

async function openFromDisk(page: Page, dir: string): Promise<void> {
  const r = await page.evaluate(
    (d) => (globalThis as unknown as RendererGlobal).__canvasE2E.openProjectFromDisk(d),
    dir
  )
  if (r.status !== 'open') throw new Error(`openProjectFromDisk(${dir}) settled '${r.status}'`)
}

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

/**
 * Fire the REAL main→renderer cycle channel, carrying the hold modifier exactly as
 * `globalHotkey.onInput` does for the default `CommandOrControl+Alt+]` chord on this platform.
 *
 * Targeted at the window Playwright is actually driving (`electronApp.browserWindow(page)`) rather
 * than at `getAllWindows()[first-not-destroyed]`. This suite creates OTHER BrowserWindows — every
 * Browser board is a hidden offscreen one, and closeModalKeep/ptyhostReattach close and re-create
 * the main window — so "the first live window" is not reliably the app's UI. A send to the wrong
 * webContents is silent and total: no error, no overlay, and a failure that reads as a flake.
 */
async function fireCycle(electronApp: ElectronApplication, page: Page, dir: 1 | -1): Promise<void> {
  const win = await electronApp.browserWindow(page)
  await win.evaluate((w, d) => {
    ;(
      w as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } }
    ).webContents.send('project:cycleHotkey', d, process.platform === 'darwin' ? 'Meta' : 'Control')
  }, dir)
}

/** The overlay's own state (store + the module-scoped in-flight half) — see `runningSwitcher`. */
function switcherState(page: Page) {
  return page.evaluate(() =>
    (globalThis as unknown as RendererGlobal).__canvasE2E.runningSwitcher()
  )
}

/**
 * Wait for the press to have actually raised the overlay, failing with the overlay's OWN state
 * rather than a bare "element not found" — which of `open` / `cards` / `opening` went wrong is the
 * entire diagnosis, and a DOM-only assertion throws it away.
 */
async function expectOverlayRaised(page: Page): Promise<void> {
  await expect
    .poll(async () => JSON.stringify(await switcherState(page)), {
      timeout: 8_000,
      message: 'the cycle press never raised the running-projects overlay'
    })
    .toContain('"open":true')
  await expect(page.locator('[data-testid="running-switcher"]')).toBeVisible()
}

/** The last completed switch's record — `paintable` lands two frames after the pipeline resolves,
 *  so poll for a strictly newer `at` rather than reading once (same discipline as the benches). */
function lastAt(page: Page): Promise<number> {
  return page.evaluate(
    () => (globalThis as unknown as RendererGlobal).__canvasE2E.lastSwitchMetrics()?.at ?? 0
  )
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

test.describe('@chrome commit-on-release: the hotkey overlay actually switches (R16)', () => {
  test('releasing the held modifier commits the highlighted project', async ({
    page,
    electronApp
  }) => {
    const dirB = await mintProject(electronApp, 'canvas-e2e-commit-b-', 'commit-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-commit-a-', 'commit-a')
    try {
      await openFromDisk(page, dirA) // active A
      // Keep-switch A→B: B becomes active, A becomes a resident. Running set = B + A.
      expect((await switchKeep(page, dirB)).outcome).toBe('switched')
      await declineRecapConsent(page)
      await expect(page.locator('.project-switcher-trigger')).toContainText('commit-b')

      const overlay = page.locator('[data-testid="running-switcher"]')
      const priorAt = await lastAt(page)

      // ── The gesture: chord down (overlay opens on the resident) … ──
      await fireCycle(electronApp, page, 1)
      await expectOverlayRaised(page)
      await expect(page.locator('.rps-sel .rps-name')).toContainText('commit-a')
      // The footer must actually teach the gesture that is about to happen.
      await expect(page.locator('.rps-foot')).toContainText('release')

      // ── … and up. A real keyup — nothing in MAIN swallows it, which is the mechanism. ──
      await page.keyboard.press('Control')

      // The overlay gets out of the way and the switch runs to completion.
      await expect(overlay).toHaveCount(0, { timeout: 8_000 })
      await expect(page.locator('.project-switcher-trigger')).toContainText('commit-a', {
        timeout: 30_000
      })

      // And it was a REAL switch through the instrumented pipeline, not just a UI swap.
      await expect
        .poll(() => lastAt(page), { timeout: 30_000, message: 'the release produced no switch' })
        .toBeGreaterThan(priorAt)
      const record = await page.evaluate(() =>
        (globalThis as unknown as RendererGlobal).__canvasE2E.lastSwitchMetrics()
      )
      expect(record?.outcome).toBe('switched')
    } finally {
      // The session keep dies with the run, but the worker's app is REUSED across spec files —
      // forget the policy and close the resident so no later spec inherits running state.
      for (const d of [dirA, dirB]) {
        await page
          .evaluate(
            (x) => (globalThis as unknown as RendererGlobal).api.project.forgetKeepPolicy(x),
            d
          )
          .catch(() => false)
        await closeBackground(page, d).catch(() => false)
      }
      await electronApp.evaluate(
        ({}, ds) => {
          const m = (globalThis as unknown as MainGlobal).__canvasE2EMain
          for (const d of ds) m.teardownProject(d)
        },
        [dirA, dirB]
      )
    }
  })

  test('Esc still cancels — a release after it must not resurrect the switch', async ({
    page,
    electronApp
  }) => {
    const dirB = await mintProject(electronApp, 'canvas-e2e-commitesc-b-', 'commitesc-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-commitesc-a-', 'commitesc-a')
    try {
      await openFromDisk(page, dirA)
      expect((await switchKeep(page, dirB)).outcome).toBe('switched')
      await declineRecapConsent(page)

      const overlay = page.locator('[data-testid="running-switcher"]')
      await fireCycle(electronApp, page, 1)
      await expectOverlayRaised(page)

      await page.keyboard.press('Escape')
      await expect(overlay).toHaveCount(0)

      // The user is still physically holding the modifier when they hit Esc. Letting go now must
      // change nothing — otherwise cancelling would be impossible without also letting go first.
      await page.keyboard.press('Control')
      await page.waitForTimeout(500)
      await expect(page.locator('.project-switcher-trigger')).toContainText('commitesc-b')
    } finally {
      for (const d of [dirA, dirB]) {
        await page
          .evaluate(
            (x) => (globalThis as unknown as RendererGlobal).api.project.forgetKeepPolicy(x),
            d
          )
          .catch(() => false)
        await closeBackground(page, d).catch(() => false)
      }
      await electronApp.evaluate(
        ({}, ds) => {
          const m = (globalThis as unknown as MainGlobal).__canvasE2EMain
          for (const d of ds) m.teardownProject(d)
        },
        [dirA, dirB]
      )
    }
  })
})
