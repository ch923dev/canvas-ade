/**
 * PTY dimension bounds — the resize-clamp helpers shared by the spawn-time and adopt-time
 * MessagePort listeners in `pty.ts`. Extracted (2026-07-04, max-lines doctrine) so pty.ts keeps
 * its headroom under the 700 global cap; pure + runtime-free, unit-tested in `pty.test.ts`.
 */

/**
 * Validate terminal resize dimensions before forwarding to ConPTY. Both cols
 * and rows must be positive integers in the range [1, 1000]. This guards both
 * MessagePort listener sites (spawn-time and adopt-time) — a non-integer
 * (80.5), zero, negative, or absurd value must never reach proc.resize().
 * Exported so the unit test targets the real code path used by both listeners.
 */
export function isValidResize(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols > 0 &&
    rows > 0 &&
    cols <= 1000 &&
    rows <= 1000
  )
}

/**
 * BUG-023: clamp a single spawn dimension (cols or rows) to the [1, 1000] range
 * that isValidResize enforces on the resize path. Truncates fractional values
 * before clamping so the result is always an integer in [1, 1000].
 * Exported for unit testing — both spawn-time uses call this helper.
 */
export function clampSpawnDim(value: number, fallback: number): number {
  const v = Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(Math.max(1, v), 1000)
}

/** Renderer→PTY input/resize message over a board's MessagePort. The discriminated
 * union lets the resize branch read cols/rows as plain numbers (no non-null casts);
 * the runtime guards below still defend against malformed/untrusted payloads. */
type PortInputMsg = { t: 'input'; d: string } | { t: 'resize'; cols: number; rows: number }

/** The MessagePortMain surface attachPortInput needs (structural, so this module stays
 *  electron-type-free at runtime and the unit tests keep their plain-object ports). */
interface PortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown
  start(): void
}
/** The IPty slice the forwarder writes to. */
interface ProcLike {
  write(data: string): void
  resize(cols: number, rows: number): void
}

/**
 * Attach the renderer→PTY input/resize forwarder to one MessagePort and start it.
 * This is the SINGLE renderer→PTY write guard, shared by the spawn-time and adopt-time
 * listener sites so the resize clamp (isValidResize) and the swallow-on-exited-pty
 * try/catch live in ONE place. node-pty's write/resize THROW on an exited-but-not-yet-
 * reaped pty; that throw would escape this EventEmitter listener as an uncaughtException
 * → app.exit(1), crashing the app — so it is swallowed (the session is being torn down).
 * (Moved from pty.ts 2026-07-12, max-lines doctrine; re-exported there.)
 */
export function attachPortInput(port: PortLike, proc: ProcLike): void {
  port.on('message', (e) => {
    const m = e.data as PortInputMsg
    try {
      if (m.t === 'input' && typeof m.d === 'string') proc.write(m.d)
      else if (m.t === 'resize') {
        if (isValidResize(m.cols, m.rows)) proc.resize(m.cols, m.rows)
        else if (Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols >= 1 && m.rows >= 1)
          // BUG-023: a legit but OVERSIZED grid (>1000 cols/rows — wide board at a
          // tiny font) is clamped instead of dropped, so row updates keep applying
          // instead of the PTY freezing at spawn dimensions. Garbage (non-integer,
          // <1, non-finite) is still dropped wholesale.
          proc.resize(clampSpawnDim(m.cols, 80), clampSpawnDim(m.rows, 24))
      }
    } catch {
      /* pty already exited */
    }
  })
  port.start()
}
