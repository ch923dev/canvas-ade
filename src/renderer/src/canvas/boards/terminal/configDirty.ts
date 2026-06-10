/**
 * Pure dirty check for the terminal config popover (design-audit D2-B unsaved-changes
 * guard). Mirrors EXACTLY the normalization TerminalConfig.apply() persists — trim +
 * empty→undefined, title falling back to the current board title, shell only counting
 * once the user actually touched the dropdown (the display auto-seed must not read as
 * an edit, or every open would look dirty — the #9 label-only-Apply respawn lesson).
 */
import type { TerminalBoard as TerminalBoardData } from '../../../lib/boardSchema'

export interface ConfigDraft {
  title: string
  shell: string
  /** True only after the user picked a shell from the dropdown (not the auto-seed). */
  shellTouched: boolean
  launchCommand: string
  cwd: string
}

/** Would Apply persist anything different from what the board already has? */
export function configDirty(
  board: Pick<TerminalBoardData, 'title' | 'shell' | 'launchCommand' | 'cwd'>,
  d: ConfigDraft
): boolean {
  if ((d.title.trim() || board.title) !== board.title) return true
  if (d.shellTouched && (d.shell || undefined) !== board.shell) return true
  if ((d.launchCommand.trim() || undefined) !== board.launchCommand) return true
  if ((d.cwd.trim() || undefined) !== board.cwd) return true
  return false
}
