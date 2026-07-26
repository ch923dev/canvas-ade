import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { recordBench } from './benchSink'

/**
 * @bench Project-switch latency (audit R1 + R2 — the Phase 0 gate artifact).
 *
 * The audit's central complaint was that nobody could say what a project switch costs: `src/` had
 * zero `performance.mark` calls, so PS-1's "dead air" was a description rather than a number and
 * R3 had nothing to be judged against. This bench turns `switchMetrics` into a committed baseline.
 *
 * WHAT IT MEASURES, per switch (see `src/renderer/src/store/switchMetrics.ts`):
 *
 *   arm    the DEAD AIR — gesture → transition overlay covers the outgoing canvas. Budget <100 ms.
 *   load   overlay armed → new project applied to the store.
 *   paint  applied → first frame that actually painted.
 *   total  the whole thing, minus any ask-on-switch dialog time.
 *
 * WHY IT SWEEPS BOARD COUNT. The audit's data-loading findings (DL-1 `readBak` + `gcAssets` on the
 * open path, DL-2's N × `existsSync` in `rehydrateMissingSummaries`, P-6's full-document rewrite)
 * all scale with the canvas, and a single-size measurement cannot distinguish a fixed cost from a
 * per-board one. Sweeping is what makes the baseline able to falsify those findings later.
 *
 * Planning boards, not terminals: a terminal switch would mostly time `pty:spawn` and the shell's
 * boot, which belong to a terminal bench. Planning boards grow the document — which is the thing
 * the switch pipeline actually reads, writes and snapshots — without that noise.
 *
 * Like every bench file this is NOT part of the e2e gate — `playwright.bench.config.ts` matches
 * the `.bench.ts` suffix, which the gate config deliberately does not.
 */

/** Board counts to sweep. 0 isolates the fixed pipeline cost; the rest expose per-board scaling. */
const BOARD_COUNTS = [0, 8, 24]
/** Measured switches per configuration, after the warm-up. Odd, so the median is a real sample. */
const REPEATS = 5
/** How long a single switch may take before the bench gives up waiting for its record. */
const SWITCH_BUDGET_MS = 30_000

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
  mainOpen: number | null
  outcome: string
  at: number
}

type RendererGlobal = {
  __canvasE2E: {
    seedBoard(type: string, patch?: Record<string, unknown>): string
    openProjectFromDisk(dir: string): Promise<{ status: string }>
    switchProjectFromDisk(
      dir: string,
      keep: boolean
    ): Promise<{ outcome: string; status: string; dir: string | null; boardCount: number }>
    lastSwitchMetrics(): SwitchRecord | null
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

/** Fill the CURRENTLY OPEN project with `count` planning boards. */
async function seedBoards(page: Page, count: number): Promise<void> {
  if (count === 0) return
  await page.evaluate((n) => {
    const api = (globalThis as unknown as RendererGlobal).__canvasE2E
    for (let i = 0; i < n; i++) api.seedBoard('planning')
  }, count)
}

/**
 * Switch, then wait for the switch's OWN record.
 *
 * `switchProjectFromDisk` resolves as soon as the new project is applied, but `paintable` is marked
 * two frames later — so reading `lastSwitchMetrics()` immediately can legitimately return the
 * PREVIOUS switch's record. Polling on a strictly newer `at` is what makes each sample belong to
 * the switch that produced it; without it the bench would silently report every measurement
 * one switch late.
 */
async function switchAndMeasure(page: Page, dir: string): Promise<SwitchRecord> {
  const priorAt = await page.evaluate(
    () => (globalThis as unknown as RendererGlobal).__canvasE2E.lastSwitchMetrics()?.at ?? 0
  )
  const result = await page.evaluate(
    (d) => (globalThis as unknown as RendererGlobal).__canvasE2E.switchProjectFromDisk(d, true),
    dir
  )
  if (result.outcome !== 'switched') {
    throw new Error(`switch to ${dir} settled '${result.outcome}', expected 'switched'`)
  }
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const m = (globalThis as unknown as RendererGlobal).__canvasE2E.lastSwitchMetrics()
          return m === null ? 0 : m.at
        }),
      { timeout: SWITCH_BUDGET_MS, message: 'switch produced no metrics record' }
    )
    .toBeGreaterThan(priorAt)

  const metrics = await page.evaluate(
    () => (globalThis as unknown as RendererGlobal).__canvasE2E.lastSwitchMetrics() as SwitchRecord
  )
  if (metrics.total === null) {
    throw new Error(`switch to ${dir} recorded no total (outcome '${metrics.outcome}')`)
  }
  return metrics
}

