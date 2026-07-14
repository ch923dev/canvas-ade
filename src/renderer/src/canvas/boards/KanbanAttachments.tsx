/**
 * Kanban card attachments (v19 / #346) — the capture + render block the card-detail modal shows in
 * BOTH create and edit mode. Files are added three ways: a BUTTON (native OS picker via a hidden
 * `<input type="file" multiple>`), DRAG-DROP onto the block, or PASTE (a clipboard image while the
 * modal owns focus). Each file's bytes are content-addressed into `<project>/.canvas/assets/<sha1>.<ext>`
 * through the SAME `window.api.asset.write` IPC the whiteboard paste uses — generalized past images to
 * any mime (#346 widened MAIN's ext gate to a safe slug) — so the card stores only the logical
 * `{assetId, name, kind, mime?, size?}` entry, never the blob.
 *
 * Media renders from the asset store via a `blob:` object URL (NOT `data:` / `file:` — stays inside the
 * sandbox the way pasted whiteboard images do): images → click to a lightbox; `<video>`/`<audio controls>`
 * inline players; any other file → a chip that opens externally (`library.open` → `shell.openPath`,
 * confined to `.canvas/`). The block is presentational + capture only — the parent owns the attachments
 * state and the undo-committing writes (create-mode draft vs edit-mode `setCardAttachments`).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactElement
} from 'react'
import { createPortal } from 'react-dom'
import type { KanbanAttachment } from '../../lib/kanbanSchema'
import { showToast } from '../../store/toastStore'
import { saveErrorMessage } from '../../lib/saveError'

/** Coarse media class from a MIME (falling back to the ext when the source File had no `type`). */
function deriveKind(mime: string, ext: string): KanbanAttachment['kind'] {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime) return 'file'
  // Empty MIME (some dropped files) → infer from the extension.
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic'].includes(ext))
    return 'image'
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'].includes(ext)) return 'audio'
  return 'file'
}

/** A few MIME subtypes whose canonical file extension differs from the subtype string. */
const EXT_BY_MIME_SUBTYPE: Record<string, string> = {
  jpeg: 'jpg',
  'svg+xml': 'svg',
  mpeg: 'mp3', // audio/mpeg → mp3 (the common case; video/mpeg is rare)
  quicktime: 'mov',
  'x-msvideo': 'avi',
  'x-matroska': 'mkv'
}

/**
 * The extension `asset.write` stores the blob under — a short lower-case alphanumeric slug (matching
 * MAIN's SAFE_EXT_RE). Prefers the filename's own extension; falls back to the MIME subtype; `bin` when
 * nothing usable is present. Sanitized (non-alphanumerics stripped, length-capped) so a hostile name
 * can't smuggle a `.`/`/` past the gate — MAIN re-validates regardless.
 */
function deriveExt(name: string, mime: string): string {
  const slug = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 12)
  const dot = name.lastIndexOf('.')
  const fromName = dot > 0 && dot < name.length - 1 ? slug(name.slice(dot + 1)) : ''
  if (fromName) return fromName
  const sub = mime.split('/')[1]?.toLowerCase() ?? ''
  const mapped = EXT_BY_MIME_SUBTYPE[sub] ?? slug(sub)
  return mapped || 'bin'
}

