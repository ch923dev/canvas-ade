/**
 * F1b: the resume→fresh fallback signal, shared by both Resume entry points (the Inspector's
 * Session action via TerminalBoard.resumeSession and the palette's restart-resume intent via
 * usePaletteRestart). F3 deliberately degrades a dead stored id to a fresh launch at click
 * time — safe, but silent: the user picked "resume" and got "fresh". One keyed toast names
 * that (keyed so a rapid double-invoke updates in place instead of stacking).
 * `mode: 'continue'` needs no toast — it IS a resume, of the cwd's most recent session.
 */
import { showToast } from '../../../store/toastStore'

export function notifyResumeFellBack(): void {
  showToast({
    id: 'terminal-resume-fell-back',
    message: 'Session not resumable — started fresh',
    kind: 'info'
  })
}
