# SPEC-W1-G — coordinated package+app primitive release

**Wave:** 1 · **Priority:** P0 · **Source:** C1, C2(wire), C3, F10, F11, F12, F25 · **Type:** package + app LOCKSTEP · **Repos/zones:** pkg `@expanse-ade/mcp` (Orchestrator iface + ServerFactory + write_result Zod + scopes) ; app `src/main/{mcp.ts, mcpOrchestrator.ts, appModel.ts}` + `package.json` dep bump

---

## 1. Problem

### The three unwired-but-MAIN-complete primitives (F12)

The audit table (REPORT.md §2a) records three entries with status **partial**:

| Primitive | MAIN surface | Wire status |
|---|---|---|
| `canvas://app-model` | `orchestrator.describeApp()` in `mcpOrchestrator.ts:958` | not registered in `ServerFactory` (PR-3b) |
| `spawn_group` tool | `orchestrator.spawnGroup()` via `createMcpLifecycle` | not registered in `ServerFactory` (PR-5c) |
| `await_settled` tool | `orchestrator.awaitSettled()` in `mcpOrchestrator.ts:721` | not registered (also: busy-polls — separate C7) |

This spec covers **C1 (`canvas://app-model`)** and **C2-wire (`spawn_group`)**. `await_settled` wire-registration is intentionally excluded per the audit's §8 "Killed proposals" decision: "`await_settled` wire-register half — dropped. Unjustified new surface; `handoff_prompt`/`wait_for_all` already cover the agent wait case."

### Why "zero new MAIN code" is WRONG — the §7 correction

The audit's §7 "Critical dependency note" is the load-bearing correction for this spec:

> `describeApp`/`spawnGroup`/`awaitSettled` live on the app's private `RunningMcp` facade **(`mcp.ts:85–155`)**, **not** on the package's exported `Orchestrator` interface (`dist/index.d.ts:195–285`). Each wire-registration is **three coordinated edits**: (1) add the method to the package `Orchestrator` interface, (2) bind it in `buildOrchestrator`, (3) register the tool/resource in `ServerFactory`.

Concretely, inspecting `dist/index.d.ts` lines 195–285, the `Orchestrator` interface lists `gitDiff(boardId)` (the already-wired precedent at line 254) but has **no** `describeApp()` or `spawnGroup()`. The `buildOrchestrator` in `mcpOrchestrator.ts` (lines 101–993) does implement both methods at lines 958 and 142 respectively — they are live and tested — but they are properties on the *returned object*, not methods declared on the package's `Orchestrator` interface that `ServerFactory` can call. Until the interface is extended in the package, `ServerFactory.getServer()` (currently at `dist/index.js:856`) cannot call them, and no amount of app-only changes can register the tools/resources.

This makes the release a **two-repo, lockstep change**: the package release MUST land first; the app dep bump follows.

### The dead scope pre-authorizing a non-existent tool (F11)

`dist/index.js:1084–1092` and `dist/index.d.ts` show:

```js
var SCOPE_ANSWER_PERMISSION = "answer_permission";
var ORCHESTRATOR_SCOPES = [
  SCOPE_READ, SCOPE_DISPATCH, SCOPE_SPAWN, SCOPE_GIT_WRITE,
  SCOPE_ANSWER_PERMISSION   // ← granted to every orchestrator token minted today
];
```

`SCOPE_ANSWER_PERMISSION` is reserved for the M8 `answer_permission` tool (Wave 3 / C5). That tool does **not yet exist** — the `ServerFactory.getServer()` block (lines 863–905) has no registration for it. Every orchestrator token minted today therefore carries a scope that grants permission to a future tool whose implementation and security review are not yet complete. If any future contributor adds an `answer_permission`-scoped tool without a careful security review, every existing orchestrator token gains access to it automatically. Per the audit (F11): *"implicit pre-authorization of any future same-named tool"*.

The fix: remove `SCOPE_ANSWER_PERMISSION` from `ORCHESTRATOR_SCOPES` / `defaultScopesFor('orchestrator')` in the package until C5 ships. It belongs in `defaultScopesFor` only after the tool exists and the scope-check in its registration is in place.

### Uncapped `write_result` Zod schema (F10 / BUG-009)

`dist/index.js:564–592` shows the `write_result` tool's `inputSchema`:

```js
inputSchema: {
  status: z8.string().optional(),
  summary: z8.string().optional(),       // ← no .max()
  refs: z8.array(z8.string()).optional() // ← no .max() on array or element
}
```

