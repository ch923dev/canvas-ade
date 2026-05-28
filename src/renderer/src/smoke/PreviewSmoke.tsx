import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A native WebContentsView mounts over the "cutout" div. It paints above all
 * HTML (so it covers the placeholder) — exactly the constraint Phase 1's
 * PreviewManager must manage. Here we just prove load + bounds-sync.
 */
export default function PreviewSmoke() {
  const cut = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  const rect = useCallback((): { x: number; y: number; width: number; height: number } | null => {
    const el = cut.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }, [])

  const openPreview = useCallback(async () => {
    const b = rect()
    if (!b) return
    await window.api.openPreview({ bounds: b })
    setOpen(true)
  }, [rect])

  const closePreview = useCallback(async () => {
    await window.api.closePreview()
    setOpen(false)
  }, [])

  // Keep the native view glued to the cutout as the window / layout changes.
  useEffect(() => {
    if (!open) return
    const sync = (): void => {
      const b = rect()
      if (b) void window.api.setPreviewBounds(b)
    }
    window.addEventListener('resize', sync)
    const ro = new ResizeObserver(sync)
    if (cut.current) ro.observe(cut.current)
    return () => {
      window.removeEventListener('resize', sync)
      ro.disconnect()
    }
  }, [open, rect])

  // Tear the view down when leaving the tab.
  useEffect(() => () => void window.api.closePreview(), [])

  return (
    <>
      <div className="hint">Electron WebContentsView → localhost (loopback server)</div>
      <div className="toolbar">
        {!open ? (
          <button className="btn accent" onClick={openPreview}>
            Open preview
          </button>
        ) : (
          <button className="btn" onClick={closePreview}>
            Close preview
          </button>
        )}
      </div>
      <div
        ref={cut}
        style={{
          position: 'absolute',
          inset: '56px 24px 24px',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--r-board)',
          background: 'var(--surface)',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text-3)',
          fontFamily: 'var(--mono)',
          fontSize: 12
        }}
      >
        {open ? 'native view mounted above this area' : 'WebContentsView mounts here →  click “Open preview”'}
      </div>
    </>
  )
}
