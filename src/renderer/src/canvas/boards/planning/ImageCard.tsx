/**
 * Image element (W4). Renders a pasted/dropped screenshot from the assets/ blob
 * pipeline. Bytes are fetched once via `window.api.asset.read` and wrapped in a
 * `blob:` object URL (CSP allows blob:; we never inline base64). The URL is shared
 * across cards with the same content-addressed assetId and revoked when the last
 * card unmounts. A missing blob (e.g. canvas.json restored from .bak after a sweep)
 * renders a dashed fallback tile rather than a broken <img>.
 *
 * Like NoteCard, the card body is the drag handle in select mode (the well captures
 * the pointer for the move) and falls through to the well in a draw mode so a stroke
 * can start over the image. Deletion is menu/eraser only — NO inline ×.
 */
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import type { ImageElement } from '../../../lib/boardSchema'

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

/** assetId → shared object URL + refcount (content-addressed → dedup-shared). */
const assetUrlCache = new Map<string, { url: string; refs: number }>()

/** Resolve an assetId to a blob: URL (null while loading or when the blob is missing). */
function useAssetUrl(assetId: string): string | null {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)

  // useLayoutEffect runs synchronously during the layout phase — BEFORE any sibling
  // component's useEffect cleanup fires in the same commit batch. By incrementing
  // the ref here (on cache hit), we prevent the following race (BUG-036 guarantee):
  //
  //   1. This component renders, reading a shared blob URL from the cache.
  //   2. A sibling that shares the same assetId unmounts in the same batch.
  //   3. React's passive-effect flush runs the sibling's useEffect cleanup (refs→0,
  //      URL revoked, cache deleted) BEFORE this component's useEffect can increment.
  //   4. This component is left rendering a revoked blob URL (broken image).
  //
  // With the useLayoutEffect claim below, step 3 sees refs=2 (not 1), so it goes to
  // refs=1 — no revocation. The useEffect cleanup handles the final decrement/revoke.
  //
  // The two effects are kept SEPARATE (not collapsed into one) to preserve the
  // BUG-036 sibling-ordering guarantee: layout claims run in layout phase;
  // cleanup must run in the passive phase so a newly mounting sibling's layout
  // effect can claim BEFORE this cleanup fires (same batch ordering we rely on).
  //
  // `layoutClaimedRef` tracks whether THIS layout-effect run made a claim so
  // the passive cleanup never decrements a ref it did not take (BUG-051 fix).
  const layoutClaimedRef = useRef(false)

  useLayoutEffect(() => {
    const cached = assetUrlCache.get(assetId)
    if (cached) {
      cached.refs++
      layoutClaimedRef.current = true
    } else {
      layoutClaimedRef.current = false
    }
    // No cleanup here: the useEffect cleanup below owns ref decrement + revocation.
    // Keeping cleanup in useEffect (not here) is intentional — see above.
  }, [assetId])

  useEffect(() => {
    let cancelled = false
    // Whether THIS passive-effect run made a claim that the cleanup must release.
    // Initialised from the layout-effect result: if layout already claimed, the
    // passive effect inherits that claim and is responsible for releasing it.
    let passiveClaimed = layoutClaimedRef.current

    const cached = assetUrlCache.get(assetId)
    if (!cached) {
      // Cache miss at layout time AND still a miss now: start an async read.
      void window.api.asset
        .read(assetId)
        .then((bytes) => {
          if (cancelled) return
          if (!bytes) {
            setLoadedUrl(null)
            return
          }
          const again = assetUrlCache.get(assetId)
          if (again) {
            // A sibling's read resolved between our layout miss and now.
            // Claim the existing entry (BUG-051: mark as claimed so cleanup releases it).
            again.refs++
            passiveClaimed = true
            setLoadedUrl(again.url)
            return
          }
          const ext = assetId.split('.').pop() ?? ''
          const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
          const objUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
          assetUrlCache.set(assetId, { url: objUrl, refs: 1 })
          passiveClaimed = true
          setLoadedUrl(objUrl)
        })
        .catch(() => {
          if (!cancelled) setLoadedUrl(null)
        })
    } else if (!passiveClaimed) {
      // BUG-051 path (b): layout saw a miss but by the time the passive effect
      // runs a sibling's read has populated the cache. The render already reads
      // the cache URL via line `return assetUrlCache.get(…)?.url ?? loadedUrl`,
      // so we must claim a ref here so cleanup can release it correctly.
      cached.refs++
      passiveClaimed = true
    }
    // If cached && passiveClaimed: layout already claimed — nothing more to do here.

    return () => {
      cancelled = true
      // BUG-051: only release a ref this instance actually claimed. An unclaimed
      // cleanup (cancelled read, or a layout-miss + passive-miss race) must never
      // steal another live card's ref and trigger a premature URL revocation.
      if (!passiveClaimed) return
      const entry = assetUrlCache.get(assetId)
      if (entry) {
        entry.refs--
        if (entry.refs <= 0) {
          URL.revokeObjectURL(entry.url)
          assetUrlCache.delete(assetId)
        }
      }
    }
  }, [assetId])

  // Prefer the live cache entry; fall back to the last value stored in state. The
  // state fallback ensures a valid URL survives a transient cache eviction between
  // the layout effect and the passive effect (e.g. during a sibling's cleanup run).
  return assetUrlCache.get(assetId)?.url ?? loadedUrl
}

