# SPEC-W1-D — shared MCP type module

**Wave:** 1 · **Priority:** P0 · **Source findings:** F9 · **Type:** refactor/cross-bundle · **Repos/zones:** `src/main/mcpCommand.ts`, `src/renderer/src/store/useMcpCommands.ts`, `src/renderer/src/store/planningMcpApply.ts`, `src/renderer/src/canvas/AuditLogViewer.tsx`, `tsconfig.node.json`, `tsconfig.web.json`, `tsconfig.preload.json`

---

## 1. Problem

**Quoted from F9 (MED — Security/Correctness):**

> `McpCommandIn`/`PlanningOp`/`AuditEntry` hand-mirrored across bundle split, no compile-time safety — `useMcpCommands.ts:15`, `AuditLogViewer.tsx:15`

The MAIN → renderer control channel is typed by three independent definitions that must stay in sync but have no mechanism for enforcing it:

- **`McpCommand`** (the union MAIN sends) is defined in `src/main/mcpCommand.ts` and is explicitly documented as "the single source of truth." Its comment even calls out the renderer's manual mirror: *"the renderer applier (`useMcpCommands`, a separate bundle) mirrors it by hand."*
- **`McpCommandIn`** (the renderer's receiver type) is a verbatim copy in `src/renderer/src/store/useMcpCommands.ts:17–37`. The two unions diverge silently if a developer adds a variant on one side and forgets the other. Today both define the same six variants (`ping`, `addBoard`, `removeBoard`, `configureBoard`, `patchPlanning`, `spawnGroup`) and `McpCommandAck`/`McpAck` — but this is coincidence maintained by convention, not by the compiler.
- **`PlanningOp`** and **`PlanningOpTint`** are separately defined in both `src/main/mcpCommand.ts` (exported from MAIN) and `src/renderer/src/store/planningMcpApply.ts:24–35`. The renderer's `planningMcpApply.ts` comment explicitly says: *"Renderer mirror of MAIN's `PlanningOp` (`src/main/mcpCommand.ts`) — kept in sync BY HAND."*
- **`AuditEntry`** is exported from `src/main/auditLog.ts` and locally re-declared as an identical `interface AuditEntry` in `src/renderer/src/canvas/AuditLogViewer.tsx:15–25` with the comment: *"Mirror of the MAIN/preload `AuditEntry` (type-only; kept local to avoid a cross-bundle import)."*

**Why this must precede new command variants (W2/W3 skill/recipe dispatch):**

Every new command variant for skill dispatch (e.g. a `runSkill` or `dispatchRecipe` envelope planned in Wave 2/3) must be added to the `McpCommand` union. If the renderer's `McpCommandIn` is a separate, hand-mirrored copy, a new variant added to MAIN will compile cleanly, serialize over IPC, and arrive in the renderer — where `applyMcpCommand`'s `default:` branch will silently return `{ ok: false, error: 'unknown command' }`. No type error. No test failure unless an e2e probe hits that exact new path. This is the silent-drift failure mode: new surface added with false confidence, discovered only at runtime. Extracting the shared module first gives every future variant exactly one place to define and one `pnpm typecheck` run to validate both sides agree.

---

## 2. Goal & non-goals

**Goal:** Extract the three sets of hand-mirrored type definitions into a single TYPE-ONLY module (`src/shared/mcpTypes.ts`) imported by both MAIN and the renderer, so the union is defined once and mismatches between the two processes are caught by `pnpm typecheck` before any code ships.

**Non-goals:**

- No behaviour change of any kind. `applyMcpCommand`, `sendMcpCommand`, `materializePlanningOps`, `createAuditLog`, `AuditLogViewer` — all logic stays exactly where it is. Only the type declarations move.
- No runtime import across the process boundary. The module emits zero runtime JavaScript; it is `import type`-only on the renderer side and a type-only re-export on the MAIN side.
- No new tsconfig project or build target. The three existing tsconfig projects (`node`, `preload`, `web`) each need only one `include` path addition.
- No schema or persistence changes. `AuditEntry` lives in the JSONL log on disk; its shape is not changed.
- No package version bump to `@expanse-ade/mcp`. All changes are in the app repo only.

---

## 3. Design

### New module path

```
src/shared/mcpTypes.ts
```

`src/shared/` does not currently exist. It is the natural home for a cross-bundle type-only contract in an electron-vite repo: equidistant from `src/main/`, `src/preload/`, and `src/renderer/`. The name `mcpTypes.ts` is explicit about scope (MCP control-plane types only).

### Types that move

| Type | Current definition | Moves to `src/shared/mcpTypes.ts` |
|---|---|---|
| `McpCommand` (union) | `src/main/mcpCommand.ts:29–49` | yes — re-exported from MAIN as `export type { McpCommand } from '../shared/mcpTypes'` |
| `PlanningOpTint` | `src/main/mcpCommand.ts:52` | yes |
| `PlanningOp` | `src/main/mcpCommand.ts:66–71` | yes |
| `McpCommandAck` | `src/main/mcpCommand.ts:74` | yes |
| `McpCommandIn` | `src/renderer/src/store/useMcpCommands.ts:17–37` | deleted (was a mirror of `McpCommand`; renderer now imports the canonical type) |
| `McpAck` | `src/renderer/src/store/useMcpCommands.ts:40` | deleted (was a mirror of `McpCommandAck`; renderer now imports the canonical type) |
| `PlanningOpTint` (renderer copy) | `src/renderer/src/store/planningMcpApply.ts:24` | deleted (was a mirror) |
| `PlanningOp` (renderer copy) | `src/renderer/src/store/planningMcpApply.ts:30–35` | deleted (was a mirror) |
| `AuditEntry` (renderer copy) | `src/renderer/src/canvas/AuditLogViewer.tsx:15–25` | deleted (was a mirror) |
| `AuditEntry` (canonical) | `src/main/auditLog.ts:35–46` | stays in `auditLog.ts` — re-exported from `src/shared/mcpTypes.ts` via `export type { AuditEntry } from '../main/auditLog'` OR inlined; see §3 "AuditEntry placement" below |

### Detailed module content

`src/shared/mcpTypes.ts` is a **declaration-only** file: no imports of values, no `import` of Electron types, no Node built-ins. It must compile cleanly under all three tsconfigs (node / preload / web). Accordingly it must be self-contained — it cannot re-export from `src/main/auditLog.ts` (which imports `node:fs/promises`, a Node-only module) because that would pull Node types into the renderer tsconfig.

**`AuditEntry` placement decision:** `AuditEntry` and `AuditInput` live in `src/main/auditLog.ts` alongside I/O logic that requires Node. The renderer only needs the `AuditEntry` shape for display; the preload needs it for the typed `readAudit` bridge. The cleanest solution is to **inline** `AuditEntry` (and `AuditInput` for completeness) in `src/shared/mcpTypes.ts` as a verbatim copy, then in `src/main/auditLog.ts` replace the local `interface AuditEntry` with `import type { AuditEntry, AuditInput } from '../shared/mcpTypes'`. This preserves the single-source-of-truth invariant (the shared module wins) while keeping `auditLog.ts` free of any structural change to its I/O logic.

**Concrete shape of `src/shared/mcpTypes.ts`:**

```typescript
/**
 * Cross-bundle MCP type contract — TYPE-ONLY.
 *
 * Imported by both MAIN (`src/main/`) and the renderer (`src/renderer/src/`)
 * as `import type { … } from '../../shared/mcpTypes'` (or `../shared/mcpTypes`
 * from renderer depth). Contains NO value exports, NO Node/Electron imports —
 * so it compiles cleanly under tsconfig.node, tsconfig.preload, and tsconfig.web.
 *
 * Single source of truth for:
 *   McpCommand         — the MAIN→renderer control-plane union
 *   McpCommandAck      — the renderer→MAIN ack
 *   PlanningOp / PlanningOpTint — planning-element write-op types
 *   AuditEntry / AuditInput    — MCP dispatch audit trail entry shapes
 *
 * Do not add value exports or Node/DOM/Electron imports to this file.
 */

// ---------- Planning op types (formerly hand-mirrored in mcpCommand.ts + planningMcpApply.ts) ---

export type PlanningOpTint = 'yellow' | 'blue' | 'green' | 'plain'

export type PlanningOp =
  | { kind: 'note'; text: string; tint: PlanningOpTint }
  | { kind: 'checklist'; title: string; items: Array<{ label: string; done: boolean }> }
  | { kind: 'text'; text: string }
  | { kind: 'arrow'; dx: number; dy: number }
  | { kind: 'diagram'; source: string }

// ---------- Command union (formerly hand-mirrored in mcpCommand.ts + useMcpCommands.ts) ---------

/**
 * Control-plane command envelope, MAIN → renderer. Renderer receives this via the
 * `mcp:command` IPC channel and acks on the CSPRNG reply channel.
 *
 * MAIN's `sendMcpCommand` serializes a value of this type; the renderer's
 * `applyMcpCommand` switches on it. Adding a variant here propagates the type error
 * to BOTH sides simultaneously — the compile-time safety this file exists to enforce.
 */
export type McpCommand =
  | { type: 'ping' }
  | { type: 'addBoard'; board: { id: string; type: string } }
  | { type: 'removeBoard'; id: string }
  | {
      type: 'configureBoard'
      id: string
      patch: { shell?: string; launchCommand?: string; cwd?: string }
    }
  | { type: 'patchPlanning'; id: string; ops: PlanningOp[] }
  | {
      type: 'spawnGroup'
      group: { id: string; name: string }
      members: {
        terminal: { id: string; launchCommand?: string }
        planning?: { id: string }
        browser?: { id: string }
      }
    }

/** The renderer's reply to a McpCommand. `type` echoes the handled command. */
export type McpCommandAck = { ok: true; type: string } | { ok: false; error: string }

// ---------- Audit entry types (formerly hand-mirrored in auditLog.ts + AuditLogViewer.tsx) ------

export interface AuditInput {
  type: string
  targetId: string
  prompt: string
  nonce: string
  status?: string
  outputs?: string
  detail?: string
}

export interface AuditEntry {
  seq: number
  ts: number
  type: string
  targetId: string
  prompt: string
  nonce: string
  status: string
  outputs?: string
  detail?: string
}
```

### How both bundles import it — type-only

**MAIN** (`src/main/mcpCommand.ts`): replace the local `export type McpCommand`, `PlanningOpTint`, `PlanningOp`, `McpCommandAck` definitions with:
```typescript
export type { McpCommand, McpCommandAck, PlanningOp, PlanningOpTint } from '../shared/mcpTypes'
```
The function `sendMcpCommand` in `mcpCommand.ts` uses `McpCommand` and `McpCommandAck` as parameter/return types — importing them via `import type` or re-exporting them keeps the module's TypeScript shape identical. No runtime artifact is produced for type-only imports under `isolatedModules: true`.

**MAIN** (`src/main/auditLog.ts`): replace the local `interface AuditEntry` and `interface AuditInput` with:
```typescript
import type { AuditEntry, AuditInput } from '../shared/mcpTypes'
export type { AuditEntry, AuditInput }
```
All existing callers of `auditLog.ts` that import `AuditEntry` from there continue to work; the re-export is transparent.

**Renderer** (`src/renderer/src/store/useMcpCommands.ts`): delete `McpCommandIn` and `McpAck` type definitions and `PlanningOp` import from `planningMcpApply`; add:
```typescript
import type { McpCommand, McpCommandAck } from '../../../shared/mcpTypes'
```
Replace all usages of `McpCommandIn` with `McpCommand` and `McpAck` with `McpCommandAck` throughout the file.

**Renderer** (`src/renderer/src/store/planningMcpApply.ts`): delete `PlanningOpTint` and `PlanningOp` definitions; add:
```typescript
import type { PlanningOp, PlanningOpTint } from '../../../shared/mcpTypes'
```

**Renderer** (`src/renderer/src/canvas/AuditLogViewer.tsx`): delete the local `interface AuditEntry` (lines 15–25); add:
```typescript
import type { AuditEntry } from '../../../shared/mcpTypes'
```

### Vite / tsc bundling — no runtime artifact

Under `isolatedModules: true` (set in all three tsconfigs), `import type` is erased at compile time. Vite's bundler (esbuild under the hood) also strips type-only imports — no `require()` or `import()` of `src/shared/mcpTypes.ts` appears in the output bundles. The file has no value exports, so there is nothing to bundle. The shared module is purely a compile-time contract; it produces no runtime artifact in `out/main/`, `out/preload/`, or `out/renderer/`.

### tsconfig include verification

**Current state:**
- `tsconfig.node.json` includes `src/main/**/*` — does NOT include `src/shared/`.
- `tsconfig.web.json` includes `src/renderer/src/**/*` — does NOT include `src/shared/`.
- `tsconfig.preload.json` includes `src/preload/**/*` — does NOT include `src/shared/`.

**Required additions:** Each tsconfig must add `"src/shared/**/*"` to its `include` array so the shared file is type-checked as part of that project's composite build (not just transitively inferred). Without this addition, `pnpm typecheck` would succeed via inference but the `composite: true` + `tsBuildInfoFile` incremental build might miss changes to the shared file.

```json
// tsconfig.node.json
"include": ["src/main/**/*", "src/shared/**/*", "electron.vite.config.ts", "e2e/**/*", "playwright.config.ts"]

// tsconfig.web.json
"include": ["src/renderer/src/**/*", "src/renderer/src/**/*.tsx", "src/preload/index.d.ts", "src/vendor/**/*", "src/shared/**/*"]

// tsconfig.preload.json
"include": ["src/preload/**/*", "src/shared/**/*"]
```

The shared file uses only standard TypeScript types (no Node, no DOM, no Electron), so it compiles cleanly under all three lib configurations (`["ES2022"]` for node/preload, `["ES2022", "DOM", "DOM.Iterable"]` for web).

---

## 4. Implementation plan

Steps are ordered to keep `pnpm typecheck` green at each checkpoint. No step changes runtime behavior.

1. **Create `src/shared/mcpTypes.ts`** with the full content shown in §3. Do not touch any other file yet. Run `pnpm typecheck` — it should still pass because no imports reference the new file yet.

2. **Update all three tsconfigs** (`tsconfig.node.json`, `tsconfig.web.json`, `tsconfig.preload.json`) to add `"src/shared/**/*"` to their `include` arrays. Run `pnpm typecheck` — the shared module is now checked standalone; it must pass clean (no Node/DOM/Electron dependencies to violate cross-project lib constraints).

3. **Repoint MAIN — `src/main/mcpCommand.ts`:** Delete the four local type definitions (`McpCommand`, `PlanningOpTint`, `PlanningOp`, `McpCommandAck`) and replace with re-exports from `'../shared/mcpTypes'`. The function `sendMcpCommand` and its JSDoc are unchanged. Run `pnpm typecheck` — the node project must be green.

4. **Repoint MAIN — `src/main/auditLog.ts`:** Delete `interface AuditEntry` and `interface AuditInput` (lines 18–46). Add `import type { AuditEntry, AuditInput } from '../shared/mcpTypes'` at the top and re-export both. All downstream MAIN callers that import from `auditLog.ts` continue to resolve via the re-export. Run `pnpm typecheck` to confirm the node project stays green.

5. **Repoint renderer — `src/renderer/src/store/planningMcpApply.ts`:** Delete `PlanningOpTint` (line 24) and `PlanningOp` (lines 30–35) definitions. Add `import type { PlanningOp, PlanningOpTint } from '../../../shared/mcpTypes'`. Verify the remainder of the file (materializePlanningOps, neededBoardHeight) still type-checks — the types are structurally identical so no narrowing changes.

6. **Repoint renderer — `src/renderer/src/store/useMcpCommands.ts`:** Delete `McpCommandIn` (lines 17–37) and `McpAck` (line 40) definitions. Delete the `type PlanningOp` import from `planningMcpApply` (PlanningOp is now accessed through mcpTypes). Add `import type { McpCommand, McpCommandAck } from '../../../shared/mcpTypes'`. Rename all `McpCommandIn` usages to `McpCommand` and all `McpAck` usages to `McpCommandAck` within the file. The `addBoard` variant: note that MAIN's `McpCommand` uses `type: string` for the board type while the renderer's `McpCommandIn` used `type: BoardType` — the shared canonical type follows MAIN's looser `string` (MAIN mints the id/type; the renderer validates via `SPAWNABLE.includes(type)` at runtime). This is the one semantic difference to resolve: adopt `string` in the shared union (matching MAIN) and keep the runtime SPAWNABLE guard in `applyMcpCommand`. Run `pnpm typecheck`.

7. **Repoint renderer — `src/renderer/src/canvas/AuditLogViewer.tsx`:** Delete the local `interface AuditEntry` (lines 14–25). Add `import type { AuditEntry } from '../../../shared/mcpTypes'`. Run `pnpm typecheck`.

8. **Final full typecheck:** Run `pnpm typecheck` across all three projects. Confirm zero errors. Also run `pnpm lint` — the `noUnusedLocals`/`noUnusedParameters` lint rules will catch any stale local imports left behind.

9. **Delete the hand-mirror comments** — `src/main/mcpCommand.ts`'s comment "the renderer applier…mirrors it by hand" and `planningMcpApply.ts`'s "kept in sync BY HAND" comment are now false. Update them to reference `src/shared/mcpTypes.ts`.

---

## 5. Schema / migration impact

None. This is a pure TypeScript type refactor. No values change, no serialized format changes, no IPC channel names change, no `canvas.json` schema version is affected. `AuditEntry` is the shape of JSONL lines in `mcp-audit.jsonl`; that shape is identical before and after (the shared module inlines the same field names and types).

---

## 6. Tests

**Primary gate: `pnpm typecheck`**

`pnpm typecheck` runs `tsc --build` across all three composite projects (`node` + `preload` + `web`) in parallel. After this refactor, a mismatch between MAIN's `McpCommand` and the renderer's receiver would produce a TypeScript error — the compile-time safety this spec exists to establish. This is the mandatory gate.

**Secondary: `pnpm lint`**

ESLint with `noUnusedLocals` / `noUnusedParameters` catches stale type alias declarations left behind after the mirror deletions. Must be green.

**Optional structural test (recommended, not blocking):**

A unit test in `src/main/` (or a dedicated `src/shared/mcpTypes.test.ts` if a test runner picks up `src/shared/`) can assert assignability:

```typescript
// Verify the shared McpCommand is assignable to what sendMcpCommand accepts
import type { McpCommand } from './mcpTypes'
import { sendMcpCommand } from '../main/mcpCommand'
// If McpCommand drifts from sendMcpCommand's parameter type, this static assertion fails:
type _AssertSendAcceptsSharedCommand = Parameters<typeof sendMcpCommand>[2] extends McpCommand
  ? true
  : never
const _check: _AssertSendAcceptsSharedCommand = true
```

This is a compile-time assertion (no runtime cost) that fires if `sendMcpCommand` is ever refactored to accept a diverged local type instead of the shared one.

**No runtime artifact check:**

Inspect `out/main/index.js` and `out/renderer/index.js` after `pnpm build` and confirm that `mcpTypes` does not appear as a `require()` call or dynamic import — verifying the type-only erasure. This can be a `grep` in the CI check script, but is not a blocking gate for the PR.

---

## 7. Acceptance criteria (DoD)

- [ ] `src/shared/mcpTypes.ts` exists and contains exactly one definition each of `McpCommand`, `McpCommandAck`, `PlanningOp`, `PlanningOpTint`, `AuditEntry`, `AuditInput`. No value exports. No Node/Electron/DOM imports.
- [ ] `src/main/mcpCommand.ts` no longer defines `McpCommand`, `PlanningOp`, `PlanningOpTint`, or `McpCommandAck` locally — they are re-exported from `src/shared/mcpTypes.ts`.
- [ ] `src/main/auditLog.ts` no longer defines `AuditEntry` or `AuditInput` locally — they are imported and re-exported from `src/shared/mcpTypes.ts`.
- [ ] `src/renderer/src/store/useMcpCommands.ts` no longer declares `McpCommandIn` or `McpAck` — it imports `McpCommand` and `McpCommandAck` from `src/shared/mcpTypes.ts`.
- [ ] `src/renderer/src/store/planningMcpApply.ts` no longer declares `PlanningOp` or `PlanningOpTint` — they are imported from `src/shared/mcpTypes.ts`.
- [ ] `src/renderer/src/canvas/AuditLogViewer.tsx` no longer declares a local `interface AuditEntry` — it imports `AuditEntry` from `src/shared/mcpTypes.ts`.
- [ ] All three tsconfigs (`node`, `preload`, `web`) include `"src/shared/**/*"` in their `include` arrays.
- [ ] `pnpm typecheck` passes with zero errors across all three projects.
- [ ] `pnpm lint` passes (no stale unused type declarations).
- [ ] `pnpm build` produces bundles where `mcpTypes` generates no `require()` or dynamic `import()` calls in any output file.
- [ ] No behaviour change: the existing e2e suite (`pnpm test:e2e`) passes unchanged.
- [ ] The "kept in sync BY HAND" comments in `mcpCommand.ts` and `planningMcpApply.ts` are removed or updated to reference the shared module.

---

## 8. Risks & invariants

**No runtime import across the process boundary (mandatory invariant — never weaken):**

The Electron security model (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`) strictly separates MAIN and renderer. The shared module must contain ONLY type declarations. If a value export were accidentally added to `src/shared/mcpTypes.ts`, Vite would bundle it into the renderer, and if that value imported anything from `src/main/` (which uses Node built-ins), the renderer bundle would break. The safeguard is: `src/shared/mcpTypes.ts` has no `import` statements at all (or only `import type`), so there is nothing to accidentally pull across.

**`addBoard.board.type` narrowing (one semantic note):**

MAIN's `McpCommand` uses `board: { id: string; type: string }` (a loose `string`) while the renderer's old `McpCommandIn` used `board: { id: string; type: BoardType }` (a narrower renderer-only union). The canonical shared type follows MAIN (`string`), which is the correct direction: MAIN is the sender and does not import renderer types. The renderer keeps its runtime SPAWNABLE guard (`SPAWNABLE.includes(type)`) in `applyMcpCommand`, which is the correct defense-in-depth enforcement point. No type safety is lost — the narrowing was never enforced at the IPC boundary anyway (the value crosses IPC as JSON).

**Strict-mode clean:**

The shared module must pass `strict: true`, `noUnusedLocals: true`, and `noUnusedParameters: true` under all three tsconfigs. Because it has only type exports and no function bodies, this is trivially satisfied.

**`isolatedModules` compatibility:**

All three tsconfigs set `isolatedModules: true`. Type-only exports (`export type { … }`) and interfaces are valid under `isolatedModules`. The shared module uses no const enums or namespace merges that would break isolated compilation.

**Preload bundle:**

The preload (`src/preload/index.ts`) exposes the typed `readAudit` bridge to the renderer via `contextBridge`. It currently imports `AuditEntry` from `src/main/auditLog.ts` (inferred transitively via `preload/index.d.ts`). After this refactor, the preload can import `AuditEntry` directly from `src/shared/mcpTypes.ts` — which is cleaner and avoids pulling Node-only `auditLog.ts` I/O types into the preload tsconfig transitively. Verify the preload tsconfig stays green; if the preload currently imports `AuditEntry` via `auditLog.ts`, update that import too as part of step 4.

---

## 9. Handoff / sequencing

**This spec is a BLOCKER for W2/W3 skill and recipe command variants.**

The Wave 2/3 work (S1 `registerPrompts` scaffold, S3 `fan-out-and-compare`, S4 `review-pr`, S6 recipe launcher) will each require at minimum one new `McpCommand` variant to drive the renderer. Adding that variant without this shared module means adding it to both `McpCommand` and `McpCommandIn` simultaneously — recreating the hand-mirror problem with every addition and embedding the drift risk deeper into the codebase.

**Ordering within Wave 1:**

SPEC-W1-D has no dependencies on any other Wave 1 spec. It is a pure refactor of existing types and can be implemented by any session without blocking or being blocked by F5/F6/F7/F8. It should be the **first Wave 1 item merged** so that subsequent PRs (especially any that add new `McpCommand` variants) land on the shared foundation.

**Estimated effort:** Small (S). One new file, five file edits, three tsconfig edits. No new tests beyond `pnpm typecheck` + optional static assertion. Implementation should fit in a single focused session with no blockers.

**Branch name suggestion:** `fix/shared-mcp-types`

**PR scope:** this spec only — do not bundle with F5 (sanitizer), F6 (deny label), or F8 (persist provisionedDirs). Each of those has independent risk/test surface; keeping this PR pure-types makes it trivially reviewable.
