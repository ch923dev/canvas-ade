# SPEC-W1-C — configure_board audit integrity

**Wave:** 1 · **Priority:** P0 (F6) / P1 (F7) · **Source findings:** F6, F7 · **Type:** MAIN/correctness · **Repos/zones:** `src/main/mcpOrchestrator.ts` (lines 497–548), `src/main/mcpOrchestrator.test.ts` (lines 507–547)

---

## 1. Problem

### F6 (MED — Correctness): wrong verb on the human-deny path

At `mcpOrchestrator.ts:503`, when the human-confirm dialog returns `approved: false` on a `configure_board` call that carries a `launchCommand`, the code writes:

```ts
status: 'rejected',
detail: 'launchCommand configure denied by the human gate'
```

The correct `DispatchStatus` token for a human-gated denial is `'denied'`, not `'rejected'`. Every other human-deny path in the same file uses `'denied'` (see: `handoffPrompt` ~line 309, `addPlanningElements` ~line 614, `relayPrompt`). `'rejected'` is reserved for schema/sanitizer/pre-gate failures (malformed payload, board-not-found, type mismatch) — i.e. failures that never reached a human.

The `configure_board` tool is exec-vector-adjacent: a persisted `launchCommand` runs verbatim as the first PTY line on the board's next spawn. The audit log is the forensic record for that path. Conflating `'rejected'` (automated pre-gate failure) with `'denied'` (human explicitly said no) corrupts the one place an auditor can distinguish "the system blocked this before a human saw it" from "a human was shown this exact command and chose to block it." On the riskiest configure path, that distinction is not cosmetic.

The existing test at `mcpOrchestrator.test.ts:517` asserts `audits.find((a) => a.status === 'rejected')` for the deny case — this test also passes incorrectly today and must be corrected to assert `'denied'`.

### F7 (MED — Correctness): no audit on the shell/cwd-only path

At `mcpOrchestrator.ts:544–548`, when `configure_board` is called with only `shell` and/or `cwd` (no `launchCommand`), the code applies the config directly with no audit entry on either success or failure:

```ts
// No launchCommand → no exec vector. Apply the durable per-type config via the command channel.
const ack = await registry.sendCommand({ type: 'configureBoard', id: boardId, patch: config })
if (!ack.ok) throw new Error(`configure_board failed: ${ack.error}`)
```

The locked architecture invariant is: **every cross-board write leaves an audit trace**. A `cwd` or `shell` change is a durable per-board config write that persists to `canvas.json`. The comment "no exec vector" is correct for execution risk, but it does not exempt the write from the trace requirement — the audit log is the forensic record for *any* write, not just dangerous ones. Without this trace, a shell reconfiguration (or a failed apply) leaves no record, breaking the "every write leaves exactly one correct audit entry" contract the rest of the MCP surface upholds.

The existing test at `mcpOrchestrator.test.ts:537` explicitly asserts `audits` is empty for this path — this assertion is wrong and must be inverted once the fix is in.

---

## 2. Goal & non-goals

**Goal:** Both defects are one-file MAIN fixes + test corrections. Together they restore the invariant that every `configure_board` call — across all three branches (sanitizer-reject, human-deny, shell/cwd-only) — leaves exactly one correctly labelled audit entry.

**Non-goals:**
- No change to the gating model. The shell/cwd-only path is correctly exempt from human confirm (no exec vector); this spec adds audit only, not a gate.
- No change to the `launchCommand` sanitizer-reject path (line 480): it already emits `status: 'rejected'` correctly and that is the right token for a pre-gate automated failure.
- No schema migration. `AuditEntry.status` is a free `string` field in `auditLog.ts` (not a DB column, not serialized with a version). The `DispatchStatus` union is a TypeScript type used only in `mcpOrchestrator.ts` to constrain what the local `writeAudit` wrapper accepts.
- No change to `auditLog.ts` itself. `createAuditLog` is status-agnostic.

---

## 3. Design

### Canonical verb enum

`DispatchStatus` is defined at `src/main/mcpRegistry.ts:47–56`:

