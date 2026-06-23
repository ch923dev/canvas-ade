# JD — JSON & Data Flow (umbrella build plan)

> **Epic key:** `JD` · **Source of truth:** this file + [`REPORT.md`](./REPORT.md) (proposal, mocks,
> feasibility, decisions). **Status:** awaiting sign-off — no implementation code yet.
> **Partitioned by file-zone ownership** so two sessions run two lanes without ever editing the same
> file (the PA-epic discipline). Run ≤2 lanes for this umbrella (the shared-file surface is small).

## What this umbrella is

One coherent body of work behind two user asks that share the same data source (the OSR Network
capture):

1. **Fix the JSON eyesore** — replace the flat `<pre>` (`prettyBody`, `osrNetFormat.ts:577`) with a
   real collapsible, token-faithful JSON viewer. *This is the slice the user asked for first; it ships
   standalone and retires 9 audit findings.*
2. **Visualize the full data flow** — a layered inference over the already-captured requests that
   degrades gracefully: endpoint **inventory** → inferred **schemas** → **entities** → **relationships
   (ER)** → **id-lineage**, surfaced first as a panel tab, then as a dedicated React Flow board and an
   agent-context export. *Never fabricates edges* (see `mock-e-data-flow-flat.png`).

The two halves are split into four slices, **JD-1 … JD-4**, mapped 1:1 to the report's phases P0–P3.

## Build order & dependency graph

```
 LANE A (viewer)          LANE B (data flow)
 ───────────────          ──────────────────
   JD-1  (P0)   ────────▶   JD-3  (P2)          JD-1 ∥ JD-3 may run concurrently
   the fix      ships first  inventory+schema    (share only osrNetFormat.ts + css —
     │                          │                 JD-1 owns those files; JD-3 rebases)
     ▼                          ▼
   JD-2  (P1)                 JD-4  (P3)
   enrichments               graph + canvas/agent
```

**Ship-value order:** `JD-1` → `JD-3` → `JD-2` → `JD-4`.
Rationale (from REPORT §6): ship the **fix** first (lowest risk, the actual complaint); then the
**always-works** Data Flow layers (inventory + schema); enrichments and the flagship board — which
carry the schema bump, a new dep, and the privacy/body-sampling architecture — land last.

**Dependencies:** `JD-2` waits on `JD-1` (extends the same `JsonView`/`osrJson`). `JD-4` waits on
`JD-3` (extends the same `DataFlowView`/`previewOsrNetwork`). `JD-1` and `JD-3` are otherwise
independent → two lanes.

## File-zone ownership (collision map)

Each file is **owned by exactly one slice**. A `△` marks a file two slices touch — the **earlier
slice owns it**; the later slice rebases onto the landed change (it never co-edits).

| File | JD-1 | JD-2 | JD-3 | JD-4 |
|---|:--:|:--:|:--:|:--:|
| `lib/osrJson.ts` (+`.test.ts`) | **own** | extend △ | | |
| `canvas/boards/osr/JsonView.tsx` | **own** | extend △ | | |
| `canvas/boards/osr/OsrNetworkDetail.tsx` | **own** | | | |
| `lib/virtualizer.ts` (+`.test.ts`) | | **own** | | |
| `lib/routeTemplate.ts` (+test) | | | **own** | |
| `lib/schemaInfer.ts` (+test) | | | **own** | |
| `lib/entityInfer.ts` (+test) | | | **own** | |
| `lib/lineage.ts` (+test) | | | | **own** |
| `lib/erMermaid.ts` (+test) | | | | **own** |
| `canvas/boards/osr/DataFlowView.tsx` | | | **own** | extend △ |
| `canvas/boards/osr/DataFlowBoard.tsx` | | | | **own** |
| `store/osrNetworkStore.ts` (`NetTab`) | | | **own** | |
| `canvas/boards/osr/OsrNetworkPanel.tsx` | | | **own** | |
| `main/previewOsrNetwork.ts` | | | **own** | extend △ |
| `preload/index.ts` + `main/index.ts` (IPC) | | | **own** | extend △ |
| `lib/osrNetFormat.ts` | **own** △ | | rebase △ | |
| `styles/boards/browser-devtools.css` | **own** △ | append | append △ | append |
| `schema/boardSchema.ts` + `elementRegistry` | | | | **own** |
| `package.json` (add `dagre`) | | | | **own** |

