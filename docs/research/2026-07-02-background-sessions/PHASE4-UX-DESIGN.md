# Background Project Sessions — Phase 4 UX design artifact (2026-07-02)

> **Sign-off gate.** Repo rule: UI work produces a *visible* design artifact BEFORE any component
> code. This is that artifact for Phase 4 (ask-on-switch dialog · switcher live rows · per-project
> Close). Nothing below is built until the user nods. Deleted in the PR that merges the epic
> (doc-lifecycle rule), like the rest of this folder.

Design language: the locked calm/dense Linear-Raycast contract (`design-reference/project/DESIGN.md`)
— one accent `#4f8cff`, functional color only, no glow/gradients. Tokens referenced below are real
(`src/renderer/src/styles/tokens.css`): `--accent`, `--ok #3ecf8e`, `--err`, `--text-2/3`, `--mono`.

Phase 4 also REMOVES the `EXPANSE_BG_SESSIONS` flag — keep-running becomes the shipped behavior,
mediated by the dialog below.

---

## 1 · Ask-on-switch dialog

Shown ONLY when the outgoing project actually has live resources (≥1 running terminal or open
preview — `countProjectSessions` + `countProjectOsr`); a dead project switches silently exactly as
today. Pipeline order is locked by the handoff: **lock → dialog → save → background/dispose → load**
(lock BEFORE the dialog so a second switch can't race it; Cancel releases the lock and stays).

Reuses the shared `Modal` + the ConfirmModal **chooser-tile** grammar (radio tiles + ghost/primary
buttons) — same 420px card, same `--accent-wash` selected tile.

```
        ┌────────────────────────────────────────────────┐
        │  Switch to "other-project"?                    │
        │                                                │
        │  canvas-ade has 2 terminals running and        │
        │  1 live preview.                               │
        │                                                │
        │  WHAT HAPPENS TO THEM                          │
        │  ┌────────────────────┐ ┌────────────────────┐ │
        │  │ ▣ Keep running     │ │ ▢ Stop everything  │ │
        │  │   in background    │ │   and close        │ │
        │  └────────────────────┘ └────────────────────┘ │
        │    processes keep going;    kills the agent      │
        │    switch back anytime      processes + previews  │
        │                                                │
        │                      [ Cancel ]  [ Switch ]    │
        └────────────────────────────────────────────────┘
```

- Default pick = **Keep running** (the feature's raison d'être; Enter = Switch with the default).
- Esc / backdrop = **Cancel** (fail-safe direction, same as ConfirmModal).
- Body line is assembled from live counts ("2 terminals running", "1 live preview" — singular/plural,
  omit a zero part).
- The tile sub-captions are the one place we explain consequence — body stays one sentence.
- **Remembered per project (user request 2026-07-02):** picking **Keep** sets a session-scoped
  `switchPolicy: 'keep'` on that project's `projectSessions` registry entry (dir-keyed; default
  `'ask'`). Every later switch away from that project skips the dialog and silently backgrounds —
  constant A⇄B switching never holds on a modal. **Stop everything is one-shot and never
  remembered** (destructive; asks each time it's chosen as the outgoing behavior). Policy resets
  when the user CLOSES the project (§3 ✕ → `project:closeBackground`, or the active-close path);
  quit clears everything (in-app-run lifetime, never persisted to disk). A micro caption in the
  dialog footer states it: "Keep is remembered until you close this project".

## 2 · ProjectSwitcher — live rows

Backgrounded projects (from `project:listBackground`) surface IN the existing recents menu — no new
menu. A recents row whose dir is backgrounded gains a live dot + a right-aligned mono badge; plain
recents rows are unchanged. Menu width grows ~40px; row height unchanged (dense).

```
   ┌ Switch project ────────────────────────────┐
   │ ● my-app                    2 term · 1 prev ✕ │   ← backgrounded, running (dot --ok)
   │   other-project                             │   ← plain recent (unchanged)
   │ ● api-server                1 term        ✕ │
   │ ───────────────────────────────────────────│
   │ Open folder…                                │
   │ Create project…                             │
   └─────────────────────────────────────────────┘
```

- **Dot** = 6px round, `var(--ok)`, static (no pulse — calm). It means "this project has sessions
  alive right now". `--ok` (not accent) because it is a STATUS, and the running-state green is
  already the app's semantic for alive (matches the terminal dock's usage of ok/err).
- **Badge** = `--mono` 10px `--text-3`, e.g. `2 term · 1 prev`; only the non-zero parts render.
  Counts come from `listBackgroundProjects()` (already returns `terminalsRunning` + `previews`).
- **✕** = per-row Close (hover-revealed, `--text-3` → `--err` on hover), backgrounded rows only.
  Click routes to §3 — it never switches.
- Rows stay clickable everywhere else = switch (as today).

## 3 · Per-project Close (confirm when running)

