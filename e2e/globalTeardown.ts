import os from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { classifyOwnRun, scanTempDirs, removeTempDirs } from '../scripts/e2eTempSweep'

/**
 * Reclaim this run's trace/artifact scratch (fix/e2e-storage). Playwright's own temp
 * cleanup races the worker's exit and loses — measured 2026-07-29: even a fully green
 * run orphaned ~0.7 GB (screenshots on) per run, every run. This teardown runs in the
 * runner process after all workers are gone, including on Ctrl-C (Playwright runs
 * global teardown on interrupt), so it wins that race by construction. Hard kills
 * that skip it are covered by the next run's globalSetup retention sweep.
 */
export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_KEEP_TMP) return
  // 1. The relocated trace buffer (fixtures.ts `tracesDir`) — inside THIS checkout's
  //    test-results, so it is provably ours; failure trace.zips were already exported
  //    to each test's output dir by stopChunk before we get here.
  try {
    rmSync(join(__dirname, '..', 'test-results', '.pw-trace'), {
      recursive: true,
      force: true,
      maxRetries: 2
    })
  } catch {
    /* locked — next run's outputDir wipe gets it */
  }
  // 2. os.tmpdir() scratch created during this run (snapshot diff vs globalSetup).
  //    The trace payload lives in .pw-trace above, so what remains here is Playwright's
  //    small per-launch scratch (downloads staging, client stacks). Worst case a
  //    sibling checkout's run that STARTED mid-run loses kilobyte-scale download
  //    scratch — its failure evidence is unaffected (its traces are in its own
  //    checkout's .pw-trace).
  //    FAIL CLOSED on a missing/unreadable snapshot: without a trustworthy pre-run
  //    set the diff degenerates to "every playwright* dir", which would claim a
  //    concurrent sibling checkout's LIVE scratch. Skip instead — the >6h retention
  //    sweep reclaims this run's crumbs on the next invocation.
  const root = os.tmpdir()
  const rawSnapshot = process.env.E2E_TEMP_PRERUN
  if (rawSnapshot === undefined) {
    console.log('[e2e-temp] run cleanup skipped: no pre-run snapshot (fail closed)')
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawSnapshot)
  } catch {
    parsed = undefined
  }
  if (!Array.isArray(parsed)) {
    console.log('[e2e-temp] run cleanup skipped: pre-run snapshot unreadable (fail closed)')
    return
  }
  const preRun: ReadonlySet<string> = new Set(
    parsed.filter((n): n is string => typeof n === 'string')
  )
  const created = classifyOwnRun(scanTempDirs(root), preRun).delete
  if (created.length) {
    const removed = removeTempDirs(root, created)
    console.log(
      `[e2e-temp] run cleanup: removed ${removed.length} playwright scratch dir(s) this run created in ${root}`
    )
  }
}
