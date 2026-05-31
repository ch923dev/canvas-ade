/**
 * Full-view modal: a fullscreen overlay over a 66%-black scrim with an accent-ringed
 * frame and a portal host that the matching board relocates its live content into. A
 * §6.1 top band (`FULL VIEW` label + `✕ Esc` exit) sits above the host; the relocated
 * board also keeps its own title bar (whose maximize ⤢ toggles full view off). Does NOT
 * move the camera. Closes on the band ✕, the board's maximize toggle, Esc, or a scrim
 * click. Renders the host immediately and publishes it on mount so the BoardNode can
 * portal into it the same frame.
 *
 * Motion (Slice 5 / §9): mounts in the closed state, then flips `open` on the next frame
 * so the CSS transition runs scrim opacity 0→1 + frame scale(.98→1). On `closing` it
 * reverses, then fires `onExited` so the parent unmounts only AFTER the fade — clearing
 * `fullViewId` earlier would relocate the live subtree back to canvas mid-fade and tear
 * the session. Lifecycle callbacks are timer-driven (not `transitionend`, which never
 * fires under reduced-motion). Reduced-motion collapses the timers + CSS to instant.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { CAMERA_MS, prefersReducedMotion } from '../lib/motion'

export function FullViewModal({
  closing,
  onClose,
  onEntered,
  onExited,
  onHost
}: {
  /** Parent requests the exit animation; the modal plays it then calls onExited. */
  closing: boolean
  /** A user-initiated close (band ✕ or scrim click) — parent starts the exit. */
  onClose: () => void
  /** Enter tween settled — parent drops `entering` so the native view can attach. */
  onEntered: () => void
  /** Exit tween settled — parent clears `fullViewId` (unmounts + relocates back). */
  onExited: () => void
  onHost: (el: HTMLElement | null) => void
}): ReactElement {
  const [hostEl, setHostEl] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    onHost(hostEl)
    return () => onHost(null)
  }, [hostEl, onHost])

  // Enter: mount closed → flip `open` next frame so the transition runs from the closed
  // values; signal settle after the duration (reduced-motion → instant).
  useEffect(() => {
    const dur = prefersReducedMotion() ? 0 : CAMERA_MS
    const raf = requestAnimationFrame(() => setOpen(true))
    const t = setTimeout(onEntered, dur + 16)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [onEntered])

  // Exit: parent flips `closing` → play the reverse tween, then unmount via onExited.
  useEffect(() => {
    if (!closing) return
    const dur = prefersReducedMotion() ? 0 : CAMERA_MS
    const raf = requestAnimationFrame(() => setOpen(false))
    const t = setTimeout(onExited, dur + 16)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [closing, onExited])

  return (
    <div
      className="fullview-scrim"
      data-open={open ? '' : undefined}
      onMouseDown={(e) => {
        // Only a click on the scrim itself (not the frame) closes.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="fullview-frame" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fullview-band">
          <span className="fullview-label">Full view</span>
          <button className="fullview-close" onClick={onClose} title="Close (Esc)">
            ✕ Esc
          </button>
        </div>
        <div className="fullview-host" ref={setHostEl} />
      </div>
    </div>
  )
}
