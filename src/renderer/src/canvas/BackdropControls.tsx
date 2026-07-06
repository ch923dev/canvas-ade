/**
 * Backdrop controls — the source rows (None · Wallpaper…), the tier-grouped scene gallery, and the
 * dim / saturation / grid knobs. Extracted from BackdropPicker so the SAME controls render two ways:
 *   • inside the camera-cluster <Menu> popover (the toolbar picker), and
 *   • inline in Settings › Project › Appearance (a `.bd-inline` container, NO floating menu — so the
 *     wide gallery can never overflow the Settings modal horizontally the way the popover did).
 *
 * All state flows through useCanvasStore `background` / `setBackground` (persisted by the debounced
 * autosave); the gallery derives from the registry (listScenes) with no per-scene wiring. Import caps
 * + accept list mirror the spec (30MB image / 200MB video — Blob URLs hold the whole file in memory).
 * The range/segment rows stop keydown propagation so the popover's roving-arrow handler never steals
 * the range keys (a no-op inline, harmless).
 */
import { useRef, type ChangeEvent, type ReactElement } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import {
  BACKGROUND_DIM_RANGE,
  BACKGROUND_SATURATION_RANGE,
  DEFAULT_BACKGROUND_DIM,
  DEFAULT_BACKGROUND_SATURATION,
  type GridStyle
} from '../lib/boardSchema'
import { showToast } from '../store/toastStore'
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
/** Grid-on-top lattice options (PR 4). 'off' ⇒ gridDots:false; a style ⇒ gridDots:true + gridStyle. */
const GRID_SEGMENTS: ReadonlyArray<{ key: 'off' | GridStyle; label: string }> = [
  { key: 'off', label: 'Off' },
  { key: 'dots', label: 'Dots' },
  { key: 'lines', label: 'Lines' },
  { key: 'cross', label: 'Cross' }
]

export function BackdropControls(): ReactElement {
  const fileRef = useRef<HTMLInputElement>(null)
  const background = useCanvasStore((s) => s.background)
  const setBackground = useCanvasStore((s) => s.setBackground)

  const kind = background?.kind ?? 'none'
  const enabled = kind !== 'none'
  const dim = background?.dim ?? DEFAULT_BACKGROUND_DIM
  const saturation = background?.saturation ?? DEFAULT_BACKGROUND_SATURATION
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
    // Caller fires-and-forgets — an unguarded rejection here (fd gone between dialog close and read,
    // IPC failure) would be swallowed silently.
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
    // Re-picking replaces the reference; the old asset stays in the content-addressed store.
    setBackground({ kind: 'file', assetId: res.assetId })
  }

  const onFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0]
    e.target.value = '' // same-file re-pick must fire change again
    if (f) void importFile(f)
  }

  /** Stop range/segment keys (arrows, space) from reaching the popover's roving handler. */
  const stopKeys = (e: React.KeyboardEvent): void => e.stopPropagation()

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        style={{ display: 'none' }}
        onChange={onFileChange}
        data-test="backdrop-file-input"
      />
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
      {/* Tier-grouped scene gallery — each tile is the SceneDef.thumb data-URI, derived from the
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
    </>
  )
}
