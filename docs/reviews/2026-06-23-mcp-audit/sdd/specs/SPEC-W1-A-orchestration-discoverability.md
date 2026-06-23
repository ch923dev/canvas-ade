# SPEC-W1-A — Orchestration discoverability

**Wave:** 1 · **Priority:** P0 · **Source findings:** F3, F4, H1, H6 · **Type:** renderer/UI · **Repos/zones:** `src/renderer/src/canvas/palette/commandRegistry.ts`, `src/renderer/src/canvas/palette/commandRegistry.test.ts`, `src/renderer/src/canvas/palette/usePaletteController.ts`, `src/renderer/src/canvas/hooks/useCanvasKeybindings.ts`, `src/renderer/src/canvas/AuditLogViewer.tsx`, `src/renderer/src/canvas/boards/CommandBoard.tsx`

---

## 1. Problem

**F3 (HIGH — UX):** `AuditLogViewer.tsx:68–78` registers its own `window.addEventListener('keydown', ...)` toggling on `Ctrl+Shift+A`. That handler is entirely self-contained and unknown to `commandRegistry.ts`. The `?` shortcuts sheet (`SHORTCUT_ROWS`) has no entry for it, and the Ctrl+K palette has no verb for it. The audit log is a **trust-critical surface** — it is the human's only read window into every `runGatedWrite` dispatch — yet it is undiscoverable to a new user. They must already know the chord by other means (tooltip on the "Audit" button in the bottom-left corner, or docs) to reach it.

**F4 (HIGH — UX):** `commandRegistry.ts:11` carries the comment *"Future MCP/agent verbs get a new section here"* but the `SECTION_ORDER` array (`line 16–23`) has no `'Orchestration'` entry, and `buildCommands` has no orchestration rows. Ctrl+K — the app's sole keyboard-driven command hub — contains **zero paths** to: open the Command board, enable orchestration, sync agent CLIs, or interrupt running workers. The only MCP-adjacent palette verbs are the two GROUP-01 connector rows buried in the `'Groups'` section.

**User-lost scenario:** A user wants to set up orchestration for the first time. They press Ctrl+K, type "orchestrat…", and get no results. They press `?` for shortcuts and see no "Orchestration" section. They try Ctrl+Shift+A hoping to inspect what their agent dispatched — nothing happens and the shortcut is not in the sheet. They look for the Command board by scrolling the canvas. There is no keyboard path to any of these actions.

**H6 (P2, folded in):** When orchestration is disabled, the Command board's empty-state reads "No tasks yet / Describe a task above and Dispatch — it spawns a worker zone and runs." This is misleading: the board will not actually dispatch anything until orchestration is enabled (consent given). The empty state gives no hint that a prerequisite exists.

---

## 2. Goal & non-goals

**Goals:**
- Add an `'Orchestration'` section to the command palette (`SECTION_ORDER` + `buildCommands`) with verbs covering the main orchestration actions — discoverable via Ctrl+K and the `?` sheet.
- Move Ctrl+Shift+A from its self-registered handler in `AuditLogViewer.tsx` into the drift-guarded keymap (`resolveCanvasKeyAction` → `CanvasKeyAction`) + `SHORTCUT_ROWS` + a palette verb.
- Add an empty-state guard to `CommandBoard.tsx` that, when `orchestrationStore.enabled === false`, explains the prerequisite and shows an Enable button.
- The drift-guard test must cover the new Ctrl+Shift+A chord.

**Non-goals:**
- No new IPC calls; no MAIN changes. All verbs route to existing renderer-side paths.
- No new board type or new store. `orchestrationStore.enabled` and the existing `useOrchestrationStore` are used as-is.
- No changes to the security model; no weakening of `contextIsolation` or `runGatedWrite`.
- Does not implement "Interrupt all workers" at the MAIN level — the palette verb opens the Command board and scrolls to the executing column; the per-task interrupt affordance already exists in `TaskCard`.

---

## 3. Design

### 3a. New palette section (Ctrl+K)

ASCII wireframe of the Ctrl+K palette with the new section visible (calm/dense Linear-Raycast feel; section headers in `var(--text-3)` uppercase micro-label; rows in `var(--text)` with mono glyph on the left):

