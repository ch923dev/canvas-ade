# P2 handoff — `tidy_canvas` tool (reposition-only, undoable)

> **For:** a fresh session picking up P2 of the MCP-canvas-awareness epic — the LAST sub-phase before
> the single umbrella→main integration.
> **Branch:** work on the umbrella `feat/mcp-canvas-awareness-umbrella`
> (worktree `Z:\Canvas ADE\.worktrees\mcp-canvas-awareness`) **+** the sibling package repo
> `Z:\canvas-ade-mcp` branch `feat/canvas-layout` — same two-repo setup P1b/P3a/P5a/P3b used.
> **Author of this doc:** the session that shipped P3b. Read the epic memory
> `mcp-canvas-awareness-epic.md` + `SPEC.md` (same dir) first, and skim the P3b entry — P2 is the same
> shape (a WRITE tool this time, like P3a) but simpler.

## What P2 is

The `tidy_canvas` **tool** (a write-path tool) + a `tidyBoards` `McpCommand` that reaches the **already-
built, already-undoable** deterministic packer. Today an agent is spatially aware (P1 `canvas://layout`)
but **cannot act on it** — there is no tool and no command that repositions boards. P2 closes that: the
agent reads `canvas://layout`, decides the canvas is messy/overlapping, and calls `tidy_canvas` to
re-pack it into a clean, non-overlapping arrangement.

**The renderer engine already exists and is DONE** — this is the key simplifier:
- `src/renderer/src/lib/tidyLayout.ts` — pure deterministic packer, `tidyLayout(boards, opts):
  TidyPlacement[]`, three `TidyMode`s: **`smart`** (link-aware, the default/winner), **`by-type`**
  (terminals | browsers | planning columns), **`grid`** (shelf bin-pack). Reposition-only (w/h
  untouched), non-overlapping, anchored at the cluster's current top-left (camera doesn't teleport),
  `<2` boards = no-op.
- `canvasStore.tidyBoards(mode?, aspect?)` (`canvasStore.ts` ~L843) — already wired to it, already ONE
  **undoable** `trackedChange` step (no-ops when nothing moved → no phantom undo). This is what the
  `t` key / Tidy menu already calls.

So P2 is **just the MCP plumbing to that store action** — package tool → host method → `McpCommand` →
renderer applier that calls the existing `store.tidyBoards(...)`. No new layout math, no new UI.

**No schema change.** Package + host + shared-command + a one-line renderer applier case. Like
P3a/P5a there is **no in-app UI** and the tool is not consumed in-app until integration, so:
- **No design artifact** (the design-artifact-before-code rule is UI-only; this drives an existing
  store action, no new pixels).
- **No manual dev-check, no e2e** (the tool registers + serves live only at integration, same as
  P3a/P5a/P3b). Gate = typecheck/lint/format + unit + package contract tests.

## The one real decision: is `tidy_canvas` human-gated?

**RECOMMENDED — NO gate (content-less, the `spawn_group` precedent + undo safety net).**
The write-time human-confirm gate exists for **attacker-influenceable CONTENT** (handoff/assign/relay
PTY writes, `add_planning_elements`, the card tools, `visualize_plan`). `tidy_canvas` writes **no
content** — it only repositions boards that already exist. Like `spawn_group` (content-less cluster
create → cap-checked, NOT human-gated), it carries no exec vector and no text. And it is **fully
reversible in one Ctrl+Z** (`tidyBoards` is a single `trackedChange` step) — the safety net a content
write doesn't have. So: **register it un-gated, orchestrator-tier** (see tiering below).

- Alternative — gate it behind a confirm anyway (reuse the `add_planning_elements` gate). Only pick
  this if the maintainer wants every agent-driven canvas move to pause for a human. **Default to
  un-gated** and note the choice in the PR body; the undo step is the backstop.

Whatever you pick, keep it **reposition-only** — `tidy_canvas` must NEVER resize (`w/h`), create, or
delete a board (the packer already guarantees this; don't add a path that does).

## Tiering: orchestrator-only, or both tiers?

**RECOMMENDED — orchestrator-tier only** (mirror `spawn_group`: registered only inside the
orchestrator block in `factory.ts`, absent from a worker/connected `tools/list`). Repositioning the
whole canvas is an orchestrator-scope act — a single connected worker shouldn't rearrange everyone
else's boards. (If you later want a connected agent to tidy only ITS OWN zone, that's the `boardIds`
subset param below + a connected registration — treat as a stretch, not the MVP.)

## Tool shape (recommended)