Clicking a row's ✕ when that project has running resources opens a plain two-button confirm
(no chooser — there is only one meaning):

```
        ┌────────────────────────────────────────────┐
        │  Close "my-app"?                           │
        │                                            │
        │  This stops 2 running terminals (their     │
        │  processes are killed) and closes 1        │
        │  preview. The project stays on disk and    │
        │  in recents.                               │
        │                                            │
        │              [ Cancel ]  [ Stop & close ]  │
        └────────────────────────────────────────────┘
```

- Primary button is the destructive action, labeled with the consequence ("Stop & close"), still
  the accent-filled primary (the app has no red-button grammar; the body carries the weight).
- Confirm → `project:closeBackground(dir)` (owner-checked in MAIN; only a REGISTERED backgrounded
  dir can be disposed). Row disappears from the live section; project remains a plain recent.
- Zero-resource backgrounded rows (everything exited on its own): ✕ closes silently, no modal.
- The ACTIVE project's close path (`closeActiveLiveResources`) is NOT a switcher row — it rides the
  existing window-close/quit flow and is out of scope for this menu.

## 4 · Bottom project dock (edge-hover, Task-View style) — user request 2026-07-02, refined same day

Windows-Task-View-like overview: hover the **bottom edge** → a floating, centered **project
dock** slides up (same grammar as the board dock) with one card per **SESSION project** — the
active project plus every project opened/created THIS app run (the backgrounded residents). Each
card shows a **partial view of its canvas** (thumbnail) plus the §2 live-dot/badge grammar. A
final **+** tile opens/creates another project.

```
   ┌──────────────────────────── app window ────────────────────────────┐
   │                          (canvas as usual)                         │
   │                                                                    │
   │          ┌──────────────────────────────────────────────┐          │
   │          │ ┌──────────────┐ ┌──────────────┐  ┌────┐    │          │
   │          │ │● my-app 2t·1p│ │● api-server 1t✕│  │    │   │          │
   │          │ │  ACTIVE      │ │              │  │  + │    │          │
   │          │ │ ┌─┐┌─┐  ┌──┐ │ │ ┌──┐ ┌─┐     │  │    │    │          │
   │          │ │ └─┘└─┘  └──┘ │ │ └──┘ └─┘     │  └────┘    │          │
   │          │ └──────────────┘ └──────────────┘            │          │
   │          └──────────────────────────────────────────────┘          │
   └═══════════════════ bottom-edge hover hot zone ═══════════════════════┘
```

- **Membership: session projects only** (registry `projectSessions` + the active dir). Cold
  recents NEVER appear here — they stay in the §2 switcher menu. So every card is real: it has
  live counts and a real snapshot.
- **Trigger**: pointer parked on the bottom edge (~2px hot zone, ~150ms intent delay — a drive-by
  never opens it). Leave / Esc / card-click closes. Coexists with the board dock: the project
  dock reveals ABOVE it (board dock stays put; hot zone is the window edge itself, below the
  dock's hover area).
- **Card** = header (live dot `--ok` when sessions alive · name · `2 term · 1 prev` badge ·
  hover-✕ on backgrounded cards → §3 confirm) + canvas thumbnail. Active card wears the 1.5px
  accent ring + `ACTIVE` micro tag; clicking it just closes the dock.
- **+ tile** (dashed border, trailing): small menu with the switcher's `Open folder…` /
  `Create project…` actions — the dock can grow the session set without a trip to the top-left.
- **Click** = switch, through the exact §1 pipeline (ask-on-switch dialog when the outgoing
  project has live resources). The dock is a second *presentation* of the same actions — zero new
  switch semantics.
- **Thumbnail = static snapshot, never a live render.** Captured MAIN-side via
  `webContents.capturePage(canvasRect)` (downscaled ~2×) at two moments: the outgoing project at
  **switch-away** (inside `performProjectSwitch`, before unmount) and the active project on
  **dock-open**. Cached under `userData/project-thumbs/<dirHash>.png` (app cache, NOT the project
  folder — ADR 0009 stays clean), served to the renderer as a data URL over IPC. Capture-failure
  fallback: dot-grid placeholder. Rendering N background canvases live is explicitly out of scope
  (one React Flow instance per app, by design).
- Solid surfaces only (`--surface` panel, `--surface-raised` cards) — no blur/glassmorphism
  (locked contract).
- Suggested build order: Phase 4a = §1–3 (dialog · menu rows · close), Phase 4b = the dock
  (needs the snapshot capture plumbing).

## Out of scope (locked)

- No "remember my choice" on the dialog (revisit only if the dialog proves naggy — it shows only
  when something is actually running).
- No background-resource cap UI (GLOBAL_OSR_MAX handles previews silently; Phase 5 ADR documents it).
- No badge/dot in the title-bar pill for the ACTIVE project — the pill stays as-is.