MAIN compensates with belt-and-suspenders clamps in `mcpOrchestrator.ts:62–64`:

```ts
const WRITE_RESULT_MAX_SUMMARY = 100_000
const WRITE_RESULT_MAX_REFS = 256
const WRITE_RESULT_MAX_REF_LEN = 256
```

These clamps are correct and effective today. The problem is that they are **not at the protocol layer** — a future refactor that moves the `writeResult` implementation in `mcpOrchestrator.ts` could accidentally drop or reorder the clamp before the `registry.recordResult` call, at which point the only guard is gone. Closing BUG-009 at the Zod schema level (`summary: z.string().max(100_000)`, `refs: z.array(z.string().max(256)).max(256)`) makes the cap an enforced protocol invariant rather than a fragile MAIN belt-and-suspender.

### The APP_TOOLS drift gap (F25)

`appModel.ts:99–155` contains `APP_TOOLS`, a hand-maintained static catalog of the package's registered tools. Its comment at line 18 reads: *"Static-table maintenance: `APP_TOOLS` + `APP_BOARD_TYPES` MIRROR the renderer board-type union … and the `@expanse-ade/mcp` tool registration (as of 0.11.0). When a board type or tool is added/removed in those, update the matching table here."* There is no compile-time guard enforcing this — a package bump that adds or removes a tool can silently drift the catalog. This spec adds a **test-layer drift guard** alongside the C1/C2 wiring (both add new tools that `APP_TOOLS` must track).

---

## 2. Goal & non-goals

**Goals:**

- Wire-register `canvas://app-model` as an orchestrator-tier read-only MCP resource (C1), enabling agents to call `resources/read` on their own self-model.
- Wire-register `spawn_group` as an orchestrator-tier MCP tool (C2-wire), enabling agents to spawn a feature-zone cluster over the wire.
- Add Zod `.max()` caps to the `write_result` tool's `inputSchema` in the package (C3 / F10), closing BUG-009 at the protocol layer.
- Remove `SCOPE_ANSWER_PERMISSION` from `ORCHESTRATOR_SCOPES` (F11) until the M8 `answer_permission` tool ships.
- Add an `APP_TOOLS` drift-guard test (F25) that asserts the catalog matches the set of tools the package actually registers for an orchestrator session.

**Non-goals:**

- The `spawn_group` sanitizer fix (F5 / SPEC-W1-B) — that is a **dependency** of this spec and must already be merged. This spec wires `spawnGroup()` onto the MCP surface; the safe implementation of `spawnGroup()` (free of the C1 escape-injection) is SPEC-W1-B's responsibility.
- Wire-registering `await_settled` — excluded by the audit's §8 killed-proposals decision.
- Implementing the M8 `answer_permission` tool (C5 / Wave 3) — this spec only removes the premature scope grant.
- The prompts-primitive scaffold (S1 / SPEC-W1-F) and the canvas-ade primer (S2) — those are separate specs. This spec can co-release with S1 in the same package bump (they are independent package changes), but neither is a dependency.

---

## 3. Design

### Worked precedent: the `git_diff` 3-edit pattern

`git_diff` is the only already-wired precedent of this exact pattern. It demonstrates all three edits:

1. **Package `Orchestrator` interface** (`dist/index.d.ts:254`): `gitDiff(boardId: BoardId): Promise<string>;`
2. **App `buildOrchestrator` binding** (`mcpOrchestrator.ts:935–957`): the `gitDiff` method is returned in the object literal at line 935.
3. **Package `ServerFactory` registration** (`dist/index.js:612–628`): `registerGitDiff(server, this.orchestrator)` is called in the `ctx.tier === 'orchestrator'` block at line 879.

Each new primitive follows this same 3-edit sequence.

---

### C1: `canvas://app-model` resource

**Edit 1 — Package `Orchestrator` interface** (`src/orchestrator.ts` in the package source; reflected in `dist/index.d.ts`):

```ts
/**
 * Assemble the read-only app self-model: board types, tool catalog, live canvas state
 * (boards/connectors/groups), and orchestration rules. Orchestrator-tier, read-only.
 * Wraps `buildAppModel` in MAIN over the loopback wire. Returns the {@link AppModel} shape.
 */
describeApp(): Promise<AppModel>
```

