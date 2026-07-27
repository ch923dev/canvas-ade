import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { recordBench } from './benchSink'
import { mainCall, seed, seedLiveTerminal } from './helpers'

/**
 * @bench Project-switch latency with LIVE RESOURCES — the measurement R3 was re-scoped onto.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS A SECOND FILE.
 *
 * `projectSwitch.bench.ts` sweeps 0/8/24 **planning** boards and measured `arm` at 41–49 ms median,
 * against PS-1's claimed "~800 ms of dead air". That claim was never measured — it was two 400 ms
 * `Promise.race` **timeouts** summed on paper (`CAPTURE_BUDGET_MS` + `SNAPSHOT_FETCH_BUDGET_MS`).
 * A timeout only bites when the work behind it is slow, and that sweep's configuration — no
 * terminals, no previews, no assets — is precisely the one that never makes them slow. So R3 came
 * out of Phase 0 **unproven, not refuted**, and this bench is the configuration that decides it.
 *
 * The planning sweep is NOT extended and NOT refactored: it is the committed baseline in
 * `docs/reviews/2026-07-25-bench/BASELINE.json`, and any edit to it — even a shared-helper
 * extraction — costs the ability to compare a later run against it. This file therefore repeats a
 * little of its plumbing on purpose. Cheap duplication, expensive alternative.
 *
 * WHAT `arm` ACTUALLY SPANS, which is what makes this configuration the right one:
 *
 *   start → decideKeep → cancelActiveAutosave → project:save (the whole outgoing doc)
 *         → saveSession → captureProjectThumb (400 ms budget) → fetchOutgoingSnapshot (400 ms
 *           budget) → armSwitchTransition = `armed`
 *
 * `captureProjectThumb` is a full-window `capturePage`, and its own docblock records that under GPU
 * contention from backgrounded previews and parked agents it "can take seconds" — which is exactly
 * the state the keep-path leaves behind once both projects carry resources. That is the mechanism
 * PS-1 described, and it is unreachable without live resources on the canvas.
 *
 * WHAT IS DELIBERATELY REPORTED ALONGSIDE THE NUMBER. Seeding N Browser boards does not give N live
 * previews — the renderer caps existence (`OSR_MAX_LIVE`) and MAIN caps it again globally
 * (`GLOBAL_OSR_MAX`), and off-screen boards are paint-gated on top of that. Every sample therefore
 * carries the census MAIN actually had at switch time. An `arm` number without the resource count
 * it was taken against is the same anecdote the 2026-06-25 fps reference turned out to be.
 *
 * ASSETS ARE SEEDED UNREFERENCED, ON PURPOSE. `gcAssets` runs at every `project:open` and
 * quarantines every blob the doc does not reference, so re-seeding before each switch puts the
 * sweep on its WORST path (copy + unlink per file) rather than a referenced canvas's readdir + set
 * lookups. If DL-1 is cheap here it is cheaper in reality. Note this lands in `mainOpen` — inside
 * `load`, not `arm` — so it speaks to R11, not to R3.
 *
 * Like every bench this is NOT part of the e2e gate: `playwright.bench.config.ts` matches
 * `.bench.ts`, which the gate config deliberately does not.
 */

/** One resource configuration of the bench. */
type ResourceConfig = { key: string; terminals: number; previews: number; assets: number }

/** Resource configurations, ordered so each isolates one axis before the combined case. */
const CONFIGS: ResourceConfig[] = [
  { key: 'terminals', terminals: 3, previews: 0, assets: 0 },
  { key: 'previews', terminals: 0, previews: 6, assets: 0 },
  { key: 'assets', terminals: 0, previews: 0, assets: 44 },
  { key: 'full', terminals: 3, previews: 6, assets: 44 }
]

/** Measured switches per configuration, after the warm-up. Odd, so the median is a real sample. */
const REPEATS = 5
/** Per-asset size. The audit's field survey found a real project at 44 files / 3.58 MB. */
const ASSET_BYTES = 80 * 1024
/** Mirror of `useOffscreenLiveness`'s `OSR_MAX_LIVE` — how many offscreen windows may exist per
 *  canvas. Duplicated rather than imported: the bench drives the BUILT app over IPC and has no
 *  renderer module graph to import from. Only used to pick a reachable wait target. */