```jsonc
// tool: tidy_canvas   (orchestrator-tier, un-gated)
{
  "mode": "smart",           // optional: "smart" | "by-type" | "grid"; default "smart"
  "boardIds": ["k1", "t2"]   // optional subset to tidy; omit ⇒ the whole canvas (MVP: whole-canvas only)
}
// returns:  { "moved": 3 }  // count of boards whose position changed (0 ⇒ already tidy)
```

- **`mode`** maps 1:1 to `TidyMode` (`smart`/`by-type`/`grid`). This IS the "orientation" the SPEC
  mentions — the epic folded lengthwise/crosswise into "a mode the agent picks", so expose `mode`, not
  a separate orientation knob. Reject an off-enum value at the Zod layer.
- **`boardIds` (subset)** — **RECOMMEND deferring to a stretch/skip for the MVP.** `canvasStore.tidyBoards`
  tidies ALL boards; a subset needs a NEW scoped store action (`tidyLayout(boards.filter(...), {mode})`
  → apply placements to only those ids in one `trackedChange`). Ship whole-canvas first (mode-only);
  add the subset action + param if the maintainer wants zone-scoped tidy. **`log`/note the drop** so a
  reviewer knows subset was intentionally scoped out, not forgotten.
- **return** — the moved COUNT is useful agent feedback ("already tidy" vs "moved 3"). Host owns the
  return type (package types it `unknown`, like `describeLayout`/`boardCards`), OR return `void` if you
  prefer parity with `add_planning_elements`. Count is nicer; your call.

## Files to touch (in order)

### 1. Shared command union
`src/shared/mcpTypes.ts`
- Add a `McpCommand` variant: `{ type: 'tidyBoards'; mode?: 'smart' | 'by-type' | 'grid'; aspect?: number; boardIds?: string[] }`.
  (Include `aspect` only if you want the agent to tune `grid` — optional; `tidyBoards` already accepts
  it.) Doc-comment it in the union JSDoc block like `patchKanban`/`spawnGroup`: "reposition-only,
  content-less, one undoable step; the renderer re-validates + calls the existing `tidyBoards` action."

### 2. Renderer — the applier case (the store action already exists)
`src/renderer/src/store/useMcpCommands.ts` — `applyMcpCommand` switch (`~L49`; add a `case 'tidyBoards'`
beside `case 'spawnGroup'` `~L213`)
- Validate the envelope (defense in depth, mirroring the `spawnGroup` case): `mode`, if present, must
  be one of the three; drop/ignore anything else (fall back to `'smart'`). Then call
  `useCanvasStore.getState().tidyBoards(mode, aspect)` and `return { ok: true, type: 'tidyBoards' }`.
