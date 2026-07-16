/**
 * Busy-aware background eviction — the CPU-delta busy probe.
 *
 * Output recency (ptyProjectStats.projectActivityAtCore) catches a streaming agent, but NOT a
 * silent worker: an agent 15 minutes into a 20-minute e2e run may print nothing while burning
 * CPU. Child-process EXISTENCE can't discriminate either — an idle agent CLI at its prompt (plus
 * its MCP-server children) is a process tree too. What discriminates is CPU-time DELTA between
 * sweeps: the descendant tree of a working shell accumulates CPU; an idle-at-prompt tree does not.
 *
 * Each sweep (backgroundSessions, 60s cadence) samples the FULL process table once — one
 * `Get-CimInstance Win32_Process` on Windows / one `ps -Ao` on POSIX — walks each resident's
 * session-root descendants, sums their CPU time, and compares against the previous sweep:
 * delta ≥ CPU_BUSY_EPSILON_MS ⇒ the dir is busy (protected from the idle reap + cap eviction).
 *
 * Known limits (both fail toward keeping a resident ALIVE, never toward killing a worker):
 *  - PID reuse / stale PPID chains can misattribute a stray subtree → false busy (rare, bounded;
 *    the pid-reuse e2e class this repo already met). No creation-time filter — wrong-direction
 *    risk only inflates the sum.
 *  - A sample failure keeps the PREVIOUS verdicts (never blind-idles every resident); the
 *    two-strike warning in the registry is the backstop for a persistently failing sampler.
 *  - The truly-zero-CPU blocking wait (pure `sleep`) is undetectable here — covered by the
 *    registry's two-strike warn-then-close, not by this probe.
 */
import { execFile } from 'node:child_process'

/** One process-table row: parent pid + accumulated CPU time (user+kernel), milliseconds. */
export interface ProcStat {
  ppid: number
  cpuMs: number
}
export type ProcTable = Map<number, ProcStat>

/** Tree-CPU delta per sweep at/above which a resident counts as WORKING. Generous headroom over
 *  scheduler noise (an idle prompt tree accrues ~0), tiny next to any real workload. */
export const CPU_BUSY_EPSILON_MS = 100

/** Descendant-tree CPU sum for `roots` (roots included). Cycle-safe (PID-reuse can fabricate
 *  parent loops); a root missing from the table (proc died between sample and walk) sums 0. */
export function descendantCpuMsCore(roots: number[], table: ProcTable): number {
  const children = new Map<number, number[]>()
  for (const [pid, st] of table) {
    const kids = children.get(st.ppid)
    if (kids) kids.push(pid)
    else children.set(st.ppid, [pid])
  }
  const seen = new Set<number>()
  const queue = [...roots]
  let sum = 0
  while (queue.length) {
    const pid = queue.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    const st = table.get(pid)
    if (st) sum += st.cpuMs
    const kids = children.get(pid)
    if (kids) queue.push(...kids)
  }
  return sum
}

/** Parse a POSIX `ps` TIME field (`[[dd-]hh:]mm:ss[.cc]`) to milliseconds. Malformed → 0. */
export function parsePsTime(t: string): number {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t.trim())
  if (!m) return 0
  const [, dd, hh, mm, ss] = m
  return ((Number(dd ?? 0) * 24 + Number(hh ?? 0)) * 3600 + Number(mm) * 60 + Number(ss)) * 1000
}

/** Parse `ps -Ao pid=,ppid=,time=` output. Unparseable lines are skipped. */
export function parsePsOutput(text: string): ProcTable {
  const table: ProcTable = new Map()
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    table.set(pid, { ppid, cpuMs: parsePsTime(parts[2]) })
  }
  return table
}

/** Parse the Windows CIM JSON (ConvertTo-Json of ProcessId/ParentProcessId/KernelModeTime/
 *  UserModeTime). CIM mode times are 100ns ticks → ms = /10_000. Malformed JSON → empty table. */
export function parseWinProcJson(json: string): ProcTable {
  const table: ProcTable = new Map()
  let rows: unknown
  try {
    rows = JSON.parse(json)
  } catch {
    return table
  }
  for (const r of Array.isArray(rows) ? rows : [rows]) {
    const o = r as Record<string, unknown>
    const pid = o?.ProcessId
    if (typeof pid !== 'number' || !Number.isInteger(pid)) continue
    const k = typeof o.KernelModeTime === 'number' ? o.KernelModeTime : 0
    const u = typeof o.UserModeTime === 'number' ? o.UserModeTime : 0
    const ppid = typeof o.ParentProcessId === 'number' ? o.ParentProcessId : 0
    table.set(pid, { ppid, cpuMs: (k + u) / 10_000 })
  }
  return table
}

const WIN_PS_SCRIPT =
  'Get-CimInstance Win32_Process | ' +
  'Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime | ConvertTo-Json -Compress'

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      // The full table is a few hundred KB of JSON on a busy box; 45s timeout ≪ the sweep gap.
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 45_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  })
}

/** One full process-table sample (pid → ppid + CPU ms). Rejects on spawn/timeout failure. */
export function sampleProcessTable(): Promise<ProcTable> {
  if (process.platform === 'win32') {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS_SCRIPT]).then(
      parseWinProcJson
    )
  }
  return run('ps', ['-Ao', 'pid=,ppid=,time=']).then(parsePsOutput)
}

export interface BusyProbe {
  /** Re-sample and refresh per-dir verdicts. `roots` = dir → its session root PIDs
   *  (ptyProjectStats.projectSessionPids). Dirs absent from `roots` are forgotten. */
  update(roots: Map<string, number[]>): Promise<void>
  /** Latest verdict for `dir`. Never-probed dirs read false (the output-recency window in the
   *  registry covers the gap until the first sweep probes them). */
  isBusy(dir: string): boolean
}

export function createBusyProbe(sample: () => Promise<ProcTable> = sampleProcessTable): BusyProbe {
  const prevCpu = new Map<string, number>()
  const busy = new Map<string, boolean>()
  const prune = (roots: Map<string, number[]>): void => {
    for (const dir of [...prevCpu.keys()]) if (!roots.has(dir)) prevCpu.delete(dir)
    for (const dir of [...busy.keys()]) if (!roots.has(dir)) busy.delete(dir)
  }
  return {
    async update(roots) {
      let table: ProcTable
      try {
        table = await sample()
      } catch (err) {
        // Keep the previous verdicts — a transient sampler failure must never blind-idle a
        // working resident. (Persistently failing sampler → the two-strike warn is the net.)
        console.warn('[bg-busy] process sample failed (keeping previous verdicts)', err)
        prune(roots)
        return
      }
      prune(roots)
      for (const [dir, pids] of roots) {
        const sum = descendantCpuMsCore(pids, table)
        const prev = prevCpu.get(dir)
        // First sample = busy (conservative): a delta needs two samples; a fresh resident is
        // protected until the next sweep can actually measure it.
        busy.set(dir, prev === undefined ? true : sum - prev >= CPU_BUSY_EPSILON_MS)
        prevCpu.set(dir, sum)
      }
    },
    isBusy(dir) {
      return busy.get(dir) ?? false
    }
  }
}
