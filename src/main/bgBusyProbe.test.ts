import { describe, it, expect, vi } from 'vitest'
import {
  CPU_BUSY_EPSILON_MS,
  createBusyProbe,
  descendantCpuMsCore,
  parsePsOutput,
  parsePsTime,
  parseWinProcJson,
  type ProcTable
} from './bgBusyProbe'

// Busy-aware eviction: the CPU-delta probe. Pure cores (tree walk + parsers) plus the delta
// state machine, driven with fake samplers — no child_process spawns in unit land.

const table = (rows: [pid: number, ppid: number, cpuMs: number][]): ProcTable =>
  new Map(rows.map(([pid, ppid, cpuMs]) => [pid, { ppid, cpuMs }]))

describe('descendantCpuMsCore', () => {
  it('sums the root + its whole descendant tree, ignoring unrelated processes', () => {
    const t = table([
      [10, 1, 5], // root (shell)
      [11, 10, 20], // agent CLI
      [12, 11, 30], // agent's test runner
      [13, 12, 40], // runner's electron child
      [99, 1, 1000] // unrelated tree — must not count
    ])
    expect(descendantCpuMsCore([10], t)).toBe(95)
  })

  it('handles multiple roots, a missing root (proc died between sample and walk), and cycles', () => {
    const cyclic = table([
      [20, 21, 7], // PID-reuse can fabricate parent loops — the walk must terminate
      [21, 20, 8]
    ])
    expect(descendantCpuMsCore([20], cyclic)).toBe(15)
    expect(descendantCpuMsCore([20, 21], cyclic)).toBe(15) // seen-set dedupes shared subtrees
    expect(descendantCpuMsCore([404], table([[1, 0, 9]]))).toBe(0)
    expect(descendantCpuMsCore([], table([[1, 0, 9]]))).toBe(0)
  })
})

describe('ps / CIM parsers', () => {
  it('parsePsTime handles mm:ss, hh:mm:ss, dd-hh:mm:ss and fractional seconds', () => {
    expect(parsePsTime('0:01')).toBe(1000)
    expect(parsePsTime('2:03')).toBe(123_000)
    expect(parsePsTime('1:02:03')).toBe(3_723_000)
    expect(parsePsTime('2-01:02:03')).toBe(176_523_000)
    expect(parsePsTime('0:00.55')).toBe(550)
    expect(parsePsTime('garbage')).toBe(0)
  })

  it('parsePsOutput builds the table, skipping malformed lines', () => {
    const out = ['  1     0  0:05', '  20    1  1:00:00', 'PID PPID TIME', '', '  x  y  z'].join(
      '\n'
    )
    const t = parsePsOutput(out)
    expect(t.size).toBe(2)
    expect(t.get(1)).toEqual({ ppid: 0, cpuMs: 5000 })
    expect(t.get(20)).toEqual({ ppid: 1, cpuMs: 3_600_000 })
  })

  it('parseWinProcJson converts 100ns CIM ticks to ms; tolerates a single object and junk', () => {
    const rows = JSON.stringify([
      { ProcessId: 4, ParentProcessId: 0, KernelModeTime: 10_000_000, UserModeTime: 20_000_000 },
      { ProcessId: 'bad' },
      { ParentProcessId: 1 }
    ])
    const t = parseWinProcJson(rows)
    expect(t.size).toBe(1)
    expect(t.get(4)).toEqual({ ppid: 0, cpuMs: 3000 }) // (1s + 2s of ticks) → 3000ms

    const single = parseWinProcJson(
      JSON.stringify({ ProcessId: 7, ParentProcessId: 2, UserModeTime: 5_000_000 })
    )
    expect(single.get(7)).toEqual({ ppid: 2, cpuMs: 500 })

    expect(parseWinProcJson('not json').size).toBe(0)
  })
})

describe('createBusyProbe (delta state machine)', () => {
  const ROOTS = new Map([['/proj', [10]]])

  it('first sample = busy (conservative); a flat delta then reads idle; a real delta reads busy', async () => {
    let cpu = 1000
    const probe = createBusyProbe(async () => table([[10, 1, cpu]]))

    await probe.update(ROOTS)
    expect(probe.isBusy('/proj')).toBe(true) // one sample — no delta yet, protect

    await probe.update(ROOTS)
    expect(probe.isBusy('/proj')).toBe(false) // flat CPU across sweeps = idle at prompt

    cpu += CPU_BUSY_EPSILON_MS + 1 // the silent-e2e case: no output, real CPU burn
    await probe.update(ROOTS)
    expect(probe.isBusy('/proj')).toBe(true)
  })

  it('a sampler failure keeps the previous verdicts (never blind-idles a worker)', async () => {
    let fail = false
    let cpu = 0
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const probe = createBusyProbe(async () => {
        if (fail) throw new Error('wmic exploded')
        cpu += 500
        return table([[10, 1, cpu]])
      })
      await probe.update(ROOTS)
      await probe.update(ROOTS)
      expect(probe.isBusy('/proj')).toBe(true) // +500ms delta

      fail = true
      await probe.update(ROOTS)
      expect(probe.isBusy('/proj')).toBe(true) // verdict carried, not reset
    } finally {
      warn.mockRestore()
    }
  })

  it('dirs absent from the roots are forgotten; never-probed dirs read false', async () => {
    const probe = createBusyProbe(async () => table([[10, 1, 1]]))
    await probe.update(ROOTS)
    expect(probe.isBusy('/proj')).toBe(true)

    await probe.update(new Map()) // resident closed → its state must not linger
    expect(probe.isBusy('/proj')).toBe(false)
    expect(probe.isBusy('/never-seen')).toBe(false)
  })
})