`AppModel` is an app-defined type (`src/main/appModel.ts:85`). The package does not own this type. The resource handler should serialize the result as JSON (analogous to `canvas://boards` at `dist/index.js:315–322`). The return type on the interface can be declared as `Promise<unknown>` or the package can re-export a minimal `AppModel` shape — the preferred choice is `Promise<unknown>` (keeping the interface lightweight; the JSON serialization drops the type requirement).

**Edit 2 — App `buildOrchestrator` binding** (`src/main/mcpOrchestrator.ts`):

`describeApp()` is already implemented at line 958 in the returned object literal. No new app code is needed — the method just needs to be part of a type the package recognizes. Once the interface declares `describeApp(): Promise<unknown>`, the existing implementation satisfies it.

**Edit 3 — Package `ServerFactory` registration** (in `src/server/factory.ts`, reflected in `dist/index.js`):

Add a new `registerAppModelResource` function (in `src/resources/appModel.ts`):

```ts
// src/resources/appModel.ts
function registerAppModelResource(server: McpServer, orchestrator: Orchestrator) {
  server.registerResource(
    'app-model',
    'canvas://app-model',
    {
      description:
        'Read-only app self-model: board types, tool catalog, live canvas (boards/connectors/groups), and orchestration rules. Orchestrator-tier.',
      mimeType: 'application/json'
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: JSON.stringify(await orchestrator.describeApp()) }]
    })
  )
}
```

In `ServerFactory.getServer()`, add inside the `ctx.tier === 'orchestrator'` block (alongside `registerGitDiff`):

```ts
registerAppModelResource(server, this.orchestrator)
```

**Tier:** orchestrator-only. The self-model exposes the full tool catalog, spawn cap, and idle TTL — not sensitive, but agents that are not orchestrators have no use for it and it need not be in every worker/connected `tools/list`.

---

### C2-wire: `spawn_group` tool

**Edit 1 — Package `Orchestrator` interface**:

```ts
/**
 * Spawn a feature-zone cluster: a terminal board + optional planning + optional browser, all
 * grouped under a Named Group. Orchestrator-tier only (bounds swarm growth). Cap-checked against
 * the live MCP spawn cap; rejects before minting if the cluster would exceed it. Content-less
 * (empty boards on spawn), so it is NOT human-gated — the gate stays on content writes (handoff /
 * assign / relay / add_planning_elements). Returns the minted ids of every created board + group.
 */
spawnGroup(input: SpawnGroupInput): Promise<SpawnGroupResult>
```

`SpawnGroupInput` and `SpawnGroupResult` are app-defined types (`src/main/mcpLifecycle.ts:40–61`). The package interface should use a structural equivalent declared in the package source (or use `unknown` with the handler casting). The preferred approach: declare minimal package-side types in `src/types/spawnGroup.ts` mirroring the app's shape:

```ts
export interface SpawnGroupInput {
  name: string
  planning?: boolean
  browser?: boolean
  /** 🔒 Exec vector — sanitized by MAIN before the PTY line is written. */
  launchCommand?: string
}
export interface SpawnGroupResult {
  groupId: string
  terminalId: string
  planningId?: string
  browserId?: string
}
```

**Edit 2 — App `buildOrchestrator` binding** (`src/main/mcpOrchestrator.ts`):

`spawnGroup()` is already returned in the object literal (mcp.ts line 214: `spawnGroup: (input) => orchestrator.spawnGroup(input)`). No new MAIN code is required — the method just needs the interface to recognize it.

**Edit 3 — Package `ServerFactory` registration**:

Add `src/server/tools/spawnGroup.ts`:

```ts
import { z } from 'zod'
const SPAWN_GROUP_NAME_MAX = 80 // mirrors SPAWN_GROUP_MAX_NAME in mcpLifecycle.ts

function registerSpawnGroup(server: McpServer, orchestrator: Orchestrator) {
  server.registerTool(
    'spawn_group',
    {
      description:
        'Spawn a feature-zone cluster: a terminal board + optional planning board + optional browser board, grouped under a Named Group. Orchestrator-tier only. Returns the minted ids of every created member. ' +
        'launchCommand is the first PTY line written on terminal spawn (exec vector — treat as trusted input).',
      inputSchema: {
        name: z.string().min(1).max(SPAWN_GROUP_NAME_MAX),
        planning: z.boolean().optional(),
        browser: z.boolean().optional(),
        launchCommand: z.string().max(400).optional()
      }
    },
    async (args) => {
      const result = await orchestrator.spawnGroup({
        name: args.name,
        planning: args.planning,
        browser: args.browser,
        launchCommand: args.launchCommand
      })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
}
```

