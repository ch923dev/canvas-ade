/**
 * Bracketed-paste (DECSET 2004) mode tracker for live PTY sessions.
 *
 * WHY (relay cut-off fix, 2026-07-04): the MCP dispatch gate writes a relayed prompt into the
 * target PTY as raw bytes. A human paste goes through xterm's `term.paste()`, which wraps the
 * text in `\x1b[200~ … \x1b[201~` whenever the foreground app enabled bracketed paste — so an
 * agent TUI (Claude Code) ingests it as ONE atomic paste. The raw dispatch write instead lands
 * as a long synthetic-keystroke burst, which a TUI mid-boot/redraw can partially swallow (the
 * observed failure: a ~1.6KB relay arriving with its HEAD missing, tail intact). To frame the
 * dispatch write the same way the human path is framed, MAIN must know whether the target's
 * foreground app CURRENTLY has bracketed paste on — that state only exists in the PTY output
 * stream (`\x1b[?2004h` / `\x1b[?2004l`), which this tracker observes.
 *
 * Mechanics: `observe(id, chunk)` scans each output chunk for DECSET/DECRST private-mode
 * sequences carrying param 2004 (combined param lists like `\x1b[?1049;2004h` included); the
 * LAST occurrence in stream order wins. A small per-id tail carry is prepended to the next
 * chunk so a sequence split across two output chunks is still seen (re-scanning the carried
 * tail is idempotent — re-applying an already-applied toggle sets the same state). State is
 * keyed by board id and MUST be reset wherever a (new or unknown) process binds to that id
 * (spawn, adopt) — an adopted proc's mode is unknown until it next repaints, so the tracker
 * conservatively reports `false` (= today's raw-write behaviour) until a `?2004h` is observed.
 */

/** DECSET (`h`) / DECRST (`l`) private-mode sequence; param list may combine modes. */
// eslint-disable-next-line no-control-regex -- ESC (\x1b) is the literal CSI introducer we match on.
const DEC_PRIVATE_MODE = /\x1b\[\?([0-9;]*)([hl])/g

/**
 * Longest tail kept between chunks so a split sequence still matches. 32 covers a realistic
 * combined param list (e.g. `\x1b[?1049;2004;25h` is 17 chars) with generous headroom.
 */
const CARRY_MAX = 32

interface PasteModeState {
  enabled: boolean
  carry: string
}

export interface PasteModeTracker {
  /** Feed one PTY OUTPUT chunk for board `id` (call only for the live proc's output). */
  observe(id: string, chunk: string): void
  /** Whether the last observed toggle for `id` was `?2004h`. Unknown/never-seen ⇒ false. */
  isEnabled(id: string): boolean
  /** Forget `id` (session torn down, or a new/unknown proc bound to the id). */
  drop(id: string): void
}

export function createPasteModeTracker(): PasteModeTracker {
  const states = new Map<string, PasteModeState>()
  return {
    observe(id, chunk) {
      let st = states.get(id)
      if (!st) {
        st = { enabled: false, carry: '' }
        states.set(id, st)
      }
      const hay = st.carry + chunk
      // Cheap guard: the regex only runs when the (carry-joined) text can possibly contain a
      // 2004 toggle — output chunks are hot-path (every PTY byte flows through here).
      if (hay.includes('2004')) {
        DEC_PRIVATE_MODE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = DEC_PRIVATE_MODE.exec(hay)) !== null) {
          if (m[1].split(';').includes('2004')) st.enabled = m[2] === 'h'
        }
      }
      st.carry = hay.length > CARRY_MAX ? hay.slice(-CARRY_MAX) : hay
    },
    isEnabled(id) {
      return states.get(id)?.enabled ?? false
    },
    drop(id) {
      states.delete(id)
    }
  }
}
