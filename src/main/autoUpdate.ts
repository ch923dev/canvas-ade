// src/main/autoUpdate.ts
/**
 * electron-updater wiring (Phase 5). A small, dependency-injected module so the
 * security gate + event forwarding are unit-testable WITHOUT loading electron-updater
 * or a real BrowserWindow. The real `autoUpdater` is imported only in index.ts and
 * passed in via `getUpdater` — this file stays runtime-free of electron-updater so a
 * node unit test can import it directly.
 *
 * SECURITY GATE: initAutoUpdate is a COMPLETE NO-OP unless `enabled` AND `isPackaged`.
 * `enabled` is the __ENABLE_AUTO_UPDATE__ build constant (electron.vite.config.ts),
 * true ONLY for signed production builds — the production CI job sets ENABLE_AUTO_UPDATE=1
 * exclusively when code-signing secrets are present. So an unsigned build never wires the
 * updater and never reaches the feed, enforcing the "no unsigned auto-update over a
 * feed" invariant (electron-builder.yml `publish`) in code rather than by convention.
 * `getUpdater` is invoked ONLY once the gate is open, so an unsigned/test run never even
 * resolves electron-updater.
 *
 * MANUAL update model (user-driven download + install): the ONLY automatic step is a
 * silent feed CHECK on launch, so Settings can surface "an update is available". Nothing
 * downloads or installs on its own — `autoDownload` + `autoInstallOnAppQuit` are both
 * false. The renderer drives the rest: `update:check` (re-check on demand), `update:download`
 * (start the download once the user clicks), `update:install` (quit + install the downloaded
 * update). Every step is frame-guarded IPC.
 *
 * UPDATE LEVELS (three tiers): a side-channel `updates.json` (fetched via `getMeta`, a
 * sibling of the feed manifest — NOT part of electron-updater) tags the flow:
 *   • optional     — quiet toast; the default for any release with no tag.
 *   • recommended  — a louder, dismissable banner.
 *   • mandatory    — a BLOCKING modal. Triggered when the running version is below the
 *                    published `minSupported` floor (the app-binary analogue of the schema
 *                    `minReaderVersion` compat floor, ADR 0007). The user cannot use the app
 *                    until they update.
 * The floor is the ONLY force trigger; per-version tags only pick optional↔recommended.
 * `getMeta` failing (a network blip) fails OPEN — never emits `mandatory`, so a transient
 * feed outage can never lock a user out — and defaults the tier to `optional`.
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { isForeignSender } from './ipcGuard'

/** The two non-blocking loudness levels an available update can carry. */
export type UpdateTier = 'optional' | 'recommended'

/** Status pushed main → renderer on the `update:status` channel. Mirrors preload `UpdateStatus`. */
export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string; tier: UpdateTier }
  | { state: 'mandatory'; version: string }
  | { state: 'none' }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

/**
 * The side-channel tier manifest (`updates.json`), published next to the feed. Both fields
 * are optional so a partial/older file still parses: a missing `minSupported` means "no
 * floor" (nothing is forced) and a missing/absent tier entry means "optional".
 */
export interface UpdateMeta {
  /** SemVer floor: a running version strictly below this is forced to update. */
  minSupported?: string
  /** version → tier. Only 'recommended' matters; anything else falls back to optional. */
  tiers?: Record<string, UpdateTier>
}

/** electron-updater event payloads carry these fields (UpdateInfo / ProgressInfo / Error). */
type UpdaterEventArg = { version?: string; percent?: number; message?: string }

/** The slice of electron-updater's autoUpdater we use (injectable for tests). */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, listener: (info: UpdaterEventArg) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  /**
   * Present on the real autoUpdater; optional here so test fakes stay minimal. Used ONLY by
   * the dev-only local update channel (index.ts, compile-gated __LOCAL_UPDATE_CHANNEL__) to
   * repoint the feed at a validated loopback URL before any check runs.
   */
  setFeedURL?(options: { provider: 'generic'; url: string; channel?: string }): void
}