In `ServerFactory.getServer()`, add inside the `ctx.tier === 'orchestrator'` block:

```ts
registerSpawnGroup(server, this.orchestrator)
```

**Tier:** orchestrator-only. `spawn_group` changes the canvas topology; allowing connected agents to call it would let a terminal agent grow the swarm without the orchestrator's awareness. The audit explicitly calls this out: *"Keep orchestrator-only to bound swarm growth."*

**Dependency note:** `spawnGroup()` in `mcpLifecycle.ts:142` contains the F5 sanitizer bug (`c >= ' '` passes DEL + C1). SPEC-W1-B (the sanitizer fix) must be merged **before** this spec is implemented. Wiring a live MCP tool onto a path with an escape-injection vulnerability is unacceptable.

---

### C3: `write_result` Zod `.max()` caps

In `src/server/tools/writeResult.ts` in the package source, update the `inputSchema`:

```ts
// Before:
inputSchema: {
  status: z.string().optional(),
  summary: z.string().optional(),
  refs: z.array(z.string()).optional()
}

// After:
inputSchema: {
  status: z.string().optional(),
  summary: z.string().max(100_000).optional(),      // mirrors WRITE_RESULT_MAX_SUMMARY
  refs: z.array(z.string().max(256)).max(256).optional() // mirrors WRITE_RESULT_MAX_REFS / MAX_REF_LEN
}
```

The caps mirror the existing MAIN constants exactly (`mcpOrchestrator.ts:62–64`). The MAIN belt-and-suspenders clamps (`result.summary.slice(0, WRITE_RESULT_MAX_SUMMARY)`, etc.) remain in place — they are not removed, because defense-in-depth means both layers must agree independently. What changes is that an oversized payload is now **rejected at the wire** with a Zod validation error before it ever reaches `orchestrator.writeResult()`, so the MAIN clamp is truly a backstop rather than the primary guard.

---

### F11: remove `SCOPE_ANSWER_PERMISSION` from `ORCHESTRATOR_SCOPES`

In `src/auth/scopes.ts`:

```ts
// Before:
var ORCHESTRATOR_SCOPES = [
  SCOPE_READ, SCOPE_DISPATCH, SCOPE_SPAWN, SCOPE_GIT_WRITE, SCOPE_ANSWER_PERMISSION
]

// After:
var ORCHESTRATOR_SCOPES = [
  SCOPE_READ, SCOPE_DISPATCH, SCOPE_SPAWN, SCOPE_GIT_WRITE
  // SCOPE_ANSWER_PERMISSION omitted until M8 answer_permission tool ships (Wave 3 / C5)
]
```

`SCOPE_ANSWER_PERMISSION` and the constant itself stay defined — the scope name is reserved for M8 and the constant is referenced from the scope-gate in the (future) `answer_permission` tool registration. Only its presence in the default orchestrator array is removed. `defaultScopesFor('orchestrator')` returns the spread of `ORCHESTRATOR_SCOPES`, so it will stop including the scope automatically.

**Existing token impact:** tokens already minted (in-memory `TokenStore` rows) carry their scopes as a string array set at mint time. Removing the scope from `defaultScopesFor` affects **new mints only** — tokens minted in the current process session before this package bump retain their prior scope array. Because `TokenStore` is in-memory and restarts on app restart, all tokens are re-minted at the next restart with the corrected scope set. No migration is needed.

---

### F25: `APP_TOOLS` drift-guard test

Add a test in `src/main/appModel.test.ts` (or a new `src/main/appModelDrift.test.ts`) that:

