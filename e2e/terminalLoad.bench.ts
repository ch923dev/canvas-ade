// e2e/terminalLoad.bench.ts — P2 load test for the terminal DOM renderer
// (terminal-crisp umbrella, docs/research/2026-06-25-terminal-dom-renderer).
//
// DECISION GATE: with the live terminal on xterm's DOM renderer, do N busy/streaming
// terminals stay smooth under the camera transform — or do we need the WebGL-at-zoom-1
// hybrid? This harness boots the real app, seeds N terminals each running an INFINITE
// colored-output stream through the real PTY → MessagePort → xterm.write path (exactly
// what a busy agent TUI does), tiles them above LOD so all render live simultaneously,
// and measures renderer frame cadence (rAF deltas, in-page so there are no per-frame
// bridge round-trips) across three phases at the SAME stream load:
//
//   STATIC — camera idle while streaming        (isolates write/DOM-mutation cost)
//   PAN    — camera panning while streaming      (adds layer re-compositing)
//   ZOOM   — camera zoom + pan while streaming   (adds DOM glyph re-rasterization)
//
// Reading the three together discriminates the bottleneck and therefore the fix:
//   • STATIC bad                  → write/CPU bound, renderer-agnostic → DOM-only is fine,
//                                    add write-coalescing + below-LOD paint-gating (Lane A),
//                                    NOT WebGL.
//   • STATIC good, ZOOM much worse → transform re-raster cost (DOM re-rasters glyphs each
//                                    scale) → the case where WebGL-at-zoom-1 could help.
//   • STATIC ≈ ZOOM, both good     → DOM-only is smooth under load → ship it, no hybrid.
//
// NOT a gate spec (separate playwright.bench.config.ts, '*.bench.ts'); run on demand:
//   pnpm build && pnpm exec playwright test --config playwright.bench.config.ts
import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'

// One PTY line: an infinite loop of colored lines. [char]27 (not `e) so it streams under
// pwsh 7 AND Windows PowerShell 5.1. The 7-way colour cycle forces the DOM renderer to emit
// many styled <span> runs per row — its specific stressor. Killed on reset()/app close.
const STREAM_CMD =
  "$ESC=[char]27; while($true){ for($i=0;$i -lt 400;$i++){ Write-Host ($ESC + '[3' + ($i % 7) + 'm' + 'LINE ' + $i + ' the quick brown fox 0123456789 ' + ('x' * 40) + $ESC + '[0m') } }"

const PINNED = 12.5
const CELL_W = 480
const CELL_H = 400
const PHASE_MS = 4000

interface PhaseStats {
  mode: string
  frames: number
  durationMs: number
  fps: number
  p50: number
  p95: number
  p99: number
  max: number
  jank30: number // % of frames slower than 33.3ms (below 30fps)
  jank50: number // % of frames slower than 50ms
}

/** Run a rAF loop in-page for `durationMs`, driving the camera per `mode`, collecting frame
 *  deltas. Everything stays in the renderer so the timing reflects the real main-thread
 *  cadence (no Playwright bridge latency per frame). */
function measurePhase(
  page: Parameters<typeof evalIn>[0],
  mode: 'static' | 'pan' | 'zoom',
  durationMs: number
): Promise<PhaseStats> {
  return page.evaluate(
    ({ mode, durationMs }) => {
      // The callback runs in the renderer (browser) context, but tsc typechecks this file
      // under tsconfig.node.json (no DOM lib) — so reach the browser globals through a typed
      // cast rather than referencing rAF/performance directly.
      const g = globalThis as unknown as {
        __canvasE2E: {
          getZoom(): number
          setZoom(z: number): void
          panBy(dx: number, dy: number): void
        }
        requestAnimationFrame(cb: (t: number) => void): number
        performance: { now(): number }
      }
      const api = g.__canvasE2E
      const base = api.getZoom()
      const dts: number[] = []
      return new Promise<PhaseStats>((resolve) => {
        let last = g.performance.now()
        const start = last
        const tick = (now: number): void => {
          const dt = now - last
          last = now
          const t = (now - start) / 1000
          // Skip the first ~50ms so the warmup frame (scheduling lag) doesn't skew p-values.
          if (now - start > 50) dts.push(dt)
          if (mode === 'pan') {
            api.panBy(Math.cos(t * 1.3) * 14, Math.sin(t * 0.9) * 10)
          } else if (mode === 'zoom') {
            api.setZoom(Math.max(0.42, base * (1 + 0.25 * Math.sin(t * 1.5))))
            api.panBy(Math.cos(t * 1.3) * 10, 0)
          }
          if (now - start >= durationMs) {
            const sorted = [...dts].sort((a, b) => a - b)
            const pct = (p: number): number =>
              sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0
            const slower = (ms: number): number =>
              sorted.length ? (sorted.filter((d) => d > ms).length / sorted.length) * 100 : 0
            const elapsed = now - start
            resolve({
              mode,
              frames: dts.length,
              durationMs: Math.round(elapsed),
              fps: +((dts.length / elapsed) * 1000).toFixed(1),
              p50: +pct(0.5).toFixed(1),
              p95: +pct(0.95).toFixed(1),
              p99: +pct(0.99).toFixed(1),
              max: +(sorted[sorted.length - 1] ?? 0).toFixed(1),
              jank30: +slower(33.3).toFixed(1),
              jank50: +slower(50).toFixed(1)
            })
          } else {
            g.requestAnimationFrame(tick)
          }
        }
        g.requestAnimationFrame(tick)
      })
    },
    { mode, durationMs }
  )
}

