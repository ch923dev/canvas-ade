// src/main/autoUpdateWiring.ts
/**
 * The two MAIN-side dependencies `initAutoUpdate` needs (see autoUpdate.ts), factored out of
 * index.ts so the god-file stays a thin caller and this real-runtime wiring lives in one place.
 * autoUpdate.ts itself stays dependency-injected + electron-updater-free for unit tests; these
 * concretions are only ever invoked once the gate is open (signed + packaged).
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { coerceUpdateMeta, initAutoUpdate, type UpdaterLike, type UpdateMeta } from './autoUpdate'
import { setKeepSessionsOnQuit } from './ptyHost/client'

/**
 * Feed base for the side-channel tier manifest (`updates.json`) — a sibling of the
 * electron-updater feed. Defaults to the production feed; `CANVAS_UPDATE_FEED` overrides it
 * for a local update test (point both this and app-update.yml at the same host).
 */
export const updateFeedBase = (): string =>
  (process.env.CANVAS_UPDATE_FEED ?? 'https://updates.expanse.app').replace(/\/+$/, '')

/** Hard ceiling on the meta fetch. `runCheck` awaits getMeta() BEFORE `checkForUpdates()`
 *  (the call that emits `checking-for-update`), so an un-bounded fetch against a slow/hung
 *  feed would leave the renderer's "Checking…" spinner stuck for minutes (undici's default
 *  timeouts are minutes, not seconds). Bounding it makes a slow feed degrade to the SAME
 *  fail-open path as an unreachable one. */
const META_FETCH_TIMEOUT_MS = 8000

/**
 * Fetch updates.json each check. Any failure resolves null → the flow fails OPEN (a plain
 * optional update, never a spurious forced block). A 404 (no manifest published yet) is
 * treated the same as unreachable, and so is a SLOW feed: the fetch is bounded by an
 * `AbortSignal.timeout` so a hung connection aborts (→ null) instead of stalling the check
 * indefinitely. The payload is run through `coerceUpdateMeta` — a real runtime schema check,
 * NOT a bare `as UpdateMeta` assertion — so a malformed/corrupted manifest (e.g. a non-string
 * `minSupported`) can never reach `cmpVersion` and crash main; bad fields degrade to
 * no-floor/no-tiers, preserving the fail-OPEN guarantee (ADR 0012).
 */
export async function fetchUpdateMeta(baseOverride?: string): Promise<UpdateMeta | null> {
  const res = await fetch(`${baseOverride ?? updateFeedBase()}/updates.json`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS)
  })
  if (!res.ok) return null
  return coerceUpdateMeta(await res.json())
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

/**
 * Assemble the real-runtime AutoUpdateDeps and start the updater — the one-call entry
 * index.ts uses (max-lines: the god-file stays a thin caller; this file owns the wiring).
 *
 * `localFeedUrl` is the dev-only local update channel override (a loopback URL already
 * validated by src/main/localUpdateFeed.ts, or null). Index.ts computes it behind the
 * __LOCAL_UPDATE_CHANNEL__ compile gate, so in every distributed build the argument is a
 * constant null AND the localUpdateFeed module tree-shakes out of the bundle entirely.
 * When set, it repoints BOTH feed reads at the same loopback origin: electron-updater via
 * setFeedURL (the baked app-update.yml still carries the production URL) and the
 * updates.json meta fetch via fetchUpdateMeta's base override.
 */
export async function startAutoUpdate(opts: {
  enabled: boolean
  isPackaged: boolean
  ipc: IpcMain
  getWin: () => BrowserWindow | null
  currentVersion: string
  localFeedUrl: string | null
}): Promise<void> {
  const { localFeedUrl, ...deps } = opts
  await initAutoUpdate({
    ...deps,
    // PTY-host D5 (DESIGN.md 2026-07-12): flag the update-install quit so shutdown() detaches
    // (keeps) daemon sessions instead of killing them; unflag when the install throws.
    onBeforeInstall: () => setKeepSessionsOnQuit(true),
    onInstallFailed: () => setKeepSessionsOnQuit(false),
    getMeta: () => fetchUpdateMeta(localFeedUrl ?? undefined),
    getUpdater: async () => {
      const updater = await resolveUpdater()
      if (localFeedUrl) updater.setFeedURL?.({ provider: 'generic', url: localFeedUrl })
      return updater
    }
  })
}
