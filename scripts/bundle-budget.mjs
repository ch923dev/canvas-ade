// Entry-chunk gzip budget (audit R12 — half of the §7 Phase-4 gate). Fails the CI `check`
// job when the renderer ENTRY chunk's gzip size exceeds the budget, so an accidental
// re-import of a lazy subsystem (the diagram bridge class of regression, ~+9 KB gzip)
// fails loudly instead of silently riding a merge. Run after `pnpm build`:
//   node scripts/bundle-budget.mjs
//
// Budget rationale (2026-07-30, v0.44.0): post-R12 entry = 418,800 B gzip. Budget 425,000
// leaves ~6 KB headroom — under the smallest regression class this guards against, above
// build-to-build noise (hash-only churn is byte-stable). Raise it DELIBERATELY (with a
// PR-body note) when a feature legitimately grows the entry; never raise it to silence a
// regression you can lazy-load instead.
// 2026-08-01 (v0.47.1, PR #422): 425,000 → 432,000. The old headroom had eroded to 136 B
// across #416–#421 (measured main = 424,864 B); #422's +539 B of eager store/lib code
// (boardSchema docked predicates, tidyApply, selection filter — entry-chunk by nature, its
// UI rides the lazy swarm chunk) tripped the wire. New budget restores ~6.6 KB headroom
// over the measured 425,403 B.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const BUDGET_GZIP_BYTES = 432_000

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out', 'renderer')

let html
try {
  html = readFileSync(join(outDir, 'index.html'), 'utf8')
} catch {
  console.error('bundle-budget: out/renderer/index.html not found — run `pnpm build` first.')
  process.exit(1)
}

// The entry chunk is the module script index.html actually loads (hash changes per build).
const m = html.match(/src="\.?\/?(assets\/index-[^"]+\.js)"/)
if (!m) {
  console.error(
    'bundle-budget: could not find the entry <script src="assets/index-*.js"> in index.html'
  )
  process.exit(1)
}

const entryPath = join(outDir, m[1])
const gz = gzipSync(readFileSync(entryPath)).length
const pct = ((gz / BUDGET_GZIP_BYTES) * 100).toFixed(1)
console.log(`bundle-budget: ${m[1]} gzip=${gz} B (budget ${BUDGET_GZIP_BYTES} B, ${pct}%)`)

if (gz > BUDGET_GZIP_BYTES) {
  console.error(
    `bundle-budget: ENTRY CHUNK OVER BUDGET by ${gz - BUDGET_GZIP_BYTES} B gzip.\n` +
      'Something eager joined the entry chunk. Prefer lazy-loading it (see the R12 diagram-bridge\n' +
      'pattern: import from a lazy board root, not main.tsx). If the growth is deliberate, raise\n' +
      'BUDGET_GZIP_BYTES in scripts/bundle-budget.mjs and say so in the PR body.'
  )
  process.exit(1)
}
