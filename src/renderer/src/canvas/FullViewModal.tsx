/**
 * Full-view modal: a fullscreen overlay over a 66%-black scrim with an accent-ringed
 * frame and a portal host that the matching board relocates its live content into. No
 * header band — the relocated board keeps its own title bar, whose maximize (⤢) button
 * toggles full view back off. Does NOT move the camera. Closes on the board's maximize
 * toggle, Esc, or a scrim click. Renders the host immediately and publishes it on mount
 * so the BoardNode can portal into it the same frame.
 */
import { useEffect, useState, type ReactElement } from 'react'

export function FullViewModal({
  onClose,
  onHost
}: {
  onClose: () => void
  onHost: (el: HTMLElement | null) => void
}): ReactElement {
  const [hostEl, setHostEl] = useState<HTMLElement | null>(null)

  useEffect(() => {
    onHost(hostEl)
    return () => onHost(null)
  }, [hostEl, onHost])

  return (
    <div
      className="fullview-scrim"
      onMouseDown={(e) => {
        // Only a click on the scrim itself (not the frame) closes.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="fullview-frame" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fullview-host" ref={setHostEl} />
      </div>
    </div>
  )
}
