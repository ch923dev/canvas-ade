/**
 * Project-switch hotkey (MAIN half). The chord is bound to the MAIN WINDOW via a
 * `before-input-event` listener — NOT an OS-wide `globalShortcut`. `before-input-event` only
 * reaches a webContents that currently holds keyboard focus, so the hotkey fires ONLY when
 * Expanse is focused: pressing it while another app is in front does nothing, and it no longer
 * yanks the window forward or reserves the accelerator system-wide (the cross-app-fire bug).
 *
 * On a match MAIN forwards the cycle DIRECTION to the renderer (1 = next / -1 = prev); the
 * renderer owns the running-projects switcher + the `performProjectSwitch` pipeline (single source
 * of switch logic — see store/projectSwitch.ts). The accelerators live in userData (hotkeyConfig)
 * and are user-rebindable in Settings › Shortcuts; a rebind is picked up live (the matcher is read
 * per keystroke). A window-scoped binding cannot fail to register, so there are no bind failures
 * to surface — the whole failures surface (`hotkey:failures` IPC, `set`'s `failed` list, the
 * Settings warning row) was deleted in the R15 sweep (PS-5).
 */
import { app, type BrowserWindow, type IpcMain, type Input, type WebContents } from 'electron'
import { readHotkeyConfig, type HotkeyConfig } from './hotkeyConfig'
import { registerHotkeyHandlers } from './hotkeyIpc'

/** MAIN→renderer channel carrying the cycle direction (1 next / -1 prev) + the HOLD key. */
export const PROJECT_CYCLE_CHANNEL = 'project:cycleHotkey'

/**
 * The modifier the user is holding down while the switcher is up (R16, commit-on-release).
 *
 * MAIN derives it because MAIN is the only side that knows which chord actually fired: the
 * accelerator is user-rebindable, and the chord's own keydown is `preventDefault`ed here so the
 * renderer never sees it. `null` = the bound chord has no modifier at all (e.g. a bare `F13`
 * rebind), in which case there is nothing to release and the overlay keeps its Enter/click/Esc
 * behaviour.
 */
export type ProjectCycleHold = 'Control' | 'Meta' | 'Alt' | null

export interface GlobalHotkeyDeps {
  getWin(): BrowserWindow | null
  /** Load the persisted accelerator config (re-read on every apply so a rebind takes effect). */
  loadConfig(): HotkeyConfig
}

export interface GlobalHotkeyController {
  /**
   * (Re)load the accelerators from config and ensure the window binding is attached. Idempotent —
   * the live matcher is swapped in place, so a Settings rebind takes effect with no re-attach.
   * (A window binding cannot fail, so there is nothing to return — PS-5 deleted the old
   * always-empty `failed` list.)
   */
  apply(): void
  /** Detach the window binding + focus listener (app teardown / disable). */
  dispose(): void
}

/** A parsed Electron accelerator string → the modifier + key shape matched against an `Input`. */
interface ParsedAccel {
  /** CommandOrControl — resolves to Ctrl off-mac, Cmd (meta) on mac. */
  ctrlOrCmd: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  /** The final key token, normalized to lowercase KeyboardEvent.key. */
  key: string
}

/** Electron accelerator key tokens whose KeyboardEvent.key differs from the token (lowercased). */
const NAMED_KEY: Record<string, string> = {
  space: ' ',
  plus: '+',
  tab: 'tab',
  esc: 'escape',
  escape: 'escape',
  return: 'enter',
  enter: 'enter',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright'
}

/** Parse an accelerator like `CommandOrControl+Alt+]`. Returns null if it has no key token. */
function parseAccelerator(accel: string): ParsedAccel | null {
  const parts = accel
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  const p: ParsedAccel = {
    ctrlOrCmd: false,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key: ''
  }
  for (const raw of parts) {
    switch (raw.toLowerCase()) {
      case 'commandorcontrol':
      case 'cmdorctrl':
        p.ctrlOrCmd = true
        break
      case 'command':
      case 'cmd':
      case 'super':
      case 'meta':
        p.meta = true
        break
      case 'control':
      case 'ctrl':
        p.ctrl = true
        break
      case 'alt':
      case 'option':
      case 'altgr':
        p.alt = true
        break
      case 'shift':
        p.shift = true
        break
      default: {
        const t = raw.toLowerCase()
        p.key = NAMED_KEY[t] ?? t
      }
    }
  }
  return p.key ? p : null
}

