# PERSIST-1: writeProject skips envelope check on the incoming doc

- **Severity:** Low
- **Category:** persistence / data integrity (defense-in-depth)
- **Status:** CONFIRMED (high confidence) — original claim's "no validation / no recovery / security violation" framing was overstated; kernel-of-truth confirmed
- **Files touched:** `src/main/projectStore.ts`
- **Assigned:** _(blank)_

## Summary
`writeProject` validates the **existing on-disk primary** with `isEnvelope` during `.bak` rotation, but passes
the **incoming new doc** straight to `writeFileAtomic` with **no envelope check**. A renderer bug that produces
a structurally-invalid document (non-number `schemaVersion`, non-array `boards`) writes a bad primary.

## Where
`projectStore.ts:62-73`:
- `33-40` `isEnvelope()` validates `schemaVersion` is number AND `boards` is array.
- `65` envelope check applied to the **existing primary** before copying to `.bak`.
- `72` incoming `doc` → `writeFileAtomic` with **no `isEnvelope(doc)` guard**.

## Context (what is NOT wrong)
- This is **not** a security violation: `project:save` is frame-guarded (`projectIpc.ts:100 guard(e)`), and the
  doc is a trusted structured serialization (`useAutosave.ts:58 toObject()`), not attacker input.
- Recovery is **not** absent: `.bak` rotation only copies a valid prior primary, and `readProject` falls back to
  `.bak` when the primary fails the envelope check on read (`projectStore.test.ts:48-58`). A single bad write
  leaves a recoverable `.bak`.

## How it triggers
A renderer-side serialization bug emits `{schemaVersion: undefined, boards: {...}}` → written verbatim as the
new primary. Not reachable from normal flow today; this is hardening against future regressions.

## Suggested fix direction
Add an `isEnvelope(doc)` guard at the top of `writeProject` (before any disk write); throw a typed error if the
incoming doc fails, so a renderer bug surfaces loudly instead of silently persisting a malformed primary.

## Collision notes
Lane C (with SAVE-1). Touches `main/projectStore.ts`. SAVE-1 touches `main/projectIpc.ts` +
`store/useAutosave.ts` — adjacent, batch in one branch.
