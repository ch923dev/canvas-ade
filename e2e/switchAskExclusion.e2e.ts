import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { mainCall, seedLiveTerminal } from './helpers'

/**
 * @terminal Ask-time exclusion, verified against the REAL ask-on-switch dialog (audit R1 follow-up).
 *
 * `switchMetrics` subtracts the dialog's open time from `arm` and `total` (`minusAsk`), on the
 * reasoning that a user who deliberates for nine seconds has not experienced a nine-second switch.
 * The reasoning is sound and the arithmetic was unit-proven — but until this spec the subtraction
 * had **never executed outside a unit test**, for a structural reason:
 *
 *   `decideKeep` (projectSwitch.ts) returns early on `if (explicit !== undefined) return explicit`.
 *   Every bench and every other e2e switch calls `switchProjectFromDisk(dir, true)` — an EXPLICIT
 *   keep — so the branch that calls `recordAskTime` is unreachable in an automated run.
 *
 * So this spec drives `switchProjectAsk` (the DEFAULT pipeline, no explicit keep), seeds a live
 * terminal so the outgoing project actually has something to ask about, and holds the real modal
 * open for a deliberately long interval before answering. A fast click would prove nothing: the
 * exclusion is only worth having if it survives the human-scale pause it exists to remove.
 *
 * THIS IS A CORRECTNESS ASSERTION, NOT A LATENCY GATE. The bounds are one-sided and enormously
 * slack — `total` and `arm` merely have to come in under the hold. A tight timing bound here would
 * flake on a loaded machine or the Docker leg and would rightly be reverted by the next person;
 * the numbers themselves belong to `projectSwitch*.bench.ts`, which is not part of this suite.
 */

/** How long the modal is held open before it is answered. Comfortably longer than any plausible
 *  switch, so a broken exclusion cannot hide inside measurement noise — it would have to push
 *  `arm`/`total` past this whole interval. */
const HOLD_MS = 1_500
/** Downward slack on `ask` only. The pipeline starts its clock immediately before the request and
 *  stops it immediately after the answer, so `ask` brackets the hold from OUTSIDE and can only be
 *  larger; this covers timer granularity, nothing more. */
const ASK_SLACK_MS = 100

type MainGlobal = {
  __canvasE2EMain: {
    createTempProject(prefix: string, name: string): Promise<string>
    teardownProject(tmp: string): void
  }
}

type SwitchRecord = {
  total: number | null
  arm: number | null
  load: number | null
  paint: number | null
  ask: number | null
  outcome: string
  at: number
}

type RendererGlobal = {
  __canvasE2E: {
    openProjectFromDisk(dir: string): Promise<{ status: string }>
    switchProjectAsk(
      dir: string
    ): Promise<{ outcome: string; status: string; dir: string | null; boardCount: number }>
    lastSwitchMetrics(): SwitchRecord | null
  }
  api: { project: { forgetKeepPolicy(dir: string): Promise<boolean> } }
}