1. Creates a `MockOrchestrator` (the package exports one, or the test wires a minimal stub).
2. Calls `new ServerFactory(mockOrchestrator).getServer({ tier: 'orchestrator', boardId: 'test' })`.
3. Extracts the list of registered tool names from the server (via `server.server.getCapabilities()` or the SDK's `listTools` handler).
4. Asserts that the set of registered orchestrator-tier tool names equals the set of `name` values in `APP_TOOLS` (filtering to `tier: 'orchestrator'`) plus the worker-tier tools (`tier: 'worker'`).

This test fails the moment a package bump adds or removes a tool without the companion `APP_TOOLS` update — making the maintenance requirement a CI-enforced contract rather than a comment. Specifically, after this spec lands, the test must pass with `spawn_group` in `APP_TOOLS` (see §4).

**`APP_TOOLS` update required:** add `spawn_group` to `src/main/appModel.ts`:

```ts
{
  name: 'spawn_group',
  purpose: 'Spawn a feature-zone cluster (terminal + optional planning/browser + Named Group).',
  tier: 'orchestrator'
}
```

And add `spawn_group` to the `APP_BOARD_TYPES` `terminal.tools` array (it creates a terminal among other boards):

```ts
// In APP_BOARD_TYPES, the terminal entry's tools array:
tools: [
  'spawn_board', 'configure_board', 'handoff_prompt', 'assign_prompt',
  'interrupt', 'git_diff', 'write_result', 'close_board',
  'spawn_group'  // ← add
]
```

`canvas://app-model` is a resource (not a tool), so `APP_TOOLS` is unchanged for C1 — but the drift-guard test should also verify that the set of registered **resource URIs** includes `canvas://app-model` once C1 lands.

---

## 4. Implementation plan

The sequence is strict: **package changes first, then app dep bump**. The two PRs must land in order because the app's TypeScript types (`LifecycleOrchestrator`, which extends `Orchestrator` from the package) will fail to satisfy the new interface until the package export includes `describeApp` and `spawnGroup`.

### PR 1 — Package (`@expanse-ade/mcp`)

All four package-side changes land in a single package PR:

**Step 1 — C3: add Zod `.max()` caps to `write_result`**
- Edit `src/server/tools/writeResult.ts`: add `.max(100_000)` to `summary`, `.max(256)` to each element of `refs`, `.max(256)` to the `refs` array itself.
- Add unit test: `write_result` rejects a `summary` > 100k chars and a `refs` array > 256 elements.

**Step 2 — F11: remove `SCOPE_ANSWER_PERMISSION` from `ORCHESTRATOR_SCOPES`**
- Edit `src/auth/scopes.ts`: remove `SCOPE_ANSWER_PERMISSION` from the `ORCHESTRATOR_SCOPES` array literal.
- Update the scope-table test (if one exists) to assert the scope is absent from orchestrator defaults.

**Step 3 — C1: `canvas://app-model` resource**
- Add `src/resources/appModel.ts` with `registerAppModelResource`.
- Extend the `Orchestrator` interface in `src/types/orchestrator.ts` (or wherever the interface is declared in package source): add `describeApp(): Promise<unknown>`.
- In `src/server/factory.ts`, import and call `registerAppModelResource` inside the `orchestrator` tier block.

**Step 4 — C2-wire: `spawn_group` tool**
- Add `src/types/spawnGroup.ts` with `SpawnGroupInput`/`SpawnGroupResult` (or inline in the tool file).
- Add `src/server/tools/spawnGroup.ts` with `registerSpawnGroup`.
- Extend the `Orchestrator` interface: add `spawnGroup(input: SpawnGroupInput): Promise<SpawnGroupResult>`.
- In `src/server/factory.ts`, import and call `registerSpawnGroup` inside the `orchestrator` tier block.

**Step 5 — Package version bump**
- Bump the package version: **minor** (additive tools + resource + Zod caps = no breaking schema changes; scope removal is a security hardening, not a breaking API change for callers, because callers never needed to supply the scope and the SDK never enforced it at the client level).
- Push tag `v0.14.0` (or the next appropriate minor) to trigger `publish.yml`.

### PR 2 — App (`canvas-ade` / this repo)

**Step 1 — Bump `@expanse-ade/mcp` dep** in `package.json`:
```json
"@expanse-ade/mcp": "^0.14.0"
```
Run `pnpm install` from the MAIN repo dir (never from a worktree — see memory note `worktree-pnpm-install-recreates-shared-tree.md`).

**Step 2 — App `buildOrchestrator` type satisfaction** (`src/main/mcpOrchestrator.ts`):
The existing `describeApp()` at line 958 and `spawnGroup()` (via `createMcpLifecycle`) already implement the new interface methods. After the dep bump, TypeScript will validate that `LifecycleOrchestrator` (which `buildOrchestrator` returns) satisfies the new extended `Orchestrator` interface. No new code — only a typecheck verification that it compiles.

**Step 3 — `APP_TOOLS` update** (`src/main/appModel.ts`):
- Add `spawn_group` to `APP_TOOLS` (see §3 above).
- Add `spawn_group` to the terminal entry in `APP_BOARD_TYPES.tools`.

**Step 4 — Drift-guard test**:
- Add `src/main/appModelDrift.test.ts` (or a new `describe` block in `appModel.test.ts`) implementing the tool-set equality assertion described in §3 F25.
- The test imports `ServerFactory` from `@expanse-ade/mcp` and calls `getServer` with `tier: 'orchestrator'`.

**Step 5 — Gate:**
```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run src/main/appModel.test.ts src/main/appModelDrift.test.ts
```

---

## 5. Schema / migration impact

**`canvas.json` schema:** none. None of these changes touch the persisted canvas document. No `schemaVersion` bump, no `minReaderVersion` change, no migration pipeline entry.

**Package SEMVER:** minor bump (e.g. `0.13.0` → `0.14.0`). Rationale:
- C1 and C2-wire add new tools/resources — **additive** to the MCP surface. Existing clients see new entries in `tools/list` and `resources/list` but their existing calls are unaffected.
- C3 (`write_result` `.max()` caps) is a **tightening** of validation. Clients sending oversized payloads get a Zod error where before they got a silent clamp. This is a breaking change for a malformed client — but since no legitimate client sends a 100k+ summary, this is treated as a bug-fix / security hardening rather than an API break. Minor is appropriate.
- F11 (scope removal) does not change the API shape visible to callers. Minor is appropriate.

**App dep pin update:** the app's `package.json` currently pins `"@expanse-ade/mcp": "^0.13.0"`. After PR 2 Step 1, it becomes `"^0.14.0"`. The `^` range means future patch/minor bumps are accepted; a manual update is required for the next major.

---

## 6. Tests

### Unit tests (package, per-primitive)

**C3 — `write_result` caps** (in package test suite):
```ts
describe('write_result Zod schema caps (C3 / BUG-009)', () => {
  it('rejects a summary longer than 100,000 characters', async () => {
    // Invoke registerWriteResult via a test MCP server; submit a tool call with an oversized summary.
    // Expect the server to return isError: true with a Zod validation message.
    const oversized = 'x'.repeat(100_001)
    // ... assert validation error
  })

  it('rejects a refs array with 257 elements', async () => {
    const refs = Array.from({ length: 257 }, (_, i) => `ref-${i}`)
    // ... assert validation error
  })

  it('rejects a refs element longer than 256 characters', async () => {
    const refs = ['x'.repeat(257)]
    // ... assert validation error
  })

  it('accepts a summary of exactly 100,000 characters', async () => {
    const summary = 'x'.repeat(100_000)
    // ... assert success
  })
})
```

**F11 — scope-table** (in package test suite):
```ts
describe('F11: SCOPE_ANSWER_PERMISSION absent from orchestrator defaults', () => {
  it('defaultScopesFor("orchestrator") does not include answer_permission', () => {
    const scopes = defaultScopesFor('orchestrator')
    expect(scopes).not.toContain('answer_permission')
  })

  it('defaultScopesFor("connected") does not include answer_permission', () => {
    expect(defaultScopesFor('connected')).not.toContain('answer_permission')
  })

  it('defaultScopesFor("worker") does not include answer_permission', () => {
    expect(defaultScopesFor('worker')).not.toContain('answer_permission')
  })
})
```

**C1 — `canvas://app-model` registration** (in package test suite):
```ts
describe('C1: canvas://app-model registered for orchestrator tier', () => {
  it('is present in the orchestrator resource list', async () => {
    const { server } = new ServerFactory(mockOrch).getServer({ tier: 'orchestrator', boardId: 'test' })
    // List resources and assert 'canvas://app-model' is present
  })

  it('is absent in the worker resource list (orchestrator-only)', async () => {
    const { server } = new ServerFactory(mockOrch).getServer({ tier: 'worker', boardId: 'w' })
    // List resources and assert 'canvas://app-model' is absent
  })

  it('returns JSON with the expected AppModel shape', async () => {
    const { server } = new ServerFactory(mockOrch).getServer({ tier: 'orchestrator', boardId: 'test' })
    // Read canvas://app-model; parse JSON; assert version, boardTypes, tools, canvas, rules keys present
  })
})
```

**C2-wire — `spawn_group` registration** (in package test suite):
```ts
describe('C2: spawn_group registered for orchestrator tier only', () => {
  it('is present in the orchestrator tool list', async () => {
    const { server } = new ServerFactory(mockOrch).getServer({ tier: 'orchestrator', boardId: 'test' })
    // Assert 'spawn_group' in tool list
  })

  it('is absent in the connected tool list', async () => {
    const { server } = new ServerFactory(mockOrch).getServer({ tier: 'connected', boardId: 'c' })
    // Assert 'spawn_group' absent — spawn_group is orchestrator-only, unlike spawn_board
  })

  it('calls orchestrator.spawnGroup with the correct args', async () => {
    // Call spawn_group tool; assert mock was called with { name, planning, browser, launchCommand }
  })

  it('returns the minted ids as JSON', async () => {
    // Assert the tool content contains groupId, terminalId, etc.
  })
})
```

### App-side unit test (F25 — drift guard)

```ts
// src/main/appModelDrift.test.ts
describe('F25: APP_TOOLS drift guard — catalog matches package registration', () => {
  it('orchestrator tool names in APP_TOOLS match what ServerFactory registers', async () => {
    // 1. Mint a minimal MockOrchestrator satisfying the Orchestrator interface.
    // 2. Call new ServerFactory(mock).getServer({ tier: 'orchestrator', boardId: 'test' }).
    // 3. Extract registered tool names (via the MCP SDK's listTools or server internals).
    // 4. Extract tool names from APP_TOOLS.
    // 5. Assert the two sets are equal (symmetric difference = []).
    const registered = new Set(/* tools from server */)
    const cataloged = new Set(APP_TOOLS.map(t => t.name))
    expect(registered).toEqual(cataloged)
  })

  it('canvas://app-model is in the orchestrator resource list', async () => {
    // Assert the resource URI is registered — not in APP_TOOLS (it's a resource),
    // but the test anchors C1's presence in the real server output.
  })
})
```

### Live @mcp probes (app-level e2e)

These belong in `e2e/mcp.e2e.ts` (the existing `@mcp`-tagged spec):

**`canvas://app-model` read probe:**
```ts
// Send resources/read for canvas://app-model with an orchestrator-tier token.
// Assert: response is JSON; parsed object has { version: 1, boardTypes, tools, canvas, rules }.
// Assert: parsed.tools includes { name: 'spawn_group', tier: 'orchestrator' }.
```

**`spawn_group` call probe:**
```ts
// Call spawn_group tool with { name: 'e2e-zone', planning: true } using an orchestrator token.
// Assert: response contains groupId, terminalId, planningId (no browserId).
// Assert: canvas has a new terminal board + planning board + a Named Group with that name.
// Assert: both boards are within the MCP spawn cap.
// Teardown: call close_board for terminalId and planningId; assert cap released.
```

**`write_result` oversized rejection probe:**
```ts
// Call write_result with a worker-tier token; pass summary: 'x'.repeat(100_001).
// Assert: the tool returns isError: true (Zod validation at the wire level).
```

### Manual verification (Inspector + real CLI)

After the app build with the bumped package:

1. Open MCP Inspector pointed at the loopback server with an orchestrator token. Confirm:
   - `resources/list` shows `canvas://app-model`.
   - `tools/list` shows `spawn_group` (and does NOT show `answer_permission` as a tool — it was never a tool, only a scope).
   - A `resources/read` for `canvas://app-model` returns the current canvas state.
2. In a real CLI session (claude/codex), verify `spawn_group` creates a visible cluster on the canvas and returns the correct ids.
3. Confirm `mintBoardToken` output (via a debug log or the token payload) does **not** include `answer_permission` in the scopes list.

---

## 7. Acceptance criteria

- [ ] **C1 wire-reachable:** an orchestrator-tier MCP session can call `resources/read` on `canvas://app-model` and receive the current app self-model as JSON with `{ version: 1, boardTypes, tools, canvas, rules }`.
- [ ] **C2 wire-reachable:** an orchestrator-tier MCP session can call the `spawn_group` tool and receive `{ groupId, terminalId, planningId?, browserId? }`; a Named Group + the requested board cluster appear on the canvas.
- [ ] **C3 enforced at protocol:** calling `write_result` with `summary` > 100k chars or `refs` with > 256 elements (or any element > 256 chars) returns `isError: true` from the package Zod validator — not a silent clamp.
- [ ] **F11 scope gone:** `defaultScopesFor('orchestrator')` does not include `'answer_permission'`; newly minted orchestrator tokens do not carry that scope.
- [ ] **F25 drift guard green:** the `APP_TOOLS` drift-guard test passes; `APP_TOOLS` includes `spawn_group` with `tier: 'orchestrator'`; the terminal entry in `APP_BOARD_TYPES.tools` includes `spawn_group`.
- [ ] **MAIN belt-and-suspenders intact:** the `WRITE_RESULT_MAX_SUMMARY` / `WRITE_RESULT_MAX_REFS` / `WRITE_RESULT_MAX_REF_LEN` clamps in `mcpOrchestrator.ts` are NOT removed (both layers remain).
- [ ] **Tier enforcement:** `spawn_group` and `canvas://app-model` are absent from the connected and worker tier `tools/list` / `resources/list`.
- [ ] **Two-layer test green:** package unit tests (C3 caps, F11 scope, C1 registration, C2 registration) + app unit drift-guard test all green under `pnpm typecheck && pnpm vitest run`.
- [ ] **LOCKSTEP order:** the package tag is published and available on npm before the app PR bumps the dep. The app PR must not merge against the old package version.

---

## 8. Risks & invariants

**LOCKSTEP ordering is non-negotiable.** The app's `LifecycleOrchestrator` (return type of `buildOrchestrator`) must satisfy the package's `Orchestrator` interface. TypeScript will not compile the app if the interface declares `describeApp()` and `spawnGroup()` but they are absent from the type. Conversely, the app already implements both methods — the only failure mode is attempting to merge the app PR before the package publish completes. The app PR's CI will fail with a type error if the old package version is still resolved.

**`spawn_group` is orchestrator-only — do not relax this.** The audit's §6a C2 rationale: *"Keep orchestrator-only to bound swarm growth."* A connected agent (a terminal with a cable) being able to call `spawn_group` would let it grow the swarm topology without the orchestrator's awareness. The `ctx.tier === 'orchestrator'` guard in `ServerFactory.getServer()` is the enforcement point.

**F5 sanitizer (SPEC-W1-B) must be merged first.** `spawnGroup()` in `mcpLifecycle.ts:142` contains the C1 escape-injection hole until SPEC-W1-B is applied. Shipping a wire-registered `spawn_group` MCP tool on top of the vulnerable MAIN implementation would expose the injection to any connected orchestrator. The implementation plan in §4 is predicated on SPEC-W1-B having already landed on `main`.

**`write_result` MAIN clamps stay.** The C3 change closes BUG-009 at the protocol layer. The MAIN belt-and-suspenders clamps at `mcpOrchestrator.ts:62–64` and lines 813–818 are NOT removed — they are defense-in-depth for the case where a future caller bypasses the package layer (e.g. the CANVAS_E2E seam calling `orchestrator.writeResult()` directly, or the in-process `RunningMcp.mcp.ts` path). Both layers must agree independently.

**`SCOPE_ANSWER_PERMISSION` constant stays defined.** The scope name is needed by the future M8 implementation to gate the `answer_permission` tool. Only its inclusion in `ORCHESTRATOR_SCOPES` is removed. If a contributor re-adds it to the default array before the tool ships, the F11 scope-table test will catch it.

---

## 9. Handoff / sequencing

**Dependency on W1-B:** SPEC-W1-B (`spawnGroup` sanitizer) must be merged to `main` before this spec is implemented. The sanitizer fix is independent of wiring and should ship on its own PR (SPEC-W1-B's §9 makes this explicit). Block the C2-wire implementation on SPEC-W1-B being green.

**Co-release opportunity with W1-F (prompts substrate):** The prompts-primitive scaffold (S1 / SPEC-W1-F, filling `registerPrompts`) is a package-only change with no interface extension. It can be bundled into the same package PR as C1/C2/C3/F11 to save a package bump cycle. Neither is a dependency of the other; co-release is an optimization, not a requirement.

**Wave 2 unlock:** the Wave 2 canvas-ade primer (S2) generates its tool catalog from `APP_TOOLS` and checks the registered tool list to validate itself. Both `spawn_group` and `canvas://app-model` must be in the catalog + registered before S2 is written — otherwise the primer would describe a tool the agent can't yet call and miss the resource it should read for orientation. This spec is therefore a **hard gate** on SPEC-W2-S2.

**Package publish pipeline:** the publish is triggered by a semver tag push (`v*`) to the `canvas-ade-mcp` repo's `publish.yml`. The tag must be pushed explicitly after the PR merges to `main` on the sibling repo. Monitor the npm registry (`@expanse-ade/mcp`) for the new version before opening the app PR (see memory note `mcp-publish-gating.md` for the `setup-node@v5 package-manager-cache:false` gotcha in the publish workflow).
