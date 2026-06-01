# In-depth review — 2026-06-01 (Round 2)

9-dimension workflow review (security/IPC · PTY · preview · persistence · state+undo · board-actions ·
camera/edges · whiteboard · silent-failures). 44 agents: 9 opus finders + adversarial-verify pass per
candidate. ~35 raw candidates → **9 survived verification** (most refuted). No High/Critical. Codebase healthy.

Dedup: cross-checked against `../2026-06-01-indepth-review/findings/` (~40 prior cards). Only NEW or
materially-deeper items kept; `ATTACH-1` overlaps a known issue (noted).

## Findings

| ID | Sev | Status | Title | File |
|----|-----|--------|-------|------|
| [PTY-1](findings/PTY-1.md) | **Medium** | CONFIRMED | Parked PTY sessions not reaped on project switch | `store/disposeLiveResources.ts` · `main/pty.ts` |
| [PREV-1](findings/PREV-1.md) | Low | CONFIRMED | Full-view title-bar toggle closes live boards without snapshot → blank frame | `boards/BrowserPreviewLayer.tsx:569` |
| [PERSIST-1](findings/PERSIST-1.md) | Low | CONFIRMED | `writeProject` skips envelope check on incoming doc | `main/projectStore.ts:62` |
| [SAVE-1](findings/SAVE-1.md) | Low | PARTIAL | Autosave I/O failure silently swallowed (no user feedback) | `main/projectIpc.ts:99` · `store/useAutosave.ts:34` |
| [ATTACH-1](findings/ATTACH-1.md) | Low | CONFIRMED | `attachBoard` missing post-await recheck → transient live-count miscount | `boards/BrowserPreviewLayer.tsx:416` |
| [NOTE-1](findings/NOTE-1.md) | Nit | CONFIRMED | Empty-note Backspace delete missing `!interactive` guard | `boards/planning/NoteCard.tsx:175` |
| [TEXT-1](findings/TEXT-1.md) | Nit | CONFIRMED | Empty free-text Backspace delete missing `!interactive` guard | `boards/planning/FreeText.tsx:166` |
| [SEC-NIT-1](findings/SEC-NIT-1.md) | Nit | REFUTED→clarity | `isUnsafeProjectDir` dual-check redundancy (no impact) | `main/projectIpc.ts:52` |
| [DISPOSE-NIT-1](findings/DISPOSE-NIT-1.md) | Nit | REFUTED→logging | `disposeLiveResources` swallows IPC errors (intentional best-effort) | `store/disposeLiveResources.ts:11` |

## Recommended fix clustering (non-colliding lanes)

- **Lane A — PTY-1**: `main/pty.ts` + `store/disposeLiveResources.ts` (wire parked-reap into switch path)
- **Lane B — PREV-1 + ATTACH-1**: `boards/BrowserPreviewLayer.tsx` (snapshot-before-close guard + post-await recheck) — same file, sequence together
- **Lane C — PERSIST-1 + SAVE-1**: `main/projectStore.ts` + `main/projectIpc.ts` + `store/useAutosave.ts` (incoming envelope guard + surface save error)
- **Lane D — NOTE-1 + TEXT-1**: trivial `!interactive` guard, batch together

SEC-NIT-1 / DISPOSE-NIT-1: optional clarity/logging hygiene, no functional defect — skip unless tidying.

## Status

Cards written 2026-06-01. **All 7 actionable findings FIXED** on branch `fix/review-2026-06-01-round2`
(TDD: 11 new unit tests, 438 total green; lint + typecheck clean; e2e 22/25 — 3 = documented
browser-trio env flake):

- **PTY-1** — new `pty:disposeAll` IPC → `disposeAllPtys()` drains live + parked maps;
  `disposeLiveResources` calls `window.api.disposeAllTerminals()` on switch. `disposeLiveResources.test.ts`.
- **PREV-1** — `evictLiveBoard` captures a snapshot before closing when none exists (full-view path).
- **ATTACH-1** — `attachBoard` re-checks `r.attached`/`attachSeq` after the open await.
- **PERSIST-1** — `writeProject` throws on an envelope-invalid incoming doc. `projectStore.test.ts`.
- **SAVE-1** — `project:save` try/catch → `false`; autosaver gains `onError`. `projectIpc.test.ts` + `useAutosave.test.ts`.
- **NOTE-1 / TEXT-1** — `if (!interactive) return` guard on the empty-element Backspace. `NoteCard.test.tsx` + `FreeText.test.tsx`.

**SEC-NIT-1 / DISPOSE-NIT-1**: not fixed by design — refuted as defects (no functional/security
impact; the swallowed catch is intentional best-effort). Left as clarity/logging notes.