**Shared-file rule for `osrNetFormat.ts`:** JD-1 extracts the `looksJson` gate out of `prettyBody`
(different function from `urlName`); JD-3 refactors `urlName`→`routeTemplate`. Land JD-1's edit first,
then JD-3 rebases — they touch disjoint functions, so the rebase is mechanical. **`browser-devtools.css`
is append-only per slice** (each slice adds its own `.bb-*` block; no slice rewrites another's).

---

## JD-1 — JSON viewer core (the fix) · maps to REPORT P0

> **🔒 LOCKED — full implementation spec: [`JD-1-SPEC.md`](./JD-1-SPEC.md).** Ready to build.

**Scope.** Flat-row model + memoized `visibleRows` + single-line uniform rows + **Option-A
accent-on-keys coloring** + default-collapse-to-depth-2 + size badges + Raw⇄Tree toggle +
truncation-tolerant parse-fail fallback. The spine is a **single lenient, source-string tokenizer**
in `osrJson.ts` — **not `JSON.parse`** — so duplicate keys, key order, big integers, and truncated
bodies stay wire-faithful and Raw mode is lossless by construction. **No** virtualization, **no**
search (those are JD-2). Strip BOM before the `looksJson` test.

**Files.**
- **Add:** `lib/osrJson.ts` (+ `lib/osrJson.test.ts`), `canvas/boards/osr/JsonView.tsx`.
- **Change:** `canvas/boards/osr/OsrNetworkDetail.tsx` — replace `prettyBody(...)` at **both** call
  sites (`BodyBar` ≈`:108` response/request-payload, `PreviewTab` non-image branch ≈`:250`) with
  `<JsonView text mime base64 truncated />`; route the request-payload site through `detectBodyKind`.
  *(Line numbers drift — match on the `prettyBody(` calls, not the line.)*
- **Change:** `lib/osrNetFormat.ts` — extract `looksJson` into `osrJson.ts` (shared, BOM-stripped);
  leave `prettyBody` only as the Raw-mode/last-resort fallback path.
- **Change:** `styles/boards/browser-devtools.css` — add `.bb-net-json*` classes mirroring
  `.bb-net-bodytext` (mono 11px, `--text-2` base) + the Option-A token-color classes.

**Effort:** M · **Risk:** Low (no new IPC/capture/schema; isolated swap).
**Retires:** H1, H2, H3, H4, H6, M4, M8, M9.
**Decision gate:** Decision 1 (palette = **Option A**, see `mock-d`) + Decision 3 (P0 scope) — both
recommended-and-agreed; lock before code lands.
**Acceptance.** A 200-key nested response renders as a collapsible, accent-keyed tree that folds a
large array in one click, with **no `dangerouslySetInnerHTML` anywhere** in the component (assert via a
unit test on the rendered element tree **+** a manual dev check with the PR-stamped title). Unit tests:
duplicate keys survive, key order preserved, big integers shown from source (not round-tripped),
truncated body → partial tree + marker, BOM-prefixed JSON detected, form/urlencoded → kv rows, the
four error/empty states.

---

## JD-2 — JSON viewer enrichments · maps to REPORT P1

**Scope.** Custom uniform-height virtualizer + array windowing + hard row cap; in-body search +
highlight + next/prev (auto-expand ancestors); copy property-path / value / subtree; big-number
raw-source display; URL→`shell.openExternal`; ARIA `tree` + keymap + `aria-activedescendant`; type
affordances; route WS text frames (`WsRecord.frames[]`) through `JsonView` in the WS detail subtab.

**Files.** Extend `JsonView.tsx` + `lib/osrJson.ts`; add `lib/virtualizer.ts` (vendored ~80 lines) +
test; append search/virtualization CSS to `browser-devtools.css`.

**Effort:** M–L · **Risk:** Medium (ARIA-under-virtualization focus correctness is the trickiest piece).
**Retires:** H5, H7, M1, A6 (WS frames), + a11y.
**Depends on:** JD-1 (same files).
**Acceptance.** A 50k-element array opens instantly with the live DOM holding ≤~50 rows (assert node
count via the Playwright `_electron` harness), and `Ctrl/Cmd+G` jumps to a match inside a collapsed
subtree after auto-expanding its ancestors.

---

## JD-3 — Data Flow inventory + schema (always-works layers) · maps to REPORT P2

**Scope.** The pure `lib/` inference passes: **route-template collapsing** (numeric/UUID/opaque/variance
→ `{id}`/`{param}`, editable example set), **monoid schema-merge** (types/field-names/presence-counts/
format-hints — *shape, never values*), **entity/PK-FK** detection. The **API Inventory panel tab**
(extend `NetTab` `'network'|'dataflow'`, body-free inventory + lazy per-row schema fill). The
**bodies-off-by-default opt-in** ("Infer data shapes (reads response bodies)") + **MAIN-side capped
sampling** behind `isForeignSender`. Scrub on aggregate/export (reuse the Context secret-scrubber).
**Degrades gracefully** — flat/unrelated APIs show inventory + schemas + island shapes, zero
fabricated edges (`mock-e`).

**Files.**
- **Add:** `lib/routeTemplate.ts`, `lib/schemaInfer.ts`, `lib/entityInfer.ts` (+ tests each),
  `canvas/boards/osr/DataFlowView.tsx`.
- **Change:** `store/osrNetworkStore.ts` (`NetTab` union); `canvas/boards/osr/OsrNetworkPanel.tsx`
  (tab + opt-in gate); `main/previewOsrNetwork.ts` (opt-in capped sampling path); `preload/index.ts`
  + `main/index.ts` (the new sampling IPC channel, frame-guarded); `lib/osrNetFormat.ts`
  (`urlName`→`routeTemplate`, **rebased onto JD-1's `looksJson` extraction**); append DataFlow CSS.

**Effort:** L · **Risk:** Medium-High (the body-sampling path is new architecture + the privacy
surface; route-template over/under-collapse needs the editable-example escape hatch).
**Decision gate:** Decision 2 (panel-tab-first) — agreed. **Needs an ADR** for the bodies-off-by-default
+ MAIN capped-sampling subsystem (mirrors the Context consent-gated egress; same class as the file-tree
path-traversal ADR). Write the ADR before the MAIN sampling code lands.
**Acceptance.** With the opt-in on, repeated calls to `/api/users/{id}` collapse to one inventory row
whose expanded schema marks an always-present field `required` and a sometimes-missing field
`optional`, with `Authorization`/`Cookie` header values and example values **absent** from the
rendered shape. With a flat unrelated API, the view shows inventory + schemas and **draws no
entity→entity edges**.

---

## JD-4 — Data Flow graph + canvas/agent integration (flagship) · maps to REPORT P3

**Scope.** The **id-lineage pass** (id from response A reappears in request B ⇒ dashed directed edge;
needs the new **structured-initiator capture** in MAIN). The **dedicated Data-Flow board** on React
Flow (dagre layout, **focus-on-node default** — never "draw the whole surface"; sequence layout as a
second tab; idempotent regenerate + diff-highlight). The **"Sketch the data model" → Planning/Mermaid
export** (`erDiagram` via existing `makeDiagram`/`materializePlanningOps`). The **agent-context export
into `.canvas/memory/`** with scrub-on-export consent.

**Files.**
- **Add:** `canvas/boards/osr/DataFlowBoard.tsx`, `lib/lineage.ts` (+ test), `lib/erMermaid.ts`
  (Mermaid `erDiagram` serializer, + test).
- **Change:** `schema/boardSchema.ts` + `elementRegistry` (**new board type → schema bump per ADR 0007
  two-tier**: new board kind is breaking → moves `minReaderVersion`); `main/previewOsrNetwork.ts`
  (structured-initiator capture, **rebased onto JD-3**); `DataFlowView.tsx` (graph mode, **rebased onto
  JD-3**); `package.json` (add `dagre`); integrate `makeDiagram`/`materializePlanningOps`.

**Effort:** L · **Risk:** High (schema bump + new board type + new dep + lineage leans hardest on the
privacy work).
**Decision gate:** Decision 2's **"new board type (accept the schema bump)"** confirmation. Reuses
JD-3's privacy ADR; extend it for the initiator-capture change.
**Acceptance.** Clicking through a login→home flow in a Browser board produces a focus-defaulted RF
graph where an id returned by `POST /api/session` shows a dashed id-propagation edge to the subsequent
request that consumed it, and "→ Planning board" materializes the inferred ER as an editable Mermaid
diagram element.

---

## Cross-cutting invariants (every slice obeys)

- **Security (never weaken).** `contextIsolation`/`sandbox`/`nodeIntegration:false` untouched. Page-
  controlled strings (keys, values, URLs) are **React-escaped only — no `innerHTML` / no
  `dangerouslySetInnerHTML`** in any viewer. All new MAIN IPC is **frame-guarded by `isForeignSender`**
  exactly like `getOsrNetBody`. Browser-board content never reaches the PTY write channel.
- **Privacy (design-first, JD-3/JD-4).** Bodies-off by default; inventory + call graph need zero body
  access. **Shape, not values** — schema stores types/names/presence/format-hints, never raw values by
  default (example values = separate deeper opt-in + PII warning). Sampling/merge happens in MAIN,
  capped (`BODY_CAP` 5 MB); the renderer only ever receives merged **schemas**, never raw bodies, unless
  the user opens a row. Ephemeral by default; **export is the consent moment** and inherits `.canvas/`
  git-ignore-by-default.
- **No heavy deps.** Viewer + virtualizer are **vendored** (the perfect-freehand precedent). Only JD-4
  adds one runtime dep (`dagre`) for graph layout — justify in the PR.
- **Tokens.** Match `styles/tokens.css` / `browser-devtools.css`. **One accent** (`#4f8cff`),
  functional only; status colors (`--ok/--warn/--err`) for status only. The mocks are the visual
  contract (`mock-a` viewer, `mock-b`/`mock-c`/`mock-e` data flow) — de-rainbowed to Option A.
- **Schema.** Only **JD-4** bumps the schema (new board type → both tiers per ADR 0007). JD-1–JD-3 add
  **no** persisted state (the viewer + inventory are ephemeral) → no schema change.
- **Doc lifecycle.** This package lives at `docs/research/2026-06-23-json-dataflow-visualization/`. Each
  slice's spec/plan (if any) is **deleted in the PR that merges it** (build-history line is the residue);
  the research package collapses to a dated summary once the umbrella completes. The two ADRs (privacy
  sampling; and the board-type bump rides ADR 0007) land with their slice.
- **Gate.** Every slice: full local gate + e2e (`pnpm test:e2e:matrix`, both legs, at the pre-merge
  gate) + a manual dev check with `CANVAS_DEV_TITLE='PR#NNN JD-x …'`.

## Decision gates (resolve before the gated slice)

| # | Decision | Recommendation | Blocks | Status |
|---|---|---|---|---|
| 1 | JSON syntax palette | **Option A** default (accent-on-keys); Option B = opt-in toggle only | JD-1 | shown in `mock-d`; lock |
| 2 | Data Flow surface | panel tab (JD-3) → **new** RF board (JD-4); Mermaid export bridges | JD-3, JD-4 | agreed; confirm board+bump |
| 3 | P0 scope | tree + fold + Option A + Raw + truncation-tolerance; **no** virtualization/search until JD-2 | JD-1 | recommended; confirm |
| 4 | Privacy ADR | bodies-off default + MAIN capped sampling + shape-not-values | JD-3 | **write ADR before JD-3 MAIN code** |

## How to claim a slice (parallel sessions)

1. Spin a worktree off the **latest `origin/main`** (`.claude/tools/new-worktree.ps1`), branch
   `feat/jd-<n>-<slug>`.
2. Add your row to `.claude/coordination/ACTIVE-WORK.md` declaring the slice's **file zone** (copy the
   ownership table row). Lanes A (JD-1→JD-2) and B (JD-3→JD-4) are file-disjoint except the two `△`
   files JD-1 owns — coordinate those on the board first.
3. Build the slice to its **Acceptance** bar; run the full gate + e2e matrix; manual dev check with the
   PR stamp; open one PR per slice.
4. Merge sequentially into `main`, re-running the full matrix after each (the cross-OS insurance point).
   Signal via `signal-merge.ps1`; append the build-history line.

## Definition of done (umbrella)

- JD-1 shipped → the `<pre>` eyesore is gone; Network bodies render as a token-faithful collapsible
  tree (the user's original ask, satisfied standalone).
- JD-3 shipped → an honest API inventory + inferred schemas, body-free by default, opt-in for shapes,
  graceful on flat APIs.
- JD-2 + JD-4 shipped → viewer search/virtualization/a11y, and the Data-Flow board + Mermaid/agent
  export.
- Package collapsed to a build-history summary; two ADRs on `main`; all findings (H1–H7, M1/M4/M8/M9,
  A6) retired.
