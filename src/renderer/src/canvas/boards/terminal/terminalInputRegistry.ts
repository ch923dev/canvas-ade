/**
 * Voice V3 — the terminal injection seam (SPEC §4, plan §V3). A module-level registry of
 * `boardId → {paste, submit}` populated by `useTerminalSpawn` beside the `e2eTerminals`
 * lifecycle (same register-on-spawn / unregister-on-teardown shape as e2eRegistry, but
 * PRODUCTION state — not e2e-gated). The VoiceFlyout consumes it:
 *  - `paste(text)` = `term.paste()` — bracketed, multi-line safe, CANNOT auto-submit.
 *  - `submit()` = one discrete `\r` down the same `sendInput` seam every PTY write uses.
 * Send is the ONLY `\r` emitter in the whole voice feature (review-first invariant);
 * callers gate on `useTerminalRuntimeStore.running[id]` before invoking either.
 */

export interface TerminalInputEntry {
  /** Paste text into the live xterm (bracketed paste path — never submits). */
  paste(text: string): void
  /** Send ONE discrete `\r` to the PTY (the Send gesture's second, separate write). */
  submit(): void
}

const registry = new Map<string, TerminalInputEntry>()

/** Register (or replace — a config respawn re-registers the fresh term) a board's entry. */
export function registerTerminalInput(id: string, entry: TerminalInputEntry): void {
  registry.set(id, entry)
}

export function unregisterTerminalInput(id: string): void {
  registry.delete(id)
}

/** The live entry for a board, or undefined when its terminal is not mounted. */
export function getTerminalInput(id: string): TerminalInputEntry | undefined {
  return registry.get(id)
}
