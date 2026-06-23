# SPEC-W1-E — persist provisionedDirs across restart

**Wave:** 1 · **Priority:** P0 · **Source findings:** F8 (HIGH defect-audit / MED this audit), F22 (LOW) · **Type:** MAIN/security · **Repos/zones:** `src/main/cliProvisioners/index.ts`, `src/main/index.ts`, new `src/main/cliProvisioners/provisionedDirStore.ts`

---

## 1. Problem

**F8 — stale bearer token survives restart AND consent-revoke (HIGH, defect-audit 2026-06-20).**

Quoted from REPORT.md §3 F8:
> `provisionedDirs` in-memory only → bearer token in non-root cwd survives restart + consent-revoke

The exact failure sequence:

1. User enables orchestration, spawns a terminal board with `cwd = <project>/packages/api`. The spawn-time hook (`makeOrchestrationSyncProvider`, `cliProvisioners/index.ts:233–245`) writes `<project>/packages/api/.mcp.json` containing a plaintext bearer token, and calls `recordProvisionedDir(projectDir, targetDir)` to add that path to the in-memory `provisionedDirs` Map (`index.ts:168`).
2. User quits the app. The `provisionedDirs` Map is process memory — it is not persisted anywhere.
3. User restarts the app. `provisionedDirs` is now empty (a fresh `new Map<string, Set<string>>()`).
4. User revokes orchestration consent via the ConsentModal. `onChange(projectPath, false)` fires (`index.ts:633–639`), calls `unsyncProvisioners({ projectDir: projectPath })`.
5. `unsyncProvisioners` builds its dir set as `new Set([projectDir, ...(provisionedDirs.get(projectDir) ?? [])])`. Because `provisionedDirs` is empty after the restart, the set contains only `projectDir` (the project root).
6. Root cleanup runs, but `<project>/packages/api/.mcp.json` is never touched. The file still contains the now-revoked bearer token and remains a live credential on disk, readable by any process.

Any board whose `cwd` diverged from the project root during any prior app session creates this residue. The token the file carries was minted in that prior session; by the time revoke fires in the new session, the in-memory connected-token store has already been replaced (new port, new CSPRNG token), so the on-disk credential is **stale-but-readable** — it will be rejected by the MCP server, but it reveals the bearer format and could be replayed against a future session if the server happened to reuse a port.

**F22 — narrow revoke-ordering window (LOW).**

Quoted from REPORT.md §3 F22:
> Consent-revoke fires `revokeAllConnected` before `unsyncProvisioners` completes — narrow window where on-disk token is re-readable after in-memory invalidation

Current call order at `index.ts:638–639`:
```
void unsyncProvisioners({ projectDir: projectPath }).catch(() => {})  // async, fire-and-forget
mcp?.revokeAllConnected()                                              // synchronous, runs FIRST
```

`revokeAllConnected()` is synchronous (`mcp.ts:219`: `connected.revokeAll()`). It zeroes the in-memory token store immediately. However because `unsyncProvisioners` is fire-and-forget (`void … .catch()`), `revokeAllConnected` completes — and any concurrent MCP request that just passed authentication with the old bearer is now blocked — while the on-disk `.mcp.json` files still carry that token. The window between `revokeAllConnected` completing and the last `removeSync` call completing is on the order of a few file-system operations, but it is non-zero. Defense-in-depth demands that disk tokens die before the in-memory store is cleared, not after.

---

## 2. Goal and non-goals

**Goal:** Persist the `provisionedDirs` Map to `userData` (atomic write, `write-file-atomic`) so that after any app restart the full set of dirs that received a project-scoped provisioner config is available to `unsyncProvisioners`, and consent-revoke therefore removes every on-disk bearer token regardless of which app session wrote it. Additionally fix the F22 ordering so disk cleanup runs (and `await`s) before `revokeAllConnected`.

