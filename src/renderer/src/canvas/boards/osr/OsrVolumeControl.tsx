/**
 * URL-bar audio control for a Browser board (OS-3 Phase 4 — 4A volume). Replaces the bare mute
 * toggle: the speaker button reflects the current level (full / low / silent) and CLICK OPENS a
 * small popover holding a mute toggle + a 0–100% volume slider (the signed-off interaction).
 *
 * State is ephemeral, per board (`osrWidgetStore`) — never serialized. Mute uses the existing
 * `setOsrMuted` path (webContents.setAudioMuted); volume uses `setOsrVolume`, which MAIN emulates by
 * injecting `el.volume` onto the page's HTML5 media (Electron OSR exposes no native volume API, so a
 * pure Web Audio stream honors only the mute). Mounted only while the page is playing media.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { Icon } from '../../Icon'
import { useOsrWidgetStore } from '../../../store/osrWidgetStore'
import { volumeIcon } from '../../../lib/osrVolume'

export function OsrVolumeControl({ boardId }: { boardId: string }): ReactElement {
  const muted = useOsrWidgetStore((s) => s.muted[boardId] ?? false)
  const volume = useOsrWidgetStore((s) => s.volume[boardId] ?? 1)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sliderId = useId()

  const toggleMute = useCallback((): void => {
    const next = !muted
    useOsrWidgetStore.getState().setMuted(boardId, next)
    void window.api.setOsrMuted(boardId, next)
  }, [boardId, muted])

  const setVolume = useCallback(
    (v: number): void => {
      const clamped = v < 0 ? 0 : v > 1 ? 1 : v
      useOsrWidgetStore.getState().setVolume(boardId, clamped)
      void window.api.setOsrVolume(boardId, clamped)
    },
    [boardId]
  )

  // Close the popover on outside pointerdown / Escape (only while open).
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const icon = volumeIcon({ muted, volume })
  const pct = Math.round(volume * 100)

  return (
    <div ref={wrapRef} className="bb-vol" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={'bb-navbtn' + (open ? ' bb-navbtn-on' : '')}
        title="Audio"
        aria-label="Audio volume"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={icon} size={14} />
      </button>
      {open && (
        <div
          className="bb-vol-popover"
          role="dialog"
          aria-label="Audio volume"
          data-test="bb-vol-popover"
        >
          <button
            type="button"
            className={'bb-navbtn' + (muted ? ' bb-navbtn-on' : '')}
            title={muted ? 'Unmute' : 'Mute'}
            aria-label={muted ? 'Unmute' : 'Mute'}
            aria-pressed={muted}
            data-test="bb-vol-mute"
            onClick={toggleMute}
          >
            <Icon name={icon} size={14} />
          </button>
          <input
            id={sliderId}
            className="bb-vol-slider"
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct}
            aria-label="Volume"
            aria-valuetext={`${pct}%`}
            data-test="bb-vol-slider"
            onChange={(e) => setVolume(Number(e.target.value) / 100)}
          />
          <span className="bb-vol-pct" aria-hidden>
            {pct}%
          </span>
        </div>
      )}
    </div>
  )
}
