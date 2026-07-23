// @vitest-environment jsdom
// src/renderer/src/canvas/boards/terminal/useTerminalSpawn.test.ts
// jsdom: importing the hook module pulls in @xterm/addon-fit + navigator.platform at
// load time, which need a browser global (`self`/`window`/`navigator`). The tests
// themselves drive only the two PURE helpers — no xterm instance is constructed.
//
// Unit coverage for the DECIDABLE seams of the terminal spawn lifecycle, extracted
// from TerminalBoard's spawn/respawn/restart mega-callback into useTerminalSpawn.
//
// The full spawn state machine (MessagePort wiring, ResizeObserver-deferred spawn,
// adopt reattach, kill-tree teardown) is effectful and lives behind the Playwright
// `_electron` e2e net + the real-claude live verify — it is NOT unit-tested here
// (jsdom has no xterm canvas/WebGL + no layout, so proposeDimensions never goes
// finite and the spawn path can't fire). What CAN be isolated are the two pure
// decision helpers the lifecycle delegates to. These drive the REAL exported
// symbols (no replica), pinning the two load-bearing branches:
//   - resolveSpawnArgs   — the cwd fallback chain + one-shot launch-override precedence
//   - nextStateAfterAdopt — the adopt / idle-on-mount / fresh-spawn state-machine fork
import { describe, it, expect } from 'vitest'
import {
  resolveSpawnArgs,
  nextStateAfterAdopt,
  fullViewScale,
  conptyHint,
  finiteDims
} from './useTerminalSpawn'
// The T2 fit-hold + snapshot-boundary helpers are pure and unit-tested directly against their home
// module (not re-exported through the hook, which is at its max-lines cap).
import {
  fitHoldReleased,
  shouldReleaseFitHold,
  snapshotWatermark,
  nextReceived,
  buildSnapshot
} from './terminalSpawnMath'

describe('resolveSpawnArgs — spawn descriptor resolution (pure)', () => {
  it('cwd prefers the board cwd over the project dir', () => {
    expect(resolveSpawnArgs({ cwd: '/board/cwd', launchCommand: undefined }, '/proj').cwd).toBe(
      '/board/cwd'
    )
  })

  it('cwd falls back to the project dir when the board has none', () => {
    expect(resolveSpawnArgs({ cwd: undefined, launchCommand: undefined }, '/proj').cwd).toBe(
      '/proj'
    )
  })

  it('cwd is undefined (os.homedir in MAIN) when neither board nor project supplies one', () => {
    expect(resolveSpawnArgs({ cwd: undefined, launchCommand: undefined }, null).cwd).toBeUndefined()
    expect(
      resolveSpawnArgs({ cwd: undefined, launchCommand: undefined }, undefined).cwd
    ).toBeUndefined()
  })

  it('launchCommand defaults to the board launchCommand with no override', () => {
    expect(
      resolveSpawnArgs({ cwd: undefined, launchCommand: 'claude' }, '/proj').launchCommand
    ).toBe('claude')
  })

  it('launchCommand is undefined (plain shell, no agent) when the board has none and no override', () => {
    expect(
      resolveSpawnArgs({ cwd: undefined, launchCommand: undefined }, '/proj').launchCommand
    ).toBeUndefined()
  })

  it('a one-shot override (e.g. `claude --resume <id>`) takes precedence over the board command', () => {
    expect(
      resolveSpawnArgs({ cwd: undefined, launchCommand: 'claude' }, '/proj', 'claude --resume abc')
        .launchCommand
    ).toBe('claude --resume abc')
  })

  it('an empty-string override is honored as-is (caller already sanitized it; not coalesced away)', () => {
    // `??` (not `||`) so a deliberate empty command stays empty rather than silently
    // reverting to the board command — matches the original inline `override ?? board.launchCommand`.
    expect(
      resolveSpawnArgs({ cwd: undefined, launchCommand: 'claude' }, '/proj', '').launchCommand
    ).toBe('')
  })
})

describe('nextStateAfterAdopt — adopt/idle/spawn fork (pure)', () => {
  it('an adopted (undo-of-delete) session goes straight to running', () => {
    expect(nextStateAfterAdopt(true, false)).toBe('running')
    // adopt wins even when the board would otherwise mount idle.
    expect(nextStateAfterAdopt(true, true)).toBe('running')
  })

  it('a non-adopted restored/duplicated terminal mounts idle (no silent auto-spawn)', () => {
    expect(nextStateAfterAdopt(false, true)).toBe('idle')
  })

  it('a fresh, non-restored board spawns', () => {
    expect(nextStateAfterAdopt(false, false)).toBe('spawn')
  })
})

