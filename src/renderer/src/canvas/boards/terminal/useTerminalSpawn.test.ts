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
  conptyHint
} from './useTerminalSpawn'

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
