/**
 * Wallpaper-media loader for the backdrop layer: `assetId` → frame-guarded
 * `asset:read` IPC → Blob URL. The renderer never touches Node/fs — bytes only ever
 * arrive over the existing asset channel (spec §4 invariant, no new MAIN surface).
 *
 * Exactly ONE backdrop exists per project, so unlike ImageCard's ref-counted
 * module cache this hook owns its URL outright: revoked on assetId change, unmount,
 * and project switch (the consuming layer unmounts/remounts through those).
 * `missing` (read returned null / threw) drives the spec'd revert-to-none + toast
 * in BackdropLayer — never a silent black hole.
 *
 * State shape: only the ASYNC outcome lives in React state, tagged with the assetId
 * it answers for; idle/loading are derived at read time (no synchronous setState in
 * the effect — react-hooks/set-state-in-effect) and a stale outcome from a previous
 * assetId is ignored by the tag check.
 */
import { useEffect, useState } from 'react'

export type BackdropMediaState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string; video: boolean }
  | { status: 'missing' }

/** Import-accept list (spec §3) — keep in sync with BackdropPicker's file input. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  webm: 'video/webm',
  mp4: 'video/mp4'
}

type Outcome = { for: string; state: BackdropMediaState }

export function useBackdropMedia(assetId: string | undefined): BackdropMediaState {
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  useEffect(() => {
    if (!assetId) return
    let cancelled = false
    let url: string | null = null
    window.api.asset
      .read(assetId)
      .then((bytes) => {
        if (cancelled) return
        if (!bytes) {
          setOutcome({ for: assetId, state: { status: 'missing' } })
          return
        }
        const ext = assetId.split('.').pop()?.toLowerCase() ?? ''
        const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
        setOutcome({
          for: assetId,
          state: { status: 'ready', url, video: mime.startsWith('video/') }
        })
      })
      .catch(() => {
        if (!cancelled) setOutcome({ for: assetId, state: { status: 'missing' } })
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [assetId])

  if (!assetId) return { status: 'idle' }
  if (outcome && outcome.for === assetId) return outcome.state
  return { status: 'loading' }
}