export interface AutoUpdateDeps {
  /** The __ENABLE_AUTO_UPDATE__ build constant — true only for signed production builds. */
  enabled: boolean
  isPackaged: boolean
  ipc: IpcMain
  getWin: () => BrowserWindow | null
  /** The running app version (`app.getVersion()`) — compared to the `minSupported` floor. */
  currentVersion: string
  /**
   * Lazily resolve electron-updater's autoUpdater — invoked (and awaited) ONLY when the
   * gate is open. index.ts wires this to a dynamic `import('electron-updater')`, so an
   * unsigned build never even loads electron-updater (nor needs its transitive deps —
   * e.g. semver — packed). That removes a real boot-crash risk for unsigned packages.
   */
  getUpdater: () => Promise<UpdaterLike>
  /**
   * Fetch the side-channel tier manifest (`updates.json`) from the feed. Resolves null on
   * any failure (network/parse) so a feed blip fails OPEN — the flow degrades to a plain
   * optional update, never a spurious forced block. Injected so main stays feed-agnostic
   * and the classifier is unit-testable.
   */
  getMeta: () => Promise<UpdateMeta | null>
  logError?: (...args: unknown[]) => void
}

/**
 * Coerce a raw (network-fetched) `updates.json` payload into a TRUSTED `UpdateMeta`, dropping
 * any field whose shape is wrong. This is the runtime schema check that `fetchUpdateMeta`'s
 * `as UpdateMeta` assertion lacks: without it, a hand-edited manifest that drops the quotes
 * (`"minSupported": 0.9`) or ships a malformed `tiers` would reach `cmpVersion` as a non-string
 * and throw a `TypeError` synchronously inside the `update-available` handler — crashing main
 * (unhandled rejection under Node 22's throw-default), the OPPOSITE of ADR 0012's fail-OPEN
 * guarantee. Fails OPEN: a non-object, or fields of the wrong type, degrade to no-floor /
 * no-tiers (a plain optional update) rather than a value that could force or crash.
 */
export function coerceUpdateMeta(raw: unknown): UpdateMeta | null {
  if (typeof raw !== 'object' || raw === null) return null
  const src = raw as Record<string, unknown>
  const meta: UpdateMeta = {}
  // Only a STRING floor is honoured — a numeric/absent one means "no floor" (never forced).
  if (typeof src.minSupported === 'string') meta.minSupported = src.minSupported
  // Keep only well-formed version→tier entries; anything else is silently dropped to optional.
  if (typeof src.tiers === 'object' && src.tiers !== null) {
    const tiers: Record<string, UpdateTier> = {}
    for (const [version, tier] of Object.entries(src.tiers as Record<string, unknown>)) {
      if (tier === 'recommended' || tier === 'optional') tiers[version] = tier
    }
    meta.tiers = tiers
  }
  return meta
}

/**
 * Compare two dotted numeric versions (our 0.x.y scheme). Any pre-release suffix (`-beta.1`)
 * is ignored — the floor is expressed in release versions. Returns -1 / 0 / 1. Kept local
 * (no semver import) so this module stays runtime-free of electron-updater's deps. `String(v)`
 * is a root-level crash guard: even if a non-string floor slips past validation, this never
 * throws (a garbage floor parses to 0.0.0 → never forces — still fails OPEN).
 */
