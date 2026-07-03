/**
 * Recap-refresh fix: map a manual-refresh outcome to the user-facing "why nothing regenerated"
 * line. Lives outside RecapView.tsx so the component file only exports components (react-refresh).
 */

// Derived from the preload contract so there is no fourth mirror of the shapes.
export type RefreshOutcome = NonNullable<
  Awaited<ReturnType<typeof window.api.memory.refresh>>['outcome']
>

export interface RefreshNoteContent {
  text: string
  tone: 'info' | 'warn'
}

/**
 * The user-facing line for a refresh that did NOT regenerate the narrative. A coalesced outcome
 * unwraps to the in-flight run's result (the click is answered by whatever that run did).
 * `null` = nothing to say (regenerated, or not a recap-able board). Pure.
 */
export function refreshNoteFor(outcome: RefreshOutcome | undefined): RefreshNoteContent | null {
  if (!outcome) return null
  const o = outcome.status === 'coalesced' ? outcome.with : outcome
  switch (o.status) {
    case 'recap-written':
      return null
    case 'summary-written':
      switch (o.recapSkipped) {
        case 'consent-off':
          return {
            text: 'Agent recaps are off — enable them in Settings to regenerate.',
            tone: 'info'
          }
        case 'no-transcript':
          return { text: 'No session transcript yet — nothing to regenerate from.', tone: 'info' }
        case 'empty-transcript':
          return { text: 'The session has no turns to recap yet.', tone: 'info' }
        case 'not-terminal':
          return null
      }
      return null
    case 'llm-unavailable':
      switch (o.reason) {
        case 'no-provider':
          return { text: 'Regenerating needs an LLM key — add one in Settings.', tone: 'info' }
        case 'budget-exceeded':
          return { text: 'Daily AI budget reached — the recap will update tomorrow.', tone: 'info' }
        case 'provider-error':
          return { text: 'The AI provider returned an error — try refresh again.', tone: 'warn' }
      }
      return null
    case 'skipped':
      return o.reason === 'error'
        ? { text: 'Refresh failed — try again (details in the app log).', tone: 'warn' }
        : null
    case 'coalesced':
      return null // unreachable: unwrapped above (a run never reports coalesced about itself)
  }
}
