/**
 * Browser board content (Phase 2.2, DESIGN.md §7.2) — a responsive preview of the
 * user's running localhost app in a device frame.
 *
 * The live page is a native `WebContentsView` positioned by `BrowserPreviewLayer`
 * (the store-driven PreviewManager mounted inside <ReactFlow>). A native view CANNOT
 * be clipped/rounded/z-indexed against HTML (ADR 0002), so EVERYTHING this component
 * draws is HTML chrome laid out AROUND an unrounded native rect:
 *   - the rounded device frame (border + inset shadow + mobile notch),
 *   - the URL/route bar (back/forward/reload + editable URL + connected dot + WxH),
 *   - the viewport segmented control (Mobile/Tablet/Desktop) in the title-bar slot.
 * The device-frame geometry mirrors `lib/browserLayout` EXACTLY so the HTML frame
 * lines up with the native rect at every camera zoom.
 *
 * The native view paints OVER the device-stage area; underneath it this component
 * renders the snapshot fallback (motion / LOD / over-cap) and the connecting /
 * load-failed states (read from `previewStore`). Durable props (`url`, `viewport`)
 * persist on the board via `canvasStore.updateBoard`.
 *
 * Security: this never touches the PTY. URL edits + nav go through the additive
 * `preview:*` control channel to the view's OWN webContents only.
 */
import { useState, useRef, useEffect, type ReactElement } from 'react'
import type { BrowserBoard as BrowserBoardData, BrowserViewport } from '../../lib/boardSchema'
import { VIEWPORT_PRESETS, deviceFrameRect, TITLEBAR_H, URLBAR_H } from '../../lib/browserLayout'
import { BoardFrame } from '../BoardFrame'
import { Icon } from '../Icon'
import { useCanvasStore } from '../../store/canvasStore'
import { usePreviewStore, selectRuntime } from '../../store/previewStore'
import { boardStatusBucket, bucketToPill } from '../../store/boardStatus'
import type { BoardViewProps } from '../BoardNode'
import { isHttpUrl } from '../../lib/autoConnect'

const VIEWPORTS: BrowserViewport[] = ['mobile', 'tablet', 'desktop']
const VP_ICON: Record<BrowserViewport, 'mobile' | 'tablet' | 'desktop'> = {
  mobile: 'mobile',
  tablet: 'tablet',
  desktop: 'desktop'
}
const VP_LABEL: Record<BrowserViewport, string> = {
  mobile: 'Mobile',
  tablet: 'Tablet',
  desktop: 'Desktop'
}

/** One segment of the viewport control (icon; active also shows the label). */
function VpToggle({
  vp,
  active,
  onClick
}: {
  vp: BrowserViewport
  active: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      title={VP_LABEL[vp]}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        height: 22,
        padding: '0 8px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        background: active ? 'var(--accent-wash)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-3)',
        fontSize: 11,
        fontWeight: 500,
        fontFamily: 'var(--ui)'
      }}
    >
      <Icon name={VP_ICON[vp]} size={13} />
      {active && <span>{VP_LABEL[vp]}</span>}
    </button>
  )
}