export function cmpVersion(a: string, b: string): number {
  const parse = (v: string): number[] =>
    String(v)
      .split('-')[0]
      .split('.')
      .map((n) => Number(n) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export async function initAutoUpdate(deps: AutoUpdateDeps): Promise<void> {
  const { enabled, isPackaged, ipc, getWin, getUpdater, getMeta, currentVersion } = deps
  const logError = deps.logError ?? ((...a: unknown[]): void => console.error(...a))

  // Gate: unsigned / non-packaged builds wire NOTHING (see the security note above).
  if (!enabled || !isPackaged) return

  const updater = await getUpdater()

  // The tier manifest for the CURRENT check. Refreshed at the start of every check (boot +
  // each `update:check`) so an updated `updates.json` is picked up without a relaunch. The
  // sync `update-available` handler below reads this cached value.
  let meta: UpdateMeta | null = null

  // Push a status to the renderer, guarding a destroyed-but-non-null window (BUG-001):
  // accessing .webContents on a destroyed window throws, so check isDestroyed() first.
  const send = (status: UpdateStatus): void => {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc.isDestroyed()) wc.send('update:status', status)
  }

  // Decide the tier for an available `version`, given the current `meta`. The floor is the
  // ONLY force trigger; it fails OPEN (no meta / no floor → never mandatory).
  const classify = (version: string): UpdateStatus => {
    const floor = meta?.minSupported
    // typeof-string guard (not just truthiness): a malformed manifest could carry a non-string
    // floor; passing that to cmpVersion below must never throw in this SYNC handler. Belt to
    // coerceUpdateMeta's suspenders — this holds for ANY getMeta impl, not just fetchUpdateMeta.
    if (typeof floor === 'string' && cmpVersion(currentVersion, floor) < 0)
      return { state: 'mandatory', version }
    const tier: UpdateTier = meta?.tiers?.[version] === 'recommended' ? 'recommended' : 'optional'
    return { state: 'available', version, tier }
  }

  // MANUAL model: the app only CHECKS automatically — the user chooses when to download
  // and when to install (see the module header). So both auto-behaviours stay off.
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false

  updater.on('checking-for-update', () => send({ state: 'checking' }))
  updater.on('update-available', (info) => send(classify(info.version ?? '')))
  updater.on('update-not-available', () => send({ state: 'none' }))
  updater.on('download-progress', (info) =>
    send({ state: 'downloading', percent: Math.round(info.percent ?? 0) })
  )
  updater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version ?? '' }))
  updater.on('error', (info) => {
    logError('[auto-update] error', info)
    send({ state: 'error', message: info.message ?? 'update failed' })
  })

  // Refresh the tier manifest, THEN check the feed. Meta first so the (sync) update-available
  // handler classifies against the current tiers/floor. A meta failure is swallowed (fail-open).
  const runCheck = async (): Promise<void> => {
    meta = await getMeta().catch((err) => {
      logError('[auto-update] getMeta failed', err)
      return null
    })
    await updater.checkForUpdates()
  }

  // Manually re-check the feed (the Settings "Check for updates" button). With
  // autoDownload=false this only reports availability — it never starts a download.
  ipc.handle('update:check', (e) => {
    if (isForeignSender(e, getWin)) return false
    runCheck().catch((err) => logError('[auto-update] check failed', err))
    return true
  })

  // Start downloading the available update (the Settings "Download update" button /
  // toast / banner / force-modal action). Progress + completion arrive via the
  // download-progress / update-downloaded events above. Frame-guarded like every IPC.
  ipc.handle('update:download', (e) => {
    if (isForeignSender(e, getWin)) return false
    updater.downloadUpdate().catch((err) => logError('[auto-update] downloadUpdate failed', err))
    return true
  })

  // Install the downloaded update + relaunch — fired from the "ready" state (Settings
  // button / toast / banner / force modal). Frame-guarded like every IPC.
  ipc.handle('update:install', (e) => {
    if (isForeignSender(e, getWin)) return false
    try {
      // (true, true) = SILENT install + force relaunch. Without isSilent the assisted NSIS
      // installer (oneClick:false) replays the full wizard on restart — the user re-clicks
      // through every install page instead of getting a seamless in-place update.
      updater.quitAndInstall(true, true)
    } catch (err) {
      logError('[auto-update] quitAndInstall failed', err)
    }
    return true
  })

  // Kick off the initial (silent) check on launch — the ONLY automatic step. It surfaces
  // the right tier in Settings/toast/banner (or the blocking modal) without downloading.
  // Rejections surface via the 'error' event above; also caught here so a transient
  // feed/network failure never reaches the uncaughtException sink.
  runCheck().catch((err) => logError('[auto-update] initial check failed', err))
}
