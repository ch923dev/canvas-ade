# Desktop Notifications — Agent Lifecycle · SPEC

Raise agent-lifecycle events (task **done**, **needs input**, **error/focus**) from any agentic CLI in
a Terminal board to three surfaces: a native OS notification, an in-app toast, and — the key move —
the board **self-indicates on-canvas** so the user can find *which* agent wants them among many.

Design artifact (signed off 2026-07-07): `./DESIGN.md` + published mock. Plan board: canvas id
`aec9e194-62f3-4631-a607-9f0f9008129d`.

## Confirmed scope

- **Agent-agnostic.** Claude Code via real hooks (reliable); other CLIs (Codex/Gemini/opencode) via
  best-effort PTY heuristics. The two detection paths converge on one MAIN entrypoint.
- **All three events** notify: done · needs-input · error/focus.
- **OS notification fires always** (window focused, blurred, or minimized) — with an opt-in
  "only when unfocused" setting (default **off**). The board on-canvas indicator is what disambiguates
  *which* board when the window is focused and you're looking at the canvas.
- **Per-board opt-out** reuses the existing `TerminalBoard.monitorActivity` flag.

## Event model

Both detection paths normalize to one enum:

```
type LifecycleEvent = 'done' | 'needs-input' | 'error'
```

| Source | done | needs-input | error |
|---|---|---|---|
| **Claude hooks** | `Stop` (main-agent turn end) | `Notification` (permission / idle-waiting) | — (none)¹ |
| **Generic PTY** | process `exited` (code 0) | idle-at-prompt heuristic → reserved `awaiting-input` state | `exited` (code ≠ 0) / `spawn-failed` |

¹ Claude has no dedicated failure hook, so a failed Claude run reads as `done` — **accepted** (best-effort;
the generic-PTY exit code is the only reliable Claude-agnostic error signal). `SubagentStop` is
deliberately NOT mapped: it fires per Task-tool subagent mid-run (main agent still working), so treating
it as `done` would raise a premature "Task done". Only the main-agent `Stop` counts.

## Architecture

```
Claude hook (Stop/Notification) ─┐
  recordSession.js → map file    │
                                 ├─► MAIN notifyLifecycle(boardId, event, detail)
Generic PTY (exit / idle) ───────┘        │  gate: setting + monitorActivity + dedupe
  pty.ts lifecycle                         ├─► Electron new Notification (OS) ── click → focus + pan
                                           ├─► IPC → renderer: toastStore.showToast
                                           └─► IPC → renderer: attentionStore → board ring/pulse/pill
```

Detection is split (hooks vs PTY) but delivery is unified in one MAIN function so gating, dedupe, and
copy live in exactly one place.

## Phase 1 — Detect

**Real entrypoint = `src/main/agentRecapMap.ts` (NOT `claude.ts`).** `claude.ts` only writes
`.mcp.json` + `enabledMcpjsonServers`; the recap hook is installed by `agentRecapMap.ts`, which owns:
- `RECAP_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'SessionEnd']` (line ~90) — the array to
  extend.
- `installRecapHook` / `isRecapHookInstalled` — both **iterate `RECAP_HOOK_EVENTS`**, so new events are
  auto-covered by the installer + the health check with no other change there.

Changes:
- **`agentRecapMap.ts`** — extend `RECAP_HOOK_EVENTS` with `'Stop'`, `'Notification'` (NOT
  `'SubagentStop'` — see the event-model footnote). That is the whole Claude registration change.
- **`src/main/hooks/recordSession.js`** — **no change**: it already records `hookEvent:
  d.hook_event_name` and tolerates the Notification hook's leaner stdin (missing fields default to '').
- **`src/main/pty.ts`** — generic path. On process exit, classify done/error by exit code. Add an
  idle-at-prompt heuristic that emits the **reserved** `awaiting-input` state (the `{ t: 'state' }`
  port channel + `terminalState.ts` already support it — no renderer change to carry it).
- Normalize both to `LifecycleEvent` at the MAIN boundary.

> **Shared-file note:** the Claude events append to the SAME recap map file the resume feature reads.
> That is additive — `readRecapMap` keys on `transcriptExists`/`sessionId`, not event type — but the
> notification watcher must read the RAW appended lines (filter `hookEvent ∈ {Stop, Notification}`),
> not the collapsed last-write-wins map. Confirm resume semantics stay intact.