describe('fullViewScale — Pure A1 full-view fill factor (pure)', () => {
  it('scales the frozen grid UP to fill the modal (letterbox = min of width/height fit)', () => {
    // 420×340 board into a 1920×1080 viewport: modal ≈ 1728×972, so widthFit ≈ 4.11,
    // heightFit ≈ 2.86 → min = the height fit (letterbox, never overflow).
    const k = fullViewScale(420, 340, 1920, 1080)
    expect(k).toBeCloseTo(Math.min((1920 * 0.9) / 420, (1080 * 0.9) / 340), 5)
    // height is the binding constraint here → the grid never spills past the modal.
    expect(k).toBeLessThanOrEqual((1080 * 0.9) / 340 + 1e-9)
  })

  it('clamps to a sane range: a giant board never scales below 0.5×, a tiny one never above 8×', () => {
    expect(fullViewScale(100000, 100000, 1920, 1080)).toBe(0.5) // board ≫ modal → floor
    expect(fullViewScale(1, 1, 1920, 1080)).toBe(8) // board ≪ modal → ceiling
  })

  it('degenerate inputs (non-positive / non-finite) fall back to identity (1) — never NaN', () => {
    expect(fullViewScale(0, 340, 1920, 1080)).toBe(1)
    expect(fullViewScale(420, 0, 1920, 1080)).toBe(1)
    expect(fullViewScale(420, 340, 0, 1080)).toBe(1)
    expect(fullViewScale(420, 340, 1920, Number.NaN)).toBe(1)
  })
})

describe('finiteDims — FitAddon proposal gate (pure)', () => {
  // Shared by the deferred spawn (#34), the deferred respawn (#23), the backstop propose, and
  // the fit-gate release (switch-back replay fix): an unfitted well must never count as a fit.
  it('accepts a real layout proposal', () => {
    expect(finiteDims({ cols: 132, rows: 34 })).toBe(true)
  })

  it('rejects the not-laid-out shapes: undefined and non-finite dims', () => {
    expect(finiteDims(undefined)).toBe(false) // proposeDimensions() before layout
    expect(finiteDims({ cols: NaN, rows: 24 })).toBe(false) // display:none well (0-size math)
    expect(finiteDims({ cols: 80, rows: Infinity })).toBe(false)
  })
})

describe('fitHoldReleased — write-coalescer fit-hold gate (T2·D3, pure)', () => {
  it('releases (renders) only when live AND not backstopping AND grid fitted', () => {
    expect(fitHoldReleased(true, false, true)).toBe(true)
  })
  it('holds while below-LOD / off-screen (not live)', () => {
    expect(fitHoldReleased(false, false, true)).toBe(false)
  })
  it('holds while a resize-backstop snapshot is mid-flight', () => {
    expect(fitHoldReleased(true, true, true)).toBe(false)
  })
  it('holds while the grid is still the unfitted 80×24 default (gridFitted false)', () => {
    expect(fitHoldReleased(true, false, false)).toBe(false)
  })
})

describe('shouldReleaseFitHold — fit-release trigger + respawn re-arm (T2·D3, pure)', () => {
  it('releases on a fresh (re-armed) grid with a finite proposal', () => {
    expect(shouldReleaseFitHold(false, { cols: 120, rows: 30 })).toBe(true)
  })
  it('does NOT release on a non-finite (not-laid-out) proposal even when armed', () => {
    expect(shouldReleaseFitHold(false, undefined)).toBe(false)
    expect(shouldReleaseFitHold(false, { cols: NaN, rows: 30 })).toBe(false)
  })
  it('a still-set gridFitted (NOT re-armed) blocks the re-release — the defect this fixes', () => {
    // Before D3, a respawn kept gridFitted === true: this fit could not re-gate the hold at the
    // current cols, so a finite-but-wrong transient proposal would already have released it.
    expect(shouldReleaseFitHold(true, { cols: 120, rows: 30 })).toBe(false)
  })
  it('re-arming (gridFitted → false) on respawn lets the NEXT finite fit release cleanly', () => {
    const armed = false // what restart() sets before its fitWhole
    expect(shouldReleaseFitHold(armed, { cols: 132, rows: 43 })).toBe(true)
  })
})

