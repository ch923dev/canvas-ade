# JD-4 — Data Flow graph + canvas/agent integration · KICKOFF / HANDOFF

> **Status:** not started. This is the **last** slice of the JD umbrella. The flagship + the only
> schema-bumping slice. **Authoritative scope lives in [`EPIC.md`](./EPIC.md) §JD-4 and
> [`REPORT.md`](./REPORT.md) §6 P3** — this doc is the *handoff overlay*: current state, gates, the
> exact pre-code sign-offs, logistics, and the umbrella close-out. Read EPIC §JD-4 first, then this.
>
> **Doc-lifecycle note:** this file is intentionally **uncommitted on main**. The JD-4 session
> `git add`s it onto its own `feat/jd-4-*` worktree branch (feature docs never land on main directly),
> then deletes it in the merge PR like every slice spec.

## Where the umbrella stands (2026-06-23)

| Slice | State |
|---|---|
| JD-1 (viewer fix) | ✅ MERGED #220 `f6748711` |
| JD-2 (viewer enrichments) | ✅ MERGED #226 `396f4c15` |
| JD-3 (inventory + opt-in schemas + entity inspector) | ✅ MERGED #229 `cf245779`; build-history `44334faa` |
| **JD-4 (this)** | ⏳ not started — closes the umbrella |

**Rebase target / integration tip:** `origin/main` @ `44334faa`. Spin the JD-4 worktree off the
**latest** `origin/main` (re-fetch first — other lanes land often).

**What JD-3 already shipped that JD-4 builds on:**
- `lib/routeTemplate.ts` · `lib/schemaInfer.ts` · `lib/entityInfer.ts` (recursive entity/PK-FK,
  envelope-unwrap; **name+type structural only — no values cross IPC**).
- `canvas/boards/osr/DataFlowView.tsx` (inventory + recursive schema tree + entity inspector + opt-in
  gate + resizeable inspector + method/origin/template filter).
- `src/main/previewOsrShape.ts` (`extractShape` value-stripper + `sampleResponseShapes`) + the thin
  `preview:osrNetSampleSchema` IPC handler in `previewOsrNetwork.ts`.
- **ADR 0010** (`docs/decisions/0010-data-shape-inference-sampling.md`) — the privacy contract JD-4
  must EXTEND (see gate 2).
- The entity model is **GLOBAL** (uses all routes). **Value-overlap inclusion-dependency was
  deferred to JD-4** — that is the id-lineage pass below.

## The four deliverables (EPIC §JD-4)

1. **id-lineage pass** — `lib/lineage.ts` (+test). An id value in response A that reappears in
   request B ⇒ a **dashed directed edge** A→B. This is the first JD pass that reads *values* (not just
   shapes), so it is **MAIN-side only** and needs **structured-initiator capture** added to
   `previewOsrNetwork.ts` (which request initiated which — the CDP `Network.initiator` / call-stack).
2. **Dedicated Data-Flow board** — `canvas/boards/osr/DataFlowBoard.tsx`. React Flow + **dagre**
   layout. **Focus-on-node by default — never "draw the whole surface."** Sequence layout as a 2nd
   tab. **Idempotent regenerate + diff-highlight** (re-running over fresh captures updates, not
   duplicates).
3. **"Sketch the data model" → Planning/Mermaid export** — `lib/erMermaid.ts` (+test), an `erDiagram`
   serializer, wired through the existing `makeDiagram` / `materializePlanningOps` so the inferred ER
   lands as an **editable Mermaid Diagram element** on a Planning board.
4. **Agent-context export → `.canvas/memory/`** with **scrub-on-export consent** (reuse the Context
   secret-scrubber; export is the consent moment; inherits `.canvas/` git-ignore-by-default).

## File-zone ownership (JD-4 column, from EPIC)

