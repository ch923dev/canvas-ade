import { readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Temp-litter lifecycle for the e2e suite (fix/e2e-storage, measured 2026-07-29).
 *
 * Playwright buffers per-context trace data in `os.tmpdir()` scratch dirs
 * (`playwright-artifacts-*`, `playwright-tracing-*`). Measured on this suite: even a
 * fully green run ORPHANS its scratch (~0.7 GB with tracing screenshots on, ~70 MB
 * off) — the worker process exits before Playwright's async temp cleanup finishes, so
 * the dirs survive every run, not just killed ones. Six weeks of that was 1,383 dirs
 * / 103.5 GB on the system drive.
 *
 * Containment is three independent pieces:
 *  1. the trace buffer itself is relocated into the repo's `test-results/.pw-trace`
 *     (fixtures.ts `tracesDir`) — per-checkout, so reclaiming it can never touch a
 *     concurrent sibling checkout's run, and Playwright wipes `test-results` on the
 *     next run anyway;
 *  2. `globalTeardown` deletes that relocated buffer plus any tmpdir scratch created
 *     during THIS run (snapshot diff) — covers clean exits and Ctrl-C (Playwright
 *     runs global teardown on interrupt);
 *  3. `globalSetup` sweeps tmpdir scratch that has been idle past a retention window
 *     — covers hard kills (taskkill /F, crashed runner) whose teardown never ran.
 *
 * This module is the pure decision logic + a thin fs walker so the policy is unit
 * testable (vitest, node env) without an e2e run.
 */

/** Scratch-dir name families the e2e run may create in os.tmpdir(). */
export const TEMP_PATTERN = /^playwright/

/**
 * Never swept: a persistent shared cache (bounded, ~4 MB, reused across runs —
 * deleting it only slows the next run), not per-run scratch.
 */
export const KEEP_NAMES = new Set(['playwright-transform-cache'])

/** Idle time after which an unclaimed scratch dir is treated as a dead run's litter. */
export const STALE_MS = 6 * 60 * 60 * 1000

export interface TempDirInfo {
  name: string
  /** Newest mtime (ms) of the dir itself or any immediate child — cheap liveness signal. */
  newestMtimeMs: number
}

export interface SweepDecision {
  delete: string[]
  keep: string[]
}

/**
 * Retention sweep (globalSetup): delete scratch idle past `staleMs`. A LIVE run —
 * ours or a sibling checkout's — appends to its trace files continuously, so its
 * newest mtime is always recent; only dead runs' litter ages past the window.
 */
export function classifyStale(
  dirs: TempDirInfo[],
  nowMs: number,
  staleMs: number = STALE_MS
): SweepDecision {
  const decision: SweepDecision = { delete: [], keep: [] }
  for (const d of dirs) {
    if (!TEMP_PATTERN.test(d.name) || KEEP_NAMES.has(d.name)) {
      decision.keep.push(d.name)
    } else if (nowMs - d.newestMtimeMs >= staleMs) {
      decision.delete.push(d.name)
    } else {
      decision.keep.push(d.name)
    }
  }
  return decision
}

/**
 * Own-run sweep (globalTeardown): delete scratch that did not exist when the run
 * started. Anything new in tmpdir since globalSetup was created by THIS run (the
 * trace payload itself lives in the per-checkout `test-results/.pw-trace`, so a
 * concurrent sibling run's failure evidence cannot be harmed; at worst a sibling
 * that STARTED mid-run loses kilobyte-scale download scratch — accepted + disclosed).
 */
export function classifyOwnRun(dirs: TempDirInfo[], preRun: ReadonlySet<string>): SweepDecision {
  const decision: SweepDecision = { delete: [], keep: [] }
  for (const d of dirs) {
    if (!TEMP_PATTERN.test(d.name) || KEEP_NAMES.has(d.name) || preRun.has(d.name)) {
      decision.keep.push(d.name)
    } else {
      decision.delete.push(d.name)
    }
  }
  return decision
}

/** List playwright* scratch dirs in `root` with their cheap liveness mtime. */
export function scanTempDirs(root: string): TempDirInfo[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: TempDirInfo[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !TEMP_PATTERN.test(e.name)) continue
    const full = join(root, e.name)
    let newest = 0
    try {
      newest = statSync(full).mtimeMs
      for (const child of readdirSync(full)) {
        try {
          const m = statSync(join(full, child)).mtimeMs
          if (m > newest) newest = m
        } catch {
          /* child vanished mid-scan */
        }
      }
    } catch {
      continue
    }
    out.push({ name: e.name, newestMtimeMs: newest })
  }
  return out
}

/** Delete the named dirs under `root`; returns the names that were actually removed. */
export function removeTempDirs(root: string, names: string[]): string[] {
  const removed: string[] = []
  for (const name of names) {
    // Defense in depth: never follow a name outside the temp root or outside the
    // playwright* family, whatever the caller passed.
    if (!TEMP_PATTERN.test(name) || name.includes('/') || name.includes('\\')) continue
    try {
      rmSync(join(root, name), { recursive: true, force: true, maxRetries: 2 })
      removed.push(name)
    } catch {
      /* locked by AV / still open — the next run's retention sweep gets it */
    }
  }
  return removed
}
