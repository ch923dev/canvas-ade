import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * TERM-06: send Ctrl-C (SIGINT) to the running agent over the data plane AND give a
 * brief visual confirmation — sending it used to be silent. Returns `interruptSent`
 * (true for ~1.2s after a Ctrl-C; the host uses it to pulse the ⏹ button to its accent
 * state and show a transient "interrupt sent" chip by the pill) and `interrupt` (the
 * action). Calm + in-place — no toast. The flag timer is cleared on re-fire and unmount.
 */
export function useInterruptFeedback(portRef: RefObject<MessagePort | null>): {
  interruptSent: boolean
  interrupt: () => void
} {
  const [interruptSent, setInterruptSent] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )
  const interrupt = useCallback(() => {
    portRef.current?.postMessage({ t: 'input', d: '\x03' })
    setInterruptSent(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setInterruptSent(false), 1200)
  }, [portRef]) // stable hook ref; listed for exhaustive-deps (#98)
  return { interruptSent, interrupt }
}
