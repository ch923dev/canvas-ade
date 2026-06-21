import { useEffect, useRef, useState } from 'react'
import { formatTimer } from '../terminalState'

/**
 * TERM-01: the elapsed run timer for the status pill. Returns a `mm:ss` string while
 * `running` (counting from the rising edge of running), or `undefined` otherwise. The
 * start instant is captured in a ref when running flips true; the displayed seconds are
 * advanced only by the 1s interval callback (off the wall clock, so a throttled tab
 * catches up rather than drifts) and reset in the effect cleanup when running flips
 * false — so a restart counts from `00:00` again with no synchronous setState in the
 * effect body. Tiny and isolated — the host just passes the result into
 * `statusFor(state, identity, timer)`.
 */
export function useRunTimer(running: boolean): string | undefined {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(0)
  useEffect(() => {
    if (!running) return
    startRef.current = Date.now()
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => {
      clearInterval(id)
      setElapsed(0) // cleanup (not effect body) → next run starts fresh, no stale flash
    }
  }, [running])
  return running ? formatTimer(elapsed) : undefined
}
