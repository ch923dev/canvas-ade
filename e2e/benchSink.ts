/**
 * Machine-readable sink for the benches (audit R2).
 *
 * The benches print human tables to stdout, which is fine for reading a run and useless for
 * comparing two. `scripts/bench-baseline.mjs` sets `BENCH_JSON` to a file path, every bench appends
 * one NDJSON line per measured configuration, and the script folds those lines together with the
 * machine state into a committed `BASELINE.json`.
 *
 * NDJSON rather than a single JSON document because Playwright may run benches across workers and
 * across test files: appending whole lines needs no read-modify-write, so two concurrent benches
 * cannot clobber each other's results. Reading is a split on newlines.
 *
 * Entirely inert when `BENCH_JSON` is unset — a plain `pnpm bench` still just prints.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** One measured configuration of one bench. `config` identifies it (e.g. `{ n: 4 }`); `data` is
 *  whatever that bench measures, shape-owned by the bench itself. */
export interface BenchRecord {
  /** Stable bench id, e.g. `terminal-load` / `switch-latency`. */
  bench: string
  /** What distinguishes this run from the bench's other runs. */
  config: Record<string, number | string | boolean>
  /** The measurements. */
  data: unknown
}

/** Append one record. Never throws into a bench: a failed write must not fail a measurement that
 *  already succeeded — the human-readable table is still on stdout either way. */
export function recordBench(record: BenchRecord): void {
  const target = process.env.BENCH_JSON
  if (target === undefined || target === '') return
  try {
    mkdirSync(dirname(target), { recursive: true })
    appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[bench] could not append to BENCH_JSON (${String(err)})`)
  }
}