/** Median of a sample. The switch path contends with autosave and the OS filesystem cache, so a
 *  mean would let one slow outlier misrepresent the typical switch. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/** Summarise one segment across the repeats. `null` when the segment never landed in any sample —
 *  reported as absent rather than as zero. */
function summarize(
  samples: (number | null)[]
): { median: number; min: number; max: number } | null {
  const present = samples.filter((s): s is number => s !== null)
  if (present.length === 0) return null
  return {
    median: round1(median(present)),
    min: round1(Math.min(...present)),
    max: round1(Math.max(...present))
  }
}

function report(boards: number, records: SwitchRecord[]): void {
  const seg = (pick: (r: SwitchRecord) => number | null) => summarize(records.map(pick))
  const fmt = (s: ReturnType<typeof summarize>): string =>
    s === null ? '        —' : `${String(s.median).padStart(7)}ms`
  const range = (s: ReturnType<typeof summarize>): string =>
    s === null ? '' : `  (${s.min}–${s.max})`

  const total = seg((r) => r.total)
  const arm = seg((r) => r.arm)
  const load = seg((r) => r.load)
  const paint = seg((r) => r.paint)
  const mainOpen = seg((r) => r.mainOpen)

  console.log(
    `\n=== PROJECT SWITCH BENCH — ${boards} board(s), ${records.length} switches ===\n` +
      `  total  ${fmt(total)}${range(total)}\n` +
      `  arm    ${fmt(arm)}${range(arm)}   <- the dead air (PS-1); budget 100ms\n` +
      `  load   ${fmt(load)}${range(load)}\n` +
      `  paint  ${fmt(paint)}${range(paint)}\n` +
      `  main   ${fmt(mainOpen)}${range(mainOpen)}   <- project:open handler, inside 'load'\n`
  )

  recordBench({
    bench: 'switch-latency',
    config: { boards, switches: records.length },
    data: { total, arm, load, paint, mainOpen }
  })
}

test.describe('@bench project switch latency', () => {
  for (const boards of BOARD_COUNTS) {
    test(`switch latency — ${boards} board(s) per project`, async ({ page, electronApp }) => {
      // MINT AND OPEN INTERLEAVED, B first. `createTempProject` flips MAIN's currentDir, and
      // `project:open` only approves a dir that is current or in recents — so minting both up
      // front and opening afterwards leaves the first one unapproved and it settles 'error'.
      // Opening each right after its mint also lands it in recents for the later switches.
      const b = await mintProject(electronApp, 'bench-switch-b', 'Bench B')
      await openFromDisk(page, b)
      const a = await mintProject(electronApp, 'bench-switch-a', 'Bench A')
      try {
        await openFromDisk(page, a)

        // Boards have to reach DISK, and only a switch flushes. `openProjectFromDisk` is the raw
        // open path: it does not save the outgoing project, so anything seeded and then merely
        // opened-away-from is discarded and the bench would measure two empty projects while
        // claiming to sweep board count. Seed A, switch (flushing A), seed B, switch back
        // (flushing B) — after which both exist on disk at the target size.
        await seedBoards(page, boards)
        await switchAndMeasure(page, b)
        await seedBoards(page, boards)

        // This switch is also the warm-up, and is discarded. The first switch of a run pays
        // one-time costs — cold filesystem cache, first thumbnail capture, lazily-created
        // directories — that no later switch pays, and folding it in would inflate every number.
        await switchAndMeasure(page, a)

        const records: SwitchRecord[] = []
        for (let i = 0; i < REPEATS; i++) {
          records.push(await switchAndMeasure(page, i % 2 === 0 ? b : a))
        }
        report(boards, records)

        // Soft floor only, matching the terminal bench: a benchmark must not pass while measuring
        // nothing. Latency THRESHOLDS are deliberately not asserted — this is a measurement tool,
        // and a timing gate here would be flaky. Judge the numbers from the committed baseline.
        for (const r of records) {
          expect(r.total, 'switch recorded a total').not.toBeNull()
          expect(r.outcome, 'switch completed').toBe('switched')
        }
      } finally {
        // Land somewhere neutral before deleting the temp dirs — teardown while a project is still
        // open leaves the app pointed at a directory that no longer exists.
        await openFromDisk(page, a).catch(() => undefined)
        await teardownProjects(electronApp, [a, b])
      }
    })
  }
})
