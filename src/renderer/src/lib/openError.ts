/**
 * Classify a project-open failure message (canvasStore `project.error`). Only one kind is fixable
 * by updating the app: ADR 0007's refusal of a doc whose compat floor is above this build
 * (boardSchema.ts `assertReadableVersion` — "…saved by a newer version of the app; update the app
 * to open it"). The Welcome screen offers an Update now row for exactly that one (WS-12, O-2).
 * openError.test.ts pins this against the real thrown message, so a reworded refusal fails there.
 */
export function isNewerAppRequiredError(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.includes('saved by a newer version of the app')
}
