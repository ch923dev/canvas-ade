/**
 * Default-session permission posture (voice epic V0 — docs/research/2026-07-02-voice-to-text).
 *
 * With NO handler set, Electron AUTO-GRANTS every renderer permission request and exposes
 * `enumerateDevices()` device labels pre-grant. The default session (which hosts only the
 * main window — previews and the diagram worker live on their own partitioned sessions with
 * deny-all handlers) therefore pins an explicit allowlist:
 *
 *  - `media` with audio-only `mediaTypes` — the dictation mic capture (video stays denied).
 *  - `clipboard-sanitized-write` — the renderer's copy buttons (`navigator.clipboard
 *    .writeText` in TaskCard / JsonView) go through this permission CHECK; denying it
 *    would silently break them.
 *  - everything else → denied.
 *
 * Decisions are pure functions (the windowSecurity.ts discipline) so the posture is
 * unit-testable without a Session; `registerMicPermissionPosture` wires them up.
 */

/** The subset of Electron's permission-request `details` these decisions read. */
export type PermissionRequestDetailsLike = {
  requestingUrl?: string
  /** Present on `media` requests: which capture kinds the page asked for. */
  mediaTypes?: readonly string[]
}

/** The subset of Electron's permission-check `details` these decisions read. */
export type PermissionCheckDetailsLike = {
  /** Present on `media` checks: 'audio' | 'video'. Absent for enumerateDevices(). */
  mediaType?: string
}

/**
 * Whether a requesting URL/origin belongs to the app's own document. Dev: the renderer
 * dev-server origin (`computeAppOrigin`). Packaged: the app loads via `loadFile`, so its
 * page is the only `file:` document the default session can host (same-frame navigation
 * away is blocked by the index.ts nav guards) — accept `file:` when no dev origin is set.
 */
export function isAppUrl(url: string | undefined, appOrigin: string | null): boolean {
  if (!url) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (appOrigin != null) return u.origin === appOrigin
  return u.protocol === 'file:'
}

/** Decision for `session.setPermissionRequestHandler` (grants/denies a live request). */
export function permissionRequestDecision(
  permission: string,
  details: PermissionRequestDetailsLike,
  appOrigin: string | null
): boolean {
  if (!isAppUrl(details.requestingUrl, appOrigin)) return false
  if (permission === 'clipboard-sanitized-write') return true
  if (permission === 'media') {
    // Microphone only: exactly ['audio']. A request including 'video' is denied whole.
    const t = details.mediaTypes
    return Array.isArray(t) && t.length === 1 && t[0] === 'audio'
  }
  return false
}

/**
 * Decision for `session.setPermissionCheckHandler` (synchronous capability probes —
 * gates `enumerateDevices()` labels and `navigator.permissions.query`). `media` checks
 * with no `mediaType` are device enumeration: allowed for the app page so the voice
 * settings' mic picker can list devices; explicit 'video' checks stay denied.
 */
export function permissionCheckDecision(
  permission: string,
  requestingOrigin: string,
  details: PermissionCheckDetailsLike,
  appOrigin: string | null
): boolean {
  if (!isAppUrl(requestingOrigin, appOrigin)) return false
  if (permission === 'clipboard-sanitized-write') return true
  if (permission === 'media') return details.mediaType !== 'video'
  return false
}

/** Minimal structural view of Electron.Session so the module stays electron-import-free. */
export type PermissionSessionLike = {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: PermissionRequestDetailsLike
    ) => void
  ): void
  setPermissionCheckHandler(
    handler: (
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
      details: PermissionCheckDetailsLike
    ) => boolean
  ): void
}

/** Install the allowlist posture on a session (index.ts calls this with the default session). */
export function registerMicPermissionPosture(
  ses: PermissionSessionLike,
  appOrigin: string | null
): void {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permissionRequestDecision(permission, details, appOrigin))
  })
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    permissionCheckDecision(permission, requestingOrigin, details, appOrigin)
  )
}