**Add:** `canvas/boards/osr/DataFlowBoard.tsx` · `lib/lineage.ts`(+test) · `lib/erMermaid.ts`(+test).
**Change (own):** `schema/boardSchema.ts` + element/board registry · `package.json` (add `dagre`).
**Change (extend △ — rebase onto JD-3's landed versions, edit only your region):**
`main/previewOsrNetwork.ts` (structured-initiator capture) · `canvas/boards/osr/DataFlowView.tsx`
(graph mode entry) · `preload/index.ts` + `main/index.ts` (initiator IPC, frame-guarded) ·
`styles/boards/browser-devtools.css` (append-only block) · integrate `makeDiagram` /
`materializePlanningOps`.

## Pre-code gates — REQUIRE USER SIGN-OFF (same discipline as JD-3)

1. **Decision 2 confirmation — new board type + schema bump.** A new board *kind* is **breaking**
   under ADR 0007 two-tier, so it **moves `minReaderVersion`** (older app builds will refuse a doc
   containing a Data-Flow board). Get an explicit "yes, accept the schema bump." Plan the migration +
   a `boardSchema` round-trip test before code.
2. **Extend ADR 0010 for structured-initiator / value-read capture.** id-lineage reads response/request
   *values* in MAIN to match ids — a privacy delta over JD-3's shape-only contract. Amend ADR 0010
   (new section) BEFORE the MAIN code: cap the lineage scan, keep it MAIN-side, ship only the *edge
   list* (id-name + source/target request ids) to the renderer — never the matched raw values; scrub
   on the agent-context/Mermaid export path.
3. **Token-accurate Data-Flow board mock + screenshot for sign-off.** The board is non-trivial real UI
   → produce a build-ready mock with the actual tokens (`styles/tokens.css` / `browser-devtools.css`,
   one accent `#4f8cff`), covering: focus-on-node default, the sequence-layout tab, diff-highlight on
   regenerate, the "→ Planning board" action, and the **graceful-degradation** state (flat API ⇒
   inventory/shapes, **zero fabricated entity→entity edges**, cf. `mock-e`). `mock-b`/`mock-c`/`mock-e`
   are the umbrella-level visual contract to match.

## Cross-cutting invariants (do not weaken)

- Security: `contextIsolation`/`sandbox`/`nodeIntegration:false` untouched; **no `innerHTML` /
  `dangerouslySetInnerHTML`** in any viewer (React-escape only); **all new MAIN IPC frame-guarded by
  `isForeignSender`** exactly like `getOsrNetBody`; Browser-board content never reaches the PTY.
- Privacy: bodies-off by default; shape-not-values is the rule — id-lineage is the *only* value-read,
  MAIN-side and capped, edge-list-only over IPC (see gate 2). Export = the consent moment.
- Deps: `dagre` is the one allowed runtime dep (graph layout) — justify in the PR; everything else
  vendored (perfect-freehand precedent).
- Tokens: one accent, functional only; status colors for status only.

## Acceptance bar (EPIC §JD-4)

Clicking through a login→home flow in a Browser board produces a **focus-defaulted** RF graph where an
id returned by `POST /api/session` shows a **dashed id-propagation edge** to the subsequent request that
consumed it; **"→ Planning board"** materializes the inferred ER as an **editable Mermaid diagram
element**. Flat/unrelated API ⇒ inventory + schemas, **no entity→entity edges**.

## Umbrella close-out (rides with the JD-4 merge PR)

- **Collapse** `docs/research/2026-06-23-json-dataflow-visualization/` to a single dated summary
  (the perf-wave / PA-R precedent): keep REPORT/EPIC residue value, push the rest to git history.
- **Delete the leftover per-slice specs/mocks still tracked on main** (doc-lifecycle): `JD-1-SPEC.md`,
  `JD-3-SPEC.md`, `jd-3-inventory-tab-mock.{html,png}` (+ this `JD-4-KICKOFF.md` and any JD-4 spec).
- Reviews/roadmap indexes updated in the same PR; confirm all findings H1–H7 / M1·M4·M8·M9 / A6 retired.

## Logistics / gotchas

- **gh account:** active must be `ch923dev` (has write); `ch-dev401` 403s. `gh auth switch --user ch923dev`.
- **Worktree cap is hot:** ~7 parked (≈4 healthy). Tear one down (`remove-worktree.ps1` — drops the
  node_modules junction FIRST so MAIN's tree is never followed/deleted) before spawning `feat/jd-4-*`.
- **e2e:** full matrix BOTH legs at the pre-merge gate (`pnpm test:e2e:matrix`). The Windows
  `@terminal gitDiff` test **false-fails from a worktree** (host-repo escape) — confirm green on the
  Linux Docker leg and push `--no-verify`; that's expected, not a real failure.
- **Manual dev check:** `$env:CANVAS_DEV_TITLE='PR#NNN JD-4 data-flow board'; pnpm dev` — confirm the
  window title before signing off (this slice especially: schema bump → verify open/save/reopen of a
  doc with a Data-Flow board, and that an OLD build refuses it per the floor move).
- **On merge:** squash → `signal-merge.ps1 -Pr <n> -Subject "…"` → append build-history → teardown.
- **Stray stash:** a non-destructive `git stash` ("jd-3 teardown: settings.json env clobber") lingers
  from JD-3 teardown — harmless; drop it whenever convenient.