```
┌─────────────────────────────────────────────────────────┐
│  > orchestrat_                              ╳           │
├─────────────────────────────────────────────────────────┤
│  ORCHESTRATION                                          │
│  ⚡  Open Command board              [no chip]          │
│  ⊟  View audit log               Ctrl Shift A          │
│  ✦  Enable orchestration            [no chip]          │  ← hidden when enabled=true
│  ⇄  Disable orchestration           [no chip]          │  ← hidden when enabled=false
│  ⊞  Sync agent CLIs                 [no chip]          │  ← hidden when enabled=false
│  ⏹  Go to executing tasks           [no chip]          │  ← hidden when no executing tasks
├─────────────────────────────────────────────────────────┤
│  GROUPS                                                 │
│  ⊸  Connect the 2 selected boards  [Ctrl K]            │
│  ...                                                    │
└─────────────────────────────────────────────────────────┘
```

**Visibility rules (predicate = HIDDEN when false, Raycast/Linear convention):**
- "Open Command board" — always shown (no predicate).
- "View audit log" — always shown.
- "Enable orchestration" — shown when `!snap.orchestrationEnabled`.
- "Disable orchestration" — shown when `snap.orchestrationEnabled`.
- "Sync agent CLIs" — shown when `snap.orchestrationEnabled`.
- "Go to executing tasks" — shown when `snap.hasExecutingTasks` (at least one task in routing/executing/reporting status).

### 3b. `?` shortcuts sheet — new `'Orchestration'` section

New rows appended to `SHORTCUT_ROWS` (after the existing `'Groups'` rows):

```
{ section: 'Orchestration', label: 'View audit log',          chips: ['Ctrl', 'Shift', 'A'] }
{ section: 'Orchestration', label: 'Open command palette for MCP verbs', chips: ['Ctrl', 'K'] }
```

The second row is a pedagogical reminder (no drift-guard needed — Ctrl+K is already drift-guarded as `'palette'`).

### 3c. Empty Command board guard

When `orchestrationStore.enabled === false`, a banner overlays (or replaces) the "No tasks yet" hint at the bottom of the kanban body. It does NOT replace the SubmitWell — the user can still prepare a task; the guard just explains it won't run yet.

ASCII wireframe (inside the expanded CommandBoard, below the kanban columns, color: `var(--warn)` accent strip):

```
┌─ Command board (expanded) ──────────────────────────────┐
│  [Kanban | Groups]  [⟲ recap]  [⤡ collapse]            │
│  ┌─ Submit well ───────────────────────────────────┐   │
│  │  Describe a task…                     Dispatch  │   │
│  └────────────────────────────────────────────────┘   │
│  ⚡ Worker pool   0 terminals idle   spawn cap 0       │
│  ┌ Queued ┐ ┌ Routing ┐ ┌ Executing ┐ ┌ Done ┐         │
│  │ (slot) │ │ (slot)  │ │  (slot)   │ │(slot)│         │
│  └────────┘ └─────────┘ └───────────┘ └──────┘         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ ⚠  Orchestration is not enabled for this       │   │
│  │    project. Dispatched tasks will not run       │   │
│  │    until you enable it.                        │   │
│  │                      [ Enable orchestration ]  │   │
│  └─────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
```

Style: background `var(--inset)`, border `1px solid rgba(var(--warn-rgb),0.35)`, border-radius `var(--r-inner)`, text `var(--text-2)`, `var(--fs-meta)`. The "Enable orchestration" button uses the accent style (`var(--accent)`, `var(--accent-wash)` background on hover). Clicking it fires `useOrchestrationStore.getState().setModal('enable')` — which opens the existing `OrchestrationConsentModal` via the `OrchestrationModals` host already mounted in `AppChrome`. No new modal.

### 3d. Ctrl+Shift+A move into the drift-guarded keymap

New `CanvasKeyAction` variant:
```ts
| { kind: 'toggleAuditLog' }
```

New branch in `resolveCanvasKeyAction` (after the `toggleDiag` branch, same modifier grammar):
```ts
if (k === 'a' && (e.ctrlKey || e.metaKey) && e.shiftKey && !typing) return { kind: 'toggleAuditLog' }
```

