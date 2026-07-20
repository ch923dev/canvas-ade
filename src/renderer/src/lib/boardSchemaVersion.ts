/**
 * Schema version constants — kept in a DEPENDENCY-FREE module so any consumer (renderer OR a
 * main-side lock-step test) can import the authoritative numbers WITHOUT dragging in the rest of
 * boardSchema's module graph (which transitively imports DOM-only code via terminalFont, breaking
 * the node tsconfig). `boardSchema.ts` re-exports these; MAIN's `projectStore.ts` hand-mirrors them
 * (a renderer→main import is avoided in shipped code) and a lock-step test asserts parity (BUG-013/014).
 *
 * Bump on any breaking change to the persisted shape and add a migration in `boardSchema.ts`.
 *
 * SCHEMA-VERSION CLAIM:
 * - v5 = MCP M2 — spatial connectors.
 * - v6 = board groups (named board clusters, #84). Backfills an empty `groups` array.
 * - v7 = free-text typography tokens (fontFamily / fontSize / align / color / bold — all optional on
 *   TextElement; defaulted at render time). Identity migration. #84 took v6 first, so v6 → v7 (ADR 0004).
 * - v8 = optional TextElement.width (area-text wrap-box width in board px). All-optional → identity bump.
 * - v9 = optional root `background` (canvas backdrop). Optional + defaulted-at-read → identity bump.
 * - v10 = optional TerminalBoard `agentKind` + `monitorActivity` (New Terminal agent presets). Both
 *   optional + defaulted-at-read → identity bump; ADDITIVE so MIN_READER_VERSION stays 9.
 * - v11 = the Planning `diagram` element kind (S4 — Mermaid Diagram). A NEW element kind is
 *   BREAKING per ADR 0007: a pre-11 validator's `assertPlanningElement` default branch throws on
 *   the unknown kind, so the compat floor moves to 11 too (see MIN_READER_VERSION below). The
 *   migration itself is identity (the kind only appears on newly-authored diagram elements).
 *   Do not silently reuse a version for a new shape.
 * - v12 = the `command` board TYPE (Command board, Phase A). A NEW board type is BREAKING per
 *   ADR 0007: a pre-12 validator's `assertBoard` default branch throws on the unknown type, so the
 *   compat floor moves to 12 too. The migration is identity (the type only appears on newly-authored
 *   command boards; the orchestrator's task queue is ephemeral `commandStore` state, never serialized,
 *   so a persisted command board is just `BoardCommon` with `type:'command'` — no new fields).
 * - v13 = the file-tree epic foundation (S1). Adds TWO new persisted kinds at once: the `'file'`
 *   BOARD type (an on-canvas file viewer/editor; `path` relative to the project root, absent =
 *   unbound placeholder) AND the `'fileref'` Planning ELEMENT kind (a clickable file-reference
 *   chip). Both are BREAKING per ADR 0007 — a pre-13 `assertBoard`/`assertPlanningElement` throws
 *   on the unknown type/kind — so the compat floor moves to 13 too (MIN_READER_VERSION below). The
 *   migration is identity (the new type/kind only appear on newly-authored content). The
 *   foundation slice owns the ENTIRE v13 bump; S2-S5 add zero schema (KICKOFF §6 bump coordination).
 * - v14 = the `dataflow` board TYPE (JD-4 — the Data-Flow board, JD umbrella close-out). A NEW board
 *   type is BREAKING per ADR 0007: a pre-14 `assertBoard` default branch throws on the unknown type,
 *   so the compat floor moves to 14 too. The migration is identity (the type only appears on
 *   newly-authored boards). The board persists only `BoardCommon` + an optional `sourceBoardId`
 *   (the Browser board whose captured traffic it visualizes — mirrors `BrowserBoard.previewSourceId`);
 *   the inferred model (endpoints/schemas/entities/lineage) is body-derived + EPHEMERAL (ADR 0010) and
 *   is NEVER serialized (export to `.canvas/memory/` is the consent moment), so there are no new
 *   body-derived persisted fields.
 * - v15 = two new BrowserBoard viewport presets — `qhd` (2560×1440, "1440p") and `uhd`
 *   (3840×2160, "4K") — extending the closed `BrowserViewport` enum past mobile/tablet/desktop.
 *   The values only appear on newly-selected boards, so existing docs have nothing to backfill
 *   (identity migration). BREAKING (floor → 15): a pre-15 `assertBoard` rejects the unrecognized
 *   viewport string and would fail the whole doc, so the compat floor moves to 15 for the clean
 *   "update the app" message. This bump ALSO introduces the forward-compat clamp in `fromObject`
 *   (an UNRECOGNIZED viewport coerces to `desktop` instead of failing) — so this is the LAST
 *   viewport-enum floor bump: every future preset value rides through additively (floor stays 15).
 * - v16 = optional TerminalBoard `themeId` + `fontFamilyId` (terminal theming, Lane B). Both are
 *   closed-registry ids (terminalThemes.ts) persisted as free strings + defaulted/degraded at read,
 *   so this is ADDITIVE (writer-only bump, floor STAYS 15 — ADR 0007): an older reader ignores the
 *   unknown keys, and `assertBoard` only type-checks them as strings (it does NOT reject an unknown
 *   id), so a doc carrying a future theme id never fails validation. The migration is identity.
 * - v17 = the `kanban` board TYPE (MCP canvas-awareness epic, P4) — a dedicated full-board
 *   Trello-style plan visualizer. Unlike the `command`/`dataflow` boards (ephemeral bodies), a
 *   Kanban board PERSISTS its content: ordered `columns` + a flat `cards` list (each card bound to a
 *   column by `columnId`, so an MCP `move_card` is a single-field patch and within-column order is
 *   array order — mirrors Planning's `elements[]`). A NEW board type is BREAKING per ADR 0007: a
 *   pre-17 `assertBoard` default branch throws on the unknown type, so the compat floor moves to 17
 *   too (see MIN_READER_VERSION below). The migration is identity (the type only appears on
 *   newly-authored kanban boards).
 * - v18 = optional Planning ELEMENT appearance props on `ElementCommon` — `opacity` (0.1–1, all
 *   kinds), `strokeColor` + `strokeWidth` tokens (line kinds: arrow / pen). All optional +
 *   defaulted-at-read (absent ⇒ opaque / the kind's legacy ink + width), so this is ADDITIVE (Board
 *   Inspector P4b): writer-only bump, floor STAYS 17. An older reader ignores the unknown optional
 *   keys and they survive the `fromObject` structuredClone round-trip; `assertPlanningElement`
 *   range/token-checks them without rejecting the element. z-order is a pure `elements[]` reorder
 *   (paint order == array order) → NO schema change. (History: the board-inspector umbrella claimed
 *   this as `17` while main independently shipped the breaking Kanban v17 — re-sequenced to 18 at
 *   the epic-end umbrella→main merge exactly as the claim's re-number hazard note prescribed;
 *   ADR 0007 worktree-skew version-collision class.)
 * - v19 = optional Kanban CARD detail fields on `KanbanCard` — `description` (plain text), `tags`
 *   (string list, supersedes the singular `tag` which is still read as a fallback), and `fileRefs`
 *   ({path, line?, endLine?} — file+line pointers the card-detail modal opens on click) — PLUS the
 *   optional board-level COLUMN AXIS on `KanbanBoard`: `columnAxis` ('flow' | 'category') + `axisLabel`
 *   (what the columns group by; drives the modal column-field label). All optional + defaulted-at-read
 *   (absent ⇒ no description / fall back to `tag` / no refs / axis = 'flow'), so this is ADDITIVE
 *   (card-detail + column-axis epic): writer-only bump, floor STAYS 17. An older reader ignores the
 *   unknown optional keys and they survive the `fromObject` structuredClone round-trip;
 *   `assertKanbanContent` shape-checks them without rejecting the card/board. The migration is identity
 *   (no data rewrite — a pre-v19 board/card simply carries none of the new fields).
 * - v20 = optional TerminalBoard `openRouter` ({enabled, model?}) — per-board OpenRouter routing
 *   intent (maintainer-private, compile-gated __TERMINAL_OPENROUTER__; ungated builds validate +
 *   round-trip the field, render no UI, inject no env). Optional + defaulted-at-read (absent ⇒ no
 *   routing) → ADDITIVE: writer-only bump, floor STAYS 17. The API key is NOT in the doc — it
 *   lives only in the encrypted llmKeyStore (canvas.json is git-trackable).
 * - v21 = the DiagramElement `'expanse'` ENGINE (diagram-viz Phase 1): `engine` widens
 *   'mermaid' → 'mermaid'|'expanse'; `source` becomes engine-conditional (required for mermaid,
 *   absent for expanse); NEW `spec` (the structured DiagramSpec — diagramSpec.ts) is canonical for
 *   expanse; NEW optional `importedFrom` preserves the original Mermaid source on conversion. A new
 *   ELEMENT CAPABILITY is BREAKING per ADR 0007: a pre-21 `assertPlanningElement` diagram case
 *   hard-fails `engine !== 'mermaid'` AND `typeof source !== 'string'`, so a doc carrying an
 *   expanse diagram dies deep validation on any older reader — the compat floor moves to 21 too
 *   (MIN_READER_VERSION below). The migration is identity (the engine value only appears on
 *   newly-authored expanse elements; every existing diagram element already satisfies the
 *   mermaid branch unchanged).
 * - v22 = optional DiagramElement `revisions` (diagram-viz Phase 2, B4) — a capped (20) list of
 *   `{spec, ts, author}` snapshots of an expanse diagram's PRIOR specs, captured when a tracked
 *   elements patch replaces a spec (boardPatch.withSpecRevisions) and scrubbed read-only from the
 *   card header. Optional + defaulted-at-read (absent ⇒ no history) → identity bump; ADDITIVE so
 *   MIN_READER_VERSION stays 21 (a pre-22 reader ignores the unknown optional key on the element
 *   and it rides through the structuredClone round-trip; assertPlanningElement's expanse case
 *   validates only known fields).
 */