/**
 * Which held modifier releasing commits the overlay (R16). Ctrl/Cmd wins when the chord has one —
 * that is the locked decision and the Windows-Alt-Tab / VS-Code-Ctrl+Tab muscle memory — and Alt is
 * the fallback so a modifier-light rebind like `Alt+]` still gets the gesture rather than losing it.
 * `KeyboardEvent.key` spelling, because that is what the renderer compares a `keyup` against.
 */
export function holdKeyOf(p: ParsedAccel, isMac: boolean): ProjectCycleHold {
  if (p.ctrlOrCmd) return isMac ? 'Meta' : 'Control'
  if (p.meta) return 'Meta'
  if (p.ctrl) return 'Control'
  if (p.alt) return 'Alt'
  return null
}

/** Exact chord match: the key + the precise modifier set (no extra modifiers held). */
function matchesAccel(input: Input, p: ParsedAccel, isMac: boolean): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false
  if (input.key.toLowerCase() !== p.key) return false
  const wantCtrl = p.ctrl || (p.ctrlOrCmd && !isMac)
  const wantMeta = p.meta || (p.ctrlOrCmd && isMac)
  return (
    input.control === wantCtrl &&
    input.meta === wantMeta &&
    input.alt === p.alt &&
    input.shift === p.shift
  )
}

export function createGlobalHotkey(deps: GlobalHotkeyDeps): GlobalHotkeyController {
  const isMac = process.platform === 'darwin'
  let cfg: HotkeyConfig = deps.loadConfig()
  let nextAccel: ParsedAccel | null = null
  let prevAccel: ParsedAccel | null = null
  // Track which webContents already carry the listener so a re-apply / re-focus never double-binds.
  const bound = new WeakSet<WebContents>()

  const onInput = (event: { preventDefault(): void }, input: Input): void => {
    if (!cfg.enabled) return
    const matched =
      nextAccel && matchesAccel(input, nextAccel, isMac)
        ? { dir: 1 as const, accel: nextAccel }
        : prevAccel && matchesAccel(input, prevAccel, isMac)
          ? { dir: -1 as const, accel: prevAccel }
          : null
    if (!matched) return
    // Swallow the chord so the key never reaches a focused input/terminal as text. Note this is a
    // keyDown-only match (matchesAccel), so the modifier's own `keyup` is NOT swallowed and still
    // reaches the page — which is what R16's commit-on-release listens for. No new IPC needed.
    event.preventDefault()
    const wc = deps.getWin()?.webContents
    if (wc && !wc.isDestroyed()) {
      wc.send(PROJECT_CYCLE_CHANNEL, matched.dir, holdKeyOf(matched.accel, isMac))
    }
  }

  const attach = (wc: WebContents | undefined): void => {
    if (!wc || wc.isDestroyed() || bound.has(wc)) return
    bound.add(wc)
    wc.on('before-input-event', onInput)
    wc.once('destroyed', () => bound.delete(wc))
  }

  // The window may not exist yet when apply() first runs (it fires inside whenReady, before
  // createWindow). Attach lazily on first focus — mirrors the recap re-ensure focus wiring
  // (index.ts) — and a fresh window (rare in this single-window app) re-binds on its first focus.
  const onFocus = (): void => attach(deps.getWin()?.webContents)
  app.on('browser-window-focus', onFocus)

  return {
    apply() {
      cfg = deps.loadConfig()
      nextAccel = cfg.enabled ? parseAccelerator(cfg.next) : null
      prevAccel = cfg.enabled ? parseAccelerator(cfg.prev) : null
      // A window already up (a runtime Settings rebind) gets bound now; onInput reads the matchers
      // live, so swapping them above is all a rebind needs.
      attach(deps.getWin()?.webContents)
    },
    dispose() {
      app.removeListener('browser-window-focus', onFocus)
      const wc = deps.getWin()?.webContents
      if (wc && !wc.isDestroyed()) {
        wc.removeListener('before-input-event', onInput)
        bound.delete(wc)
      }
    }
  }
}

/**
 * One-call wiring for MAIN: build the controller, attach the window binding, and register the
 * Settings get/set IPC (re-applying on every save). Returns the controller so the caller can
 * `dispose()` it on shutdown. Keeps index.ts under the max-lines ratchet — the whole hotkey
 * concern lives here.
 *
 */
export function wireGlobalHotkey(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string
): GlobalHotkeyController {
  const controller = createGlobalHotkey({ getWin, loadConfig: () => readHotkeyConfig(userDataDir) })
  controller.apply()
  registerHotkeyHandlers(ipc, getWin, {
    userDataDir,
    reapply: () => controller.apply()
  })
  return controller
}