function mintProject(app: ElectronApplication, prefix: string, name: string) {
  return app.evaluate(
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

function lastAt(page: Page): Promise<number> {
  return page.evaluate(
    () => (globalThis as unknown as RendererGlobal).__canvasE2E.lastSwitchMetrics()?.at ?? 0
  )
}

/**
 * Wait for the record belonging to the switch that just completed.
 *
 * `switchProjectAsk` resolves as soon as the new project is applied, but `paintable` is marked two
 * frames later (`markPaintableAndEnd`), so reading `lastSwitchMetrics()` the instant the promise
 * settles can legitimately return the PREVIOUS switch's record — which here would mean asserting
 * the exclusion against a switch that never showed a dialog. Polling on a strictly newer `at` is
 * what binds the record to its own switch; same discipline as `projectSwitch.bench.ts`.
 */
async function metricsAfter(page: Page, priorAt: number): Promise<SwitchRecord> {
  await expect
    .poll(() => lastAt(page), { timeout: 30_000, message: 'switch produced no metrics record' })
    .toBeGreaterThan(priorAt)
  return page.evaluate(
    () => (globalThis as unknown as RendererGlobal).__canvasE2E.lastSwitchMetrics() as SwitchRecord
  )
}

test.describe('@terminal switch metrics — ask-dialog time is excluded from arm/total', () => {
  test('holding the real modal open does not inflate the measured switch', async ({
    page,
    electronApp
  }) => {
    // Mint→open interleaved: `project:open` only approves the CURRENT dir (or a recent), and
    // `createTempProject` flips currentDir — so each project is opened right after its mint.
    const dirB = await mintProject(electronApp, 'canvas-e2e-askexcl-b-', 'askexcl-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-askexcl-a-', 'askexcl-a')
    try {
      await openFromDisk(page, dirA)
      // The dialog only appears when the outgoing project has something to hand over, and the PTY
      // has to be REAL — `askOnSwitchInfo` counts MAIN's live sessions, not mounted boards.
      await seedLiveTerminal(page, electronApp)

      const modal = page.locator('[data-testid="ask-switch-modal"]')
      const priorAt = await lastAt(page)

      // Start the DEFAULT switch without awaiting: the promise only settles once the modal is
      // answered, and the whole point of this spec is to sit inside that window.
      const wallStart = Date.now()
      const switching = page.evaluate(
        (d) => (globalThis as unknown as RendererGlobal).__canvasE2E.switchProjectAsk(d),
        dirB
      )
      await expect(modal).toBeVisible()
      await page.waitForTimeout(HOLD_MS)
      await page.locator('[data-testid="ask-switch-confirm"]').click()

      const result = await switching
      const wallMs = Date.now() - wallStart
      expect(result.outcome).toBe('switched')
      expect(result.dir).toBe(dirB)

      const m = await metricsAfter(page, priorAt)
      expect(m.outcome, 'the measured record is this switch').toBe('switched')

      // 1. The dialog time was captured at all — the branch that unit tests covered has now run.
      expect(m.ask, 'the dialog was timed').not.toBeNull()
      expect(m.ask as number, 'ask covers the hold').toBeGreaterThanOrEqual(HOLD_MS - ASK_SLACK_MS)

      // 2. The switch really did take that long in wall-clock terms. Without this the next two
      //    assertions could pass on a switch where the dialog never opened.
      expect(wallMs, 'the switch spanned the hold in real time').toBeGreaterThanOrEqual(HOLD_MS)

      // 3. …yet neither reported segment contains it. This is the exclusion. A regression that
      //    dropped `minusAsk` would put the full hold into both numbers, so both land far on the
      //    wrong side of a bound this loose.
      expect(m.total, 'total reached a painted frame').not.toBeNull()
      expect(m.total as number, 'total excludes the dialog').toBeLessThan(HOLD_MS)
      expect(m.arm, 'arm was measured (an overlay was armed)').not.toBeNull()
      expect(m.arm as number, 'arm excludes the dialog').toBeLessThan(HOLD_MS)

      // 4. Control: switching BACK asks nothing (outgoing B has no live resources), so `ask` must
      //    be null there. Without this the assertions above would also pass against an
      //    implementation that populated `ask` unconditionally.
      const priorAt2 = await lastAt(page)
      const back = await page.evaluate(
        (d) => (globalThis as unknown as RendererGlobal).__canvasE2E.switchProjectAsk(d),
        dirA
      )
      expect(back.outcome).toBe('switched')
      await expect(modal).toHaveCount(0)
      const silent = await metricsAfter(page, priorAt2)
      expect(silent.ask, 'a dialog-free switch records no ask time').toBeNull()
    } finally {
      // Keep (without the forever tick) still records a per-project policy; clear it so a re-run
      // of this spec starts from 'ask' rather than silently keeping and never showing the modal.
      await page
        .evaluate(
          (d) => (globalThis as unknown as RendererGlobal).api.project.forgetKeepPolicy(d),
          dirA
        )
        .catch(() => false)
      await mainCall(electronApp, 'teardownProject', dirA)
      await mainCall(electronApp, 'teardownProject', dirB)
    }
  })
})
