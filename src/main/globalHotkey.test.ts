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
    expect(send).toHaveBeenCalledWith(PROJECT_CYCLE_CHANNEL, 1)
    expect(pd).toHaveBeenCalled()
  })

  it('sends prev (-1) on the prev chord', () => {
    const { onInput, send } = makeController(DEFAULT)
    onInput(noop, keyDown({ key: '[', control: true, alt: true }))
    expect(send).toHaveBeenCalledWith(PROJECT_CYCLE_CHANNEL, -1)
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

  it('apply reports no bind failures — a window binding cannot fail to register', () => {
    const { controller } = makeController(DEFAULT)
    expect(controller.apply()).toEqual({ failed: [] })
  })

  it('CommandOrControl resolves to Cmd (meta) on mac, not Ctrl', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const { onInput, send } = makeController(DEFAULT)
      // Cmd+Alt+] fires on mac…
      onInput(noop, keyDown({ key: ']', meta: true, alt: true }))
      expect(send).toHaveBeenCalledWith(PROJECT_CYCLE_CHANNEL, 1)
      // …while Ctrl+Alt+] (the Windows chord) must NOT.
      send.mockClear()
      onInput(noop, keyDown({ key: ']', control: true, alt: true }))
      expect(send).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })
})