```ts
export type DispatchStatus =
  | 'rejected'   // automated pre-gate failure (sanitizer, board-not-found, type mismatch)
  | 'denied'     // human said no at the confirm dialog
  | 'failed'     // write reached the apply step and failed there
  | 'dispatched' // live PTY write in-flight
  | 'completed'  // live PTY write confirmed done
  | 'closed'
  | 'timed_out'
  | 'configured' // durable config persisted (launchCommand path, already in use correctly)
  | 'applied'    // add_planning_elements confirmed + landed
```

### F6 fix: deny path

Change the status token at line 503 from `'rejected'` to `'denied'`. No other field changes.

Before:
```ts
await writeAudit({
  type: 'configure_board',
  targetId: boardId,
  prompt: safeLaunch,
  nonce: '',
  status: 'rejected',
  detail: 'launchCommand configure denied by the human gate'
})
```

After:
```ts
await writeAudit({
  type: 'configure_board',
  targetId: boardId,
  prompt: safeLaunch,
  nonce: '',
  status: 'denied',
  detail: 'launchCommand configure denied by the human gate'
})
```

### F7 fix: shell/cwd-only path

Add two audit entries to the shell/cwd branch: `'configured'` on success, `'failed'` on apply failure. The prompt field is empty (no exec content); the detail describes the patch keys written (or the error).

Before:
```ts
const ack = await registry.sendCommand({ type: 'configureBoard', id: boardId, patch: config })
if (!ack.ok) throw new Error(`configure_board failed: ${ack.error}`)
```

After:
```ts
const ack = await registry.sendCommand({ type: 'configureBoard', id: boardId, patch: config })
if (!ack.ok) {
  await writeAudit({
    type: 'configure_board',
    targetId: boardId,
    prompt: '',
    nonce: '',
    status: 'failed',
    detail: `configure_board apply failed: ${ack.error}`
  })
  throw new Error(`configure_board failed: ${ack.error}`)
}
await writeAudit({
  type: 'configure_board',
  targetId: boardId,
  prompt: '',
  nonce: '',
  status: 'configured',
  detail: `shell/cwd configured: ${Object.keys(config).join(', ')}`
})
```

The `detail` field records which keys were actually patched (e.g. `"shell/cwd configured: shell, cwd"`) so the audit entry is forensically useful without including the value of `cwd` (which could be a sensitive path). The prompt is `''` because there is no exec content — this matches the `add_planning_elements` pattern (content-less actions use `''` for prompt).

---

## 4. Implementation plan

All changes are in a single file: `src/main/mcpOrchestrator.ts`.

**Step 1 — F6: change one word (line 503)**

Locate the block inside `configureBoard` that is reached after `registry.confirm()` returns `{ approved: false }`. Change `status: 'rejected'` to `status: 'denied'`. The surrounding `writeAudit` call, the `nonce: ''`, the `detail`, and the `throw` are all correct — only the status token changes.

**Step 2 — F7: add audit to the shell/cwd branch (lines 544–548)**

Locate the branch at the end of `configureBoard` that begins with the comment `// No launchCommand → no exec vector.` Replace the two-line `sendCommand` + conditional throw with the four-branch pattern described in §3: sendCommand → if not ok: writeAudit `failed` + throw → writeAudit `configured`. No new imports are needed; `writeAudit` is already in scope at this point.

**Step 3 — update the test file: `src/main/mcpOrchestrator.test.ts`**

Two test corrections:

1. The test at line 507 (`'a denied confirm blocks the launchCommand write — NO command sent, audits rejected'`):
   - Change the test name to use `'denied'` not `'rejected'`.
   - Change the assertion at line 517: `audits.find((a) => a.status === 'rejected')` → `audits.find((a) => a.status === 'denied')`.
   - The `toMatchObject` at line 518 must also match the updated status: add `status: 'denied'` to the matcher.

