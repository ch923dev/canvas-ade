# DISPOSE-NIT-1: disposeLiveResources swallows IPC errors without logging

- **Severity:** Nit
- **Category:** error-handling / logging hygiene
- **Status:** REFUTED as a defect → kept as logging-hygiene note only
- **Files touched:** `src/renderer/src/store/disposeLiveResources.ts`
- **Assigned:** _(blank)_

## Summary
`disposeLiveResources` uses `.catch(() => false)` on `closeAllPreviews()` and `killTerminal` (`lines 11, 16`),
swallowing IPC errors with no logging.

## Why this is NOT a defect
- The swallowing is **intentional** — docstring (`1-5`) explicitly states "Idempotent / best-effort."
- Claimed impact ("stale resources accumulate in **renderer** memory") is **factually wrong**: WebContentsViews
  and node-pty processes live in **MAIN**, not the renderer. A swallowed renderer-side catch leaks nothing.
- The genuine switch-time leak is the **separate** PTY-1 (parked sessions not reaped) — unrelated to this catch.
- Proposed remediation (throw/abort the switch) would be a **regression**: `AppChrome.tsx:56-65` awaits this
  then loads the new project; throwing would block project switching whenever a best-effort cleanup fails.
  Continue-on-failure is correct.

## Suggested fix direction
Optional only: add a `console.warn` in the catch for diagnostics. Do **not** change control flow.

## Collision notes
None — informational. The real switch leak is tracked in PTY-1.