**Non-goals:**
- This is NOT an agent-driven `/canvas-revoke` skill. The audit explicitly killed that approach (REPORT.md §8 Killed proposals): "Build the MAIN fix (F8 persistence), not the skill." A file-scanner skill would need to track four config formats, edit user credential files, and runs in the wrong process.
- This is NOT a canvas.json schema change. The provisioned-dir set is MAIN/security state that must outlive any one project file and is never user-visible. It lives in `userData`, not the project folder.
- This does NOT change what configs are written or the 0o600 / merge-not-clobber invariants on the write side.
- This does NOT introduce any new IPC surface.
- This does NOT gate the revoke path on persistence success — revoke must still complete even if the store file is unwritable (best-effort cleanup rule unchanged).

---

## 3. Design

### 3a. Persisted file path and shape

```
<userData>/provisioned-dirs.json
```

Following the exact pattern used by `orchestration-consent.json` (`orchestrationConsent.ts:34–71`) and `recap-consent.json` (`recapConsent.ts:17–50`): a flat JSON object keyed by absolute project path, value is an array of divergent target dirs.

```jsonc
{
  "/Users/alice/myproject": [
    "/Users/alice/myproject/packages/api",
    "/Users/alice/myproject/apps/web"
  ],
  "/Users/alice/otherproject": []
}
```

