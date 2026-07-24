import { useEffect, useState } from 'react'
import { useSwitchMetricsStore, bucketOf, type SwitchBucket } from '../store/switchMetrics'

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

export default function DiagOverlay() {
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
      <Row label="heap" value={sample.heapMb === null ? '—' : `${fmt(sample.heapMb)} MB`} />
      <SwitchRows />
    </div>
  )
}

/** Human duration: sub-second reads in whole ms, past a second in seconds. Switch latencies
 *  straddle that boundary, and "1240 ms" is harder to bucket at a glance than "1.24 s". */
const dur = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`

/**
 * Last project switch, segmented (audit R1). Renders nothing until a switch has been measured, so
 * the overlay stays three rows tall on boot rather than showing a block of em-dashes.
 *
 * Only `switch` (the headline) and `arm` (the segment with a stated budget — PS-1/R3) are tinted.
 * `load` and `paint` are diagnostic breakdown; colouring every row turns the overlay into a
 * traffic light and violates the design reference's "one accent, functional only".
 */
function SwitchRows() {
  const last = useSwitchMetricsStore((s) => s.last)
  if (last === null) return null
  return (
    <>
      <div style={ruleStyle} />
      <Row
        label="switch"
        value={last.total === null ? '—' : dur(last.total)}
        tone={bucketOf(last.total)}
      />
      {last.arm !== null && (
        <Row label="arm" value={dur(last.arm)} tone={bucketOf(last.arm)} indent />
      )}
      {last.load !== null && <Row label="load" value={dur(last.load)} indent />}
      {last.paint !== null && <Row label="paint" value={dur(last.paint)} indent />}
      {/* Only when a dialog actually appeared. Shown so the exclusion from `switch`/`arm` is
          visible — a silently-subtracted number is one nobody can audit. */}
      {last.ask !== null && <Row label="ask" value={dur(last.ask)} indent />}
    </>
  )
}

/** Bucket → token. Buckets come from the NN/g response-time limits (see `switchMetrics`). */
const toneColor: Record<SwitchBucket, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  err: 'var(--err)'
}

function Row({
  label,
  value,
  tone,
  indent
}: {
  label: string
  value: string
  tone?: SwitchBucket | null
  indent?: boolean
}) {
  return (
    <div style={rowStyle}>
      <span style={indent === true ? indentLabelStyle : labelStyle}>{label}</span>
      <span style={tone == null ? valueStyle : { ...valueStyle, color: toneColor[tone] }}>
        {value}
      </span>
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

/** Sub-segments sit under their total. `paddingLeft` rather than a nested container so the
 *  space-between row layout still right-aligns every value on the same edge. */
const indentLabelStyle: React.CSSProperties = {
  color: 'var(--text-3)',
  paddingLeft: 8
}

/** Hairline between the frame stats and the switch block. */
const ruleStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border-subtle)',
  margin: '4px 0'
}

const valueStyle: React.CSSProperties = {
  color: 'var(--text)'
}