export const SCHEMA_VERSION = 22

/**
 * Two-tier versioning (ADR 0007): the compat floor stamped into every written doc as
 * `minReaderVersion` — the lowest SCHEMA_VERSION an app needs to read what we write.
 *
 * - ADDITIVE change (new OPTIONAL fields, defaulted at read): bump SCHEMA_VERSION only.
 *   Older readers (>= this floor) still open the doc; unknown optional fields ride through
 *   fromObject's structuredClone and survive a save round-trip.
 * - BREAKING change (new board type / element kind, a semantic change an older validator rejects or
 *   misreads, or a NEW DOC-LEVEL KEY — toObject rebuilds the root object, so an older reader's save
 *   would DROP it): bump BOTH to the same value.
 *
 * Floor was 9 (v9's root `background` key — a v8 reader would DROP the user's wallpaper on its next
 * save). Floor moved to 11 with the v11 `diagram` element kind (S4): an app older than 11 has no
 * `diagram` case in `assertPlanningElement`, so it would HARD-FAIL deep validation on a doc that
 * contains one. Floor moved to 12 with the v12 `command` board type (Phase A): an app older than 12
 * has no `command` case in `assertBoard`, so it would HARD-FAIL on a doc containing one. Floor moves
 * to 13 with the v13 `file` board type AND `fileref` element kind (file-tree S1): an app older than
 * 13 has no `file` case in `assertBoard` nor a `fileref` case in `assertPlanningElement`, so it would
 * HARD-FAIL deep validation on a doc that contains either. Stamping `minReaderVersion: 13` makes
 * pre-13 apps show the clean "update the app to open it" message (assertReadableVersion) instead of a
 * confusing `.bak`-fallback parse failure. Floor moves to 14 with the v14 `dataflow` board type
 * (JD-4): an app older than 14 has no `dataflow` case in `assertBoard`, so it would HARD-FAIL on a doc
 * containing one — pre-14 apps get the clean update-the-app message instead. Floor moves to 15 with the
 * v15 `qhd`/`uhd` viewport presets: an app older than 15 has those values absent from its `VIEWPORTS`
 * set, so `assertBoard` rejects a board carrying one and would `.bak`-fallback. Stamping
 * `minReaderVersion: 15` gives the clean update prompt instead. v15 is the LAST viewport floor bump —
 * it adds the `fromObject` clamp (unknown viewport → `desktop`), so every app from 15 on reads all
 * future additive viewport docs. Floor moves to 17 with the v17 `kanban` board type (P4): an app
 * older than 17 has no `kanban` case in `assertBoard`, so it would HARD-FAIL on a doc containing one
 * — pre-17 apps get the clean "update the app to open it" message instead of a `.bak`-fallback. (v16
 * was additive and left the floor at 15; v17 is the next breaking bump, moving BOTH to 17. Floor
 * STAYS 17 through v18, v19 AND v20 — the Planning element appearance props (v18), the Kanban
 * card-detail fields (v19), and the TerminalBoard `openRouter` field (v20) are all ADDITIVE.)
 * Floor moves to 21 with the v21 `'expanse'` diagram engine: a pre-21 reader's diagram case
 * requires `engine === 'mermaid'` and a string `source`, so it would HARD-FAIL deep validation on
 * a doc containing an expanse-engine diagram — stamping `minReaderVersion: 21` gives pre-21 apps
 * the clean "update the app to open it" message instead of a confusing `.bak`-fallback. A doc with
 * only mermaid diagrams still READS on older apps once written, but ADR 0007 floors are stamped by
 * CAPABILITY, not per-doc content (the v11/v13 precedent). (Floor STAYS 21 through v22 — the
 * DiagramElement `revisions` field is ADDITIVE.)
 */
export const MIN_READER_VERSION = 21