const OSR_MAX_LIVE = 4
/** How long to wait for a seeded terminal's PTY to exist, under this bench's contention. */
const PTY_SPAWN_BUDGET_MS = 60_000
/** How long a single switch may take before the bench gives up waiting for its record. */
const SWITCH_BUDGET_MS = 60_000
/** How long to wait for a project's resources to come back up after landing on it. Bounded and
 *  NON-fatal: a configuration that never reaches its target still measures something real, and the
 *  census recorded with each sample says what it actually had. */
const REVIVE_BUDGET_MS = 45_000
/** Spawning several PTYs and a dozen offscreen windows, three times over, outruns the config-wide
 *  240 s default long before anything is wrong. */
const TEST_TIMEOUT_MS = 600_000

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

/** What MAIN really had running at the moment of a switch. */
type Census = { terminals: number; osrOpen: number; osrPainting: number }

/** One measured switch plus the resource state it was measured against. */
type Sample = { metrics: SwitchRecord; census: Census }

type MainGlobal = {
  __canvasE2EMain: {
    createTempProject(prefix: string, name: string): Promise<string>
  }
}

type RendererGlobal = {
  __canvasE2E: {
    openProjectFromDisk(dir: string): Promise<{ status: string }>
    switchProjectFromDisk(
      dir: string,
      keep: boolean
    ): Promise<{ outcome: string; status: string; dir: string | null; boardCount: number }>
    lastSwitchMetrics(): SwitchRecord | null
    fitView(id?: string): void
    getBoards(): { id: string; type: string }[]
  }
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

async function census(app: ElectronApplication): Promise<Census> {
  const pty = await mainCall<{ live: number; parked: number }>(app, 'ptySessionCounts')
  const osr = await mainCall<{ open: number; painting: number; ready: number }>(app, 'osrCounts')
  return { terminals: pty.live, osrOpen: osr.open, osrPainting: osr.painting }
}

/**
 * Fill the CURRENTLY OPEN project with the configuration's live resources.
 *
 * Terminals are awaited to a real pid (`seedLiveTerminal`) — a mounted `TerminalBoard` whose
 * `pty:spawn` has not landed costs the outgoing project's flush and handover nothing, so seeding
 * without waiting would measure an empty canvas while claiming otherwise.
 *
 * Browser boards then get `fitView` ON THE FIRST ONE, never a fit-all. A fit-all frames every
 * seeded board at once, which drives the camera BELOW `LOD_ZOOM` (0.4) — and a below-LOD canvas
 * takes every preview's offscreen window down with it. Measured directly while building this bench:
 * 6 boards + fit-all = `{ open: 0, painting: 0 }`, i.e. a "preview-bearing" configuration carrying
 * no previews at all. Fitting one board holds the camera at a real working zoom and yields the
 * cap's worth of live windows (`{ open: 4, painting: 4 }`), which is the honest maximum the app
 * permits on one canvas. How many actually survive is reported per sample either way.
 */
async function seedResources(
  page: Page,
  app: ElectronApplication,
  cfg: ResourceConfig
): Promise<void> {
  // A generous PTY wait: the combined configuration spawns shells while a dozen offscreen windows
  // are loading, and the stock 20 s is a comfortable bound only on an otherwise idle canvas.
  for (let i = 0; i < cfg.terminals; i++) await seedLiveTerminal(page, app, PTY_SPAWN_BUDGET_MS)
  if (cfg.previews > 0) {
    const url = await mainCall<string>(app, 'localUrl')
    for (let i = 0; i < cfg.previews; i++) await seed(page, 'browser', { url })
    await fitFirstBrowser(page)
  }
}

/** Frame the CURRENT project's first Browser board, holding the camera above `LOD_ZOOM`. Reads the
 *  id from the live store rather than remembering one: after a switch the boards are rehydrated
 *  from disk, so a seeded id captured earlier belongs to a canvas that has since been remounted. */
async function fitFirstBrowser(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (globalThis as unknown as RendererGlobal).__canvasE2E
    const first = api.getBoards().find((b) => b.type === 'browser')
    if (first) api.fitView(first.id)
  })
}