/** Tile N terminals in a grid (cols≈√N), each streaming, then fit the camera. Returns the
 *  ids + the settled fit zoom (so the report can confirm they were above LOD = live). */
async function seedStreamingGrid(
  page: Parameters<typeof evalIn>[0],
  n: number
): Promise<{ ids: string[]; fitZoom: number }> {
  await evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '${PINNED}')`)
  const cols = Math.ceil(Math.sqrt(n))
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = await seed(page, 'terminal', { launchCommand: STREAM_CMD })
    const x = (i % cols) * CELL_W
    const y = Math.floor(i / cols) * CELL_H
    await evalIn(page, `window.__canvasE2E.patchBoard(${JSON.stringify(id)}, { x: ${x}, y: ${y} })`)
    ids.push(id)
  }
  // Wait for every terminal to mount.
  for (const id of ids) {
    await expect
      .poll(() => evalIn(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`), {
        timeout: 12_000
      })
      .toBe(true)
  }
  // Frame all of them above LOD so they all render live text simultaneously.
  await evalIn(page, `window.__canvasE2E.fitView()`)
  await page.waitForTimeout(400)
  const fitZoom = await evalIn<number>(page, `window.__canvasE2E.getZoom()`)
  return { ids, fitZoom }
}

/** Confirm the streams are actually flowing: every terminal's buffer must grow over ~1.5s. */
async function assertStreaming(page: Parameters<typeof evalIn>[0], ids: string[]): Promise<void> {
  const lenOf = (id: string): Promise<number> =>
    evalIn<number>(page, `(window.__canvasE2E.readTerminal(${JSON.stringify(id)}) ?? '').length`)
  const before = await Promise.all(ids.map(lenOf))
  await page.waitForTimeout(1500)
  const after = await Promise.all(ids.map(lenOf))
  const growing = ids.filter((_, i) => after[i] > before[i]).length
  expect(growing, `all ${ids.length} terminals streaming (buffer growing)`).toBe(ids.length)
}

function report(n: number, fitZoom: number, phases: PhaseStats[]): void {
  const rows = phases
    .map(
      (p) =>
        `  ${p.mode.padEnd(6)} fps=${String(p.fps).padStart(5)}  p50=${String(p.p50).padStart(5)}ms` +
        `  p95=${String(p.p95).padStart(6)}ms  p99=${String(p.p99).padStart(6)}ms` +
        `  max=${String(p.max).padStart(6)}ms  jank>33ms=${String(p.jank30).padStart(5)}%` +
        `  jank>50ms=${String(p.jank50).padStart(5)}%`
    )
    .join('\n')
  console.log(
    `\n=== TERMINAL LOAD BENCH — N=${n} terminals streaming, fitZoom=${fitZoom.toFixed(3)}` +
      `${fitZoom < 0.4 ? ' (BELOW LOD — not live!)' : ' (live)'} ===\n${rows}\n`
  )
}

test.describe('@bench terminal DOM renderer under streaming load', () => {
  for (const n of [1, 4, 8]) {
    test(`N=${n} streaming terminals — frame cadence under static/pan/zoom`, async ({ page }) => {
      const { ids, fitZoom } = await seedStreamingGrid(page, n)
      await assertStreaming(page, ids)
      const phases: PhaseStats[] = []
      for (const mode of ['static', 'pan', 'zoom'] as const) {
        phases.push(await measurePhase(page, mode, PHASE_MS))
      }
      report(n, fitZoom, phases)
      // Soft floor only — a benchmark must not silently pass while producing a slideshow.
      // Real thresholds are judged from the printed report, not asserted here.
      for (const p of phases) {
        expect(p.frames, `${p.mode}: rAF actually ran`).toBeGreaterThan(10)
      }
    })
  }
})
