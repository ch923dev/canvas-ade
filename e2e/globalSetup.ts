import os from 'node:os'
import { classifyStale, scanTempDirs, removeTempDirs } from '../scripts/e2eTempSweep'

/**
 * Retention sweep for dead runs' temp litter (fix/e2e-storage). A hard-killed run
 * (taskkill /F, crashed runner) never reaches globalTeardown, so its os.tmpdir()
 * scratch survives; measured 2026-07-29 that litter had accumulated to 1,383 dirs /
 * 103.5 GB over six weeks. Anything idle past the 6h window is a dead run's litter —
 * a LIVE run (ours or a sibling checkout's) appends to its scratch continuously and
 * never ages past it. Disclosure: every deletion is printed. E2E_KEEP_TMP=1 skips
 * all sweeping (temp forensics / debugging).
 */
export default async function globalSetup(): Promise<void> {
  const root = os.tmpdir()
  if (!process.env.E2E_KEEP_TMP) {
    const stale = classifyStale(scanTempDirs(root), Date.now()).delete
    if (stale.length) {
      const removed = removeTempDirs(root, stale)
      console.log(
        `[e2e-temp] retention sweep: removed ${removed.length} playwright scratch dir(s) ` +
          `idle >6h in ${root}: ${removed.join(', ')} (E2E_KEEP_TMP=1 skips this)`
      )
    }
  }
  // Snapshot AFTER the sweep — globalTeardown deletes tmpdir scratch not in this set,
  // i.e. exactly what this run created. Env survives to teardown (same runner process).
  process.env.E2E_TEMP_PRERUN = JSON.stringify(scanTempDirs(root).map((d) => d.name))
}
