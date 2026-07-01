# P3b handoff — `canvas://board/{id}/cards` read resource

> **For:** a fresh session picking up P3b of the MCP-canvas-awareness epic.
> **Branch:** work on the umbrella `feat/mcp-canvas-awareness-umbrella`
> (worktree `Z:\Canvas ADE\.worktrees\mcp-canvas-awareness`) **+** the sibling package repo
> `Z:\canvas-ade-mcp` branch `feat/canvas-layout` — same two-repo setup P1b/P3a/P5a used.
> **Author of this doc:** primary session that shipped P4.1/P4.2/P3a/P5a. Read the epic memory
> `mcp-canvas-awareness-epic.md` + `SPEC.md` (same dir) first.

## What P3b is

The **read half** that closes the card loop. P3a gave agents the WRITE tools
(`add_card`/`move_card`/`update_card`/`remove_card`); P3b gives them the READ resource so an agent
can see a Kanban board's live columns + cards **before** it mutates them (today it is card-blind —
`canvas://boards` exposes only id/type/title/status/geometry, no card content).

New resource: **`canvas://board/{id}/cards`** — a per-board, read-only JSON projection of one Kanban
board's lanes and cards. Direct sibling of the existing per-board read resources
`canvas://board/{id}/status` and `canvas://board/{id}/summary`.

**No UI. No schema change.** Package + host + renderer-snapshot only. Like P1b/P3a/P5a there is **no
in-app UI**, so:
- **No design artifact needed** (the "design-artifact-before-code" rule is UI-only — P3b is a JSON
  resource, same as P1b `canvas://layout`).
- **No manual dev-check, no e2e** (the resource is not consumed in-app until integration, same as
  P1b/P3a/P5a). Gate = typecheck/lint/format + unit + package contract tests.

## The one real decision: where does the host get the cards?

The host serves resources from the **live renderer→MAIN board mirror** (`boardRegistry.ts`), NOT from
`canvas.json`. Today the mirror carries **metadata only** (id/type/title/status/agentKind/
monitorActivity/path/fileRefs) **+ geometry** (x/y/w/h — P1a added it). It does **not** carry card
content.

**RECOMMENDED — option (A): ride the mirror (the P1a/geometry + fileRefs precedent).**
Thread a **bounded** kanban projection (`columns` + `cards`) onto the board snapshot, exactly the way
P1a threaded geometry and file-tree S5 threaded `fileRefs`. Then `boardCards(id)` reads it straight
off `registry.listBoards()` — zero new IPC, always fresh, one code path. Card content is small and
gets hard-capped (see caps below), so the "control plane; no content" comment on `BoardMirror` is
only mildly stretched — the same stretch `fileRefs` already made.

- Alternative (B) — on-read IPC round-trip renderer↔main per resource read. Leaner mirror, but new
  async infra + a new channel + foreign-frame guard, and it is NOT the established pattern. Only pick
  this if a reviewer objects to card content on the mirror. **Default to (A).**

Go with (A) unless you find a concrete blocker; note the choice in the PR body.

## Resource shape (recommended)

Grouped-by-column (agent-friendly — mirrors how `move_card` reasons and how the human sees it).
Within-column order = array order. Drop dangling cards (a `columnId` with no column) — the schema
already drops them on read, so a live board shouldn't have any; be defensive anyway.

```jsonc
{
  "boardId": "k1",
  "title": "Sprint plan",
  "isKanban": true,
  "columns": [
    { "id": "backlog", "title": "Backlog", "wip": null,
      "cards": [ { "id": "c1", "title": "One", "tag": "feature", "assignee": "claude", "ref": "PR #271" } ] },
    { "id": "in-progress", "title": "In Progress", "wip": 2, "cards": [] }
  ]
}
```

