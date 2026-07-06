// src/main/autoUpdateWiring.ts
/**
 * The two MAIN-side dependencies `initAutoUpdate` needs (see autoUpdate.ts), factored out of
 * index.ts so the god-file stays a thin caller and this real-runtime wiring lives in one place.
 * autoUpdate.ts itself stays dependency-injected + electron-updater-free for unit tests; these
 * concretions are only ever invoked once the gate is open (signed + packaged).
 */
import type { UpdaterLike, UpdateMeta } from './autoUpdate'

/**
 * Feed base for the side-channel tier manifest (`updates.json`) — a sibling of the
 * electron-updater feed. Defaults to the production feed; `CANVAS_UPDATE_FEED` overrides it
 * for a local update test (point both this and app-update.yml at the same host).
 */
export const updateFeedBase = (): string =>
  (process.env.CANVAS_UPDATE_FEED ?? 'https://updates.expanse.app').replace(/\/+$/, '')

/**
 * Fetch updates.json each check. Any failure resolves null → the flow fails OPEN (a plain
 * optional update, never a spurious forced block). A 404 (no manifest published yet) is
 * treated the same as unreachable.
 */
export async function fetchUpdateMeta(): Promise<UpdateMeta | null> {
  const res = await fetch(`${updateFeedBase()}/updates.json`, { cache: 'no-store' })
  if (!res.ok) return null
  return (await res.json()) as UpdateMeta
}

/**
 * Resolve electron-updater's autoUpdater via a DYNAMIC import so the module (and its transitive
 * deps, e.g. semver) load only when the gate is open — an unsigned build never imports it.
 *
 * electron-updater is CJS and exposes `autoUpdater` through an `Object.defineProperty` getter
 * (out/main.js). Node's CJS→ESM interop (cjs-module-lexer) does NOT surface a defineProperty
 * getter as a named ESM export, so under a native dynamic import `mod.autoUpdater` is UNDEFINED —
 * the live getter only exists on the default export (= module.exports). Reading the named export
 * crashed init with "Cannot set properties of undefined (setting 'autoDownload')". Prefer
 * `default`, fall back to the named export for any bundler that DOES hoist it. The double-cast is
 * the deliberate boundary between our minimal interface and its per-event types.
 */
export async function resolveUpdater(): Promise<UpdaterLike> {
  const mod = (await import('electron-updater')) as unknown as {
    autoUpdater?: UpdaterLike
    default?: { autoUpdater?: UpdaterLike }
  }
  const updater = mod.default?.autoUpdater ?? mod.autoUpdater
  if (!updater) throw new Error('electron-updater: autoUpdater export not found')
  return updater
}
