import { useEffect, useRef, useState, type ReactElement } from 'react'
import { hsvToHex, hexToHsv, normalizeHex } from '../../../lib/osrWidgets'

/**
 * OS-3 Phase 4 (4E) — color picker overlay for a previewed page's `<input type="color">` (no native
 * picker offscreen). Saturation/Value square + hue slider + hex field; OK commits the `#rrggbb` value
 * back via CDP. Esc dismisses. The geometry/colour math is the pure `osrWidgets` helpers.
 */
export function OsrColorPicker({
  value,
  onCommit,
  onDismiss
}: {
  value: string
  onCommit: (hex: string) => void
  onDismiss: () => void
}): ReactElement {
  const initial = hexToHsv(value) ?? { h: 210, s: 0.65, v: 1 }
  const [hsv, setHsv] = useState(initial)
  const [hexText, setHexText] = useState(
    normalizeHex(value) ?? hsvToHex(initial.h, initial.s, initial.v)
  )
  const svRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const apply = (next: { h: number; s: number; v: number }): void => {
    setHsv(next)
    setHexText(hsvToHex(next.h, next.s, next.v))
  }

  // Drag within an element → normalized [0,1] x/y (clamped). Shared by the SV square + hue bar.
  const dragFrom = (
    el: HTMLDivElement | null,
    e: React.PointerEvent,
    onPos: (nx: number, ny: number) => void
  ): void => {
    if (!el) return
    const move = (clientX: number, clientY: number): void => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      onPos(
        Math.max(0, Math.min(1, (clientX - r.left) / r.width)),
        Math.max(0, Math.min(1, (clientY - r.top) / r.height))
      )
    }
    move(e.clientX, e.clientY)
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic event */
    }
    const onMove = (ev: PointerEvent): void => move(ev.clientX, ev.clientY)
    const onUp = (): void => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  const hueColor = `hsl(${Math.round(hsv.h)}, 100%, 50%)`
  const current = hsvToHex(hsv.h, hsv.s, hsv.v)

  return (
    <div
      ref={rootRef}
      className="bb-osr-color"
      tabIndex={0}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          onDismiss()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          onCommit(current)
        }
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        ref={svRef}
        className="bb-osr-sv"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})`
        }}
        onPointerDown={(e) =>
          dragFrom(svRef.current, e, (nx, ny) => apply({ ...hsv, s: nx, v: 1 - ny }))
        }
      >
        <span
          className="bb-osr-sv-knob"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: current }}
        />
      </div>
      <div
        ref={hueRef}
        className="bb-osr-hue"
        onPointerDown={(e) => dragFrom(hueRef.current, e, (nx) => apply({ ...hsv, h: nx * 360 }))}
      >
        <span className="bb-osr-hue-knob" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>
      <div className="bb-osr-color-row">
        <input
          className="bb-osr-hex"
          value={hexText}
          spellCheck={false}
          onChange={(e) => {
            setHexText(e.target.value)
            const hsv2 = hexToHsv(e.target.value)
            if (hsv2) setHsv(hsv2)
          }}
        />
        <span className="bb-osr-sw" style={{ background: current }} />
        <button
          className="bb-osr-btn bb-osr-btn-primary"
          onClick={() => onCommit(current)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          OK
        </button>
      </div>
    </div>
  )
}
