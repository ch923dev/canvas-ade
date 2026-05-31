import { useEffect, useState } from 'react'

// Chromium exposes a non-standard `performance.memory`; type it minimally so
// the heap read is strict-safe without `@ts-ignore`. Optional everywhere.
interface PerformanceMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}
interface PerformanceWithMemory extends Performance {
  memory?: PerformanceMemory
}

interface DiagOverlayProps {
  /** Live WebContentsView count, fed from the PreviewManager in 1-C+. */
  liveViews: number
}

interface Sample {
  /** Smoothed frame time in ms over the rolling window. */
  ms: number
  /** Derived FPS (1000 / ms), clamped sane. */
  fps: number
  /** Used JS heap in MB, or null when `performance.memory` is absent. */
  heapMb: number | null
}

// Rolling window of recent frame deltas; ~45 frames ≈ 0.75s at 60fps.
const WINDOW = 45
// Throttle the React update to ~5x/sec so the overlay itself stays cheap —
// measuring at full rAF rate, but only committing to state periodically.
const UPDATE_MS = 200

const fmt = (n: number, d = 1): string => n.toFixed(d)

export default function DiagOverlay({ liveViews }: DiagOverlayProps) {
  const [sample, setSample] = useState<Sample>({ ms: 0, fps: 0, heapMb: null })

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let lastCommit = last
    const deltas: number[] = []
    let i = 0
    const perf = performance as PerformanceWithMemory

    const loop = (now: number): void => {
      const dt = now - last
      last = now
      // Fill then overwrite the ring — bounded allocation, no shift().
      if (deltas.length < WINDOW) deltas.push(dt)
      else {
        deltas[i] = dt
        i = (i + 1) % WINDOW
      }

      if (now - lastCommit >= UPDATE_MS) {
        lastCommit = now
        let sum = 0
        for (const d of deltas) sum += d
        const ms = sum / deltas.length
        const heap = perf.memory?.usedJSHeapSize
        setSample({
          ms,
          fps: ms > 0 ? 1000 / ms : 0,
          heapMb: heap === undefined ? null : heap / (1024 * 1024)
        })
      }

      raf = requestAnimationFrame(loop)
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div style={style}>
      <Row label="frame" value={`${fmt(sample.ms)} ms`} />
      <Row label="fps" value={fmt(sample.fps, 0)} />
      <Row label="views" value={String(liveViews)} />
      <Row label="heap" value={sample.heapMb === null ? '—' : `${fmt(sample.heapMb)} MB`} />
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle}>{value}</span>
    </div>
  )
}

const style: React.CSSProperties = {
  position: 'fixed',
  // Top-right: clears React Flow's Controls (bottom-left), MiniMap (bottom-right)
  // and the `.hint` (top-left) so the overlay never overlaps canvas chrome.
  top: 12,
  right: 12,
  zIndex: 50,
  pointerEvents: 'none',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--text-2)',
  background: 'var(--surface-raised)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 6,
  padding: '6px 9px',
  minWidth: 116,
  boxShadow: 'var(--shadow-pop)'
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 16
}

const labelStyle: React.CSSProperties = {
  color: 'var(--text-3)'
}

const valueStyle: React.CSSProperties = {
  color: 'var(--text)'
}