The existing self-registered listener in `AuditLogViewer.tsx:68–78` is **removed**. The `useCanvasKeybindings` dispatch loop gains a `'toggleAuditLog'` case that calls an injected `toggleAuditLog?: () => void` dep (optional, same pattern as `openPalette`). `Canvas.tsx` passes a callback that calls the `openViewer` / `closeViewer` logic exposed from `AuditLogViewer` (currently internal — needs a lift to a ref or a small Zustand slice; see §4).

### 3e. `PaletteVerbs` and `PaletteSnapshot` extensions

New verbs added to `PaletteVerbs`:
```ts
openCommandBoard: () => void
viewAuditLog: () => void
enableOrchestration: () => void
disableOrchestration: () => void
syncAgentCLIs: () => void
goToExecutingTasks: () => void
```

New snapshot fields added to `PaletteSnapshot`:
```ts
orchestrationEnabled: boolean
hasExecutingTasks: boolean
```

`SECTION_ORDER` gains `'Orchestration'` (inserted before `'Canvas'`):
```ts
export const SECTION_ORDER = [
  'Boards',
  'Selected board',
  'Groups',
  'Orchestration',   // NEW
  'Canvas',
  'Edit',
  'Help'
] as const
```

---

## 4. Implementation plan

Steps are ordered; each is independent of the next unless noted.

**Step 1 — `AuditLogViewer.tsx`: extract toggle to a ref-stable callback and expose it**

Lift `openViewer` / `closeViewer` out of the component so they can be called externally without a module import of the component. The lightest approach: create `src/renderer/src/canvas/auditLogStore.ts` — a tiny Zustand slice with `{ open: boolean; toggle: () => void }`. `AuditLogViewer` reads from it instead of `useState`. The self-registered `keydown` handler at lines 68–78 is deleted (the keyboard binding moves to the keybindings hook). The "Audit" corner-button `title` attribute updates to reflect the new shortcut chip format (`Ctrl+Shift+A`).

**Step 2 — `useCanvasKeybindings.ts`: add `'toggleAuditLog'` to keymap**

- Add `| { kind: 'toggleAuditLog' }` to `CanvasKeyAction`.
- Add the resolver branch: `if (k === 'a' && (e.ctrlKey || e.metaKey) && e.shiftKey && !typing) return { kind: 'toggleAuditLog' }`. Insert after the existing `toggleDiag` branch (same guard shape). No `!e.altKey` guard needed — Alt+Shift+A is an unrelated OS chord.
- Add `toggleAuditLog?: () => void` to `CanvasKeybindingDeps`.
- Add the `'toggleAuditLog'` case in `useCanvasKeybindings`'s dispatch switch that calls `deps.toggleAuditLog?.()` with `e.preventDefault()`.

**Step 3 — `commandRegistry.ts`: `SECTION_ORDER`, `PaletteSnapshot`, `PaletteVerbs`, `buildCommands`**

- Insert `'Orchestration'` into `SECTION_ORDER` between `'Groups'` and `'Canvas'`.
- Add `orchestrationEnabled: boolean` and `hasExecutingTasks: boolean` to `PaletteSnapshot`.
- Add the six new verb signatures to `PaletteVerbs`.
- In `buildCommands`, add the `// ── Orchestration ──` block after the Groups block:
  ```ts
  // ── Orchestration ──
  out.push({
    id: 'open-command-board',
    section: 'Orchestration',
    title: 'Open Command board',
    keywords: 'orchestrator mcp dispatch kanban agent hub',
    glyph: '⚡',
    run: () => verbs.openCommandBoard()
  })
  out.push({
    id: 'view-audit-log',
    section: 'Orchestration',
    title: 'View audit log',
    keywords: 'mcp dispatch history trust review',
    glyph: '⊟',
    chips: ['Ctrl', 'Shift', 'A'],
    run: () => verbs.viewAuditLog()
  })
  if (!snap.orchestrationEnabled) {
    out.push({
      id: 'enable-orchestration',
      section: 'Orchestration',
      title: 'Enable orchestration',
      keywords: 'mcp setup onboard consent agent',
      glyph: '✦',
      run: () => verbs.enableOrchestration()
    })
  }
  if (snap.orchestrationEnabled) {
    out.push({
      id: 'disable-orchestration',
      section: 'Orchestration',
      title: 'Disable orchestration',
      keywords: 'mcp revoke consent turn off',
      glyph: '✦',
      run: () => verbs.disableOrchestration()
    })
    out.push({
      id: 'sync-agent-clis',
      section: 'Orchestration',
      title: 'Sync agent CLIs',
      keywords: 'mcp provisioner claude codex configure',
      glyph: '⇄',
      run: () => verbs.syncAgentCLIs()
    })
  }
  if (snap.hasExecutingTasks) {
    out.push({
      id: 'go-to-executing-tasks',
      section: 'Orchestration',
      title: 'Go to executing tasks',
      keywords: 'mcp workers running interrupt dispatch',
      glyph: '⏹',
      run: () => verbs.goToExecutingTasks()
    })
  }
  ```