- **`tidyBoards` is ALREADY ONE undoable `trackedChange` step + no-ops when nothing moved** — do NOT
  wrap it in `beginChange()` (that's for the additive card/planning writes); just call it. This is the
  whole reason P2 is small.
- If you do the subset stretch: add `tidyBoardsSubset(ids, mode)` to `canvasStore.ts` (filter →
  `tidyLayout` → apply placements to those ids in one `trackedChange`, same no-op guard) and call that
  when `boardIds` is present.

### 3. Host — the orchestrator method
`src/main/mcpOrchestrator.ts`
- Add `tidyCanvas(input)` beside the other write methods. It is SIMPLE (no cap, no mint, no sanitize,
  no confirm if un-gated): validate `mode`, `await registry.sendCommand({ type: 'tidyBoards', mode,
  boardIds })`, and (optionally) return the moved count if you have the ack carry it (or just resolve).
  If un-gated it does not touch `requestConfirm`/`writeAudit` (a structural reposition is not a
  dispatch — but you MAY audit a `tidied` line if you want the forensic trail; not required).
- **⚠️ `mcpOrchestrator.ts` is AT the max-lines(700) cap.** P3b/P5a paid this tax by EXTRACTING. Put
  the method body in a small factory (e.g. `createTidyMethod({ sendCommand })` in a new
  `src/main/mcpTidy.ts`) and spread `...createTidyMethod(...)` into the return literal — copy the
  `createBoardCardsMethod` (P3b, `mcpBoardCards.ts`) / `createVisualizeMethod` (P5a) pattern EXACTLY.
  Do NOT bump the ratchet (pins move DOWN only — `docs/contributing/file-size-doctrine.md`).

`src/main/mcpRegistry.ts`
- Add `'tidyCanvas'` to the `LifecycleOrchestrator` `Omit<Orchestrator, …>` union and re-declare
  `tidyCanvas(input): Promise<…>` in the intersection — copy the `boardCards`/`describeLayout`
  narrowing block verbatim (WHY: the package declares it `Promise<unknown>`; omitting from the base is
  a harmless no-op against installed 0.17.0 AND matches 0.18.0-rc.5 at integration).

`src/main/appModel.ts`
- **DO NOT add `'tidy_canvas'` to `APP_TOOLS` in the worktree.** `tidy_canvas` IS a tool (unlike P3b's
  read resource), so the F25 drift guard (`appModelDrift.test.ts`) runs `APP_TOOLS` against the
  INSTALLED 0.17.0 (which lacks it) — adding it now REDS the guard. It is deferred to integration WITH
  the pin bump, bundled with P3a's +4 card tools and P5a's `visualize_plan` (see the epic's
  "integration owes" list). This is the ONE thing that differs from P3b (a read resource wasn't in the
  tool catalog, so F25 was unaffected there).

### 4. Package (`Z:\canvas-ade-mcp`, branch `feat/canvas-layout`)
- `src/constants.ts` — `export const TOOL_TIDY_CANVAS = 'tidy_canvas'`. Add `TIDY_MODES = ['smart',
  'by-type', 'grid'] as const` for the Zod enum + a `MAX_TIDY_BOARD_IDS` cap (e.g. 500) if you do the
  subset param.
- `src/server/tools/tidyCanvas.ts` — NEW, copy `spawnGroup.ts` (the content-less tool template):
  `registerTidyCanvas(server, orchestrator)`, `server.registerTool(TOOL_TIDY_CANVAS, { description,
  inputSchema: { mode: z.enum(TIDY_MODES).optional(), boardIds: z.array(z.string()).max(...).optional() } },
  async (args) => { const r = await orchestrator.tidyCanvas(args); return { content: [{ type: 'text',
  text: JSON.stringify(r) }] } })`.
- `src/server/factory.ts` — call `registerTidyCanvas(server, this.orchestrator)` **inside the
  orchestrator-tier block** (beside `registerSpawnGroup`, `~L114`) so it is orchestrator-only. (If you
  chose the un-gated+orchestrator recommendation, it needs NO `planningWrite` guard — it is not a
  content write. Confirm you are NOT putting it behind the `if (planningWrite)` block.)
- `src/orchestrator/Orchestrator.ts` — declare `tidyCanvas(input: { mode?: string; boardIds?: string[] }):
  Promise<unknown>` on the `Orchestrator` interface, doc-commented like `describeLayout` (host owns the
  return shape).
- `src/orchestrator/mock.ts` — add a `tidyCanvas` stub returning a small fixture (`{ moved: 0 }`) so the
  package tests + consumers compile.
- `src/prompts/canvas-orientation.ts` — the orientation prompt lists tools implicitly via the tier
  synopsis; add `tidy_canvas` to the orchestrator capability line if you list write tools there
  (optional — check whether spawn_group is enumerated; match that level of detail).
- Bump `package.json` → **`0.18.0-rc.5`**, tag `v0.18.0-rc.5`, push → the OIDC trusted-publish workflow
  publishes to npm under the `next` dist-tag (no token; `latest` stays `0.17.0`). **Confirm the tool
  shape with the maintainer before publishing** (the P3b protocol). See `mcp-publish-gating` /
  `mcp-npmjs-public-migration` memories. Prior tip is `v0.18.0-rc.4` (P3b).

## Caps (package `src/constants.ts` + mirror host-side if you do subset)
`tidy_canvas` carries no free text, so no length caps. If you implement `boardIds`, cap the array
(`MAX_TIDY_BOARD_IDS`, e.g. 500 — matches `MAX_BOARDS`) at the Zod layer AND re-cap host-side; an id
not on the canvas is silently ignored by the packer (harmless), so no per-id validation beyond length.

## Security invariants (unchanged — do not weaken)
- `contextIsolation:true` / `nodeIntegration:false` / `sandbox:true` — untouched.
- **Reposition-only.** The command must NEVER carry `w/h`, create, or delete a board. The packer
  guarantees this; the renderer applier must not add a resize/create path under `tidyBoards`.
- `sendMcpCommand` is the ONLY MCP→canvas write path (frame-guarded). Route through it, don't add a
  new channel.
- No PTY, no content, no nonce — `tidy_canvas` is a structural reposition, not a dispatch. Do not wire
  it to the PTY write channel.

## Tests + gate (no e2e, no UI)
- Renderer: `useMcpCommands` unit — a `tidyBoards` command calls `store.tidyBoards(mode)` (spy) and
  acks `{ ok: true, type: 'tidyBoards' }`; an off-enum `mode` falls back to `smart`; (subset variant, if
  built, routes to `tidyBoardsSubset`). `canvasStore.tidyBoards` itself is ALREADY covered
  (`canvasStore.test.ts` `describe('tidyBoards')`) — don't duplicate; test the applier wiring.
- Host: `mcpOrchestrator` unit — `tidyCanvas` forwards a `tidyBoards` `sendCommand` with the right mode
  (+ boardIds when present); an invalid mode is normalized/rejected per your choice.
- Package: contract test for `tidy_canvas` registration + tier — copy `spawnGroup`'s contract test:
  orchestrator `tools/list` INCLUDES `tidy_canvas`; worker + connected `tools/list` OMIT it; a call
  round-trips to the mock. (Mirror `test/contract/` naming.)
- Run the gate with **nvm node 22.17** (node defaults to 25 here → false-fails; see
  `session-pnpm-via-nvm-node22`): `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` in
  BOTH repos. NOTE: the **package repo's `format:check` is RED on ~82 pre-existing files** — keep YOUR
  touched files prettier-clean (`npx prettier --write <your files>`); do NOT sweep the other 82 (out of
  scope). The app repo's `format:check` must be fully clean.
- Watch the **max-lines(700)** gate on `mcpOrchestrator.ts` — extract (see step 3) if `tidyCanvas` tips
  it over (it will; the file is at the cap).

## Do NOT (deferred to umbrella→main integration — bundled with P1b/P3a/P5a/P3b)
- **Do NOT** bump the app's `@expanse-ade/mcp` pin or `pnpm install` in the worktree (shared
  node_modules landmine). The pin bump `^0.17.0`→`0.18.0-rc.5` + install happens ONCE on MAIN at
  integration.
