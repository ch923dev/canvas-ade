/**
 * Browser board content (Phase 2.2, DESIGN.md §7.2) — a responsive preview of the
 * user's running localhost app in a device frame.
 *
 * The live page renders OFFSCREEN (OS-3 / ADR 0002) and streams BGRA frames into a DOM
 * `<canvas>` inside `.bb-frame` — a normal DOM node that clips / rounds / z-orders, so the
 * preview composites correctly under other boards and chrome (the occlusion fix). This
 * component draws the HTML chrome around it:
 *   - the rounded device frame (border + inset shadow + mobile notch),
 *   - the URL/route bar (back/forward/reload + editable URL + connected dot + WxH),
 *   - the viewport segmented control (Mobile/Tablet/Desktop) in the title-bar slot,
 *   - a hidden composition-proxy <textarea> (keyboard/IME/clipboard target) + the
 *     native-widget overlay layer (JS dialogs / <select> popups the bitmap can't composite).
 * The device-frame geometry mirrors `lib/browserLayout` so the HTML frame matches the page's
 * laid-out preset at every camera zoom.
 *
 * The connecting / load-failed / crashed states (read from `previewStore`) render UNDER the
 * canvas as the fallback layer. Durable props (`url`, `viewport`) persist on the board via
 * `canvasStore.updateBoard`.
 *
 * Security: this never touches the PTY. URL edits + nav go through the additive
 * `preview:*` control channel to the board's OWN offscreen webContents only.
 */
