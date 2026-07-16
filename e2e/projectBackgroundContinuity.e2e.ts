import { existsSync } from 'fs'
import { join } from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * @terminal Background project sessions (Phase 5) — scrollback CONTINUITY across a
 * keep-running switch. The ring caps at 256KB, so pre-Phase-5 a switch-back replayed at
 * most the ring tail; now the switch-away sidecar snapshot is replayed as the preface and
 * only the POST-PARK ring tail follows (`OutputRing.written` watermark splice). Proven
 * here end-to-end: output deeper than the ring survives the round-trip, appears EXACTLY
 * once (a full-ring replay over the snapshot would duplicate the overlap), and the
 * backgrounded-tail output still arrives. Plus the snapshot dir-isolation invariant:
 * project A's sidecars never land under project B's `.canvas/`.
 *
 * Mint→open interleaved, destination first (the R2 dir-pin save gotcha — see
 * projectSwitchMotion.e2e.ts).
 */

type MainGlobal = {
  __canvasE2EMain: {
    createTempProject(prefix: string, name: string): Promise<string>
    teardownProject(tmp: string): void
    terminalPid(id: string): number | null
    writeTerminal(id: string, data: string): boolean
    ptySessionCounts(): { live: number; parked: number }
  }
}

type RendererGlobal = {
  __canvasE2E: {
    seedBoard(type: string, patch?: Record<string, unknown>): string
    readTerminal(id: string): string | null
    openProjectFromDisk(dir: string): Promise<{ status: string }>
    switchProjectFromDisk(
      dir: string,
      keep: boolean
    ): Promise<{ outcome: string; status: string; dir: string | null; boardCount: number }>
    setZoom(z: number): void
    getZoom(): number
    fitView(id?: string): void
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

function writePty(electronApp: ElectronApplication, id: string, data: string) {
  return electronApp.evaluate(
    ({}, arg) =>
      (globalThis as unknown as MainGlobal).__canvasE2EMain.writeTerminal(arg.id, arg.data),
    { id, data }
  )
}

function readTerm(page: Page, id: string) {
  return page.evaluate(
    (bid) => (globalThis as unknown as RendererGlobal).__canvasE2E.readTerminal(bid) ?? '',
    id
  )
}

async function seedLiveTerminal(
  page: Page,
  electronApp: ElectronApplication,
  patch?: Record<string, unknown>
): Promise<{ id: string; pid: number }> {
  const id = await page.evaluate(
    (p) => (globalThis as unknown as RendererGlobal).__canvasE2E.seedBoard('terminal', p),
    patch
  )
  await expect
    .poll(async () => ((await pidOf(electronApp, id)) ?? 0) > 0, { timeout: 20_000 })
    .toBe(true)
  const pid = (await pidOf(electronApp, id)) as number
  return { id, pid }
}

/** Occurrences of `needle` in `hay` (no regex escaping worries). */
function countOf(hay: string, needle: string): number {
  let n = 0
  let i = hay.indexOf(needle)
  while (i !== -1) {
    n++
    i = hay.indexOf(needle, i + needle.length)
  }
  return n
}

test.describe('@terminal background project sessions — Phase 5 scrollback continuity', () => {
  test('scrollback deeper than the ring survives a keep-switch round-trip, spliced exactly once', async ({
    page,
    electronApp
  }) => {
    const dirB = await mintProject(electronApp, 'canvas-e2e-splice-b-', 'splice-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-splice-a-', 'splice-a')
    try {
      await openFromDisk(page, dirA)
      // Max scrollback: at the board's default (2000 ROWS) the ~55-col well WRAPS each
      // 200-char filler line to ~4 rows, so xterm would evict the early marker BEFORE the
      // 256KB ring does and the snapshot could never carry it. 50k rows ≫ ring cap keeps
      // the premise honest: deeper than the RING, still inside the xterm buffer.
      const { id, pid } = await seedLiveTerminal(page, electronApp, { scrollback: 50000 })

      // Early marker, then ~340KB of filler so the 256KB ring EVICTS it — only the
      // switch-away snapshot can carry it back. Markers are built by concatenation so the
      // echoed COMMAND LINE never contains the literal (keeps the exactly-once count honest).
      const fill =
        process.platform === 'win32'
          ? "echo ('EARLY-'+'MARKER'); foreach ($i in 1..1600) { echo (('F'*200)+$i) }; echo ('FILL-'+'DONE')\r"
          : 'echo "EARLY-""MARKER"; for i in $(seq 1 1600); do printf "F%.0s" $(seq 1 200); echo $i; done; echo "FILL-""DONE"\r'
      await writePty(electronApp, id, fill)
      await expect.poll(() => readTerm(page, id), { timeout: 60_000 }).toContain('FILL-DONE')

      // A self-producing ticker (writeTerminal can't reach a PARKED proc): first tick lands
      // pre-switch, later ticks emit while backgrounded — the post-watermark tail.
      const ticker =
        process.platform === 'win32'
          ? "foreach ($i in 1..20) { echo ('BGTA'+'IL-'+$i); sleep 1 }\r"
          : 'for i in $(seq 1 20); do echo "BGTA""IL-$i"; sleep 1; done\r'
      await writePty(electronApp, id, ticker)
      await expect.poll(() => readTerm(page, id), { timeout: 20_000 }).toContain('BGTAIL-1')

      // Keep-switch away: the flush serializes the FULL xterm buffer (early marker included)
      // into A's sidecar; the park records the ring watermark. Let a few ticks accumulate.
      const toB = await switchTo(page, dirB)
      expect(toB.outcome).toBe('switched')
      await page.waitForTimeout(3_500)

      // Switch back: live reattach (same pid) with snapshot-preface + tail replay.
      const toA = await switchTo(page, dirA)
      expect(toA.outcome).toBe('switched')
      await expect.poll(async () => pidOf(electronApp, id), { timeout: 20_000 }).toBe(pid)

      // The early marker was ring-EVICTED (≈340KB of filler followed it), so its presence
      // proves the sidecar preface; a LATE tick (only emittable while parked) proves the
      // post-park tail replay.
      await expect.poll(() => readTerm(page, id), { timeout: 20_000 }).toContain('EARLY-MARKER')
      await expect
        .poll(() => readTerm(page, id), { timeout: 20_000 })
        .toMatch(/BGTAIL-([4-9]|1[0-9])\n/)
      // No duplication: a full-ring replay stacked on the snapshot (the pre-Phase-5 shape)
      // would repeat every pre-park tick that also sat in the ring. Each tick may appear
      // AT MOST once — boundary ticks emitted between the serialize and the park sit in
      // neither (the accepted watermark-at-park loss window), so 0 is legal; 2 never is.
      const buf = await readTerm(page, id)
      expect(countOf(buf, 'EARLY-MARKER')).toBe(1)
      for (let i = 1; i <= 6; i++) {
        expect(countOf(buf, `BGTAIL-${i}\n`)).toBeLessThanOrEqual(1)
      }
    } finally {
      await teardownProjects(electronApp, [dirA, dirB])
    }
  })

  test('snapshot dir-isolation: A’s sidecar lives under A’s .canvas only, never B’s', async ({
    page,
    electronApp
  }) => {
    const dirB = await mintProject(electronApp, 'canvas-e2e-iso-b-', 'iso-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-iso-a-', 'iso-a')
    try {
      await openFromDisk(page, dirA)
      const { id } = await seedLiveTerminal(page, electronApp)
      // Platform-forked like the splice test — pwsh concat vs POSIX string-splitting (the
      // Linux leg's bash errors on `('…'+'…')`, so the marker would never print there).
      const mark =
        process.platform === 'win32' ? "echo ('ISO-'+'MARKER')\r" : 'echo "ISO-""MARKER"\r'
      await writePty(electronApp, id, mark)
      await expect.poll(() => readTerm(page, id), { timeout: 20_000 }).toContain('ISO-MARKER')

      const toB = await switchTo(page, dirB)
      expect(toB.outcome).toBe('switched')

      // The switch-away flush wrote A's sidecar under A's .canvas (async write — poll)…
      await expect
        .poll(() => existsSync(join(dirA, '.canvas', 'terminal', `${id}.snapshot`)), {
          timeout: 20_000
        })
        .toBe(true)
      // …and NOTHING for that board ever lands under B's .canvas (the R2 dir-pin class).
      expect(existsSync(join(dirB, '.canvas', 'terminal', `${id}.snapshot`))).toBe(false)
    } finally {
      await teardownProjects(electronApp, [dirA, dirB])
    }
  })
})

test.describe('@terminal background project sessions — switch-back replay geometry', () => {
  test('replay lands at the board’s true width — never wrapped at the unfitted 80-col default', async ({
    page,
    electronApp
  }) => {
    // The corruption class this pins: on switch-back a terminal board remounts with a FRESH
    // xterm at the constructor-default 80×24, and the adopt's replayed scrollback can arrive
    // BEFORE the first real fit (the well is display:none below LOD — proposeDimensions is
    // not finite yet). Unfixed, the replay hard-wraps at 80 cols and the first fit's reflow
    // then mangles it (on Win11 ConPTY the `windowsPty` hint disables xterm reflow entirely,
    // so the 80-col wrap simply STAYS — the broken display users see). The fix holds the
    // bytes in the write coalescer until the grid reflects a real layout.
    //
    // Premise forcing: A's switch-back remount lands on a content-FIT camera (React Flow's
    // init fit wins over any parked/persisted viewport — observed live), so the way to mount
    // the terminal below LOD is GEOMETRY: a far-away dummy board stretches the content
    // cluster to ~20k world px, and the fit-to-all camera lands near Z_MIN (≪ LOD_ZOOM 0.4).
    // The terminal therefore mounts with its well at display:none — deterministically
    // unfitted while the adopt replays, not just on a slow frame.
    const dirB = await mintProject(electronApp, 'canvas-e2e-rewrap-b-', 'rewrap-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-rewrap-a-', 'rewrap-a')
    try {
      await openFromDisk(page, dirA)
      // Wide board (~1160px ⇒ well over 110 cols at the default font) so the marker line fits
      // UNWRAPPED at the true width but MUST wrap on an 80-col default grid.
      const { id, pid } = await seedLiveTerminal(page, electronApp, { w: 1160, h: 420 })
      // The LOD anchor: stretches A's content cluster so the switch-back fit-to-all camera
      // sits far below LOD_ZOOM (see the premise note above).
      await page.evaluate(() =>
        (globalThis as unknown as RendererGlobal).__canvasE2E.seedBoard('planning', {
          x: 20_000,
          y: 0
        })
      )

      // One 110-char output line: 100 filler X's + a concat-built marker (the echoed command
      // line never contains the literal, keeping the exactly-once count honest).
      const mark =
        process.platform === 'win32'
          ? "echo ('X'*100 + 'WIDE'+'MARKER')\r"
          : 'printf "X%.0s" $(seq 1 100); echo "WIDE""MARKER"\r'
      const needle = 'X'.repeat(100) + 'WIDEMARKER'
      await writePty(electronApp, id, mark)
      // Unbroken at the true width pre-switch — proves the board is wide enough for the premise.
      await expect.poll(() => readTerm(page, id), { timeout: 20_000 }).toContain(needle)

      const toB = await switchTo(page, dirB)
      expect(toB.outcome).toBe('switched')

      // Switch back: the terminal remounts below LOD (unfitted) while the adopt replays.
      const toA = await switchTo(page, dirA)
      expect(toA.outcome).toBe('switched')
      await expect.poll(async () => pidOf(electronApp, id), { timeout: 20_000 }).toBe(pid)
      // Premise check: A restored with its below-LOD viewport (the unfitted-mount window).
      await expect
        .poll(
          () =>
            page.evaluate(() => (globalThis as unknown as RendererGlobal).__canvasE2E.getZoom()),
          { timeout: 10_000 }
        )
        .toBeLessThan(0.4)

      // Reveal: fit the camera to the board (≥ LOD + on-screen) → first real fit + catch-up flush.
      await page.evaluate(
        (bid) => (globalThis as unknown as RendererGlobal).__canvasE2E.fitView(bid),
        id
      )

      // The marker must come back as ONE unbroken 110-char run (a translateToString row walk
      // joins rows with '\n', so an 80-col wrap would split the needle) — and exactly once
      // (reflow duplication is the other face of the same corruption).
      await expect.poll(() => readTerm(page, id), { timeout: 20_000 }).toContain(needle)
      expect(countOf(await readTerm(page, id), needle)).toBe(1)
    } finally {
      await teardownProjects(electronApp, [dirA, dirB])
    }
  })
})
