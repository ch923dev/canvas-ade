/**
 * Project Library — a single project-level slide-in panel (modeled on DigestPanel) that browses
 * files saved INTO the project under `<project>/.canvas/` (ADR 0009): the Browser boards' downloads
 * (`.canvas/downloads/`) and the canvas asset store (`.canvas/assets/`). Distinct from the per-board
 * DevTools Assets/Downloads tabs, which inspect the CURRENT page's network resources.
 *
 * Self-contained: its open state lives in `libraryStore` (so the e2e `reset()` can close it between
 * specs — see the store note), with its own reopen tab + e2e-driveable DOM, so Canvas mounts it with
 * a single `<ProjectLibraryPanel />`. Reads the filesystem via the MAIN-confined `api.library`
 * (list/reveal/open) — no schema, nothing serialized.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Icon } from './Icon'
import { FILEREF_MIME } from './fileTreeData'
import { useLibraryStore } from '../store/libraryStore'
import { useCanvasStore } from '../store/canvasStore'
import type { LibraryItem, LibraryListing } from '../../../preload'

type Tab = 'downloads' | 'assets'

/** Human-readable byte size (1 decimal under 10 units, else rounded): 480 KB · 2.1 MB · 14 MB. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

export function ProjectLibraryPanel(): ReactElement {
  // Open state lives in the store (not useState) so the e2e reset() can close it between specs —
  // a panel left open leaked across specs and occluded a later @preview click target.
  const open = useLibraryStore((s) => s.open)
  const setOpen = useLibraryStore((s) => s.setOpen)
  const [tab, setTab] = useState<Tab>('downloads')
  const [listing, setListing] = useState<LibraryListing | null>(null)
  const asideRef = useRef<HTMLElement>(null)
  // Bumped when a file lands under .canvas/ (a screenshot saved to assets/, a completed download);
  // re-lists the open panel so the new file shows up immediately (no manual refresh).
  const refreshNonce = useLibraryStore((s) => s.refreshNonce)
  // Re-list when the open project changes too — otherwise the panel would keep showing the prior
  // project's files after a switch (MAIN's current dir has already moved by the time this updates).
  const projectDir = useCanvasStore((s) => s.project.dir)

  // a11y: stays mounted + slid off-screen when closed, so reflect `inert` imperatively (presence =
  // inert) — open removes it, closed sets it. Mirrors DigestPanel's T-F3 fix.
  useEffect(() => {
    const el = asideRef.current
    if (!el) return
    if (open) el.removeAttribute('inert')
    else el.setAttribute('inert', '')
  }, [open])

  const refresh = useCallback(async (): Promise<void> => {
    setListing(await window.api.library.list())
  }, [])

  // Load (and re-load) the listing whenever the panel opens OR a .canvas/ file is added
  // (refreshNonce). setListing runs in the promise callback (not synchronously in the effect),
  // guarded against a close/unmount/stale-response race.
  useEffect(() => {
    if (!open) return
    let active = true
    void window.api.library.list().then((l) => {
      if (active) setListing(l)
    })
    return () => {
      active = false
    }
  }, [open, refreshNonce, projectDir])

  const items: LibraryItem[] =
    tab === 'downloads' ? (listing?.downloads ?? []) : (listing?.assets ?? [])

  return (
    <>
      {!open && (
        <button
          type="button"
          className="lib-reopen"
          data-test="library-open"
          onClick={() => setOpen(true)}
          title="Project library"
        >
          Library
        </button>
      )}
      <aside
        ref={asideRef}
        className="lib-panel"
        data-test="library-panel"
        data-open={open}
        aria-hidden={!open}
        aria-label="Project Library"
      >
        <header className="lib-head">
          <span className="lib-head-title">Project Library</span>
          <button
            type="button"
            className="lib-icon-btn"
            data-test="library-refresh"
            onClick={() => void refresh()}
            aria-label="Refresh library"
            title="Refresh"
          >
            <Icon name="refresh" size={13} />
          </button>
          <button
            type="button"
            className="lib-icon-btn"
            data-test="library-close"
            onClick={() => setOpen(false)}
            aria-label="Dismiss library panel"
          >
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="lib-tabs" role="tablist" aria-label="Library category">
          {(['downloads', 'assets'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={'lib-tab' + (tab === t ? ' lib-tab-on' : '')}
              data-test={`library-tab-${t}`}
              onClick={() => setTab(t)}
            >
              {t === 'downloads' ? 'Downloads' : 'Assets'}
            </button>
          ))}
        </div>
        <div className="lib-list" role="tabpanel">
          {items.length === 0 ? (
            <p className="lib-empty">No {tab} saved yet.</p>
          ) : (
            items.map((it) => (
              <div
                key={it.relPath}
                className="lib-row"
                data-test="library-row"
                title={it.name}
                // Drag onto the canvas to open the file as a File board (same FILEREF payload + drop
                // handler the file tree uses). The path is project-root-relative; .canvas/ files are
                // readable (only the tree LISTING hides .canvas/). Binary/large files degrade to the
                // File board's placeholder; images preview as <img>.
                draggable
                onDragStart={(e) => {
                  const path = `.canvas/${it.relPath}`
                  e.dataTransfer.setData(FILEREF_MIME, JSON.stringify({ path, label: it.name }))
                  e.dataTransfer.setData('text/plain', path)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
              >
                <Icon name="file" size={14} />
                <span className="lib-name">{it.name}</span>
                <span className="lib-size">{formatBytes(it.size)}</span>
                <button
                  type="button"
                  className="lib-act"
                  onClick={() => void window.api.library.open(it.relPath)}
                  aria-label={`Open ${it.name}`}
                  title="Open"
                >
                  ⤓
                </button>
                <button
                  type="button"
                  className="lib-act"
                  onClick={() => void window.api.library.reveal(it.relPath)}
                  aria-label={`Reveal ${it.name} in file manager`}
                  title="Reveal in file manager"
                >
                  ⧉
                </button>
              </div>
            ))
          )}
        </div>
        {tab === 'downloads' && listing && (
          <p className="lib-foot" title={listing.downloadsDir}>
            saved → {listing.downloadsDir}
          </p>
        )}
      </aside>
    </>
  )
}