/** Human byte size (e.g. "2.4 MB"). Absent/zero ⇒ empty string (the chip just omits it). */
function fmtSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${n < 10 && u > 0 ? n.toFixed(1) : Math.round(n)} ${units[u]}`
}

/** loading (read in flight) · ready (blob URL) · missing (no assetId, or the blob was swept). */
type MediaUrl = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'missing' }

/**
 * Resolve an assetId to a `blob:` URL typed by the stored MIME (so `<video>`/`<audio>` know the codec).
 * Per-instance (the modal shows a handful of attachments, not hundreds of cards) — reads once, revokes
 * on unmount. Returns a discriminated status so a tile can show a neutral placeholder WHILE loading and
 * "missing" ONLY when the blob is truly gone (no cold-load flash of "missing"). An empty assetId (file
 * chips, which need no in-app URL) short-circuits to `missing` without an IPC read. Not the ImageCard
 * refcount cache — that dedups across many long-lived cards; here a simple own-the-URL lifecycle suffices.
 */
function useAttachmentUrl(assetId: string, mime: string | undefined): MediaUrl {
  // assetId is stable per tile (the grid keys tiles by assetId, so a different asset REMOUNTS this hook),
  // so the initializer sets the starting status and the effect only ever setState()s from its ASYNC
  // read callback — never synchronously in the body (react-hooks/set-state-in-effect).
  const [state, setState] = useState<MediaUrl>(() =>
    assetId ? { status: 'loading' } : { status: 'missing' }
  )
  useEffect(() => {
    if (!assetId) return
    let cancelled = false
    let objUrl: string | null = null
    window.api.asset
      .read(assetId)
      .then((bytes) => {
        if (cancelled) return
        if (!bytes) {
          setState({ status: 'missing' })
          return
        }
        objUrl = URL.createObjectURL(
          new Blob([bytes as BlobPart], { type: mime || 'application/octet-stream' })
        )
        setState({ status: 'ready', url: objUrl })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'missing' })
      })
    return () => {
      cancelled = true
      if (objUrl) URL.revokeObjectURL(objUrl)
    }
  }, [assetId, mime])
  return state
}

/** Full-bleed image overlay (portal above the modal). Click anywhere or Esc closes — the capture-phase
 *  Esc listener stops propagation so it doesn't ALSO trip the modal's own Esc-to-close. */
function Lightbox({
  url,
  name,
  onClose
}: {
  url: string
  name: string
  onClose: () => void
}): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div
      className="kba-lightbox"
      role="dialog"
      aria-label={`Image: ${name}`}
      onPointerDown={onClose}
    >
      <img className="kba-lightbox-img" src={url} alt={name} />
    </div>,
    document.body
  )
}

/** One attachment tile, rendered by kind. */
function AttachmentTile({
  att,
  onRemove
}: {
  att: KanbanAttachment
  onRemove: () => void
}): ReactElement {
  // Media kinds need the blob URL; a plain file chip opens externally and needs no in-app URL (pass ''
  // → the hook short-circuits to `missing` without a read; the file branch ignores it anyway).
  const needsUrl = att.kind !== 'file'
  const media = useAttachmentUrl(needsUrl ? att.assetId : '', att.mime)
  const [lightbox, setLightbox] = useState(false)

  const remove = (
    <button
      className="kba-remove"
      aria-label={`Remove attachment ${att.name}`}
      title="Remove"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onRemove()
      }}
    >
      ×
    </button>
  )

  if (att.kind === 'image') {
    return (
      <div className="kba-tile kba-tile-image" data-testid="kba-tile">
        {media.status === 'ready' ? (
          <button
            className="kba-thumb"
            title={att.name}
            aria-label={`Open image ${att.name}`}
            onClick={() => setLightbox(true)}
          >
            <img src={media.url} alt={att.name} />
          </button>
        ) : (
          <div
            className={'kba-thumb ' + (media.status === 'missing' ? 'kba-missing' : 'kba-loading')}
            aria-label={media.status === 'missing' ? 'Missing image' : 'Loading image'}
          >
            {media.status === 'missing' ? 'missing' : ''}
          </div>
        )}
        {remove}
        {lightbox && media.status === 'ready' && (
          <Lightbox url={media.url} name={att.name} onClose={() => setLightbox(false)} />
        )}
      </div>
    )
  }

  if (att.kind === 'video') {
    return (
      <div className="kba-tile kba-tile-media" data-testid="kba-tile">
        {media.status === 'ready' ? (
          <video className="kba-video" src={media.url} controls preload="metadata" />
        ) : (
          <div
            className={
              'kba-missing-media ' + (media.status === 'missing' ? 'kba-missing' : 'kba-loading')
            }
          >
            {media.status === 'missing' ? 'missing video' : ''}
          </div>
        )}
        <div className="kba-media-foot">
          <span className="kba-name" title={att.name}>
            {att.name}
          </span>
          {remove}
        </div>
      </div>
    )
  }

  if (att.kind === 'audio') {
    return (
      <div className="kba-tile kba-tile-media" data-testid="kba-tile">
        <div className="kba-media-foot">
          <span className="kba-name" title={att.name}>
            {att.name}
          </span>
          {remove}
        </div>
        {media.status === 'ready' ? (
          <audio className="kba-audio" src={media.url} controls preload="metadata" />
        ) : (
          <div
            className={
              'kba-missing-media ' + (media.status === 'missing' ? 'kba-missing' : 'kba-loading')
            }
          >
            {media.status === 'missing' ? 'missing audio' : ''}
          </div>
        )}
      </div>
    )
  }

  // file — a chip that opens externally with the OS default app.
  const size = fmtSize(att.size)
  return (
    <div className="kba-tile kba-tile-file" data-testid="kba-tile">
      <button
        className="kba-file"
        title={`Open ${att.name}`}
        onClick={() => void window.api.library.open(att.assetId)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M4 1.5h5L13 5.5v8a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z"
            stroke="currentColor"
            strokeWidth="1.1"
          />
          <path d="M9 1.5V5.5h4" stroke="currentColor" strokeWidth="1.1" />
        </svg>
        <span className="kba-file-name" title={att.name}>
          {att.name}
        </span>
        {size && <span className="kba-file-size">{size}</span>}
      </button>
      {remove}
    </div>
  )
}

export function AttachmentsBlock({
  attachments,
  onAdd,
  onRemove,
  toastKey
}: {
  attachments: KanbanAttachment[]
  /** Append freshly-built entries (parent commits: draft append in create mode / setCardAttachments in edit). */
  onAdd: (entries: KanbanAttachment[]) => void
  /** Remove the entry at `index` from the current list. */
  onRemove: (index: number) => void
  /** A stable key (the board id) so repeated write-failure toasts collapse in place. */
  toastKey: string
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  // Persist a file's bytes into the content-addressed store, then hand a built entry to the parent.
  // Sequential await (one gesture at a time); a single failed write toasts + is skipped, the rest land.
  const addFiles = useCallback(
    async (files: File[]): Promise<void> => {
      const built: KanbanAttachment[] = []
      for (const file of files) {
        const mime = file.type || ''
        const ext = deriveExt(file.name, mime)
        const bytes = new Uint8Array(await file.arrayBuffer())
        const res = await window.api.asset.write(bytes, ext)
        if ('error' in res) {
          showToast({
            id: `attach-write-failed-${toastKey}`,
            kind: 'error',
            message: saveErrorMessage(res.code, 'Could not attach file')
          })
          continue
        }
        const entry: KanbanAttachment = {
          assetId: res.assetId,
          name: file.name || `attachment.${ext}`,
          kind: deriveKind(mime, ext)
        }
        if (mime) entry.mime = mime
        if (file.size > 0) entry.size = file.size
        built.push(entry)
      }
      if (built.length) onAdd(built)
    },
    [onAdd, toastKey]
  )

  // Paste: a clipboard image while the modal owns focus (the modal is the top surface + focus-trapped).
  // Only image files are captured; we never preventDefault a text paste, so pasting into the description
  // textarea still works normally.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const data = e.clipboardData
      if (!data) return
      const files: File[] = []
      for (const it of data.items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile()
          if (f) files.push(f)
        }
      }
      if (!files.length) {
        for (const f of Array.from(data.files)) if (f.type.startsWith('image/')) files.push(f)
      }
      if (!files.length) return
      e.preventDefault()
      void addFiles(files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [addFiles])

  const onDrop = (e: ReactDragEvent): void => {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length) void addFiles(files)
  }
  const onDragOver = (e: ReactDragEvent): void => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    if (!dragging) setDragging(true)
  }

  return (
    <div
      className={'kba' + (dragging ? ' kba-dragover' : '')}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {attachments.length > 0 && (
        <div className="kba-grid">
          {attachments.map((att, i) => (
            <AttachmentTile key={att.assetId + '#' + i} att={att} onRemove={() => onRemove(i)} />
          ))}
        </div>
      )}
      <div className="kba-actions">
        <button className="kba-add" data-testid="kba-add" onClick={() => inputRef.current?.click()}>
          + Add file
        </button>
        <span className="kba-hint">or drop / paste an image</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        data-testid="kba-input"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = '' // reset so re-picking the same file fires change again
          if (files.length) void addFiles(files)
        }}
      />
    </div>
  )
}
