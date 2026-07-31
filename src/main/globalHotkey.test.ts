import { describe, it, expect, vi, beforeEach } from 'vitest'

// createGlobalHotkey value-imports only `app` from electron (the rest are type-only). Stub it so
// the `browser-window-focus` wiring in the factory is a no-op under the test. vi.hoisted: the
// vi.mock factory is hoisted above the file, so its captured fns must be hoisted too.
const { appOn, appRemove } = vi.hoisted(() => ({ appOn: vi.fn(), appRemove: vi.fn() }))
vi.mock('electron', () => ({ app: { on: appOn, removeListener: appRemove } }))

import { createGlobalHotkey, PROJECT_CYCLE_CHANNEL, type GlobalHotkeyDeps } from './globalHotkey'

type InputLike = {
  type: string
  key: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  isAutoRepeat: boolean
}
const keyDown = (over: Partial<InputLike>): InputLike => ({
  type: 'keyDown',
  key: ']',
  control: false,
  alt: false,
  shift: false,
  meta: false,
  isAutoRepeat: false,
  ...over
})

const DEFAULT = {
  enabled: true,
  next: 'CommandOrControl+Alt+]',
  prev: 'CommandOrControl+Alt+['
}

/** Build a controller against a fake window and return the captured before-input-event handler. */
function makeController(cfg: { enabled: boolean; next: string; prev: string }) {
  const send = vi.fn()
  const on = vi.fn()
  const wc = { on, once: vi.fn(), isDestroyed: () => false, send }
  const win = { webContents: wc, isDestroyed: () => false }
  const deps = {
    getWin: () => win,
    loadConfig: () => cfg
  } as unknown as GlobalHotkeyDeps
  const controller = createGlobalHotkey(deps)
  controller.apply()
  const call = on.mock.calls.find((c) => c[0] === 'before-input-event')
  const onInput = call?.[1] as
    | ((e: { preventDefault(): void }, input: InputLike) => void)
    | undefined
  return { controller, wc, send, onInput: onInput! }
}

const noop = { preventDefault: () => {} }

describe('globalHotkey — window-scoped binding (fix #1)', () => {
  beforeEach(() => {
    appOn.mockReset()
    appRemove.mockReset()
  })

  it('binds a before-input-event listener on the window (not an OS-global accelerator)', () => {
    const { wc } = makeController(DEFAULT)
    expect(wc.on).toHaveBeenCalledWith('before-input-event', expect.any(Function))
    // The focus-driven lazy attach is wired at the app level, never a globalShortcut registration.
    expect(appOn).toHaveBeenCalledWith('browser-window-focus', expect.any(Function))
  })

  it('sends next (1) on the configured chord and swallows the key', () => {
    const { onInput, send } = makeController(DEFAULT)
    const pd = vi.fn()
    onInput({ preventDefault: pd }, keyDown({ key: ']', control: true, alt: true }))
    // R16: the payload carries the HOLD modifier too — releasing it commits the overlay.
    expect(send).toHaveBeenCalledWith(PROJECT_CYCLE_CHANNEL, 1, 'Control')
    expect(pd).toHaveBeenCalled()
  })

  it('sends prev (-1) on the prev chord', () => {
    const { onInput, send } = makeController(DEFAULT)
    onInput(noop, keyDown({ key: '[', control: true, alt: true }))
    expect(send).toHaveBeenCalledWith(PROJECT_CYCLE_CHANNEL, -1, 'Control')
  })

  it('ignores a partial chord (a required modifier missing)', () => {
    const { onInput, send } = makeController(DEFAULT)
    onInput(noop, keyDown({ key: ']', control: true, alt: false }))
    expect(send).not.toHaveBeenCalled()
  })

  it('requires an EXACT chord — an extra modifier does not match', () => {
    const { onInput, send } = makeController(DEFAULT)
    onInput(noop, keyDown({ key: ']', control: true, alt: true, shift: true }))
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores key-up and auto-repeat', () => {
    const { onInput, send } = makeController(DEFAULT)
    onInput(noop, keyDown({ key: ']', control: true, alt: true, type: 'keyUp' }))
    onInput(noop, keyDown({ key: ']', control: true, alt: true, isAutoRepeat: true }))
    expect(send).not.toHaveBeenCalled()
  })

  it('does nothing while disabled', () => {
    const { onInput, send } = makeController({ ...DEFAULT, enabled: false })
    onInput(noop, keyDown({ key: ']', control: true, alt: true }))
    expect(send).not.toHaveBeenCalled()
  })

  it('apply returns nothing — a window binding cannot fail to register (PS-5)', () => {
    const { controller } = makeController(DEFAULT)
    expect(controller.apply()).toBeUndefined()
  })

  it('CommandOrControl resolves to Cmd (meta) on mac, not Ctrl', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const { onInput, send } = makeController(DEFAULT)
      // Cmd+Alt+] fires on mac…
      onInput(noop, keyDown({ key: ']', meta: true, alt: true }))
      // …and the hold resolves to Cmd with it, so mac commits on releasing ⌘ (R16).
      expect(send).toHaveBeenCalledWith(PROJECT_CYCLE_CHANNEL, 1, 'Meta')
      // …while Ctrl+Alt+] (the Windows chord) must NOT.
      send.mockClear()
      onInput(noop, keyDown({ key: ']', control: true, alt: true }))
      expect(send).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })
})

/**
 * R16 — the HOLD modifier MAIN reports alongside the direction. It has to be derived here rather
 * than guessed in the renderer for two reasons: the accelerator is user-rebindable, and the
 * chord's own keydown is `preventDefault`ed above, so the renderer never observes the modifier
 * going down at all. Only the modifier's `keyup` reaches the page — which is exactly what
 * commit-on-release listens for, and why this needs no new IPC channel.
 */
describe('globalHotkey — the commit-on-release hold key (R16)', () => {
  beforeEach(() => {
    appOn.mockReset()
    appRemove.mockReset()
  })

  const holdFor = (accel: string, key: string, input: Partial<InputLike>): unknown => {
    const { onInput, send } = makeController({ enabled: true, next: accel, prev: 'F24' })
    onInput(noop, keyDown({ key, ...input }))
    return send.mock.calls[0]?.[2]
  }

  it('Ctrl/Cmd wins when the chord has one — the locked Alt-Tab gesture', () => {
    expect(holdFor('CommandOrControl+Alt+]', ']', { control: true, alt: true })).toBe('Control')
  })

  it('an explicit Control chord reports Control', () => {
    expect(holdFor('Control+Shift+P', 'p', { control: true, shift: true })).toBe('Control')
  })

  it('Alt is the fallback, so a modifier-light rebind still gets the gesture', () => {
    // `Alt+]` has no Ctrl/Cmd to release; releasing Alt is the only sensible commit, and dropping
    // to null here would silently strip commit-on-release from anyone who rebinds this way.
    expect(holdFor('Alt+]', ']', { alt: true })).toBe('Alt')
  })

  it('a modifier-FREE chord reports null — there is nothing to release', () => {
    // The overlay then keeps its Enter/click/Esc behaviour rather than inventing a hold that the
    // user is not holding.
    expect(holdFor('F13', 'f13', {})).toBeNull()
  })

  it('the direction is still the first argument (the payload is additive)', () => {
    const { onInput, send } = makeController(DEFAULT)
    onInput(noop, keyDown({ key: ']', control: true, alt: true }))
    expect(send.mock.calls[0]?.[1]).toBe(1)
  })
})