/**
 * Wait for the project just landed on to bring its resources back up.
 *
 * The keep-path parks PTYs and freezes previews rather than killing them, but the boards still
 * remount and re-attach on the way back in, and a switch measured while that is still in flight
 * would be a switch away from a half-empty canvas.
 *
 * THE CAMERA HAS TO BE RE-FITTED, and that is a real product behaviour rather than a harness wart:
 * landing on a project frames its whole canvas, which for a spread-out multi-board project settles
 * at zoom ≈ 0.25 — below `LOD_ZOOM` (0.4). Below LOD the incoming project's previews do not paint
 * and their windows do not open, so without this the bench would measure switch after switch away
 * from a canvas whose only live windows belonged to the OTHER, backgrounded project. Measured while
 * building this bench: after a switch back, `{ open: 4, painting: 0 }` — the four being the
 * backgrounded resident's, none of them the current project's.
 *
 * Re-fitting happens strictly BETWEEN measured switches, never inside one, so it costs the
 * measurement nothing; it just holds the configuration constant across samples.
 */
async function reviveResources(
  page: Page,
  app: ElectronApplication,
  cfg: ResourceConfig
): Promise<void> {
  if (cfg.terminals === 0 && cfg.previews === 0) return
  if (cfg.previews > 0) await fitFirstBrowser(page)
  try {
    await expect
      .poll(
        async () => {
          const c = await census(app)
          // The cap, not the seeded count, is the reachable target for previews: the renderer lets
          // at most OSR_MAX_LIVE (4) windows exist per canvas however many boards are seeded.
          const wantOsr = Math.min(cfg.previews, OSR_MAX_LIVE)
          return c.terminals >= cfg.terminals && c.osrOpen >= wantOsr
        },
        { timeout: REVIVE_BUDGET_MS }
      )
      .toBe(true)
  } catch {
    /* non-fatal by design — the per-sample census reports what was actually there */
  }
}

/** Re-seed the on-disk asset store for both projects: `gcAssets` quarantined the previous set on
 *  the last open, so without this only the FIRST switch of a run would face a full directory. */
async function reseedAssets(
  app: ElectronApplication,
  cfg: ResourceConfig,
  dirs: string[]
): Promise<void> {
  if (cfg.assets === 0) return
  for (const d of dirs) {
    await mainCall<string[]>(app, 'seedProjectAssets', d, cfg.assets, ASSET_BYTES)
  }
}

/**
 * Switch, then wait for the switch's OWN record.
 *
 * `switchProjectFromDisk` resolves as soon as the new project is applied, but `paintable` is marked
 * two frames later — so reading `lastSwitchMetrics()` immediately can legitimately return the
 * PREVIOUS switch's record, and every measurement would silently be reported one switch late.
 */
