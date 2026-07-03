import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * @terminal Background project sessions (Phase 4) — the ask-on-switch dialog + per-project keep
 * policy. Drives the DEFAULT pipeline (`switchProjectAsk`, no explicit keep) so the REAL modal
 * mediates: ask once → Keep remembers (silent next switch) → forget (∞ path, via the same IPC
 * the badge calls) brings the dialog back → Cancel aborts with no side effects → Stop kills the
 * outgoing project's sessions. The forever checkbox is asserted via keepForeverDirs.
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
    pidsAlive(pids: number[]): number[]
  }
}

type RendererGlobal = {
  __canvasE2E: {
    seedBoard(type: string, patch?: Record<string, unknown>): string
    openProjectFromDisk(dir: string): Promise<{ status: string }>
    switchProjectAsk(
      dir: string
    ): Promise<{ outcome: string; status: string; dir: string | null; boardCount: number }>
  }
  // The preload bridge (window.api ≡ globalThis.api in the page) — the policy IPCs the ∞
  // badge / forever assertions ride.
  api: {
    project: {
      keepForeverDirs(): Promise<string[]>
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

/** Start the DEFAULT switch (dialog-mediated) WITHOUT awaiting — the spec answers the modal,
 *  then awaits this promise for the pipeline outcome. */
function startSwitchAsk(page: Page, dir: string) {
  return page.evaluate(
    (d) => (globalThis as unknown as RendererGlobal).__canvasE2E.switchProjectAsk(d),
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

/** Seed a terminal board and wait for its PTY to actually spawn; returns { id, pid }. */
async function seedLiveTerminal(
  page: Page,
  electronApp: ElectronApplication
): Promise<{ id: string; pid: number }> {
  const id = await page.evaluate(() =>
    (globalThis as unknown as RendererGlobal).__canvasE2E.seedBoard('terminal')
  )
  await expect
    .poll(async () => ((await pidOf(electronApp, id)) ?? 0) > 0, { timeout: 20_000 })
    .toBe(true)
  const pid = (await pidOf(electronApp, id)) as number
  return { id, pid }
}

test.describe('@terminal background project sessions — ask-on-switch dialog + keep policy', () => {
  test('ask once → Keep remembers → forget re-asks → Cancel aborts → Stop kills', async ({
    page,
    electronApp
  }) => {
    const dirB = await mintProject(electronApp, 'canvas-e2e-bgdlg-b-', 'bgdlg-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-bgdlg-a-', 'bgdlg-a')
    try {
      await openFromDisk(page, dirA)
      const { id, pid } = await seedLiveTerminal(page, electronApp)

      // 1. DEFAULT switch away with a live terminal → the dialog MUST appear (policy 'ask').
      const modal = page.locator('[data-testid="ask-switch-modal"]')
      const firstSwitch = startSwitchAsk(page, dirB)
      await expect(modal).toBeVisible()
      await expect(modal).toContainText('1 terminal running')
      // Keep is the default pick; tick FOREVER too so the persisted store is exercised.
      await page.locator('[data-testid="ask-switch-forever"]').check()
      await page.locator('[data-testid="ask-switch-confirm"]').click()
      const toB = await firstSwitch
      expect(toB.outcome).toBe('switched')
      expect(toB.dir).toBe(dirB)
      await expect.poll(() => sessionCounts(electronApp)).toEqual({ live: 0, parked: 1 })
      expect(await pidOf(electronApp, id)).toBe(pid) // kept, parked

      // The forever flag reached the persisted store (the ∞ badge source).
      const foreverDirs = await page.evaluate(() =>
        (globalThis as unknown as RendererGlobal).api.project.keepForeverDirs()
      )
      expect(foreverDirs).toContain(dirA)

      // 2. Switch back (outgoing B has nothing running → silent, no dialog).
      const toA = await startSwitchAsk(page, dirA)
      expect(toA.outcome).toBe('switched')
      await expect
        .poll(() => sessionCounts(electronApp), { timeout: 20_000 })
        .toEqual({ live: 1, parked: 0 })

      // 3. Switch away AGAIN — policy is remembered ⇒ SILENT keep (no dialog appears; the
      //    promise settles without any modal interaction).
      const toB2 = await startSwitchAsk(page, dirB)
      expect(toB2.outcome).toBe('switched')
      await expect(modal).toHaveCount(0)
      await expect.poll(() => sessionCounts(electronApp)).toEqual({ live: 0, parked: 1 })

      // 4. Back to A, then FORGET the policy (the ∞ badge IPC) → the next switch asks again.
      expect((await startSwitchAsk(page, dirA)).outcome).toBe('switched')
      expect(
        await page.evaluate(
          (d) => (globalThis as unknown as RendererGlobal).api.project.forgetKeepPolicy(d),
          dirA
        )
      ).toBe(true)
      expect(
        await page.evaluate(() =>
          (globalThis as unknown as RendererGlobal).api.project.keepForeverDirs()
        )
      ).not.toContain(dirA)

      // 5. Cancel path: dialog reappears; Cancel aborts — still on A, session untouched.
      const cancelled = startSwitchAsk(page, dirB)
      await expect(modal).toBeVisible()
      await page.locator('[data-testid="ask-switch-cancel"]').click()
      const stay = await cancelled
      expect(stay.outcome).toBe('cancelled')
      expect(stay.dir).toBe(dirA)
      await expect.poll(() => sessionCounts(electronApp)).toEqual({ live: 1, parked: 0 })
      expect(await pidOf(electronApp, id)).toBe(pid)

      // 6. Stop path: choose "Stop everything" — switch lands and the process is DEAD.
      const stopped = startSwitchAsk(page, dirB)
      await expect(modal).toBeVisible()
      await page.locator('[data-testid="ask-switch-stop"]').click()
      await page.locator('[data-testid="ask-switch-confirm"]').click()
      const toB3 = await stopped
      expect(toB3.outcome).toBe('switched')
      expect(toB3.dir).toBe(dirB)
      await expect
        .poll(() => sessionCounts(electronApp), { timeout: 20_000 })
        .toEqual({ live: 0, parked: 0 })
      await expect
        .poll(
          () =>
            electronApp.evaluate(
              ({}, pids) => (globalThis as unknown as MainGlobal).__canvasE2EMain.pidsAlive(pids),
              [pid]
            ),
          { timeout: 20_000 }
        )
        .toEqual([])
    } finally {
      // Clear any persisted forever flag so a re-run of the suite starts from 'ask'.
      await page
        .evaluate(
          (d) => (globalThis as unknown as RendererGlobal).api.project.forgetKeepPolicy(d),
          dirA
        )
        .catch(() => false)
      await teardownProjects(electronApp, [dirA, dirB])
    }
  })
})