describe('snapshotWatermark — exact snapshot/tail splice boundary (T2·D2, pure)', () => {
  it('is the received count when nothing is held or dropped (fully-rendered live board)', () => {
    // The common switch-away case: coalescer caught up → boundary == everything received.
    expect(snapshotWatermark(4096, 0, 0)).toBe(4096)
  })
  it('excludes still-held (unrendered) bytes so they land in the post-snapshot replay tail', () => {
    // A hidden board holding 300 bytes: only 700 are IN the snapshot, so the boundary is 700 and
    // the 300 held bytes are replayed from MAIN's ring on switch-back (no gap).
    expect(snapshotWatermark(1000, 300, 0)).toBe(700)
  })
  it('ALSO excludes hold-cap dropped bytes (reviewer fix: else the gap re-opens for a hidden firehose)', () => {
    // 1000 received, 300 still queued, 200 evicted by trim() → only 500 rendered into the snapshot.
    // Subtracting dropped keeps those 200 (still in MAIN's ring) in the replay tail (overlap, not gap).
    expect(snapshotWatermark(1000, 300, 200)).toBe(500)
  })
  it('never goes negative (held/dropped can transiently exceed received during an adopt replay)', () => {
    expect(snapshotWatermark(50, 200, 100)).toBe(0)
  })
})

describe('nextReceived — ring-axis byte counter reducer (T2·D2, pure)', () => {
  it('adds a live data message length to the running total', () => {
    expect(nextReceived(100, { t: 'data', d: 'hello' })).toBe(105)
  })
  it('OVERWRITES to the ring absolute on a sync (re-aligns past an adopt replay)', () => {
    // Even though the renderer just accrued replay bytes, sync snaps it back to MAIN's `written`.
    expect(nextReceived(999, { t: 'sync', written: 4096 })).toBe(4096)
  })
  it('is inert for state/exit/empty messages', () => {
    expect(nextReceived(100, { t: 'state' })).toBe(100)
    expect(nextReceived(100, { t: 'exit' })).toBe(100)
    expect(nextReceived(100, { t: 'data' })).toBe(100) // no d → nothing added
    expect(nextReceived(100, { t: 'sync' })).toBe(100) // no written → no reseed
  })
  it('a fresh spawn counts from 0 == the ring written (no sync needed)', () => {
    let n = 0
    n = nextReceived(n, { t: 'data', d: 'abc' })
    n = nextReceived(n, { t: 'data', d: 'de' })
    expect(n).toBe(5)
  })
})

describe('buildSnapshot — persisted snapshot + exact boundary (T2·D2, pure)', () => {
  it('pairs the serialized text with received−held−dropped as the boundary', () => {
    expect(buildSnapshot('BUFFER', 1000, 300, 200)).toEqual({ text: 'BUFFER', watermark: 500 })
  })
  it('is null when there is nothing to serialize (no serializer / non-string)', () => {
    expect(buildSnapshot(undefined, 1000, 0, 0)).toBeNull()
  })
  it('keeps an empty string (the registry skips blanks itself) with a 0-clamped boundary', () => {
    expect(buildSnapshot('', 0, 50, 0)).toEqual({ text: '', watermark: 0 })
  })
})

describe('conptyHint — A-Win xterm windowsPty build gate (pure)', () => {
  it('returns the ConPTY hint on Windows 11 builds (>= 21376)', () => {
    expect(conptyHint(22631)).toEqual({ backend: 'conpty', buildNumber: 22631 })
    expect(conptyHint(26100)).toEqual({ backend: 'conpty', buildNumber: 26100 })
    expect(conptyHint(21376)).toEqual({ backend: 'conpty', buildNumber: 21376 }) // boundary (inclusive)
  })

  it('returns undefined on Win 10 builds below 21376 — setting it there would DISABLE reflow', () => {
    expect(conptyHint(19045)).toBeUndefined() // Win 10 22H2
    expect(conptyHint(21375)).toBeUndefined() // one below the boundary
  })

  it('returns undefined off Windows (null build)', () => {
    expect(conptyHint(null)).toBeUndefined()
  })
})
