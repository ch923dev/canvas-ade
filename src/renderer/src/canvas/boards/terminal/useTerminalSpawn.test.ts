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
import { resolveSpawnArgs, nextStateAfterAdopt } from './useTerminalSpawn'

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