2. The test at line 537 (`'a shell/cwd-only patch (no launchCommand) passes WITHOUT a confirm or audit'`):
   - Rename the test to reflect the new contract: `'a shell/cwd-only patch (no launchCommand) passes WITHOUT a confirm and leaves a configured audit entry'`.
   - Remove the assertion `expect(audits).toEqual([])`.
   - Add assertions confirming a single `'configured'` audit entry was written with `type: 'configure_board'`, `targetId: 'board-5'`, `prompt: ''`, and `status: 'configured'`.

**Step 4 — add two new regression tests (F6 + F7 named)**

Add the following tests immediately after the existing `configureBoard` block:

- `'F6: denied confirm audits status=denied not rejected'` — mirrors the existing deny-path test but explicitly names the finding and asserts `status === 'denied'` and `status !== 'rejected'`.
- `'F7: shell/cwd-only failure audits status=failed'` — uses a `configReg({ ack: { ok: false, error: 'no-window' } })` fixture with no `launchCommand`, calls `configureBoard` with `{ shell: 'pwsh' }`, and asserts the audits include one entry with `status: 'failed'` and `type: 'configure_board'`.

---

## 5. Schema / migration impact

None. `AuditEntry` in `auditLog.ts` defines `status: string` — no enum, no DB column, no version bump. The `DispatchStatus` union in `mcpRegistry.ts` already includes both `'denied'` and `'configured'`; no extension is needed. The JSONL audit log on disk has no schema version; old entries are simply read as-is (tolerating unknown statuses via `parseEntries`). New entries written with `'denied'` and `'configured'` are fully backward-compatible.

Note: `DispatchStatus` is a TypeScript-only constraint applied at the call site of `writeAudit` (line 224: the wrapper types the `status` field to `DispatchStatus`). If new status tokens are ever needed for future `configure_board` variants, they must be added to the union in `mcpRegistry.ts`. No extension is required for this spec.

---

## 6. Tests

### Corrections to existing tests (`mcpOrchestrator.test.ts`)

| Line | Current assertion | Corrected assertion | Reason |
|---|---|---|---|
| 507 (test name) | `'...audits rejected'` | `'...audits denied'` | Name should match expected status |
| 517 | `audits.find((a) => a.status === 'rejected')` | `audits.find((a) => a.status === 'denied')` | F6: deny path must emit `'denied'` |
| 518 | `toMatchObject({ type: 'configure_board', targetId: 'board-5' })` | add `status: 'denied'` to matcher | Explicit status assertion |
| 537 (test name) | `'...passes WITHOUT a confirm or audit'` | `'...passes WITHOUT a confirm and leaves a configured audit entry'` | F7: shell/cwd path now audits |
| 543 | `expect(audits).toEqual([])` | remove; replace with configured-entry assertions | F7: invert the no-audit assertion |

### New regression tests (add after line 591)

```
describe('F6 regression — configure_board deny path emits denied not rejected', () => {
  it('F6: a human-denied launchCommand configure audits status=denied, not rejected', async () => {
    const { audits } = configReg({ confirm: async () => ({ approved: false }) })
    const orch = buildOrchestrator(registry)
    await expect(orch.configureBoard('board-5', { launchCommand: 'claude' })).rejects.toThrow()
    const denied = audits.find((a) => a.status === 'denied')
    expect(denied).toBeDefined()
    expect(denied).toMatchObject({ type: 'configure_board', targetId: 'board-5', status: 'denied' })
    expect(audits.some((a) => a.status === 'rejected')).toBe(false) // 'rejected' must NOT appear
  })
})

describe('F7 regression — shell/cwd-only configure_board path audits on success and failure', () => {
  it('F7: shell/cwd success writes a configured audit entry', async () => {
    const { audits } = configReg({})
    const orch = buildOrchestrator(registry)
    await orch.configureBoard('board-5', { shell: 'pwsh', cwd: '/repo' })
    const configured = audits.find((a) => a.status === 'configured')
    expect(configured).toMatchObject({
      type: 'configure_board',
      targetId: 'board-5',
      prompt: '',
      status: 'configured'
    })
  })

  it('F7: shell/cwd failure writes a failed audit entry before throwing', async () => {
    const { audits } = configReg({ ack: { ok: false, error: 'no-window' } })
    const orch = buildOrchestrator(registry)
    await expect(orch.configureBoard('board-5', { shell: 'pwsh' })).rejects.toThrow(/no-window/)
    const failed = audits.find((a) => a.status === 'failed')
    expect(failed).toMatchObject({
      type: 'configure_board',
      targetId: 'board-5',
      prompt: '',
      status: 'failed'
    })
  })
})
```

