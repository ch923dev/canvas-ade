# ADR 0007 — Two-tier schema versioning (`minReaderVersion` forward compatibility)

**Status:** Accepted · **Date:** 2026-06-13 · (0006 = canvas backdrop, merged #126; this ADR
deliberately took the next number.)

## Context

`migrate()` hard-refused any `canvas.json` whose `schemaVersion` was above the build's
`SCHEMA_VERSION` — `"newer than supported"` — and the second autosave rotates `canvas.json.bak`
to the same version, so there was no recovery path. But six of the seven shipped migrations
(v2→v8) are **identity bumps**: optional fields, defaulted at read. The single version number
conflated *additive* with *breaking*, so the strict refuse paid brick-the-project costs for
changes an older reader handles fine.

This bit for real on 2026-06-13: a parallel worktree build at schema v9 (canvas-backdrop)
autosaved a user project, and the `main` build (v8) then refused to open it. Post-release the
same failure reappears as auto-update rollback, or one project folder shared by two machines on
different app versions.

Two facts make forward compatibility nearly free here:

1. `fromObject` validates known fields then `structuredClone`s the whole doc — **unknown
   board/element-level fields already ride through the store and back out through `toObject`'s
   clone**, so an old reader's save round-trip preserves a newer schema's optional fields.
2. The deep validators (`assertBoard` / `assertPlanningElement`) reject unknown board types and
   element *kinds* — exactly the changes that genuinely break an older reader.

## Decision

Add an optional **`minReaderVersion`** to the doc root (the compat floor): the lowest
`SCHEMA_VERSION` an app must support to read this doc. Writers stamp
`boardSchema.MIN_READER_VERSION` (mirrored in MAIN's `projectStore` under the BUG-024 lock-step
rule). `migrate()` on a newer doc now:

- **opens it as-is** when `minReaderVersion ≤ SCHEMA_VERSION` (additive bump). Deep validation
  stays the safety net; the renderer shows a keyed info toast ("saved by a newer version …
  saving re-stamps it at vN"). The next save re-stamps the file at the reader's version; the
  newer app simply re-migrates the identity bumps on its next open.

The floor starts at **9**, not 8: v9's root `background` (canvas backdrop, #126/ADR 0006) is
exactly the doc-level-key case in the table below — a v8 reader would open the doc but silently
drop the user's wallpaper on its next save. So v9 is the breaking baseline; forward compatibility
pays off from the next additive bump (v10+).
- **refuses** only when the floor is above us (true breaking change) — or when a newer doc has
  no `minReaderVersion` at all (docs written before this ADR keep the old strict behavior). The
  message keeps the `"newer than supported"` phrase (pinned by tests + e2e) and now says to
  update the app.

### Bump rules (the contract)

| Change | `SCHEMA_VERSION` | `MIN_READER_VERSION` |
|---|---|---|
| New OPTIONAL field, defaulted at read | bump | keep |
| New board type / element kind; semantic change; anything an older validator rejects or misreads | bump | bump to same |
| New DOC-LEVEL key (root of `canvas.json`) | bump | **bump to same** — `toObject` rebuilds the root object from store state, so an older reader's save silently DROPS unknown root keys; that data loss makes root additions breaking by default (or the author must explicitly accept the loss) |

## Consequences

- Version skew stops bricking projects: any app ≥ v8 opens every future additive doc. The floor
  only moves on real breaking changes, which should stay rare.
- Schema authors must now make one explicit call per bump: additive or breaking (the
  `MIN_READER_VERSION` doc comment carries the checklist). The backdrop's `background` root key
  (v9) is the worked example: doc-level → breaking → floor 9.
- Rode-along fix: #126 bumped the renderer to v9 but missed MAIN's lock-stepped duplicate
  (`projectStore.SCHEMA_VERSION` still 8 — fresh projects were created with a stale version
  marker). Both MAIN constants now sit at 9 with the assertions updated.
- `e2e/recovery.e2e.ts`'s too-new corpus (`schemaVersion: 999999`, no floor) still exercises the
  refuse path unchanged.
- MAIN's duplicated constant gains a sibling (`MIN_READER_VERSION`), same lock-step test
  discipline as BUG-024.
