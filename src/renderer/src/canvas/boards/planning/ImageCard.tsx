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
  useEffect,
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
  const [url, setUrl] = useState<string | null>(() => assetUrlCache.get(assetId)?.url ?? null)
  useEffect(() => {
    let cancelled = false
    const cached = assetUrlCache.get(assetId)
    if (cached) {
      cached.refs++
      setUrl(cached.url)
    } else {
      void window.api.asset
        .read(assetId)
        .then((bytes) => {
          if (cancelled) return
          if (!bytes) {
            setUrl(null)
            return
          }
          const again = assetUrlCache.get(assetId)
          if (again) {
            again.refs++
            setUrl(again.url)
            return
          }
          const ext = assetId.split('.').pop() ?? ''
          const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
          const objUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
          assetUrlCache.set(assetId, { url: objUrl, refs: 1 })
          setUrl(objUrl)
        })
        .catch(() => {
          if (!cancelled) setUrl(null)
        })
    }
    return () => {
      cancelled = true
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
  return url
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

export function ImageCard({
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
        cursor: interactive ? 'grab' : 'default'
      }}
      onPointerDown={(e) => {
        // In a draw mode let the press fall through to the well (a stroke can start
        // over the image); in select mode this is the drag handle.
        if (!interactive) return
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
            color: 'var(--text-faint)',
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
}
