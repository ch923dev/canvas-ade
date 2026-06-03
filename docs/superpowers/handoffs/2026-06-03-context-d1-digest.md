# Handoff — M-digest T-D1: Tier-1 digest module (2026-06-03)

**Branch:** `feat/context` (worktree `Z:\canvas-ade-context`, base `main` @ `9758cec`).
**Plan:** `docs/superpowers/plans/2026-06-03-context-d1-tier1-digest.md`.
**Spec:** `docs/superpowers/specs/2026-06-03-desktop-context-memory-design.md` §5.1.

## What landed

A pure Tier-1 context-digest module — the no-LLM, no-key data behind the reopen panel (T-D2).

- `src/renderer/src/lib/digest.ts` — `buildDigest(doc: CanvasDoc): CanvasDigest`. Pure (type-only import
  from `boardSchema`; no React / Zustand / network / runtime state). Per-type helpers
  (`digestTerminal` / `digestBrowser` / `digestPlanning`) + a count header; cross-board reverse link
  (which browser previews which terminal) derived from the whole doc.
- `src/renderer/src/lib/digest.test.ts` — 11 unit tests.

### Exported contract (what T-D2 consumes)

```ts
interface BoardDigest { boardId: string; type: BoardType; title: string; status: string; lines: string[] }
interface CanvasDigest { header: string; boards: BoardDigest[] }
function buildDigest(doc: CanvasDoc): CanvasDigest
```

**Digest rules:**
- **header:** `"<N> board(s) — <t> terminal, <b> browser, <p> planning"` (singular `board` only when N===1).
- **terminal:** `` Runs `<launchCommand>` `` or `No launch command set`; `cwd: <cwd>` if set;
  `Dev server port <port>` if set; `Feeds preview "<browserTitle>"` if a browser's `previewSourceId` is
  this terminal. `status = launchCommand ? 'ready' : 'idle'`.
- **browser:** `URL <url>`, `Viewport <viewport>`; `Preview of "<terminalTitle>"` if `previewSourceId`
  set (raw id fallback if the source is gone). `status = previewSourceId ? 'linked' : 'static'`.
- **planning:** one line per checklist `"<title>: <done>/<total> done"`; `"<n> note(s)"` (singular
  `note` when n===1); `Empty board` if no lines. `status` = aggregate `"<doneSum>/<totalSum> done"`
  across checklists, else `'notes'`.
- Boards in document order.

> **Disk-only (by design, §5.1):** terminal **last-command + live status are runtime-only**, not in
> `canvas.json`, so they are NOT in Tier-1. The Tier-2 loop (M-memory) captures them later.

## Test evidence

- Unit: `pnpm exec vitest run src/renderer/src/lib/digest.test.ts` → **11/11 pass** (empty canvas,
  mixed counts, singular header, terminal ready/idle + cwd/port, browser static/linked + missing-source
  fallback + reverse link, planning checklists/notes/singular-note/empty-board/notes-status).
- Full gate (worktree): `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`
  → all green; **513 unit** total (502 base + 11), build OK.
- **e2e:** none for T-D1 — pure module, no runtime consumer yet (nothing imports `digest.ts`), so no
  `CANVAS_SMOKE` regression risk. The e2e probe lands in **T-D2** when the panel wires it in (per the
  roadmap card).

## Review

- **Spec compliance:** ✅ (independent code read — every rule verified, no extra/out-of-scope changes).
- **Code quality:** Approved-with-minor → all minors fixed in `9e55beb`: dropped a dead
  `export type { ChecklistElement }` re-export, hoisted a mid-file test import, locked the
  linked-browser line contract with `toEqual`, added the singular-header test. (Also a TDD-cleanup
  commit `5a45122` removed the `base()` scaffold helper once it became dead code — TS6133.)

## Commits

```
9e55beb refactor(context): code-review fixes — drop dead re-export, hoist test import, lock linked-browser contract, singular-header test
5a45122 fix(context): remove unused base() scaffold helper (TS6133)
ea85141 feat(context): Tier-1 planning digest (checklists + notes)
07af32b feat(context): Tier-1 browser digest + reverse preview link
929ad3d feat(context): Tier-1 terminal digest
7258908 feat(context): Tier-1 digest scaffold — types + header
```

## Follow-ups / next task

- **Next: T-D2 — slide-in digest panel** (`docs/roadmap-context.md` › M-digest). It consumes
  `CanvasDigest`, renders an auto slide-in side panel of per-board cards on project open, and brings the
  first `CANVAS_SMOKE=e2e` probe (`src/main/e2e/probes/context.ts`) asserting the panel mounts with one
  correct card per board. Use **real input** for any transform-affected assertions
  (memory `e2e-sendinputevent-vs-dispatchevent`).
- No open issues from T-D1.
