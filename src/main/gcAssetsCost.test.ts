import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { performance } from 'node:perf_hooks'
import { gcAssets } from './projectStore'

/**
 * Audit R11, the re-scoped question — "quantify the REFERENCED-asset path, then decide".
 *
 * The number that revived R11 (`mainOpen` 9.8–13.0 ms → 65.4 ms at 44 assets, BASELINE.md §6) was
 * taken with the seeded assets deliberately UNREFERENCED, so `gcAssets` took its worst path: a
 * quarantine copy-then-unlink of every file, i.e. ~3.5 MB of file I/O per open. A real project
 * whose doc references its own assets pays `readdirSync` plus a Set lookup per file and moves
 * nothing. Those are different algorithms, not different constants, so the honest way to price
 * R11's remaining premise is to run both against the same directory.
 *
 * Isolated rather than measured through a switch on purpose: the switch-level figure buries a
 * sub-millisecond candidate under ~300 ms of unrelated work, and the box's ±40% ambient spread
 * (BASELINE.md) is larger than the effect being priced.
 *
 * OPT-IN — `pnpm test` must stay a correctness gate, not a timing one, and a timing assertion in
 * CI is a flake generator. Run it with:
 *   CANVAS_ASSET_BENCH=1 pnpm vitest run src/main/gcAssetsCost.test.ts
 */
const ENABLED = process.env.CANVAS_ASSET_BENCH === '1'

/** The audit's field survey found a real project at 44 files / 3.58 MB. */
const ASSET_COUNT = 44
const ASSET_BYTES = 80 * 1024
const REPEATS = 9

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const round2 = (n: number): number => Math.round(n * 100) / 100

describe.skipIf(!ENABLED)('gcAssets cost — referenced vs unreferenced (audit R11)', () => {
  /** A project whose `.canvas/assets/` holds ASSET_COUNT distinct blobs. Returns their ids. */
  const seed = (): { dir: string; ids: string[] } => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-gc-'))
    const assets = join(dir, '.canvas', 'assets')
    mkdirSync(assets, { recursive: true })
    const ids: string[] = []
    for (let i = 0; i < ASSET_COUNT; i++) {
      // Distinct bytes per file so nothing collapses to a single blob.
      writeFileSync(join(assets, `asset${i}.png`), Buffer.alloc(ASSET_BYTES, (i % 251) + 1))
      ids.push(`assets/asset${i}.png`)
    }
    return { dir, ids }
  }

  it('prices both paths at 44 assets / 3.5 MB', () => {
    const referenced: number[] = []
    const unreferenced: number[] = []
    const secondSweep: number[] = []
    for (let r = 0; r < REPEATS; r++) {
      // Referenced: the doc claims every blob — a readdir plus a Set hit per file, no I/O.
      {
        const { dir, ids } = seed()
        const t = performance.now()
        gcAssets(dir, new Set(ids))
        referenced.push(performance.now() - t)
        // Nothing may have been swept: that is the property the timing is meaningless without.
        expect(readdirSync(join(dir, '.canvas', 'assets'))).toHaveLength(ASSET_COUNT)
        rmSync(dir, { recursive: true, force: true })
      }
      // Unreferenced: the worst path, and the one BASELINE.md §6's 65.4 ms was taken on. The
      // SECOND sweep of the same directory is measured too, because the quarantine is not re-done:
      // the orphans are already in `.trash`, which the sweep skips. That decides whether the worst
      // path is a per-open cost (R11's premise) or a one-time cost after orphaning.
      {
        const { dir } = seed()
        const t = performance.now()
        gcAssets(dir, new Set<string>())
        unreferenced.push(performance.now() - t)
        expect(readdirSync(join(dir, '.canvas', 'assets', '.trash'))).toHaveLength(ASSET_COUNT)
        const t2 = performance.now()
        gcAssets(dir, new Set<string>())
        secondSweep.push(performance.now() - t2)
        rmSync(dir, { recursive: true, force: true })
      }
    }
    const ref = round2(median(referenced))
    const unref = round2(median(unreferenced))
    // Written to a file rather than logged: vitest swallows test-side console output under this
    // repo's reporter setup, and a measurement you cannot read is not a measurement. The default
    // lands under the repo's own gitignored test-results/, not the world-shared OS temp dir — a
    // fixed filename in tmpdir is symlink-attackable (CodeQL js/insecure-temporary-file).
    const out =
      process.env.CANVAS_ASSET_BENCH_OUT ??
      join(process.cwd(), 'test-results', 'gc-assets-cost.json')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(
      out,
      JSON.stringify(
        {
          assets: ASSET_COUNT,
          bytesEach: ASSET_BYTES,
          repeats: REPEATS,
          referencedMs: { median: ref, samples: referenced.map(round2) },
          unreferencedMs: { median: unref, samples: unreferenced.map(round2) },
          unreferencedSecondSweepMs: {
            median: round2(median(secondSweep)),
            samples: secondSweep.map(round2)
          },
          ratio: round2(unref / Math.max(ref, 0.001))
        },
        null,
        2
      )
    )
    // Soft floor only: a benchmark must not pass while measuring nothing.
    expect(referenced).toHaveLength(REPEATS)
    expect(unreferenced).toHaveLength(REPEATS)
  })
})
