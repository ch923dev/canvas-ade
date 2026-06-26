// Phase 5 · S1 — save the terminal's output to a user-chosen .txt file.
//
// Two pure helpers (serialize the buffer to plain text; build the default filename) plus
// the impure runner that mirrors the whiteboard `runBoardExport`: serialize → MAIN save
// dialog + atomic write → toast on the result (silent on user cancel). Plain text only in
// S1 (zero new dep); the colored `.html` export folds in with addon-serialize in S2.
//
// Nothing here writes to the PTY — serialize is a read of the renderer buffer; the
// "terminal input is trusted-user-only" invariant is untouched.
import type { Terminal } from '@xterm/xterm'
import { showToast } from '../../../store/toastStore'

/**
 * The minimal slice of xterm's active buffer the serializer needs — so the unit test can
 * pass a tiny fake instead of standing up a real Terminal. xterm's `IBuffer`/`IBufferLine`
 * are structurally compatible (translateToString takes extra optional args we don't use).
 */
export interface TerminalBufferLike {
  readonly length: number
  getLine(i: number): { translateToString(trimRight?: boolean): string } | undefined
}

/**
 * Walk the FULL active buffer (scrollback + viewport) to plain text — one trailing-trimmed
 * line per row, with the blank trailing rows dropped (the buffer is padded out to its row
 * count). Mirrors e2eHooks.readTerminal's `translateToString(true)` walk.
 */
export function serializeTerminalText(buf: TerminalBufferLike): string {
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length > 0 ? lines.join('\n') + '\n' : ''
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Default save name: `<slug>-<YYYYMMDD-HHmmss>.txt`, or `terminal-<stamp>.txt` when the
 * board is untitled. `now` is injected so the stamp is deterministic under test. (MAIN
 * re-sanitizes the name before it hits the dialog, so a friendly slug is fine here.)
 */
export function buildTerminalSaveName(title: string | undefined, now: Date): string {
  const stamp =
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug ? `${slug}-${stamp}.txt` : `terminal-${stamp}.txt`
}

export type TerminalSaveResult =
  | { ok: true; path: string }
  | { ok: false; canceled?: boolean; error?: string }

/**
 * Serialize the live buffer → MAIN save dialog + atomic write → toast on the outcome.
 * Mirrors `runBoardExport`: silent on an explicit user cancel, a sticky error toast on a
 * genuine write failure, a brief success toast otherwise. Returns the raw IPC result so the
 * e2e seam can assert the written path.
 */
export async function runTerminalSave(
  term: Terminal,
  title: string | undefined,
  boardId: string
): Promise<TerminalSaveResult> {
  const text = serializeTerminalText(term.buffer.active)
  const suggestedName = buildTerminalSaveName(title, new Date())
  const id = `term-save-${boardId}`
  try {
    const res = await window.api.terminal.saveOutput({ text, suggestedName })
    if (res.ok) {
      showToast({ id, kind: 'ok', message: 'Saved terminal output' })
    } else if (!res.canceled) {
      // eslint-disable-next-line no-console
      console.error('terminal save failed:', res.error)
      showToast({
        id,
        kind: 'error',
        sticky: true,
        message: 'Save failed — check file permissions and disk space'
      })
    }
    return res
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('terminal save failed', err)
    showToast({ id, kind: 'error', sticky: true, message: 'Save failed' })
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}