import { useState, useRef, useEffect, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { BrowserBoard as BrowserBoardData, BrowserViewport } from '../../lib/boardSchema'
import { VIEWPORT_PRESETS, deviceFrameRect, TITLEBAR_H, URLBAR_H } from '../../lib/browserLayout'
import { BoardFrame } from '../BoardFrame'
import { Icon } from '../Icon'
import { useInspectorSlot } from '../inspector/inspectorSlotStore'
import { ViewportControl } from './browser/BrowserViewportControl'
import { BrowserInspector, type ConnTone } from './browser/BrowserInspector'
import { useCanvasStore } from '../../store/canvasStore'
import { usePreviewStore, selectRuntime } from '../../store/previewStore'
import { useOsrLivenessStore } from '../../store/osrLivenessStore'
import { showToast } from '../../store/toastStore'
import { boardStatusBucket, bucketToPill } from '../../store/boardStatus'
import type { BoardViewProps } from '../BoardNode'
import { isHttpUrl } from '../../lib/autoConnect'
import { useOffscreenPreview } from './useOffscreenPreview'
import { useOffscreenInput } from './useOffscreenInput'
import { useOffscreenSizing } from './useOffscreenSizing'
import { useOsrWidgetEvents } from './osr/useOsrWidgetEvents'
import { OsrWidgetLayer } from './osr/OsrWidgetLayer'
import { OsrVolumeControl } from './osr/OsrVolumeControl'
import { useOsrWidgetStore } from '../../store/osrWidgetStore'
import { useLibraryStore } from '../../store/libraryStore'
import { useOsrNetwork } from './osr/useOsrNetwork'
import { OsrNetworkPanel } from './osr/OsrNetworkPanel'
import { useOsrNetworkStore } from '../../store/osrNetworkStore'

export function BrowserBoard({
  board,
  selected,
  hovered,
  dimmed,
  fullView = false,
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup,
  onRemoveFromAllGroups,
  onStartConnect
}: BoardViewProps<BrowserBoardData>): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const beginChange = useCanvasStore((s) => s.beginChange)
  const runtime = usePreviewStore(selectRuntime(board.id))
  const preset = VIEWPORT_PRESETS[board.viewport]

  // The offscreen-preview canvas. useOffscreenPreview opens an offscreen render in MAIN and
  // paints its frames into this canvas (inside .bb-frame). Stays enabled in FULL VIEW: portal
  // full view RELOCATES this live subtree (canvas + its 2D context + input listeners) into the
  // modal host without remounting (useFullView), so the OSR window is never torn down — the
  // canvas keeps painting + forwarding in full view too.
  const osrCanvasRef = useRef<HTMLCanvasElement>(null)
  // OS-3 Phase 3: a hidden composition-proxy <textarea> is the keyboard/IME/clipboard target
  // (the canvas can't host IME/composition). useOffscreenInput focuses it on canvas pointerdown.
  const osrProxyRef = useRef<HTMLTextAreaElement>(null)
  useOffscreenPreview(board.id, board.url, osrCanvasRef)
  // Forward pointer/wheel on the canvas + keyboard/IME/clipboard on the proxy to the offscreen
  // page (OS-3 Phase 3 closed the IME / AltGr / clipboard / wheel-precision gaps; Phase 4 added
  // native <select> / dialogs / downloads / audio mute).
  useOffscreenInput(board.id, osrCanvasRef, osrProxyRef, board.viewport)
  // OS-3 Phase 1 (M1 sharpness + M4 responsive reflow): drive the offscreen render size from
  // the board geometry + settled camera zoom + DPR via a settle-gated preview:osrResize — the
  // page renders supersampled (crisp) and lays out at the preset width (real breakpoint reflow).
  // Low-frequency only (settle/preset/resize), so the OSR path keeps its zero-per-frame-IPC win.
  // PREV-01: in full view the supersample is recomputed from the (much larger) full-view pixel box
  // so the blown-up preview stays crisp; passing the canvas ref lets it measure that box.
  useOffscreenSizing(board.id, board.w, board.h, board.viewport, fullView, osrCanvasRef)
  // OS-3 Phase 4: subscribe the board's native-widget event streams (JS dialog · native popup ·
  // audible flip · download) → osrWidgetStore + toasts. Drives the mute toggle + the overlay layer.
  useOsrWidgetEvents(board.id)
  // DevTools Network inspector (per board). The hook subscribes MAIN capture ONLY while the panel is
  // open; the URL-bar toggle flips `open`. Ephemeral (no schema). FIND-011 cleanup lives in the hook.
  useOsrNetwork(board.id)
  const netOpen = useOsrNetworkStore((s) => s.byBoard[board.id]?.open ?? false)
  const netDock = useOsrNetworkStore((s) => s.byBoard[board.id]?.dock ?? 'bottom')
  const toggleNet = (): void => useOsrNetworkStore.getState().setOpen(board.id, !netOpen)
  // 4A — the URL-bar audio control shows only while the page is playing media. Mute + volume are
  // the user's manual choices (MAIN also auto-mutes off-screen); both ephemeral (no schema). The
  // control itself (speaker icon + click-open mute/slider popover) lives in OsrVolumeControl.
  const osrAudibleNow = useOsrWidgetStore((s) => s.audible[board.id] ?? false)

  // Editable URL: a local draft committed on Enter / blur. When the durable
  // board.url changes underneath (e.g. set elsewhere), re-sync the draft DURING
  // render via the "adjust state on prop change" pattern (no effect → no cascading
  // render; https://react.dev/learn/you-might-not-need-an-effect).
  const [draftUrl, setDraftUrl] = useState(board.url)
  const [lastUrl, setLastUrl] = useState(board.url)
  // BUG-059: the URL input is being edited. While focused, an external board.url
  // change (auto-connect detect push, terminal push-to-preview, MCP, undo) must NOT
  // clobber the in-progress draft; blur/Escape re-sync from board.url instead.
  const [editingUrl, setEditingUrl] = useState(false)
  // The user actually typed since focus — only then does blur commit the draft
  // (a focus-without-edit blur must not write a stale draft back over an external
  // url change).
  const urlDirty = useRef(false)
  // D2-C: the committed draft failed the URL sanity check (scheme + host). Shown inline in
  // the bar (red field + message in the dims slot), keeping the URL-bar feedback together.
  const [urlError, setUrlError] = useState<string | null>(null)
  // D2-C: an EXTERNAL writer (auto-connect detect push, terminal push-to-preview,
  // MCP) just rewrote board.url — flash the URL field with the accent wash for 600ms
  // so the silent background mutation is noticeable. A self-commit never reaches
  // this branch: commitUrl pre-syncs lastUrl/draft to the committed value, so only
  // a url the user did NOT just type can mismatch here.
  const [urlFlash, setUrlFlash] = useState(false)
  if (board.url !== lastUrl) {
    setLastUrl(board.url)
    if (!editingUrl) {
      setDraftUrl(board.url)
      setUrlError(null) // the synced board.url supersedes a stale inline error
      setUrlFlash(true)
    }
  }
  useEffect(() => {
    if (!urlFlash) return
    const t = setTimeout(() => setUrlFlash(false), 600)
    return () => clearTimeout(t)
  }, [urlFlash])

  // D0-6 (A9): live-region text for the connection dot. Starts EMPTY and fills only on
  // the first status TRANSITION — a region inserted with content can announce on mount,
  // which would speak "not connected" for every board on project load.
  const [srConn, setSrConn] = useState('')
  const firstStatus = useRef(true)
  useEffect(() => {
    if (firstStatus.current) {
      firstStatus.current = false
      return
    }
    setSrConn(connWord(runtime.status))
  }, [runtime.status])

  const commitUrl = (): void => {
    const next = draftUrl.trim()
    // BUG-059: an unedited blur must not commit — the draft may be a STALE value an
    // external writer (auto-connect) superseded while the input was focused.
    if (!urlDirty.current || !next || next === board.url) {
      urlDirty.current = false
      setDraftUrl(board.url)
      setUrlError(null)
      return
    }
    // D2-C: lightweight sanity check (scheme + host) BEFORE the commit — a typo'd
    // URL otherwise round-trips to main just to bounce off the scheme allowlist as a
    // full "Couldn't load" board state. Keep the rejected draft in place (with the
    // inline error) so the user can fix it; nothing is written to the board.
    if (!isHttpUrl(next)) {
      setUrlError('Needs an http(s)://host URL')
      return
    }
    urlDirty.current = false
    setUrlError(null)
    // Pre-sync the mirrors to the committed value so the render-adjust branch above
    // sees no mismatch — the accent flash fires only for EXTERNAL writers.
    setLastUrl(next)
    setDraftUrl(next)
    // One undo checkpoint per committed URL edit (also clears any armed redo branch).
    beginChange()
    updateBoard(board.id, { url: next })
  }

  const setViewport = (vp: BrowserViewport): void => {
    if (vp !== board.viewport) {
      beginChange()
      updateBoard(board.id, { viewport: vp })
    }
  }

  // D1-A: feedback routes to the app toast channel (was a board-anchored note that
  // replaced a single slot). Board-scoped keys keep that collapse behavior — a rapid
  // repeat (double-click on a broken URL, re-shot screenshot) replaces the previous
  // toast in place instead of stacking duplicates (makePortDetectNote pattern).
  const openExternal = (): void => {
    const externalError = (): string =>
      showToast({
        id: `browser-external-${board.id}`,
        kind: 'error',
        message: 'Cannot open that URL in a browser'
      })
    void window.api
      .openExternalPreview(runtime.liveUrl ?? board.url)
      .then((ok) => {
        if (!ok) externalError()
      })
      // D0-5: an IPC rejection (teardown race, channel gone) was silent before.
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('openExternalPreview failed', err)
        externalError()
      })
  }

  const takeScreenshot = (): void => {
    const shotToast = (t: { kind?: 'error' | 'ok' | 'info'; message: string }): string =>
      showToast({ id: `browser-shot-${board.id}`, ...t })
    void (async () => {
      // D0-5: the IPC can also REJECT (capture race, channel teardown) — without the
      // catch that path was a silent no-op while the success/false branches spoke.
      try {
        const res = await window.api.screenshotPreview(board.id)
        // BUG-028: main reports whether the clipboard write actually landed.
        const clipOk = res.ok && res.clipboardOk
        if (!res.ok) shotToast({ message: 'Open the preview to screenshot it' })
        else if (res.assetId) {
          // A new asset landed in <project>/.canvas/assets/ — re-list the Project Library so the
          // screenshot shows up immediately (no manual refresh).
          useLibraryStore.getState().requestRefresh()
          shotToast({
            kind: 'ok',
            message: clipOk
              ? 'Screenshot copied + saved to assets/'
              : 'Screenshot saved to assets/ (clipboard unavailable)'
          })
        } else if (clipOk) shotToast({ kind: 'ok', message: 'Screenshot copied to clipboard' })
        else
          shotToast({
            kind: 'error',
            message: 'Screenshot failed: clipboard unavailable and nothing saved'
          })
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('screenshotPreview failed', err)
        shotToast({ kind: 'error', message: 'Screenshot failed — try again' })
      }
    })()
  }

  // Device-frame outer rect in board-LOCAL coords (matches browserLayout exactly:
  // frame.y is measured from the board top, i.e. below TITLEBAR_H + URLBAR_H).
  const frame = deviceFrameRect(board.w, board.h, board.viewport)
  // The frame is a child of .bb-stage, whose origin sits at board-y = TITLEBAR_H +
  // URLBAR_H (content slot starts below the titlebar; the URL bar takes its first
  // URLBAR_H px). Re-base the frame's top into .bb-stage's coordinate space.
  const frameTopInStage = frame.y - TITLEBAR_H - URLBAR_H

  // T1.6: the title-bar pill is derived from the SAME bucket the MCP sees
  // (canvas://boards), so the on-canvas dot and the agent's view never disagree.
  const status = bucketToPill(boardStatusBucket('browser', { preview: runtime.status }))

  // Only show "Reconnecting…" when the engine will actually retry: reload path needs
  // an http(s) URL; detect path needs a linked source terminal.
  const willRetry = isHttpUrl(board.url) || !!board.previewSourceId

  // OS-3 Phase 2 (2B): the MAX_LIVE cap evicted this board — its offscreen window was closed
  // (renderer freed) but its last frame stays frozen on the canvas. Surface a "paused" badge
  // off the liveness store so the user knows interaction is dead until a live slot frees.
  const osrAlive = useOsrLivenessStore((s) => s.alive[board.id] ?? true)
  const paused = !osrAlive

  // D2-C Reload CTA: reloading the offscreen window relaunches a crashed renderer; its fresh
  // main-frame nav-start clears the crashed latch back to `connecting` (useOffscreenPreview).
  const reloadCrashed = (): void => {
    void window.api.reloadOsrPreview(board.id)
  }

  // ── Board Inspector (P1) ──────────────────────────────────────────────────────────────────────
  // The portaled BrowserInspector is presentation-only; the reads/handlers it needs are the SAME
  // paths the URL-bar controls use (OsrVolumeControl mute/volume, NavBtns, ViewportControl) — no
  // duplicated state. The slot is non-null only while this board is the single eligible selection.
  const inspectorSlot = useInspectorSlot(board.id)
  const muted = useOsrWidgetStore((s) => s.muted[board.id] ?? false)
  const volume = useOsrWidgetStore((s) => s.volume[board.id] ?? 1)
  const urlInputRef = useRef<HTMLInputElement>(null)

  const onMute = (next: boolean): void => {
    useOsrWidgetStore.getState().setMuted(board.id, next)
    void window.api.setOsrMuted(board.id, next)
  }
  const onVolume = (v: number): void => {
    const clamped = v < 0 ? 0 : v > 1 ? 1 : v
    useOsrWidgetStore.getState().setVolume(board.id, clamped)
    void window.api.setOsrVolume(board.id, clamped)
  }
  // Configuration → Edit URL focuses the on-board URL field (reusing its exact commit/validate path —
  // no duplicated editor); select() so the user can immediately overtype.
  const onEditUrl = (): void => {
    const el = urlInputRef.current
    if (!el) return
    el.focus()
    el.select()
  }

  // Preview status word + semantic tone (CSS colours the dot off `data-tone`). An evicted board reads
  // "paused" (its renderer is freed) regardless of the last connection status.
  const statusTone: ConnTone = paused
    ? 'idle'
    : runtime.status === 'connected'
      ? 'ok'
      : runtime.status === 'connecting'
        ? 'warn'
        : runtime.status === 'load-failed' || runtime.status === 'crashed'
          ? 'err'
          : 'idle'
  const statusWord = paused ? 'paused' : connWord(runtime.status)

  return (
    <>
      {/* P1 Board Inspector content — portaled into the shell's slot only while this browser board is
          the single eligible selection. Same handlers as the URL/title bar (kept), zero duplication. */}
      {inspectorSlot &&
        createPortal(
          <BrowserInspector
            viewport={board.viewport}
            onViewport={setViewport}
            onBack={() => void window.api.goBackOsrPreview(board.id)}
            onForward={() => void window.api.goForwardOsrPreview(board.id)}
            onReload={() => void window.api.reloadOsrPreview(board.id)}
            canGoBack={runtime.canGoBack}
            canGoForward={runtime.canGoForward}
            statusWord={statusWord}
            statusTone={statusTone}
            audible={osrAudibleNow}
            muted={muted}
            volume={volume}
            onMute={onMute}
            onVolume={onVolume}
            onScreenshot={takeScreenshot}
            screenshotDisabled={runtime.status !== 'connected' || !osrAlive}
            onOpenExternal={openExternal}
            netOpen={netOpen}
            onToggleNet={(next) => useOsrNetworkStore.getState().setOpen(board.id, next)}
            netDock={netDock}
            onNetDock={(dock) => useOsrNetworkStore.getState().setDock(board.id, dock)}
            url={board.url}
            onEditUrl={onEditUrl}
          />,
          inspectorSlot
        )}
      <BoardFrame
        type="browser"
        boardId={board.id}
        title={board.title}
        selected={selected}
        hovered={hovered}
        dimmed={dimmed}
        status={status}
        contentBg="var(--surface)"
        actions={<ViewportControl value={board.viewport} onChange={setViewport} />}
        onFull={onFull}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onAddToGroup={onAddToGroup}
        onRemoveFromGroup={onRemoveFromGroup}
        onRemoveFromAllGroups={onRemoveFromAllGroups}
        onStartConnect={onStartConnect}
      >
        {/* URL / route bar (DESIGN.md §7.2) — pinned to the top of the content slot. */}
        <div className="bb-urlbar" style={{ height: URLBAR_H }}>
          {/* D0-2: interactive cluster at rest — faint is disabled-only */}
          <div style={{ display: 'flex', gap: 2, color: 'var(--text-3)' }}>
            <NavBtn
              name="back"
              title="Back"
              disabled={!runtime.canGoBack}
              onClick={() => void window.api.goBackOsrPreview(board.id)}
            />
            <NavBtn
              name="forward"
              title="Forward"
              disabled={!runtime.canGoForward}
              onClick={() => void window.api.goForwardOsrPreview(board.id)}
            />
            <NavBtn
              name="refresh"
              title="Reload"
              onClick={() => void window.api.reloadOsrPreview(board.id)}
            />
            {/* 4A — audio control (mute + volume), shown only while the preview is playing media. */}
            {osrAudibleNow && <OsrVolumeControl boardId={board.id} />}
            <NavBtn
              name="camera"
              title="Screenshot"
              // The screenshot IPC captures the offscreen window's last painted frame. Enable once
              // the board can be captured: connected AND not evicted (over the MAX_LIVE cap).
              disabled={runtime.status !== 'connected' || !osrAlive}
              onClick={takeScreenshot}
            />
            <NavBtn name="external" title="Open in browser" onClick={openExternal} />
            {/* DevTools Network inspector toggle — accent when the panel is open. */}
            <button
              title="Network inspector"
              aria-label="Network inspector"
              aria-pressed={netOpen}
              onClick={toggleNet}
              onMouseDown={(e) => e.stopPropagation()}
              className={'bb-navbtn' + (netOpen ? ' bb-navbtn-on' : '')}
              style={{ cursor: 'pointer' }}
            >
              <Icon name="activity" size={14} />
            </button>
          </div>
          <div
            className={
              'bb-url-field' +
              (urlError ? ' bb-url-invalid' : '') +
              (urlFlash ? ' bb-url-flash' : '')
            }
          >
            {/* D0-6 (A9): the dot is color-only — D2-C pairs it with an ALWAYS-VISIBLE
              status word (Linear pattern, colorblind-safe) plus the polite live
              region announcing transitions. The word IS the accessible label (no
              aria-hidden): a screen reader navigating here in a static state reads
              it directly; the live region only speaks transitions. An evicted board
              reads "paused" — its status may still say connected, but the renderer
              (and the page state) is gone until a live slot frees. */}
            <span
              className="bb-conn-dot"
              aria-hidden
              style={{ background: paused ? 'var(--text-3)' : connDot(runtime.status) }}
            />
            <span className="bb-conn-word">{paused ? 'paused' : connWord(runtime.status)}</span>
            <span className="sr-only" role="status" aria-live="polite">
              {srConn}
            </span>
            <input
              ref={urlInputRef}
              className="bb-url-input"
              value={draftUrl}
              spellCheck={false}
              // PREV-04 (a11y): the field has no visible <label>, so name it; flag the invalid state
              // for AT when the committed draft failed the scheme/host check (mirrors .bb-url-invalid).
              aria-label="Preview URL"
              aria-invalid={urlError ? true : undefined}
              onMouseDown={(e) => e.stopPropagation()}
              onFocus={() => {
                setEditingUrl(true)
                urlDirty.current = false
              }}
              onChange={(e) => {
                urlDirty.current = true
                setUrlError(null) // re-validate on the next commit attempt
                setDraftUrl(e.target.value)
              }}
              onBlur={() => {
                setEditingUrl(false)
                commitUrl()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  ;(e.target as HTMLInputElement).blur()
                } else if (e.key === 'Escape') {
                  // Discard the edit: blur's commitUrl sees a clean (non-dirty) draft
                  // and re-syncs from board.url instead of committing the typed text.
                  urlDirty.current = false
                  setUrlError(null)
                  setDraftUrl(board.url)
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
          </div>
          {/* D2-C: the inline URL error takes the dims slot — INSIDE the bar's own height,
            keeping all URL-bar feedback in one place rather than over the device stage. */}
          {urlError ? (
            <span className="bb-url-error" role="alert">
              {urlError}
            </span>
          ) : (
            <span className="bb-dims">
              {preset.w} × {preset.h}
            </span>
          )}
        </div>

        {/* Device stage: a hatched backing well + the rounded HTML device frame. The offscreen
          preview canvas fills the frame's inner area; the connecting/failed/crashed states sit
          UNDER it as the fallback layer. In full view the stage centres the frame so the
          letterbox (hatched backing) shows around an aspect-correct emulator. */}
        <div
          className="bb-stage"
          style={
            netOpen
              ? {
                  top: URLBAR_H,
                  display: 'flex',
                  flexDirection: netDock === 'right' ? 'row' : 'column'
                }
              : fullView
                ? // COLUMN, not a centred row: `.bb-stage-main`'s `flex:1 1 0` then grows the MAIN
                  // axis (height) to a DEFINITE size, so the emulator `.bb-frame { height:100% }`
                  // resolves instead of collapsing against an indefinite (align-items:center) height —
                  // the full-screen blank that only "appeared" once the Network panel was opened (the
                  // panel makes `.bb-stage` a column, which is what fixed it). `.bb-stage-main` keeps
                  // its own center alignment, so the emulator is still centred + letterboxed.
                  { top: URLBAR_H, display: 'flex', flexDirection: 'column' }
                : { top: URLBAR_H }
          }
        >
          {/* Browser region — a STABLE wrapper (never conditionally unmounted, so the offscreen
            <canvas> never remounts + the preview never reconnects). When the inspector is open
            (B3 split) or in full view it flexes + centres the emulator frame; otherwise it is a
            passthrough for the on-canvas absolute device-frame rect. */}
          <div
            className="bb-stage-main"
            style={
              fullView || netOpen
                ? {
                    position: 'relative',
                    flex: '1 1 0',
                    minWidth: 0,
                    minHeight: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }
                : { position: 'absolute', inset: 0 }
            }
          >
            <div
              className="bb-frame"
              data-bb-frame={board.id}
              // In full view (or when the inspector splits the stage, B3) the frame is an EMULATOR:
              // sized to the preset's ASPECT RATIO (height/width-bound, centred, letterboxed) within
              // its region rather than the board-geometry rect. The offscreen canvas fills it and
              // useOffscreenSizing reflows the page to the preset width, so the scale stays uniform.
              // On canvas with the panel closed it keeps the fitted device-box rect.
              style={
                fullView || netOpen
                  ? {
                      position: 'relative',
                      height: '100%',
                      width: 'auto',
                      aspectRatio: `${preset.w} / ${preset.h}`,
                      maxWidth: '100%',
                      maxHeight: '100%',
                      borderRadius: preset.radius
                    }
                  : {
                      left: frame.x,
                      top: frameTopInStage,
                      width: frame.width,
                      height: frame.height,
                      borderRadius: preset.radius
                    }
              }
            >
              {preset.notch && <div className="bb-notch" />}
              <DeviceContent
                runtime={runtime}
                url={board.url}
                willRetry={willRetry}
                onReload={reloadCrashed}
              />
              {/* Offscreen-rendered frames paint here, OVER the connecting/failed/crashed state
              fallback. A normal DOM <canvas> clips/rounds with .bb-frame (the occlusion fix).
              When the preview isn't connected the canvas is blank and has nothing to forward, so
              it must NOT intercept the state layer's CTAs (e.g. the crashed Reload button) — drop
              its pointer events off the connected path. */}
              <canvas
                ref={osrCanvasRef}
                className="bb-live nowheel nodrag"
                style={runtime.status === 'connected' ? undefined : { pointerEvents: 'none' }}
              />
              {/* The hidden proxy <textarea> is the keyboard/IME/clipboard target (Phase 3) —
              invisible + click-through, focused programmatically on canvas pointerdown. */}
              <textarea
                ref={osrProxyRef}
                className="bb-ime-proxy nowheel nodrag"
                aria-hidden="true"
                tabIndex={-1}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {/* OS-3 Phase 4: native-widget chrome (JS dialog modal · <select>/date/color overlay)
              the offscreen bitmap can't composite. A DOM layer → clips/rounds with the frame. */}
              <OsrWidgetLayer boardId={board.id} pageW={preset.w} pageH={preset.h} />
              {/* OS-3 Phase 2 (2B): an evicted (over-cap) board's renderer is freed — its last frame
              stays frozen on the canvas, so flag it "paused" until a live slot frees. */}
              {paused && <span className="bb-paused-badge">paused</span>}
            </div>
          </div>
          {/* DevTools Network inspector — a flex SIBLING of the browser region (B3): it splits the
            stage instead of overlaying, so the browser stays fully visible. Bottom drawer / right
            dock per the in-header switch. */}
          <OsrNetworkPanel boardId={board.id} onFullView={onFull} paused={paused} />
        </div>
      </BoardFrame>
    </>
  )
}

/** A 24x24 URL-bar nav button (back/forward/reload/camera/external). The Phase-4 audio control is
 *  its own component (OsrVolumeControl). */
function NavBtn({
  name,
  title,
  disabled = false,
  onClick
}: {
  name: 'back' | 'forward' | 'refresh' | 'camera' | 'external'
  title: string
  disabled?: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      className="bb-navbtn"
      style={{ opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' }}
    >
      <Icon name={name} size={name === 'refresh' ? 13 : 14} />
    </button>
  )
}

/** The fallback layer UNDER the offscreen preview canvas: connecting, load-failed, or
 *  crashed (D2-C). The canvas (blank until connected) paints over this once frames arrive. */
function DeviceContent({
  runtime,
  url,
  willRetry,
  onReload
}: {
  runtime: ReturnType<ReturnType<typeof selectRuntime>>
  url: string
  willRetry: boolean
  onReload: () => void
}): ReactElement {
  if (runtime.status === 'crashed') {
    return (
      <div className="bb-state">
        <div className="bb-state-title" style={{ color: 'var(--err)' }}>
          Preview crashed
        </div>
        <div className="bb-state-sub">{runtime.error || url}</div>
        <button
          className="bb-reload-btn"
          onClick={onReload}
          onMouseDown={(e) => e.stopPropagation()}
        >
          Reload
        </button>
      </div>
    )
  }
  if (runtime.status === 'load-failed') {
    return (
      <div className="bb-state">
        <div className="bb-state-title" style={{ color: 'var(--err)' }}>
          Couldn’t load
        </div>
        <div className="bb-state-sub">
          {willRetry ? 'Reconnecting… · ' : ''}
          {runtime.error || url}
        </div>
      </div>
    )
  }
  // Connecting / idle (first open, before the canvas paints): a calm placeholder under the canvas.
  return (
    <div className="bb-state">
      <div className="bb-state-title">{runtime.status === 'connecting' ? 'Connecting…' : ''}</div>
      <div className="bb-state-sub">{url}</div>
    </div>
  )
}

/** Connection dot colour for the URL field. */
function connDot(status: ReturnType<ReturnType<typeof selectRuntime>>['status']): string {
  if (status === 'connected') return 'var(--ok)'
  if (status === 'load-failed' || status === 'crashed') return 'var(--err)'
  if (status === 'connecting') return 'var(--warn)'
  return 'var(--text-3)'
}

/** D0-6 (A9) / D2-C: the dot's meaning as a word — visible label + live-region text. */
function connWord(status: ReturnType<ReturnType<typeof selectRuntime>>['status']): string {
  if (status === 'connected') return 'connected'
  if (status === 'load-failed') return 'failed to load'
  if (status === 'crashed') return 'crashed'
  if (status === 'connecting') return 'connecting'
  return 'not connected'
}