- Add the two new `SHORTCUT_ROWS` entries (after the Groups block):
  ```ts
  { section: 'Orchestration', label: 'View audit log',          chips: ['Ctrl', 'Shift', 'A'] },
  { section: 'Orchestration', label: 'Open command palette for MCP verbs', chips: ['Ctrl', 'K'] },
  ```

**Step 4 — `usePaletteController.ts`: wire the new verbs and snapshot fields**

- Add `orchestrationEnabled` and `hasExecutingTasks` to the snapshot read (subscribe to `useOrchestrationStore` for `enabled`, and `useCommandStore` for tasks to derive `hasExecutingTasks`).
- Wire the six new verbs in `paletteVerbs`:
  - `openCommandBoard`: call `goToBoard` with the command board's id (look it up from `useCanvasStore.getState().boards.find(b => b.type === 'command')?.id`); if absent, call `addCentered('command')`.
  - `viewAuditLog`: call `auditLogStore.getState().toggle()` (or the equivalent after Step 1).
  - `enableOrchestration`: call `useOrchestrationStore.getState().setModal('enable')`.
  - `disableOrchestration`: call `useOrchestrationStore.getState().setModal('enable')` (the modal handles the toggle, as existing consent-revoke flow is invoked from within it; alternative: `setModal('none')` + direct `IPC.revokeConsent()` — check the existing Settings toggle for the correct path and mirror it).
  - `syncAgentCLIs`: call `useOrchestrationStore.getState().setModal('sync')`.
  - `goToExecutingTasks`: call `goToBoard` with the command board id (same as `openCommandBoard`); the Command board will show the executing column.

**Step 5 — `Canvas.tsx` (or the hook call site): pass `toggleAuditLog` dep**

In `Canvas.tsx` (the call site of `useCanvasKeybindings`), add `toggleAuditLog: () => auditLogStore.getState().toggle()` to the deps object passed to the hook.

**Step 6 — `CommandBoard.tsx`: empty-state orchestration guard**

In the `tasks.length === 0` block inside the kanban view (lines 279–287 of the current file), add a conditional **below** the existing "No tasks yet" hint:

```tsx
{!orchestrationEnabled && (
  <div style={orchestrationGuardStyle}>
    <span style={{ color: 'var(--warn)' }}>⚠</span>
    {' '}Orchestration is not enabled for this project. Dispatched tasks will not run until you enable it.
    <button
      type="button"
      className="nodrag"
      onClick={(e) => {
        e.stopPropagation()
        useOrchestrationStore.getState().setModal('enable')
      }}
      style={enableBtnStyle}
    >
      Enable orchestration
    </button>
  </div>
)}
```

`orchestrationEnabled` comes from `useOrchestrationStore((s) => s.enabled)` — add that subscription at the top of `CommandBoard`. The static style objects `orchestrationGuardStyle` / `enableBtnStyle` go at the bottom of the file with the other static styles.