async function switchAndMeasure(
  page: Page,
  app: ElectronApplication,
  dir: string
): Promise<Sample> {
  // Captured BEFORE the switch: this is the state the outgoing project's flush, thumbnail capture
  // and handover actually contend with, which is the thing `arm` is being blamed on.
  const before = await census(app)
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
  return { metrics, census: before }
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

function report(cfg: ResourceConfig, samples: Sample[]): void {
  const seg = (pick: (r: SwitchRecord) => number | null) =>
    summarize(samples.map((s) => pick(s.metrics)))
  const fmt = (s: ReturnType<typeof summarize>): string =>
    s === null ? '        —' : `${String(s.median).padStart(7)}ms`
  const range = (s: ReturnType<typeof summarize>): string =>
    s === null ? '' : `  (${s.min}–${s.max})`

  const total = seg((r) => r.total)
  const arm = seg((r) => r.arm)
  const load = seg((r) => r.load)
  const paint = seg((r) => r.paint)
  const mainOpen = seg((r) => r.mainOpen)

  // The measured resource state, NOT the requested one — the caps make those different numbers.
  const live = {
    terminals: summarize(samples.map((s) => s.census.terminals)),
    osrOpen: summarize(samples.map((s) => s.census.osrOpen)),
    osrPainting: summarize(samples.map((s) => s.census.osrPainting))
  }
  const liveFmt = (s: ReturnType<typeof summarize>): string =>
    s === null ? '—' : `${s.median} (${s.min}–${s.max})`

  console.log(
    `\n=== SWITCH BENCH (LIVE RESOURCES) — ${cfg.key}: ` +
      `${cfg.terminals} terminal(s) + ${cfg.previews} preview(s) + ${cfg.assets} asset(s) ` +
      `per project, ${samples.length} switches ===\n` +
      `  MEASURED at switch time — terminals ${liveFmt(live.terminals)} · ` +
      `osr open ${liveFmt(live.osrOpen)} · osr painting ${liveFmt(live.osrPainting)}\n` +
      `  total  ${fmt(total)}${range(total)}\n` +
      `  arm    ${fmt(arm)}${range(arm)}   <- the dead air (PS-1); budget 100ms, timeouts at 800ms\n` +
      `  load   ${fmt(load)}${range(load)}\n` +
      `  paint  ${fmt(paint)}${range(paint)}\n` +
      `  main   ${fmt(mainOpen)}${range(mainOpen)}   <- project:open handler, inside 'load'\n`
  )

  recordBench({
    bench: 'switch-latency-resources',
    config: {
      config: cfg.key,
      terminalsSeeded: cfg.terminals,
      previewsSeeded: cfg.previews,
      assetsSeeded: cfg.assets,
      switches: samples.length
    },
    data: { total, arm, load, paint, mainOpen, live }
  })
}

test.describe('@bench project switch latency — live resources', () => {
  for (const cfg of CONFIGS) {
    test(`switch latency — resource-bearing (${cfg.key})`, async ({ page, electronApp }) => {
      test.setTimeout(TEST_TIMEOUT_MS)
      // MINT AND OPEN INTERLEAVED, B first. `createTempProject` flips MAIN's currentDir, and
      // `project:open` only approves a dir that is current or in recents — so minting both up
      // front and opening afterwards leaves the first one unapproved and it settles 'error'.
      const b = await mintProject(electronApp, 'bench-res-b', 'Bench Res B')
      await openFromDisk(page, b)
      const a = await mintProject(electronApp, 'bench-res-a', 'Bench Res A')
      try {
        await openFromDisk(page, a)

        // Boards have to reach DISK, and only a switch flushes. Seed A, switch (flushing A), seed
        // B, switch back (flushing B) — after which BOTH projects carry the resources, which is
        // what makes every later switch a resource-bearing one in both directions.
        await seedResources(page, electronApp, cfg)
        await reseedAssets(electronApp, cfg, [a, b])
        await switchAndMeasure(page, electronApp, b)
        await seedResources(page, electronApp, cfg)

        // This switch is also the warm-up, and is discarded. The first switch of a run pays
        // one-time costs — cold filesystem cache, first thumbnail capture, lazily-created
        // directories, first offscreen window — that no later switch pays.
        await reseedAssets(electronApp, cfg, [a, b])
        await switchAndMeasure(page, electronApp, a)
        await reviveResources(page, electronApp, cfg)

        const samples: Sample[] = []
        for (let i = 0; i < REPEATS; i++) {
          await reseedAssets(electronApp, cfg, [a, b])
          samples.push(await switchAndMeasure(page, electronApp, i % 2 === 0 ? b : a))
          await reviveResources(page, electronApp, cfg)
        }
        report(cfg, samples)

        // Soft floor only, matching the sibling bench: a benchmark must not pass while measuring
        // nothing. Latency THRESHOLDS are deliberately not asserted — this is a measurement tool,
        // and a timing gate here would be flaky. Judge the numbers from the committed baseline.
        for (const s of samples) {
          expect(s.metrics.total, 'switch recorded a total').not.toBeNull()
          expect(s.metrics.outcome, 'switch completed').toBe('switched')
        }
      } finally {
        // Land somewhere neutral before deleting the temp dirs — teardown while a project is still
        // open leaves the app pointed at a directory that no longer exists.
        await openFromDisk(page, a).catch(() => undefined)
        await mainCall(electronApp, 'teardownProject', a).catch(() => undefined)
        await mainCall(electronApp, 'teardownProject', b).catch(() => undefined)
      }
    })
  }
})