- Optional chips (`tag`/`assignee`/`ref`) omitted when absent (don't emit empty strings). `wip`: the
  number, or `null` when unset.
- **Board-not-found** → `throw new Error('canvas://board/{id}/cards: board not found: <id>')`
  (matches `boardStatus`).
- **Board exists but is not a Kanban** → return the graceful shell
  `{ boardId, title, isKanban: false, columns: [] }` (an agent may probe any id; don't throw). Mirror
  the empty-shell discipline of `boardOutput`/`boardSummary`.

## Files to touch (in order)

### 1. Renderer — put a bounded kanban projection on the snapshot
`src/renderer/src/store/boardStatus.ts`
- Extend `BoardSnapshotInput` to accept a kanban board's `columns`/`cards` (like it reads `elements`
  for planning fileRefs). Extend `BoardMirrorEntry` with an optional `kanban?: { columns, cards }`
  (bounded projection — NOT the raw arrays).
- In `buildBoardSnapshot`, when `b.type === 'kanban'`, project a **capped** `{ columns, cards }`
  (cap counts + field lengths — see caps) and spread it on only for kanban boards (byte-identical
  snapshot for every other type — keep the existing conditional-spread style).
- The publish hook that calls `buildBoardSnapshot` already passes the full `Board`; confirm it feeds
  `columns`/`cards` through (grep the caller — it's the same hook P1a wired for geometry).

### 2. Host — accept + sanitize the projection on the mirror
`src/main/boardRegistry.ts`
- Add the optional `kanban?: {...}` field to `BoardMirror` (doc it like the `fileRefs` field).
- In `sanitizeSnapshot`, validate/cap it (mcp:boards is an IPC channel — trust nothing). Add a
  `sanitizeKanban(input)` helper mirroring `sanitizeFileRefs`: cap columns (`MAX_KANBAN_COLUMNS`),
  cap cards (`MAX_KANBAN_CARDS`), each string field `MAX_FIELD_LEN`; `wip` kept only as a finite
  positive number; drop malformed entries; return `undefined` when empty so the field is omitted.

### 3. Host — the loopback method
`src/main/mcpOrchestrator.ts`
- Add `boardCards(boardId)` beside `boardStatus`/`boardSummary` (~line 444) / `describeLayout`
  (~line 1071). Read the board from `registry.listBoards()`, build the grouped shape above from its
  sanitized `kanban` projection. Non-kanban → `{ isKanban: false, columns: [] }` shell;
  missing → throw.
- Define the return type `BoardCards` host-side (host owns the shape, package types it `unknown` —
  same discipline as `LayoutDigest`).

`src/main/mcpRegistry.ts`
- Add `'boardCards'` to the `LifecycleOrchestrator` `Omit<Orchestrator, ...>` union (line ~93) and
  re-declare `boardCards(boardId): Promise<BoardCards>` in the intersection — copy the `describeLayout`
  narrowing block verbatim (it explains WHY: package declares `Promise<unknown>`; omitting from the
  base is a harmless no-op against installed 0.17.0 AND matches 0.18.0-rc.4 at integration).

### 4. Package (`Z:\canvas-ade-mcp`, branch `feat/canvas-layout`)
- `src/orchestrator/Orchestrator.ts` — declare `boardCards(boardId: BoardId): Promise<unknown>` on
  the `Orchestrator` interface, doc-commented like `describeLayout` (host owns the shape).
- `src/resources/boards.ts` — register the resource inside `registerBoardResources` (it serves BOTH
  tiers — observation is safe; card read is useful to a worker managing its own plan). Copy the
  `board-status` `ResourceTemplate('canvas://board/{id}/status', …)` block; name it `board-cards`,
  URI `canvas://board/{id}/cards`, handler calls `orchestrator.boardCards(id)`. Keep the
  `Array.isArray(variables.id) ? variables.id[0] : variables.id` + missing-id guard.
- `src/orchestrator/mock.ts` — add a `boardCards` stub returning a small fixture (mirror the
  `describeLayout`/`boardStatus` stubs) so the package's own tests + consumers compile.
- `src/prompts/canvas-orientation.ts` — add one line to the resource enumeration:
  `'- canvas://board/{id}/cards — one Kanban board's columns + cards (read-only).'` (the orientation
  prompt lists every read URI; keep it complete).
- Bump `package.json` → **`0.18.0-rc.4`**, tag `v0.18.0-rc.4`, push → the OIDC trusted-publish
  workflow publishes to npm under the `next` dist-tag (no token; `latest` stays `0.17.0`). See
  `mcp-publish-gating` / `mcp-npmjs-public-migration` memories.

## Caps (add to `Z:\canvas-ade-mcp\src\constants.ts` + mirror host-side)
P3a already added: `MAX_CARD_TITLE=200`, `MAX_CARD_TAG=40`, `MAX_CARD_ASSIGNEE=40`, `MAX_CARD_REF=80`
— reuse for the read sanitize. Add two count caps for the read projection:
`MAX_KANBAN_COLUMNS` (e.g. 50) and `MAX_KANBAN_CARDS` (e.g. 300 per board). Host `boardRegistry.ts`
gets its own local copies (the mirror sanitize can't import the package — the P1b "host does NOT
import from an installed package it predates" lesson).

## Security invariants (unchanged — do not weaken)
- `contextIsolation:true` / `nodeIntegration:false` / `sandbox:true` — untouched.
- The resource is **read-only** — no write, no PTY, no nonce/confirm. It exposes card TEXT the human
  already sees on-canvas; it must never expose anything else (no file content, no PTY bytes).
- `mcp:boards` is an IPC channel → **sanitize + cap** the kanban projection (never trust the payload
  wholesale); the foreign-frame guard on the channel is already in place — don't remove it.
- Card content is trusted-user text; it must **never** reach the PTY write channel (it doesn't here —
  this is a read path — just don't wire it to one).

## Tests + gate (no e2e, no UI)
- Renderer: `buildBoardSnapshot` unit — a kanban board projects a bounded `{columns,cards}`; every
  other type is byte-identical (no `kanban` field).
- Host: `sanitizeSnapshot` unit — caps counts, drops malformed cards/columns, `wip` only finite+positive.
- Host: `mcpOrchestrator` unit — `boardCards`: kanban → grouped columns w/ ordered cards + chips;
  non-kanban → `{isKanban:false, columns:[]}`; missing board → throws; dangling card dropped.
- Package: contract test for the resource registration + shape (copy the layout/board-status test).
- Run the gate with **nvm node 22.17** (`nvm use 22.17.0` then `corepack pnpm …` — node defaults to
  25 here and false-fails localStorage/metric tests; see `session-pnpm-via-nvm-node22`).
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` in BOTH repos.
- Watch the **max-lines(700, code-lines-only)** gate on `mcpOrchestrator.ts` / `boardRegistry.ts` —
  if `boardCards` tips one over, extract like P3a did (`mcpKanban.ts`) / P5a (`mcpVisualizeGate.ts`).

## Do NOT (deferred to umbrella→main integration — bundled with P1b/P3a/P5a)
- **Do NOT** bump the app's `@expanse-ade/mcp` pin or `pnpm install` in the worktree — it disturbs
  the shared node_modules other live worktrees junction to. The pin bump
  `^0.17.0`→`0.18.0-rc.4` + install happens ONCE on MAIN at integration.
- **Do NOT** touch `appModel.ts` `APP_TOOLS` — the F25 drift guard runs against the INSTALLED 0.17.0;
  adding anything now reds it. (A read *resource* isn't in the tool catalog anyway — F25 unaffected —
  but the pin/install is still integration-time.)
- The `canvas://board/{id}/cards` resource only serves LIVE once MAIN consumes the rc at integration.
  In-worktree it is proven by unit + package-contract tests only (same as P1b/P3a/P5a).

## Housekeeping before you start
- **Rebase first** — this worktree is stale (behind origin/main; PR #270 landed):
  `git fetch origin && git rebase origin/main`.
- CodeGraph indexes **MAIN**, not this worktree — it will NOT show the umbrella-only files
  (`kanbanSchema.ts`, `mcpKanban*.ts`, `layoutModel.ts`, the P1a mirror geometry). **Read the worktree
  files directly** for anything epic-specific; only trust CodeGraph for stable/main code.
- After it merges: update `SPEC.md` (P3b status bullet) + the `mcp-canvas-awareness-epic.md` memory,
  and add the epic's integration-owe list. Remaining after P3b: **P2** (`tidy_canvas` tool). Then the
  single umbrella→main integration (bundled pin bump + `APP_TOOLS` for the P3a/P5a tools + full e2e
  matrix).

## Reference points (read these, don't reinvent)
- Per-board read resource template: `Z:\canvas-ade-mcp\src\resources\boards.ts` (`board/{id}/status`)
  and `…\memory.ts` (`board/{id}/summary`).
- Digest resource + host loopback: `…\resources\layout.ts` + `mcpOrchestrator.ts` `describeLayout`
  (~1071) + `mcpRegistry.ts` `LifecycleOrchestrator` narrowing (~93-119).
- Mirror sanitize precedent: `src/main/boardRegistry.ts` `sanitizeSnapshot`/`sanitizeFileRefs`.
- Snapshot builder precedent: `src/renderer/src/store/boardStatus.ts` `buildBoardSnapshot`/`deriveFileRefs`.
- Kanban shapes: `src/renderer/src/lib/kanbanSchema.ts` (`KanbanCard`/`KanbanColumn`).