**Drift-guard implication:** Step 2 adds `'toggleAuditLog'` to `CanvasKeyAction`. Step 3 adds `'view-audit-log'` with `chips: ['Ctrl', 'Shift', 'A']`. The drift-guard test (in `commandRegistry.test.ts`, `describe('chip ↔ resolveCanvasKeyAction drift guard')`) must gain a new entry in the `CLAIMS` array:
```ts
{
  id: 'view-audit-log',
  chord: key('a', { ctrlKey: true, shiftKey: true }),
  kind: 'toggleAuditLog'
}
```
This is the only new CLAIM needed. The `'Orchestration'` section must also pass the existing `'every command sits in a known section'` test — which it will because `SECTION_ORDER` is updated.

---

## 5. Schema / migration impact

None. All changes are pure renderer-side (Zustand ephemerals + React state). No `canvas.json` fields are read or written. No `schemaVersion` bump. No `minReaderVersion` change. The `auditLogStore.ts` introduced in Step 1 is runtime-only session state (never serialized — same discipline as `commandStore.ts`).

---

## 6. Tests

**Unit — `commandRegistry.test.ts`:**

1. **New section baseline test:** `buildCommands` with `orchestrationEnabled: false, hasExecutingTasks: false` must include `'open-command-board'`, `'view-audit-log'`, `'enable-orchestration'` and must NOT include `'disable-orchestration'`, `'sync-agent-clis'`, `'go-to-executing-tasks'`.
2. **Enabled=true predicate:** with `orchestrationEnabled: true, hasExecutingTasks: false`, must include `'disable-orchestration'` and `'sync-agent-clis'`; must NOT include `'enable-orchestration'`; must NOT include `'go-to-executing-tasks'`.
3. **`hasExecutingTasks` predicate:** with `hasExecutingTasks: true`, must include `'go-to-executing-tasks'`.
4. **`SECTION_ORDER` test update:** the existing `'every command sits in a known section'` test passes through because `'Orchestration'` is added to `SECTION_ORDER`.
5. **Drift-guard CLAIMS update:** add the `'toggleAuditLog'` entry as described in §4.
6. **`SHORTCUT_ROWS` — new rows:** assert `SHORTCUT_ROWS.some(r => r.section === 'Orchestration' && r.label === 'View audit log' && r.chips.includes('A'))` is `true`.

**Unit — `useCanvasKeybindings.test.ts`:**

7. **New resolver branch:** `resolveCanvasKeyAction({ key: 'a', ctrlKey: true, shiftKey: true, metaKey: false, altKey: false }, { typing: false, bareKeyAllowed: false, boardNavAllowed: false })` returns `{ kind: 'toggleAuditLog' }`.
8. **Typing guard:** same chord with `typing: true` returns `null`.

**Manual dev-app check (CANVAS_DEV_TITLE stamped):**

Run:
```
$env:CANVAS_DEV_TITLE='PR#NNN W1-A orchestration-discoverability'; pnpm dev
```
Verify (window title must read the stamp before sign-off):
- Ctrl+K opens palette; typing "orch" shows the `Orchestration` section with at least "Open Command board" and "View audit log".
- `?` opens shortcuts sheet; "Orchestration" section appears with "View audit log / Ctrl Shift A".
- Ctrl+Shift+A toggles the audit log panel (works from canvas, from inside a board, and from the command palette open state — same behavior as before).
- Open a Command board with orchestration disabled: the warning banner is visible below the kanban; clicking "Enable orchestration" opens the existing `OrchestrationConsentModal`.
- After enabling orchestration: "Enable orchestration" row is gone from Ctrl+K; "Disable orchestration" and "Sync agent CLIs" rows appear.
- Confirm the "Audit" corner button still works (click, hover tooltip reflects `Ctrl+Shift+A`).

---

## 7. Acceptance criteria

Definition-of-Done checklist:

- [ ] `SECTION_ORDER` in `commandRegistry.ts` contains `'Orchestration'` between `'Groups'` and `'Canvas'`.
- [ ] `PaletteSnapshot` has `orchestrationEnabled: boolean` and `hasExecutingTasks: boolean`.
- [ ] `PaletteVerbs` has `openCommandBoard`, `viewAuditLog`, `enableOrchestration`, `disableOrchestration`, `syncAgentCLIs`, `goToExecutingTasks`.
- [ ] `buildCommands` emits the six new verbs with correct predicate logic (hidden = absent from output array).
- [ ] `SHORTCUT_ROWS` contains an `'Orchestration'` section entry for `'View audit log'` with chips `['Ctrl', 'Shift', 'A']`.
- [ ] `CanvasKeyAction` has `| { kind: 'toggleAuditLog' }`.
- [ ] `resolveCanvasKeyAction` returns `{ kind: 'toggleAuditLog' }` for Ctrl+Shift+A (not typing).
- [ ] `AuditLogViewer.tsx` no longer registers its own `window.addEventListener` keydown handler.
- [ ] Drift-guard CLAIMS table includes `'view-audit-log'` → `toggleAuditLog`; all drift-guard tests pass.
- [ ] `CommandBoard.tsx` subscribes to `orchestrationStore.enabled` and shows the prerequisite banner + Enable button when `false`.
- [ ] `pnpm typecheck` clean (no new `any`, no unused params).
- [ ] `pnpm lint` + `pnpm format:check` clean.
- [ ] All existing unit tests in `commandRegistry.test.ts` and `useCanvasKeybindings.test.ts` remain green.
- [ ] New unit tests for the six predicate rows, the new SHORTCUT_ROWS entry, the resolver branch, and the typing guard are green.
- [ ] Manual dev-app check completed with CANVAS_DEV_TITLE stamp; all manual bullets in §6 confirmed.

---

## 8. Risks & invariants to preserve

**Security invariants (never weaken):**
- The new palette verbs open **modals or navigate to existing surfaces only**. None write to MAIN, spawn PTY processes, or cross the `contextBridge`. `enableOrchestration` / `disableOrchestration` call `setModal(...)` which is a pure Zustand state write; the actual IPC is fired by the existing `OrchestrationModals` host on user-confirmation inside the modal (same path as the Settings toggle — do not bypass it).
- `viewAuditLog` calls the toggle on the audit store — read-only renderer action.
- No new IPC channels, no `nodeIntegration` relaxation, no `sandbox` weakening.

**Predicate correctness:**
- The Raycast/Linear convention is that rows are **absent** (not disabled) when their predicate fails. The `buildCommands` output array must not contain a row whose predicate is false — never push then hide with CSS.
- The `hasExecutingTasks` predicate must read the commandStore at build-time via the snapshot (caller responsibility in `usePaletteController`), not subscribe inside `buildCommands`. `buildCommands` must remain a pure function.

**Drift-guard contract:**
- Every palette row with `chips` that claims a live canvas chord MUST appear in `CLAIMS`. If the new `'view-audit-log'` chip (`['Ctrl','Shift','A']`) is added without updating CLAIMS, the test will pass trivially (it only checks rows in the CLAIMS list) — the implementer must actively add the CLAIMS entry as part of Step 3.

**AuditLogViewer removal safety:**
- After removing the self-registered handler from `AuditLogViewer.tsx`, the `openViewer` / `closeViewer` callbacks must remain reachable via the new `auditLogStore` so the corner "Audit" button still works. Do not remove the corner button.

**No palette section order collisions:**
- The existing test `'every command sits in a known section'` uses `SECTION_ORDER` as the allowlist. Adding `'Orchestration'` to `SECTION_ORDER` automatically passes any new rows through that test — no further test modification needed for the section guard.

---

## 9. Handoff / sequencing notes

**No dependencies on other Wave 1 items.** This is pure renderer — no MAIN changes, no package bump, no shared-type extraction (F9), no new IPC. It can be built and merged in a standalone PR ahead of or in parallel with F5/C2, F6/F7, and the S1 prompts scaffold.

**Ships first in Wave 1.** The audit (§7 of REPORT.md) lists H1+H6 as the first Wave 1 item precisely because they have zero blockers and close the two highest-UX findings (F3, F4) immediately.

**Suggested PR name:** `feat(palette): orchestration section + canonical Ctrl+Shift+A + command-board empty-state guard (#W1-A)`

**Suggested e2e tag:** `@chrome` (palette + keyboard) — the pre-push scope map will route to the Windows-leg-only fast path, keeping the gate time under budget.

**Post-merge:** update `docs/reviews/2026-06-23-mcp-audit/README.md` (once created) to mark F3, F4, H1, H6 as resolved. The `REPORT.md` itself is not edited (findings are the audit record).
