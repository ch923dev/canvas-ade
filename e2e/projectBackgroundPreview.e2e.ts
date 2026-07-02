import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * @preview Background project sessions (Phase 3) — a Browser board's OFFSCREEN window SURVIVES a
 * keep-running project switch (kept + frozen, never destroyed) and a switch-back resumes the SAME
 * page with NO reload: a window-global planted in the page's JS context before the switch is still
 * there after it (a reload would mint a fresh context and lose it). Also proves the switch-back
 * synthetic re-emit (previewOsr `preview:osrOpen` existing-entry branch): the remounted board's
 * fresh previewStore entry converges 'connecting' → 'connected' even though the kept window fires
 * no new real lifecycle events. Drives the REAL pipeline via `switchProjectFromDisk` with an
 * explicit keep flag, so the spec is independent of the EXPANSE_BG_SESSIONS env flag.
 *
 * Project juggling: `createTempProject` sets MAIN's currentDir as a side effect, and
 * `project:open` only approves a dir that is current or in recents — so every temp project is
 * minted FIRST, then renderer-opened once (which puts it in recents), interleaved mint→open.
 *
 * Probes: OSR window liveness is asserted MAIN-side (`osrPainting` — false = kept+frozen, null =
 * destroyed = the regression; `osrEval` — executeJavaScript into the offscreen page). The budget
 * eviction policy (GLOBAL_OSR_MAX) is unit-tested (pickOsrEvictions), not staged here.
 */

type MainGlobal = {
  __canvasE2EMain: {
    createTempProject(prefix: string, name: string): Promise<string>
    teardownProject(tmp: string): void
    localUrl(): string
    osrPainting(id: string): boolean | null
    osrEval(id: string, code: string): Promise<unknown>
  }
}

type RendererGlobal = {
  __canvasE2E: {
    seedBoard(type: string, patch?: Record<string, unknown>): string
    fitView(id: string): void
    getRuntime(boardId: string): { status?: string } | null
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

function switchTo(page: Page, dir: string) {
  return page.evaluate(
    (d) => (globalThis as unknown as RendererGlobal).__canvasE2E.switchProjectFromDisk(d, true),
    dir
  )
}

function osrPainting(electronApp: ElectronApplication, id: string) {
  return electronApp.evaluate(
    ({}, bid) => (globalThis as unknown as MainGlobal).__canvasE2EMain.osrPainting(bid),
    id
  )
}

function osrEval(electronApp: ElectronApplication, id: string, code: string) {
  return electronApp.evaluate(
    ({}, arg) => (globalThis as unknown as MainGlobal).__canvasE2EMain.osrEval(arg.id, arg.code),
    { id, code }
  )
}

/** Wait until a board's preview runtime reaches `status` (mirrors browserTyping.e2e.ts). */
function waitForStatus(page: Page, id: string, status: string, timeoutMs: number): Promise<void> {
  return expect
    .poll(
      () =>
        page.evaluate(
          ({ bid, want }) => {
            const r = (globalThis as unknown as RendererGlobal).__canvasE2E.getRuntime(bid)
            return !!r && r.status === want
          },
          { bid: id, want: status }
        ),
      { timeout: timeoutMs, message: `board ${id} reaches ${status}` }
    )
    .toBe(true)
}

test.describe('@preview background project sessions — preview keep-alive', () => {
  test('a browser board survives A→B→A frozen-not-destroyed, with NO reload, and resumes', async ({
    page,
    electronApp
  }) => {
    // Mint→open interleaved: project:open only approves the CURRENT dir (or recents),
    // and createTempProject flips currentDir — so each project is opened right after
    // its mint (which also lands it in recents for the later switches).
    const dirB = await mintProject(electronApp, 'canvas-e2e-bgprev-b-', 'bgprev-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-bgprev-a-', 'bgprev-a')
    try {
      await openFromDisk(page, dirA)

      // Seed a Browser board at the in-process local page and get it live + painting.
      const url = await electronApp.evaluate(() =>
        (globalThis as unknown as MainGlobal).__canvasE2EMain.localUrl()
      )
      const id = await page.evaluate(
        (u) =>
          (globalThis as unknown as RendererGlobal).__canvasE2E.seedBoard('browser', {
            url: u,
            viewport: 'desktop'
          }),
        url
      )
      await page.waitForTimeout(150)
      await page.evaluate(
        (bid) => (globalThis as unknown as RendererGlobal).__canvasE2E.fitView(bid),
        id
      )
      await waitForStatus(page, id, 'connected', 20_000)
      await expect.poll(() => osrPainting(electronApp, id), { timeout: 20_000 }).toBe(true)

      // Plant the no-reload witness: a window-global in the page's live JS context. A reload
      // (the thing Phase 3 must never do) would mint a fresh context and lose it.
      expect(await osrEval(electronApp, id, `(window.__bgProbe = 'alive-123')`)).toBe('alive-123')

      // Switch away with keep — the offscreen window must SURVIVE, frozen: osrPainting false.
      // null would mean the window was destroyed (the pre-Phase-1 disposeAll behavior) = bug.
      const toB = await switchTo(page, dirB)
      expect(toB.outcome).toBe('switched')
      expect(toB.dir).toBe(dirB)
      await expect.poll(() => osrPainting(electronApp, id), { timeout: 20_000 }).toBe(false)

      // Switch back. The board remounts with a FRESH previewStore entry ('connecting'); the kept
      // window fires no new real lifecycle events, so reaching 'connected' PROVES the synthetic
      // re-emit (did-navigate + did-finish-load) — without it the board sits at "Connecting…".
      const toA = await switchTo(page, dirA)
      expect(toA.outcome).toBe('switched')
      expect(toA.dir).toBe(dirA)
      await waitForStatus(page, id, 'connected', 20_000)

      // Same JS context ⇒ the page never reloaded: the planted global is still there.
      expect(await osrEval(electronApp, id, `window.__bgProbe`)).toBe('alive-123')

      // Liveness resumed: the remounted, on-screen board is painting again (foregroundProjectOsr
      // un-throttled; the liveness manager's preview:osrSetPaint(true) restarts the pump).
      await page.evaluate(
        (bid) => (globalThis as unknown as RendererGlobal).__canvasE2E.fitView(bid),
        id
      )
      await expect.poll(() => osrPainting(electronApp, id), { timeout: 20_000 }).toBe(true)
    } finally {
      await teardownProjects(electronApp, [dirA, dirB])
    }
  })
})
