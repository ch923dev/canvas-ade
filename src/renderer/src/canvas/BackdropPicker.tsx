/**
 * Backdrop picker — camera-cluster popover (docs/canvas-backdrop/spec.md §3).
 * Sibling of the Tidy picker, rendered through the shared <Menu> shell (D1-C):
 * body portal + viewport clamp, Esc/outside/resize close, and the ADR 0002
 * detach-live-previews-while-open token come free.
 *
 * Source rows: None · bundled scenes (sceneRegistry — empty until PR 2) ·
 * Wallpaper… (file input → asset:write → background.assetId). Sliders + the grid
 * segment (Off · Dots · Lines · Cross, PR 4) apply LIVE via setBackground (persisted
 * by the debounced autosave) and are enabled only when a source is active. Import caps
 * (spec §6): 30MB image / 200MB video — Blob URLs hold the whole file in memory.
 * Slider/segment rows stop keydown propagation so the Menu shell's roving arrows never
 * steal the range keys (they are deliberately NOT role=menuitem; keyboard reach is a
 * recorded follow-up).
 */
import { useRef, useState, type ChangeEvent, type ReactElement } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import {
  BACKGROUND_DIM_RANGE,
  BACKGROUND_SATURATION_RANGE,
  DEFAULT_BACKGROUND_DIM,
  DEFAULT_BACKGROUND_SATURATION,
  type GridStyle
} from '../lib/boardSchema'
import { showToast } from '../store/toastStore'
import { Menu } from './Menu'
import { Icon } from './Icon'
import { listScenes, type SceneDef } from './backdrop/sceneRegistry'
import { IMAGE_EXTS, VIDEO_EXTS } from './backdrop/acceptExts'

export const IMAGE_CAP_BYTES = 30 * 1024 * 1024
export const VIDEO_CAP_BYTES = 200 * 1024 * 1024
/** Accept list shared with useBackdropMedia + drift-guarded against MAIN (acceptExts). */
const ACCEPT = [...IMAGE_EXTS, ...VIDEO_EXTS].map((e) => `.${e}`).join(',')
/** Gallery section order (addendum §3): ambient = subtle, scenic = wallpaper-grade. */
const TIERS: ReadonlyArray<{ tier: SceneDef['tier']; label: string }> = [
  { tier: 'ambient', label: 'Ambient' },
  { tier: 'scenic', label: 'Scenic' }
]
/** Grid-on-top lattice options (PR 4). 'off' hides the grid; the three styles map
 *  1:1 to React Flow BackgroundVariants. 'off' ⇒ gridDots:false; a style ⇒
 *  gridDots:true + gridStyle. One segmented control replaces the old on/off checkbox. */
const GRID_SEGMENTS: ReadonlyArray<{ key: 'off' | GridStyle; label: string }> = [
  { key: 'off', label: 'Off' },
  { key: 'dots', label: 'Dots' },
  { key: 'lines', label: 'Lines' },
  { key: 'cross', label: 'Cross' }
]

