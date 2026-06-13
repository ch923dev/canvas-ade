# Spec — New Terminal agent-preset dialog (+ MCP agent identity)

- **Status:** DRAFT, awaiting design sign-off on `mock.html` / `mock-rendered.png`.
- **Branch:** `feat/new-terminal-presets` (off `main` @ `d82acc6`).
- **Schema:** claims **v10** (additive; `minReaderVersion` stays 9). Coordinate with in-flight
  `canvas-backdrop` (v9) — see Coordination.
- **Decisions locked (with the user, 2026-06-13):**
  1. **Creation flow = place-first, then dialog.** Drag-to-create (#75) is preserved; the dialog opens
     over the just-dropped board.
  2. **MCP scope = identity + observation (Phase A + B).** Persist `agentKind`, expose it in
     `canvas://boards`/status, and let `monitorActivity` gate attention/swarm participation. Phase C
     (spawn-by-kind, orchestrator role) is **out of scope** → its own future slice with Feature Workspaces.

---

## 1. Why

Today a Terminal board has **no identity** and **no creation flow**:

- The dock *arms* a tool; the user clicks/drags to drop a board (`useBoardPlacement`); config
  (`shell`/`launchCommand`/`cwd`/`fontSize`) happens *after*, in the ⚙ `TerminalConfig` popover. A new
  user must already know to type `claude` into a free-text field.
- A terminal is just a free-text title + command. The canvas can't show "this is a Claude agent," and
  **neither can MCP** — an orchestrator agent reading `canvas://boards` sees `{id, type, title, status}`
  and cannot tell whether a board runs Claude, Codex, or a plain shell. Everything is opaque
  `launchCommand`.

This spec adds a **Quick Start** creation dialog (agent presets) and promotes **agent identity** to a
first-class, MCP-observable property — the connective tissue between the shipped MCP swarm layer and the
deferred Feature Workspaces.

## 2. Design artifact (sign-off gate)

- **`mock-v2.html` / `mock-v2-rendered.png` — CURRENT artifact.** Adds (a) monochrome brand glyphs per
  agent, (b) the structured + searchable command builder. (User feedback 2026-06-13.)
- `mock.html` / `mock-rendered.png` — **superseded** v1 (neutral monograms + free-text command field).
- Served over localhost (`file:` is blocked); tokens copied verbatim from `src/renderer/src/index.css`.

v2 states: **State 1** = Claude selected, full command builder; **State 2** = search "perm" filtering the
option list. Notes baked into the mock footer.

**Design-contract points honored:**
- Built on the shared `Modal.tsx` (scrim + focus-trap + Esc + `prefers-reduced-motion`).
- Single accent (`--accent` #4f8cff); `--surface-raised` card; `--shadow-pop`; `--r-ctl` radius.
- **Brand glyphs are MONOCHROME** (inherit `currentColor` → accent when selected), not full-color logos —
  keeps the calm palette and sidesteps trademark/bundling concerns. This is a deliberate softening of the
  DESIGN.md "functional, non-illustrative" rule (identity marks are functional here); glyph SVG paths are
  added to `Icon.tsx`. Glyphs in the mock are recognizable approximations; the impl uses official-mark
  silhouettes.
- Segmented control reuses the `BrowserBoard` VpToggle pattern; fields reuse `TerminalConfig` styles.

## 3. The flow (place-first)

```
+Terminal armed → user clicks/drags → store.addBoard('terminal', …, { configPending: true })
                                            │
                          board appears IDLE  (auto-spawn suppressed)
                                            │
                          NewTerminalDialog opens, pre-focused
            ┌─────────────────────────────┬──────────────────────────────────┐
            │ Create                       │ Cancel                            │
            │ apply patch (agentKind,      │ clear configPending → spawn a     │
            │ title, launchCommand, cwd,   │ plain shell (no agentKind,        │
            │ monitorActivity) → spawn     │ monitorActivity defaults on)      │
            └─────────────────────────────┴──────────────────────────────────┘
```

**Critical correctness risk (the #1 test target):** a freshly-dropped terminal currently *auto-spawns on
mount* (`useTerminalSpawn.ts`; restored/duplicated boards instead start idle). The dialog flow MUST reuse
that **idle-on-mount** path via a transient `configPending` flag so the PTY does **not** spawn until
Create/Cancel resolves — otherwise we spawn a shell and immediately respawn it. `configPending` is
**ephemeral** (never serialized, never a `PATCHABLE_KEY`) — it lives in the same place as the existing
idle-on-mount tracking, not in the board's durable schema.

## 4. Schema (Phase A) — `lib/boardSchema.ts`

Add to `TerminalBoard`:

```ts
agentKind?: string         // 'claude' | 'codex' | 'gemini' | 'opencode' | 'shell' | <custom>
monitorActivity?: boolean  // absent ⇒ treated as true; false ⇒ out of swarm/attention
```

- **Additive only** → bump `SCHEMA_VERSION` **9 → 10**; `MIN_READER_VERSION` **stays 9** (ADR 0007 —
  older apps still open v10 docs; unknown fields survive round-trip).
- `migrate(9→10)` = identity bump (both fields optional).
- `toObject` / `assertBoard` gain branches for the two fields (string / boolean validation; drop invalid).
- `agentKind` is a free string (not a closed enum) so a custom preset / future agent doesn't require a
  schema bump. The renderer maps unknown kinds to a generic glyph.

## 5. Preset registry + option schema (Phase A) — new pure module(s)

`canvas/boards/terminal/agentPresets.ts`:

```ts
export interface AgentPreset {
  id: string            // stable key, also the persisted agentKind
  label: string         // 'Claude Code'
  bin: string           // base binary: 'claude' | 'codex' | … ('' for shell)
  glyph: IconName       // monochrome brand-glyph icon (added to Icon.tsx)
  options?: AgentOption[]  // the command-builder schema for this agent (absent ⇒ raw-only, e.g. Shell)
  defaultRole?: 'orchestrator' | 'worker'  // reserved for Phase C; unused in A/B
}

// One row in the builder. Renders by kind; composes to a CLI fragment.
export type AgentOption =
  | { id: string; kind: 'select'; label: string; flag: string; choices: { value: string; label: string }[]; default?: string }
  | { id: string; kind: 'toggle'; label: string; flag: string }          // presence-only flag, e.g. -c
  | { id: string; kind: 'text';   label: string; flag: string; placeholder?: string }

export const AGENT_PRESETS: readonly AgentPreset[]   // claude, codex, gemini, opencode, shell
export function presetById(id: string): AgentPreset | undefined
```

`canvas/boards/terminal/composeCommand.ts` (pure, unit-tested):

```ts
// values: { [optionId]: string | boolean }  → "claude --model opus --effort high -c"
export function composeCommand(preset: AgentPreset, values: Record<string, string | boolean>): string
// best-effort reverse so re-opening config re-hydrates the builder; unknown tokens ⇒ raw fallback
export function parseCommand(preset: AgentPreset, raw: string): { values: Record<string, …>; extra: string }
```

**Claude option schema (grounded in real, current `claude` flags — verified via claude-code-guide
2026-06-13; flags drift across CLI versions, so this is curated + maintainable, NOT exhaustive):**

| Option | kind | flag | choices / notes |
|---|---|---|---|
| Model | select | `--model` | `sonnet` · `opus` · `haiku` · `fable` (or full id) |
| **Effort** | select | `--effort` | `low` · `medium` · `high` · `xhigh` · `max` *(the user's "effort mode" — a real flag)* |
| Permission mode | select | `--permission-mode` | `default` · `acceptEdits` · `plan` · `auto` · `dontAsk` · `bypassPermissions` |
| Continue last session | toggle | `-c` | |
| Resume a session | text | `--resume` | session id/name (blank ⇒ interactive picker) |
| Skip permission prompts | toggle | `--dangerously-skip-permissions` | (danger-styled) |
| Background session | toggle | `--bg` | |
| Add directory | text | `--add-dir` | space-separated paths |
| MCP config | text | `--mcp-config` | json path / inline |
| Allowed / Disallowed tools | text | `--allowedTools` / `--disallowedTools` | rule lists |

- Fixed v1 lists for claude/codex/gemini/opencode (codex/gemini/opencode schemas curated from their
  `--help`; **TODO before impl: ground each the same way I grounded claude**). Shell has no `options` →
  builder hidden, optional raw command only.
- Designed for later **user extension via config** (the schema is plain data) — this keeps the locked
  *agent-agnostic* decision: the builder is a convenience over a string, never a hard dependency.
- Pure → unit-tested (compose for each kind; Shell → empty command → plain shell; parse round-trip).

## 6. Dialog component (Phase A) — `canvas/boards/terminal/NewTerminalDialog.tsx`

- Renders inside the shared `Modal.tsx` (centered). Props: `boardId`, `onCreate(patch)`, `onCancel()`.
- Quick Start tile row → **monochrome brand glyph** per preset; selecting one sets `agentKind` and loads
  that preset's option schema into the builder.
- **Command builder** (`canvas/boards/terminal/CommandBuilder.tsx`) — replaces the free-text field for
  agents that have an `options` schema:
  - A **search box** filters the option list by label / flag (the user's "searchable list").
  - Each option renders by `kind`: `select` → a pill dropdown (Model / Effort / Permission mode); `toggle`
    → a checkbox (Continue / Skip-permissions / …); `text` → an inline input (Resume id / add-dir).
  - A live **composed command** (`composeCommand`) shows below and **stays editable** — the raw escape
    hatch. Editing it by hand sets a "raw override" flag so the builder doesn't clobber the user's text
    (best-effort `parseCommand` re-hydrates known flags; unknown tokens stay in the raw tail).
  - Shell (no `options`) → builder hidden; just an optional raw command input.
- Details tab: Name (`title`), the command builder (above), Working dir (`cwd`), Monitor activity
  (`monitorActivity`).
- Appearance tab: Font size stepper (reuses `MIN/MAX_TERMINAL_FONT` from `terminalFont.ts`); optional
  accent tint (canvas-only — **only if we add a board tint field**; otherwise drop for v1).
- Create → `beginChange()` + `updateBoard(boardId, { title, agentKind, launchCommand: <composed>, cwd,
  monitorActivity })` then trigger spawn (clear `configPending`).
- Cancel → clear `configPending` → spawn plain shell. Esc = Cancel (Modal handles it).

**Source-of-truth note:** the persisted value is still the composed **`launchCommand` string** (+
`agentKind`). The structured option *values* are NOT persisted to schema in v1 — on re-open, the builder
re-hydrates via `parseCommand`. (Persisting `agentOptions` for lossless round-trip is an optional
follow-up; keeps schema minimal now.)

## 7. Wiring (Phase A)

| File | Change |
|---|---|
| `store/canvasStore.ts` | `addBoard` accepts transient `configPending`; add `agentKind`, `monitorActivity` to `PATCHABLE_KEYS.terminal`. |
| `canvas/hooks/useBoardPlacement.ts` | on a **terminal** drop, set `configPending` + open the dialog (browser/planning unchanged). |
| `canvas/boards/terminal/useTerminalSpawn.ts` | treat `configPending` as idle-on-mount (suppress auto-spawn until resolved). |
| `canvas/boards/TerminalBoard.tsx` | identity pill reads `agentKind` (generic fallback for unknown/shell); host the dialog when `configPending`. |
| `canvas/Icon.tsx` | **add 5 monochrome brand glyphs** (`claude`/`codex`/`gemini`/`opencode`/`shell`) as `currentColor` single-path/group marks (24-unit viewBox, matches the existing style). |
| `canvas/boards/terminal/CommandBuilder.tsx` | **new** — searchable option list + select/toggle/text controls + composed-command preview. |
| `canvas/boards/terminal/composeCommand.ts` | **new** — pure compose/parse (§5). |

**Phasing within Phase A** (so the skeleton can land before the builder):
- **A1** — schema v10 + preset registry + brand glyphs + dialog shell + place-first wiring + **raw command
  field** (no builder yet). Shippable.
- **A2** — per-agent option schema + `CommandBuilder` + compose/parse search. Layers onto A1.
- Then **Phase B** (MCP observation). The command builder is a meaningful sub-system (option schemas +
  dynamic form + search + compose/parse) — A2 is roughly the weight of A1, plan accordingly.

## 8. MCP integration (Phase B — observation)

| File | Change |
|---|---|
| `src/main/boardRegistry.ts` (app) | publish `agentKind` + `monitorActivity` in the MAIN board mirror; **exclude `monitorActivity:false` boards from the attention buckets** that feed `canvas://attention`. |
| `store/useMcpPublish.ts` (app) | include the two fields in the published board facts (verify the publish shape carries them). |
| `@expanse-ade/mcp` `src/resources/boards.ts` | extend the boards resource item with `agentKind` (optional). |
| `@expanse-ade/mcp` version | **minor bump 0.9.0 → 0.10.0** (additive resource field). |
| app `package.json` | bump pin to `^0.10.0` after publish; `pnpm rebuild` node-pty (spaced-path gotcha). |

Two-layer test rule (package): contract test (mock orchestrator) + live test (real app) for the extended
resource.

**Result:** `canvas://boards` returns `{ id, type, title, status, agentKind }`; an orchestrator can route
by capability. `monitorActivity:false` boards never surface in `canvas://attention`.

**Security:** `agentKind` is metadata, not an exec vector. The exec vector is still `launchCommand`, which
remains (a) trusted-user-only from the UI (static preset strings), and (b) hardened on the MCP path —
`configure_board` already runs sanitize → human-confirm → audit before persisting `launchCommand`
(`mcpOrchestrator.ts:295-384`). Nothing in this spec weakens that.

## 9. Tests

- **e2e:** drag-create terminal → dialog opens → pick **Codex** → Create → board spawns with `codex`, pill
  shows Codex; **Cancel** path → plain shell, no `agentKind`.
- **unit:** preset resolution (Shell → empty cmd); `migrate(9→10)` identity; `PATCHABLE_KEYS.terminal`
  includes both keys; `configPending` suppresses auto-spawn.
- **MCP contract + live:** `canvas://boards` carries `agentKind`; `monitorActivity:false` board absent
  from `canvas://attention`.
- **Manual checks:** append entries to `docs/testing/MANUAL-CHECKS.md` for the new dialog + identity pill.

## 10. Risks

- **Auto-spawn suppression** is the main risk — see §3. Cover with the `configPending` unit + e2e tests.
- **Regression** of drag-to-create (#75) and the first-run `launchCommand` hint (#116) — the dialog
  replaces the need for the hint on the create path; decide whether to keep the hint for the ⚙ popover.
- **Schema v10 collision** with `canvas-backdrop` (v9 in flight) — see Coordination.
- **Modal vs xterm focus** — Modal's focus trap must not fight xterm; the board behind is idle (no live
  xterm) while `configPending`, so this is low risk.

## 11. Coordination

- This branch **claims schema v10.** `canvas-backdrop` holds v9 (merged `cf868d0`/PR #126; PR 2-4 need no
  migration). If a backdrop PR bumps the writer again before this lands, rebase and re-mint v10. Flag on
  `ACTIVE-WORK.md`.
- MCP package change (Phase B) is a **separate repo** (`Z:\canvas-ade-mcp`) — version-bump + publish +
  re-pin is its own step; sequence Phase A (app-only, shippable) first, Phase B after.

## 12. Out of scope (future — Phase C, with Feature Workspaces)

- `spawn_board({ type, agentKind })` — orchestrator spawns "a Claude worker" by name; the host resolves
  the binary (orchestrator stays machine-portable).
- Orchestrator / command-board **role** preset (today the command board is hardwired as `'app'`).
- Preset → MCP **prompt templates** (fills the empty `prompts/index.ts`).
- User-editable preset list in app config.