export interface ImageCardProps {
  image: ImageElement
  /** True when the `select` tool is active (enables drag + selection). */
  interactive: boolean
  /** Begin a board-local drag from a screen pointer-down on the card. */
  onDragStart: (e: ReactPointerEvent, id: string) => void
  /** True when this element is in the board selection set (draws the accent ring). */
  selected?: boolean
  /** Select this element on press; `additive` = Shift held. */
  onSelect?: (id: string, additive: boolean) => void
}

// Memoized: a moved/edited image yields a new element object; everything else keeps its
// ref, so unrelated edits in the well don't re-render this card (or re-run useAssetUrl).
export const ImageCard = memo(function ImageCard({
  image,
  interactive,
  onDragStart,
  selected,
  onSelect
}: ImageCardProps): ReactElement {
  const url = useAssetUrl(image.assetId)
  return (
    <div
      className="pl-image"
      style={{
        position: 'absolute',
        left: image.x,
        top: image.y,
        width: image.w,
        height: image.h,
        borderRadius: 'var(--r-inner)',
        overflow: 'hidden',
        outline: selected ? '1.5px solid var(--accent)' : 'none',
        outlineOffset: 2,
        // v17 (P4b) element opacity — absent ⇒ opaque, byte-identical to pre-P4b.
        opacity: image.opacity,
        cursor: interactive ? 'grab' : 'default'
      }}
      onPointerDown={(e) => {
        // In a draw mode let the press fall through to the well (a stroke can start
        // over the image); in select mode this is the drag handle.
        if (!interactive) return
        // Only the primary button initiates a drag; right/middle buttons fall
        // through to the browser context-menu / OS default (primary-button guard).
        if (e.button !== 0) return
        e.stopPropagation()
        onSelect?.(image.id, e.shiftKey)
        onDragStart(e, image.id)
      }}
    >
      {url ? (
        <img
          src={url}
          draggable={false}
          alt=""
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
            pointerEvents: 'none'
          }}
        />
      ) : (
        <div
          className="pl-image-missing"
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px dashed var(--border)',
            borderRadius: 'var(--r-inner)',
            color: 'var(--text-3)', // D0-2: a readable state — faint is disabled-only
            fontFamily: 'var(--ui)',
            fontSize: 11,
            pointerEvents: 'none'
          }}
        >
          missing image
        </div>
      )}
    </div>
  )
})