- **Key:** the project root (`projectDir`) as an absolute path string — the same key used throughout `cliProvisioners/index.ts` for the in-memory Map.
- **Value:** an array of strings (serialization of the `Set<string>`). The project root itself is NEVER stored in the array (matches `recordProvisionedDir`'s "only track divergent dirs" rule at `index.ts:172`).
- **Empty arrays** are valid and written for a project that only ever wrote to its root.
- **Unknown/extra keys** are preserved on load (round-trip safe).

### 3b. New module: `src/main/cliProvisioners/provisionedDirStore.ts`

A self-contained file-backed store, testable without Electron, following the `orchestrationConsent.ts` structure:

```ts
// Reads the persisted store from disk. Returns {} on missing or corrupt file (safe default).
function readStore(userDataDir: string): Record<string, string[]>

// Atomically writes the full store to disk. mkdirSync for userDataDir if needed.
function writeStore(userDataDir: string, store: Record<string, string[]>): void

// Record a divergent dir for a project. Reads → merges → writes atomically.
export function persistProvisionedDir(userDataDir: string, projectDir: string, targetDir: string): void

// Load persisted dirs into the in-memory Map on app boot.
export function loadProvisionedDirs(
  userDataDir: string,
  map: Map<string, Set<string>>
): void

// Remove a project's entry from the store after a full unsync (cleanup).
export function clearPersistedDirs(userDataDir: string, projectDir: string): void
```

**Atomic write** uses `writeFileAtomic.sync` (same import already present in `orchestrationConsent.ts`).  
**Read is parse-defensive** (`try/catch` → `{}`), same pattern as `readAll` in `recapConsent.ts:22–33`.  
**No Electron imports** — `userDataDir` is passed explicitly; the module is pure Node/fs (testable in vitest without mocking Electron `app`).

### 3c. Wire `provisionedDirStore` into `cliProvisioners/index.ts`

**On every `recordProvisionedDir` call** (which happens inside `makeOrchestrationSyncProvider` at `index.ts:244`), after updating the in-memory Map, call `persistProvisionedDir(userDataDir, projectDir, targetDir)`.

This requires `userDataDir` to be injectable into `recordProvisionedDir`. Two options:
- **Preferred (module-level binding, matches consent pattern):** expose a `bindProvisionedDirStore(userDataDir: string)` function, called once at boot from `index.ts` alongside `bindConsentStore`. The module-level `userDataDir` is `null` until bound; when null, `recordProvisionedDir` still updates the in-memory Map but skips the disk write (graceful degradation, not a throw — the in-memory fix still works within a session).

**On `unsyncProvisioners` full-unsync** (where `!opts.ids` at `index.ts:210`): call `clearPersistedDirs(userDataDir, projectDir)` after the cleanup loop completes, to remove the project's entry from the store.

**On boot** (in `index.ts`, after `bindProvisionedDirStore` is called): call `loadProvisionedDirs(userData, provisionedDirs)` to hydrate the in-memory Map from the persisted store before any revoke path could fire. This must happen before `registerOrchestrationHandlers` registers the `onChange` callback that calls `unsyncProvisioners`.

### 3d. Fix F22 revoke ordering in `index.ts:638–639`

Current (wrong order):
```ts
void unsyncProvisioners({ projectDir: projectPath }).catch(() => {})
mcp?.revokeAllConnected()
```

Correct (disk dies first):
```ts
// F22: await disk cleanup BEFORE revoking in-memory tokens — so the window where an
// on-disk token is readable after in-memory invalidation is eliminated.
void unsyncProvisioners({ projectDir: projectPath })
  .catch(() => {})
  .finally(() => { mcp?.revokeAllConnected() })
```

`unsyncProvisioners` is already fully idempotent and failure-isolated (each `removeSync` call is try/catched). Chaining `revokeAllConnected` in `.finally()` means it fires whether the disk cleanup succeeded or partially failed — which is the right behavior: a locked/missing file must never block the in-memory revoke. The `void` is preserved so the `onChange` callback still returns synchronously (the `orchestrationConsent.ts:142` contract: `onChange` must not throw synchronously).

### 3e. Idempotent cleanup of dirs that no longer exist

`unsyncProvisioners` already calls `PROVISIONERS[id].removeSync(dir)` inside a `try/catch` that swallows all errors (`index.ts:202–206`). A dir that vanished between sessions will cause `removeSync` to throw (ENOENT) which is caught and swallowed. No additional code is needed, but the new unit test (§6, "vanished dir") must confirm this path is exercised.

### 3f. Idempotency of `loadProvisionedDirs`

`loadProvisionedDirs` merges the stored dirs into the in-memory Map using `Set` union semantics: for each project key in the store, it creates or extends the existing Set (if the Map already has entries for that project from within the current session). This handles the edge case where boot-load runs after some dirs were already recorded in-memory during the same session (unlikely in practice, but safe).

---

## 4. Implementation plan

### Step 1 — new `src/main/cliProvisioners/provisionedDirStore.ts`

Create the module as described in §3b. It imports only `node:fs`, `node:path`, and `write-file-atomic` (all already in the project's `dependencies`). Exports: `bindProvisionedDirStore`, `persistProvisionedDir`, `loadProvisionedDirs`, `clearPersistedDirs`. No Electron imports.

File: `src/main/cliProvisioners/provisionedDirStore.ts`

### Step 2 — update `src/main/cliProvisioners/index.ts`

Four targeted changes:

1. **Import** `bindProvisionedDirStore`, `persistProvisionedDir`, `loadProvisionedDirs`, `clearPersistedDirs` from `./provisionedDirStore`.
2. **Export `bindProvisionedDirStore`** so `src/main/index.ts` can call it at boot.
3. **Export `loadProvisionedDirs`** (wrapping the internal Map) so boot can hydrate it — or expose it as `loadPersistedProvisionedDirs(userDataDir: string): void` that closes over `provisionedDirs`.
4. In **`recordProvisionedDir`** (line 171–179): after `dirs.add(targetDir)`, call `persistProvisionedDir(userDataDir, projectDir, targetDir)`.
5. In **`unsyncProvisioners`** (line 194–211): after `provisionedDirs.delete(opts.projectDir)` (the full-unsync case), call `clearPersistedDirs(userDataDir, opts.projectDir)`.
6. Update the existing `__resetProvisionedDirs` test seam to also clear the bound `userDataDir` (or add a separate `__resetProvisionedDirStore` seam for the new module — preferred to keep seams isolated).

### Step 3 — update `src/main/index.ts`

Three targeted changes (all in the boot sequence, around line 615–652):

1. **Import** `bindProvisionedDirStore` and `loadPersistedProvisionedDirs` from `./cliProvisioners`.
2. **Before `registerOrchestrationHandlers`**: call `bindProvisionedDirStore(userData)` and `loadPersistedProvisionedDirs(userData)` to hydrate the Map before any revoke callback can fire.
3. **In the `onChange` callback** (lines 633–641): replace the fire-and-forget + synchronous revoke pattern with the `.finally()` ordering described in §3d.

Boot sequence (the relevant fragment after the change):
```ts
// Boot: hydrate the provisioned-dir registry from userData before any revoke path fires.
bindProvisionedDirStore(userData)
loadPersistedProvisionedDirs(userData)

registerOrchestrationHandlers(
  ipcMain,
  () => mainWindow,
  userData,
  getCurrentDir,
  (projectPath, on) => {
    if (!on) {
      // F8: provisionedDirs is now hydrated from disk, so unsync covers dirs from prior sessions.
      // F22: disk cleanup (unsync) runs and completes before in-memory tokens are revoked.
      void unsyncProvisioners({ projectDir: projectPath })
        .catch(() => {})
        .finally(() => { mcp?.revokeAllConnected() })
    }
  }
)
```

---

## 5. Schema / migration impact

**No `canvas.json` schema change.** The `provisioned-dirs.json` file lives in `userData` and is not part of the canvas document schema (ADR 0007 / two-tier versioning applies only to `canvas.json`).

**`userData` state file versioning:** the file uses the same unversioned flat-object pattern as `orchestration-consent.json` and `recap-consent.json`. No version field is needed because:
- The file is additive-only (new project keys are merged in).
- Corrupt or unreadable files degrade to `{}` (empty map, safe default — same as no prior sessions).
- The file can be safely deleted by the user at any time (worst case: a single revoke cycle after the next boot may miss dirs from prior sessions, but re-provisioning is harmless).

If a future migration is ever needed (e.g., to add per-dir CLI tracking), a `"version"` field can be introduced then, following the same pattern used for consent stores. No floor bump is needed today.

---

## 6. Tests

All new tests live in `src/main/cliProvisioners/provisionedDirStore.test.ts` (unit) and the existing `src/main/cliProvisioners/index.test.ts` (regression coverage for the F8/F22 scenarios).

### Unit tests for `provisionedDirStore.ts`

**Test: persist + reload round-trip** (regression label: `F8-persist-reload`)
- Create a temp `userDataDir`.
- Call `persistProvisionedDir(userDataDir, '/proj', '/proj/sub')` twice (idempotency).
- Call `loadProvisionedDirs(userDataDir, new Map())`.
- Assert the Map contains `{ '/proj' => Set { '/proj/sub' } }` (one entry despite two writes).

**Test: clearPersistedDirs removes only the target project**
- Persist two projects. Clear one. Reload. Assert the other survives.

**Test: readStore degrades gracefully on corrupt / missing file**
- Call `loadProvisionedDirs` pointing at a dir with a malformed JSON file. Assert no throw, Map remains empty.

### Regression tests in `index.test.ts`

**Test: F8 — unsync cleans a non-root dir from a prior session** (regression label: `F8-cross-restart`)

```
1. Bind a real temp userDataDir.
2. Use makeOrchestrationSyncProvider to write .mcp.json into <dir>/sub.
3. Call __resetProvisionedDirs() to simulate a restart (clear in-memory Map).
4. Call loadPersistedProvisionedDirs(userDataDir) to restore from disk.
5. Call unsyncProvisioners({ projectDir: dir }).
6. Assert: join(sub, '.mcp.json') does NOT exist.
```

This test proves the core F8 fix: after simulating an in-memory reset + reload from disk, revoke still finds and cleans the divergent dir.

**Test: F8 — unsync is safe when the persisted dir no longer exists** (regression label: `F8-vanished-dir`)

```
1. Persist a dir into the store.
2. Do NOT create the dir on disk (simulate a deleted project subfolder).
3. Reload and call unsyncProvisioners.
4. Assert: no throw, cleanup completes normally.
```

**Test: F22 — revokeAllConnected fires AFTER unsync completes** (regression label: `F22-revoke-order`)

This test lives at the `index.ts` integration level (not the provisioner unit level), using vitest spies:

```
1. Spy on unsyncProvisioners and inject a deferred resolution (resolves after 10ms).
2. Spy on revokeAllConnected.
3. Trigger the onChange(projectPath, false) callback.
4. Await the full chain.
5. Assert: the revokeAllConnected spy was called AFTER unsyncProvisioners resolved (use
   invocation order captured via a shared counter or Promise chain inspection).
```

If testing the index.ts callback directly is too invasive (it's not exported), extract the revoke-ordering logic into a thin helper `revokeOrchestration(projectPath, unsync, revoke)` that is unit-testable independently.

---

## 7. Acceptance criteria (Definition of Done)

- **After restart, consent-revoke removes EVERY provisioned `.mcp.json` token.** Specifically: a bearer token written into `<project>/sub/.mcp.json` during Session A is absent from disk after a consent-revoke in Session B (even though Session B never spawned a terminal board with that cwd).
- **No stale credential survives.** The `F8-cross-restart` test passes with a real temp filesystem (not mocked).
- **Revoke ordering.** `revokeAllConnected` fires only after `unsyncProvisioners` resolves. The `F22-revoke-order` test passes.
- **Graceful degradation.** A vanished dir (`F8-vanished-dir`), a corrupt `provisioned-dirs.json`, or an unbound `userDataDir` (if `bindProvisionedDirStore` is never called, e.g. in tests) all complete without a thrown exception; the in-memory cleanup still runs.
- **`pnpm typecheck` passes** (no unused locals, strict mode, no `any` escapes).
- **Existing `index.test.ts` tests all still pass** (the FIND-001 within-session test at line 147 must continue to work — this spec does not regress it).

---

## 8. Risks and invariants

**0o600 preserved.** The new store (`provisioned-dirs.json`) contains only directory paths, not tokens. The token-bearing files it helps locate (`.mcp.json`, `opencode.json`) are written by the existing provisioner `writeSync` implementations, which already enforce 0o600. This spec does not touch those write paths.

**Merge-not-clobber preserved.** `provisionedDirStore.ts` never writes a `.mcp.json` file. It writes only `provisioned-dirs.json` in `userData`. The merge-not-clobber invariant applies exclusively to the per-CLI config write path (unchanged).

**Token never reaches renderer.** `provisioned-dirs.json` contains only path strings. No token is ever written to or read from this file. The existing invariant ("raw token NEVER crosses to the renderer", `orchestrationProvision.ts:17`) is entirely unaffected.

**userData, not project folder.** `provisioned-dirs.json` is written to `app.getPath('userData')`, exactly matching the locked CLAUDE.md rule: "App config + state live under `app.getPath('userData')`, NEVER in the project folder." Project folders are user-version-controlled territory; security state that must outlive any one project lives in `userData` (same rationale as `orchestration-consent.json`).

**Atomic writes.** All writes to `provisioned-dirs.json` use `writeFileAtomic.sync` — the same library used throughout `orchestrationConsent.ts`, `recapConsent.ts`, and the provisioner write paths.

**Single writer.** MAIN is the only writer of `provisioned-dirs.json`. The renderer never sees it and cannot request writes to it. No concurrent writer exists (single-user desktop; Electron MAIN is single-threaded for this path).

**Revoke remains best-effort.** The `.finally()` ordering change (§3d) preserves the fire-and-forget character of the `onChange` callback: `onChange` itself returns synchronously (the void + Promise chain exits the synchronous frame immediately). A file-system error during `unsyncProvisioners` is caught by `.catch(() => {})` before `.finally` fires `revokeAllConnected`, so a locked config file can never block the in-memory revoke.

---

## 9. Handoff and sequencing

**Standalone MAIN security fix.** This spec touches no renderer code, no IPC surface changes, no schema changes. It can be implemented, reviewed, and merged entirely independently of the other Wave 1 specs (W1-A through W1-D).

**Must precede shipping more provisioning surface.** The audit (REPORT.md §7, Wave 1 step 5) explicitly sequences F8 before adding new provisioner coverage: "F8 persist `provisionedDirs` — standalone security fix, precedes shipping more provisioning surface." Any new CLI provisioner or new board-cwd provisioning scenario added after this PR will inherit the persistence automatically (no per-provisioner changes needed).

**Sequencing relative to other Wave 1 items:**
- Parallel with W1-A (discoverability), W1-B (sanitizer), W1-C (config audit), W1-D (shared types) — no file-level collision.
- Does NOT depend on any of those specs.
- Does NOT block any of those specs.

**Implementation effort:** S (small). The new module is ~60 lines of pure Node/fs code following an established pattern. The `index.ts` changes are 3 targeted edits (~10 lines). The `onChange` ordering change is a 2-line mechanical transformation. Total new code < 100 lines.