Note: the test snippets above use the same `configReg` helper already defined in the `configureBoard` describe block.

---

## 7. Acceptance criteria

- [ ] `mcpOrchestrator.ts:503` emits `status: 'denied'` (not `'rejected'`) when the human confirm returns `{ approved: false }` on a `launchCommand` configure.
- [ ] `mcpOrchestrator.ts` shell/cwd-only success path writes exactly one `{ type: 'configure_board', status: 'configured', prompt: '' }` audit entry after the apply ack returns `{ ok: true }`.
- [ ] `mcpOrchestrator.ts` shell/cwd-only failure path writes exactly one `{ type: 'configure_board', status: 'failed' }` audit entry before throwing.
- [ ] No branch of `configureBoard` writes more than one audit entry per invocation (no double-audit).
- [ ] The corrected test at line 507 asserts `status === 'denied'` and the matcher includes `status: 'denied'`.
- [ ] The corrected test at line 537 asserts a `'configured'` audit entry exists (the `audits.toEqual([])` assertion is removed).
- [ ] The two new F6/F7 regression tests pass.
- [ ] `pnpm typecheck` and `pnpm test -- --testPathPattern=mcpOrchestrator` are both green with no new errors.
- [ ] The `DispatchStatus` union in `mcpRegistry.ts` requires no modification (all needed tokens already exist).

---

## 8. Risks & invariants

**Append-only chain unbroken.** `createAuditLog.append` is already serialized through a single promise chain (BUG-024). The new shell/cwd audit calls are sequential within the same `configureBoard` invocation, so there is no concurrent write risk. The chain is not shortened, rotated early, or bypassed.

**No double-audit risk.** The three `configureBoard` branches are mutually exclusive:
- Sanitizer fails → throws early, no further code runs → one `'rejected'` entry (existing, correct).
- Sanitizer passes → human-deny → one `'denied'` entry (F6 fix) + throw → shell/cwd branch never reached.
- Sanitizer passes → human-approves → apply fails → one `'failed'` entry + throw (existing, correct).
- Sanitizer passes → human-approves → apply succeeds → one `'configured'` entry (existing, correct).
- No `launchCommand` → shell/cwd branch → apply fails → one `'failed'` entry (F7 fix, new).
- No `launchCommand` → shell/cwd branch → apply succeeds → one `'configured'` entry (F7 fix, new).

Each path emits exactly one entry. No path was double-auditing before this fix and none will double-audit after.

**`writeAudit` typing.** The local `writeAudit` wrapper (line 224) types `status` as `DispatchStatus`. Both `'denied'` and `'configured'` are already members of that union. TypeScript will catch any future attempt to introduce an unlisted token at compile time.

**Security gate unchanged.** The shell/cwd-only path remains exempt from human-confirm. This spec adds only an audit trace, not a gate. The executive decision that `shell`/`cwd` changes carry no exec vector (and therefore no confirm) is not re-examined here.

---

## 9. Handoff / sequencing

This is a standalone MAIN fix. It has no dependencies on any other Wave 1 spec and no downstream dependents — it touches only one function in one file, and its tests are colocated in the existing test suite.

It pairs naturally with **SPEC-W1-D** (shared-type extraction: `McpCommandIn`/`PlanningOp`/`AuditEntry` → `src/shared/mcpTypes.ts`) but has no hard dependency on it. W1-C should be merged first so the correct status strings are in the implementation before any type-refactor shuffles import paths. If W1-D ships first, the only merge-order risk is a minor import-path conflict in `mcpOrchestrator.ts` — resolvable with a standard rebase.

The fix is a MAIN-only change (no renderer, no preload, no package bump). It qualifies for the Windows-leg-only pre-push gate (no `src/preload` or cross-platform paths touched).