export function BackdropPicker(): ReactElement {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const background = useCanvasStore((s) => s.background)
  const setBackground = useCanvasStore((s) => s.setBackground)

  const kind = background?.kind ?? 'none'
  const enabled = kind !== 'none'
  const dim = background?.dim ?? DEFAULT_BACKGROUND_DIM
  const saturation = background?.saturation ?? DEFAULT_BACKGROUND_SATURATION
  // Selected grid segment: 'off' when the grid is hidden, else the active lattice style.
  const gridSeg: 'off' | GridStyle =
    (background?.gridDots ?? false) ? (background?.gridStyle ?? 'dots') : 'off'
  const selectGrid = (seg: 'off' | GridStyle): void => {
    if (seg === 'off') setBackground({ gridDots: false })
    else setBackground({ gridDots: true, gridStyle: seg })
  }

  const importFile = async (file: File): Promise<void> => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const video = VIDEO_EXTS.includes(ext)
    if (!video && !IMAGE_EXTS.includes(ext)) {
      showToast({ id: 'backdrop-import', kind: 'error', message: 'Unsupported backdrop file type' })
      return
    }
    const cap = video ? VIDEO_CAP_BYTES : IMAGE_CAP_BYTES
    if (file.size > cap) {
      showToast({
        id: 'backdrop-import',
        kind: 'error',
        message: `File too large — backdrop ${video ? 'videos' : 'images'} are capped at ${video ? 200 : 30}MB`
      })
      return
    }
    // Caller fires-and-forgets (`void importFile(f)`) — an unguarded rejection here
    // (fd gone between dialog close and read, IPC failure) would be swallowed silently.
    let res: { assetId: string } | { error: string }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      res = await window.api.asset.write(bytes, ext)
    } catch {
      showToast({ id: 'backdrop-import', kind: 'error', message: 'Failed to read backdrop file' })
      return
    }
    if ('error' in res) {
      showToast({
        id: 'backdrop-import',
        kind: 'error',
        message: `Backdrop import failed: ${res.error}`
      })
      return
    }
    // Re-picking replaces the reference; the old asset stays in the content-addressed
    // store (GC out of scope — spec §3).
    setBackground({ kind: 'file', assetId: res.assetId })
  }

  const onFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0]
    e.target.value = '' // same-file re-pick must fire change again
    if (f) void importFile(f)
  }

  /** Stop range/checkbox keys (arrows, space) from reaching the Menu roving handler. */
  const stopKeys = (e: React.KeyboardEvent): void => e.stopPropagation()

  return (
    <div ref={triggerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className="ca-t-ctl bd-trigger"
        title="Backdrop"
        data-active={open || enabled ? '' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="wallpaper" />
      </button>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        style={{ display: 'none' }}
        onChange={onFileChange}
        data-test="backdrop-file-input"
      />
      {open && (
        <Menu
          anchor={triggerRef}
          align="right"
          gap={6}
          label="Backdrop"
          className="bd-menu"
          onClose={() => setOpen(false)}
        >
          <div className="bd-head">Backdrop</div>
          <button
            role="menuitemradio"
            className="bd-row"
            aria-checked={kind === 'none'}
            onClick={() => setBackground({ kind: 'none' })}
          >
            <span className="bd-dot" data-on={kind === 'none' ? '' : undefined} />
            None
          </button>
          <button
            role="menuitemradio"
            className="bd-row"
            aria-checked={kind === 'file'}
            onClick={() => fileRef.current?.click()}
          >
            <span className="bd-dot" data-on={kind === 'file' ? '' : undefined} />
            Wallpaper…
            <span className="bd-tag">choose file</span>
          </button>
          <div className="bd-sep" />
          {/* Tier-grouped scene gallery (PR 3a/3b). Each tile is a menuitemradio; the
              thumbnail is the SceneDef.thumb data-URI, so the gallery derives from the
              registry with no per-scene wiring here. */}
          {TIERS.map(({ tier, label }) => {
            const tierScenes = listScenes().filter((s) => s.tier === tier)
            if (tierScenes.length === 0) return null
            return (
              <div key={tier}>
                <div className="bd-tier">{label}</div>
                <div className="bd-gallery">
                  {tierScenes.map((s) => {
                    const on = kind === 'scene' && background?.scene === s.id
                    return (
                      <button
                        key={s.id}
                        role="menuitemradio"
                        className="bd-tile"
                        aria-checked={on}
                        data-on={on ? '' : undefined}
                        title={s.label}
                        onClick={() => setBackground({ kind: 'scene', scene: s.id })}
                      >
                        <img className="bd-thumb" src={s.thumb} alt="" />
                        <span className="bd-tile-label">{s.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
          <div className="bd-sep" />
          <label className="bd-slider" data-disabled={enabled ? undefined : ''}>
            <span>Dim</span>
            <input
              type="range"
              min={BACKGROUND_DIM_RANGE.min}
              max={BACKGROUND_DIM_RANGE.max}
              step={0.01}
              value={dim}
              disabled={!enabled}
              onKeyDown={stopKeys}
              onChange={(e) => setBackground({ dim: Number(e.target.value) })}
              data-test="backdrop-dim"
            />
            <span className="bd-val">{Math.round(dim * 100)}%</span>
          </label>
          <label className="bd-slider" data-disabled={enabled ? undefined : ''}>
            <span>Saturation</span>
            <input
              type="range"
              min={BACKGROUND_SATURATION_RANGE.min}
              max={BACKGROUND_SATURATION_RANGE.max}
              step={0.01}
              value={saturation}
              disabled={!enabled}
              onKeyDown={stopKeys}
              onChange={(e) => setBackground({ saturation: Number(e.target.value) })}
              data-test="backdrop-saturation"
            />
            <span className="bd-val">{saturation.toFixed(2)}</span>
          </label>
          <div className="bd-grid" data-disabled={enabled ? undefined : ''}>
            <span>Grid</span>
            <div className="bd-seg" role="radiogroup" aria-label="Grid style" onKeyDown={stopKeys}>
              {GRID_SEGMENTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  role="radio"
                  aria-checked={gridSeg === s.key}
                  className="bd-seg-btn"
                  data-on={gridSeg === s.key ? '' : undefined}
                  disabled={!enabled}
                  onClick={() => selectGrid(s.key)}
                  data-test={`backdrop-grid-${s.key}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </Menu>
      )}
    </div>
  )
}