/** Viewport segmented control (title-bar actions slot). */
function ViewportControl({
  value,
  onChange
}: {
  value: BrowserViewport
  onChange: (vp: BrowserViewport) => void
}): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        padding: 2,
        marginRight: 2,
        background: 'var(--inset)',
        borderRadius: 6,
        border: '1px solid var(--border-subtle)'
      }}
    >
      {VIEWPORTS.map((vp) => (
        <VpToggle key={vp} vp={vp} active={vp === value} onClick={() => onChange(vp)} />
      ))}
    </div>
  )
}

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
  onStartConnect
}: BoardViewProps<BrowserBoardData>): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const beginChange = useCanvasStore((s) => s.beginChange)
  const runtime = usePreviewStore(selectRuntime(board.id))
  const preset = VIEWPORT_PRESETS[board.viewport]

  // Editable URL: a local draft committed on Enter / blur. When the durable
  // board.url changes underneath (e.g. set elsewhere), re-sync the draft DURING
  // render via the "adjust state on prop change" pattern (no effect → no cascading
  // render; https://react.dev/learn/you-might-not-need-an-effect).
  const [draftUrl, setDraftUrl] = useState(board.url)
  const [lastUrl, setLastUrl] = useState(board.url)
  const [note, setNote] = useState<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  if (board.url !== lastUrl) {
    setLastUrl(board.url)
    setDraftUrl(board.url)
  }

  // Clear the note timer on unmount to prevent setState-after-unmount.
  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current)
    },
    []
  )

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
    if (!next || next === board.url) {
      setDraftUrl(board.url)
      return
    }
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

  const openExternal = (): void => {
    void window.api
      .openExternalPreview(runtime.liveUrl ?? board.url)
      .then((ok) => {
        if (!ok) showNote('Cannot open that URL in a browser')
      })
      // D0-5: an IPC rejection (teardown race, channel gone) was silent before.
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('openExternalPreview failed', err)
        showNote('Cannot open that URL in a browser')
      })
  }

  const showNote = (msg: string): void => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
    setNote(msg)
    noteTimer.current = setTimeout(() => setNote(null), 2500)
  }

  const takeScreenshot = (): void => {
    void (async () => {
      // D0-5: the IPC can also REJECT (capture race, channel teardown) — without the
      // catch that path was a silent no-op while the success/false branches spoke.
      try {
        const res = await window.api.screenshotPreview(board.id)
        if (!res.ok) showNote('Open the preview to screenshot it')
        else if (res.assetId) showNote('Screenshot copied + saved to assets/')
        else showNote('Screenshot copied to clipboard')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('screenshotPreview failed', err)
        showNote('Screenshot failed — try again')
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

  return (
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
            onClick={() => void window.api.goBackPreview(board.id)}
          />
          <NavBtn
            name="forward"
            title="Forward"
            disabled={!runtime.canGoForward}
            onClick={() => void window.api.goForwardPreview(board.id)}
          />
          <NavBtn
            name="refresh"
            title="Reload"
            onClick={() => void window.api.reloadPreview(board.id)}
          />
          <NavBtn
            name="camera"
            title="Screenshot"
            disabled={!runtime.live}
            onClick={takeScreenshot}
          />
          <NavBtn name="external" title="Open in browser" onClick={openExternal} />
        </div>
        <div className="bb-url-field">
          {/* D0-6 (A9): the dot is color-only — pair it with a hover word and a polite
              live region so connection-state changes are announced. */}
          <span
            className="bb-conn-dot"
            title={connWord(runtime.status)}
            style={{ background: connDot(runtime.status) }}
          />
          <span className="sr-only" role="status" aria-live="polite">
            {srConn}
          </span>
          <input
            className="bb-url-input"
            value={draftUrl}
            spellCheck={false}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => setDraftUrl(e.target.value)}
            onBlur={commitUrl}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                setDraftUrl(board.url)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
        </div>
        <span className="bb-dims">
          {preset.w} × {preset.h}
        </span>
      </div>

      {/* Device stage: a hatched backing well + the rounded HTML device frame. The
          native view paints over the frame's inner area; the snapshot + states sit
          UNDER it as the fallback layer. In full view the stage centres the frame so the
          letterbox (hatched backing) shows around an aspect-correct emulator. */}
      <div
        className="bb-stage"
        style={
          fullView
            ? { top: URLBAR_H, display: 'flex', alignItems: 'center', justifyContent: 'center' }
            : { top: URLBAR_H }
        }
      >
        <div
          className="bb-frame"
          data-bb-frame={board.id}
          // In full view the frame is an EMULATOR: the board is portaled out of the
          // camera-scaled canvas, so board-geometry sizing no longer applies. Size it to
          // the preset's ASPECT RATIO (height-bound, centred, letterboxed) rather than
          // stretching it edge-to-edge — a Mobile/Tablet preview then renders as a
          // bigger phone/tablet, not a blown-up landscape. The native view binds to this
          // element's live DOM rect (fullViewBoundsFor); fitZoomFactorForBounds keeps the
          // held preset width filling that rect, so the scale stays uniform (no stretch).
          // On canvas it keeps the fitted device box.
          style={
            fullView
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
          <DeviceContent runtime={runtime} url={board.url} willRetry={willRetry} />
        </div>
      </div>
      {/* Screenshot / open-external feedback toast. Rendered OUTSIDE .bb-stage so the
          native WebContentsView (which paints above all HTML inside .bb-stage) does not
          occlude it. The .ca-preview-note CSS (position:absolute; top:8px; z-index:4)
          anchors this relative to the BoardFrame content div, placing it in the
          URL-bar / title-bar zone that is pure HTML and never overlaid by a native view.
          ADR 0002. */}
      {note && (
        <div className="ca-preview-note" role="status" onMouseDown={(e) => e.stopPropagation()}>
          {note}
          <button className="ca-preview-dismiss" onClick={() => setNote(null)}>
            Dismiss
          </button>
        </div>
      )}
    </BoardFrame>
  )
}

/** A 24x24 URL-bar nav button (back/forward/reload/camera/external). */
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

/** The fallback layer under the native view: snapshot, connecting, or load-failed. */
function DeviceContent({
  runtime,
  url,
  willRetry
}: {
  runtime: ReturnType<ReturnType<typeof selectRuntime>>
  url: string
  willRetry: boolean
}): ReactElement {
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
  if (runtime.snapshot) {
    return <img src={runtime.snapshot} alt="" draggable={false} className="bb-snapshot" />
  }
  // No snapshot yet (first open / off-screen): a calm connecting placeholder.
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
  if (status === 'load-failed') return 'var(--err)'
  if (status === 'connecting') return 'var(--warn)'
  return 'var(--text-3)'
}

/** D0-6 (A9): the dot's meaning as a word — tooltip + live-region text. */
function connWord(status: ReturnType<ReturnType<typeof selectRuntime>>['status']): string {
  if (status === 'connected') return 'connected'
  if (status === 'load-failed') return 'failed to load'
  if (status === 'connecting') return 'connecting'
  return 'not connected'
}