## Phase 2 — Route (MAIN)

- **`src/main/agentLifecycle.ts`** (new) — the single `notifyLifecycle(boardId, event, detail)` entry.
  - **Claude path:** watch the recap map file (`fs.watch`, reusing `agentRecapMap.ts` read) for newly
    appended lines whose `hookEvent ∈ {Stop, Notification}`; map to a `LifecycleEvent`.
  - **Generic path:** `pty.ts` calls in directly on exit / idle.
  - **Dedupe** by `(boardId, event)` within a short window (e.g. 2s) so a rapid double-Stop burst or a
    repeated idle heuristic fires once.
  - **Gate:** master setting → per-event setting → `onlyWhenUnfocused` (skip OS layer if the window is
    focused and the flag is on) → the board's `monitorActivity` (false ⇒ silent).
- **`src/preload` + IPC** — a `notify:*` channel to push `{boardId, event, detail}` to the renderer for
  the toast + attention surfaces.

## Phase 3 — Notify (deliver)

- **OS (MAIN):** `new Notification({ title, body })` (Electron). `notification.on('click')` →
  `win.show()` + `win.focus()` + IPC renderer to select/pan to the board. Fires regardless of window
  focus unless `onlyWhenUnfocused` + focused.
- **In-app toast (renderer):** existing `toastStore.showToast` — kind mapped `done→ok`,
  `needs-input→info`/warn, `error→error`; input/error carry a **Focus** action that pans to the board.
- **On-canvas (renderer):**
  - New **`attentionStore`** (zustand) keyed by boardId → `{ kind: LifecycleEvent, ts }`. Set on event,
    **cleared** when the user selects/opens/focuses that board (attention is "unseen" state).
  - **`boardStatus.ts`** — extend `BoardStatusSignals` with `attention?: LifecycleEvent`; map in
    `boardStatusBucket`: `needs-input → awaiting-review`, `error → failed` (both already have
    `--warn`/`--err` pills in `BUCKET_PILL`). A `done`-unseen pill uses `--ok`.
  - **BoardFrame** — the ring + pulse for the attention buckets (distinct from the calm `running`
    pulse). Feeds the existing MCP `canvas://attention` queue so an orchestrator sees it too.

## Phase 4 — UX / Settings

- **App config** (userData, not the project) — `notifications: { enabled, onDone, onInput, onError,
  onlyWhenUnfocused }`. Defaults: `enabled:true, onDone:true, onInput:true, onError:true,
  onlyWhenUnfocused:false`.
- **Settings modal** — a "Notifications" section: master toggle + three per-event toggles + the
  "only when unfocused" toggle. Mirrors the existing section grammar (see `accounts-phase1/DESIGN.md`).
- **Copy:** title = `<phrase> — <agent>` ("Task done — claude", "claude needs your input"); body =
  `<board title> · <detail>`.

## Phase 5 — Test / ship

- **Unit:** `recordSession.js` event parse (extend existing test); gating (pure fn — matrix of
  setting × monitorActivity × focus); dedupe window; `attentionStore` set/clear.
- **e2e** (`@terminal`/`@core`): drive a lifecycle event → assert toast appears + the board shows the
  attention pill; assert `monitorActivity:false` stays silent.
- **Manual dev check** in the running app (`CANVAS_DEV_TITLE='PR#NNN desktop-notifications' pnpm dev`).
- **Version bump** `package.json` — **minor** (new subsystem).

## Build order (thin vertical slice first)

1. Claude `Stop` → MAIN → OS Notification + toast (skip generic + attention). Prove end-to-end.
2. Add the on-canvas attention store + ring/pill.
3. Add generic-PTY detection.
4. Settings pane + gating.
5. Tests + version bump.

## Risks / open

- **Generic idle-at-prompt heuristic is inherently flaky** — no hook, only PTY bytes. Ship it as
  best-effort; never let a false positive become noisy (dedupe + the `monitorActivity` opt-out).
- **`Notification` hook semantics** — fires for permission prompts *and* 60s-idle; both are legitimately
  "needs you", so no filtering needed, but confirm it isn't chatty in practice during the dev check.
- **Base is `27966d91`** (pre the red MCP-repin on main); rebase onto green main before the pre-push gate.