- **Do NOT** add `'tidy_canvas'` to `appModel.ts` `APP_TOOLS` now — it reds the F25 drift guard against
  installed 0.17.0. Bundle it with the P3a card tools + P5a `visualize_plan` at integration.
- The `tidy_canvas` tool registers + serves LIVE only once MAIN consumes the rc at integration. In the
  worktree it is proven by unit + package-contract tests only (same as P3a/P5a/P3b).

## Housekeeping before you start
- **Rebase first** — `git fetch origin && git rebase origin/main` (the umbrella worktree drifts behind
  main). The P3b commit `ab649b32` is the current umbrella tip; package tip is `8991b1c` /
  `v0.18.0-rc.4`.
- CodeGraph indexes **MAIN**, not this worktree — it will NOT show the umbrella-only files
  (`kanbanSchema.ts`, `mcpKanban*.ts`, `mcpBoardCards.ts`, `layoutModel.ts`, the P1a mirror geometry).
  **Read the worktree files directly** for anything epic-specific.
- After it merges: update `SPEC.md` (P2 status bullet — the epic is then feature-complete, only the
  single umbrella→main integration remains) + the `mcp-canvas-awareness-epic.md` memory. **P2 is the
  LAST sub-phase** — once it lands, the next (and final) step is the **umbrella→main integration**:
  rebase, bump the app pin `^0.17.0`→`0.18.0-rc.5` + `pnpm install` on MAIN, add ALL deferred tools to
  `APP_TOOLS` (`add_card`/`move_card`/`update_card`/`remove_card` + `visualize_plan` + `tidy_canvas` —
  NOT `boardCards`, a resource), and run the FULL e2e matrix (both legs) at the single pre-merge gate.

## Reference points (read these, don't reinvent)
- Content-less tool template (package): `Z:\canvas-ade-mcp\src\server\tools\spawnGroup.ts` +
  `registerSpawnGroup` (factory.ts `~L114`, orchestrator-tier, NO `planningWrite` guard).
- The applier case pattern: `src/renderer/src/store/useMcpCommands.ts` `case 'spawnGroup'` (`~L213`) /
  `case 'patchKanban'` (`~L180`) — envelope re-validate → store call → ack.
- The existing tidy engine + store action: `src/renderer/src/lib/tidyLayout.ts` (`tidyLayout`, the
  three modes) + `canvasStore.ts` `tidyBoards` (`~L843`, undoable `trackedChange`, no-op guard).
- The max-lines extract pattern: `src/main/mcpBoardCards.ts` `createBoardCardsMethod` (P3b) /
  `src/main/mcpVisualizeGate.ts` `createVisualizeMethod` (P5a) + their `...spread` in
  `mcpOrchestrator.ts`'s return literal.
- LifecycleOrchestrator narrowing: `src/main/mcpRegistry.ts` (`boardCards`/`describeLayout` Omit+
  re-declare blocks).
- Shared command union: `src/shared/mcpTypes.ts` `McpCommand` (add the `tidyBoards` variant next to
  `spawnGroup`).
