# Phase 5 — Terminal serialize/restore + save-to-file (umbrella)

> Final slice of the terminal-capabilities sequence (`docs/research/2026-06-23-terminal-scrollback-reflow/REPORT.md` §7).
> Shipped already: Phase 1 full-view freeze + Phase 2 find (#235), Phase 3 configurable scrollback
> (#237), Phase 4 web-links + unicode11 (#254). This phase is an **umbrella** (4 capabilities, all
> picked by the user) — sub-PRs land **into** `feat/terminal-serialize-umbrella`; the umbrella merges
> to `main` **once**, with the full e2e matrix both legs at that single pre-merge gate.

## ⚠️ Coordination & sequencing — read first

Phase 5 touches `useTerminalSpawn.ts`, `useTerminalReraster.ts`, and `TerminalBoard.tsx`. **Those exact
files are owned and actively rewritten by the in-flight `terminal-crisp-umbrella` session** (DOM-renderer
default; its P1 already landed *in that umbrella* at `b67ca826`, net −211 LOC — it **deletes the FREEZE
counter-scale / reraster machinery**). That umbrella is not yet on `main` but will land as one merge.

Two consequences bake into this spec:

1. **Phase 5 implementation is BLOCKED until the terminal-crisp umbrella lands on `main`.** This document
   is design-only until then. When it lands, branch the Phase 5 umbrella off the *post-terminal-crisp*
   `main` (or off the terminal-crisp umbrella tip if we choose to run concurrently — but a clean
   dependency is cheaper than a live rebase race on `useTerminalSpawn`).
2. **The resize backstop (Slice 2) is designed against the DOM renderer, not FREEZE.** Phase 1's fix made
   the *full-view toggle* reflow-safe by freezing cols. With the DOM renderer, zoom no longer re-fits cols
   at all (it is crisp at any CSS scale), so the **only** remaining cols-changing path is a genuine
   board-size **drag-resize** — exactly the residual REPORT §7 flagged as "the all-resize backstop."
   Slice 2 wraps that one path; it does **not** depend on the about-to-be-deleted reraster loop.

> Note: the terminal-crisp umbrella's planned "Lane C (web-links + unicode11)" duplicates Phase 4, which
> is already on `main` (#254). That lane collapses to a conflict-resolution when the umbrella rebases on
> main; it is not Phase 5's concern, but it means `@xterm/addon-web-links`/`-unicode11` are already
> present — Phase 5 adds only `@xterm/addon-serialize`.

## Problem

Four gaps remain after Phases 1–4, all enabled (or made cheap) by one capability — a faithful snapshot of
the live xterm buffer:

1. **No way to save a terminal's output.** Reading/debugging agent logs is the stated goal of the whole
   sequence, yet there is no "export this session." The user can select-copy a viewport but not capture
   the full scrollback to a shareable file.
2. **Drag-resize still corrupts scrollback.** Phase 1 fixed the full-view toggle; dragging a board wider/
   narrower still changes `cols` → xterm's known-unfixed buffer **reflow** (#5319/#3513) trims and
   duplicates lines. This is the last live instance of the corruption class.
3. **Scrollback is lost on app restart.** A terminal board reopens empty — the prior session's output is
   gone even though the user may only want to *read* it, not resume it. (Recap reconstructs an *agent
   transcript*; it does not restore the literal screen, and only works for agents that write a JSONL.)
4. **No jump-to-bottom affordance.** While scrolled up reading during streaming output, returning to the
   live tail means dragging the scrollbar all the way down.

The shared primitive is `@xterm/addon-serialize`: `serialize()` returns an ANSI string that reconstructs
the buffer (incl. scrollback) when written back into a fresh terminal; `serializeAsHTML()` returns colored
HTML. (1) and (4) don't strictly need it — (1) plain-text can walk the buffer, (4) is pure scroll UX — so
they ship first, independent; (2) and (3) are the addon's core use.

## Slices

Four sub-PRs. **Build order** groups the cheap, renderer-agnostic, zero-new-dep work first:

| # | Slice | New dep | UI | Risk | Depends on |
|---|-------|---------|----|----|-----------|
| **S4** | Jump-to-bottom badge | — | Yes (badge) | Trivial | terminal-crisp on main |
| **S1** | Save output to file (plain text) | — | Yes (menu) | Low | terminal-crisp on main |
| **S2** | Resize backstop (lossless drag-resize) | `addon-serialize` | No | **Med** | S-addon; DOM renderer |
| **S3** | Persist scrollback across restart | (addon, shared) | No | Med–High | S2 lands the addon |

> S4 + S1 are independent of the addon and of each other — they can be **one PR** ("terminal output:
> save + jump-to-bottom") or two. S2 introduces the addon; S3 reuses it. The optional **colored
> (`.html`) export** for S1 folds into S2 (once the addon is in), not S1.

---

### S4 — Jump-to-bottom badge  *(design artifact: badge wireframe below)*

**What.** A small affordance, bottom-right of the terminal well, shown only when the buffer is scrolled
above the live tail. Click → `term.scrollToBottom()`. Optionally an unread-output dot when new lines
arrive while scrolled up.

**Design (ASCII wireframe — token-matched; needs sign-off before code).**

```
 ┌───────────────────────────── terminal well ──────────────────────────────┐
 │ $ pnpm dev                                                                 │
 │ ▸ build  …                                                                 │
 │   … (scrolled up — viewportY < baseY) …                                    │
 │                                                                            │
 │                                                              ╭──────────╮  │  ← badge
 │                                                              │  ↓  3 new │  │     (only when
 │                                                              ╰──────────╯  │      scrolled up)
 └────────────────────────────────────────────────────────────────────────────┘
```

- Hidden when at the tail (`viewportY === baseY`). Appears on scroll-up.
- Tokens: `--surface-2` bg, `--border` hairline, `--accent` (`#4f8cff`) only for the unread count chip,
  `--radius-sm`, the existing icon-button hover. One accent, functional only (per DESIGN.md).
- "N new" counter optional (S4-stretch): increment on `onLineFeed` while scrolled up, reset on
  scrollToBottom. If we cut it, the badge is a plain "↓".

**Implementation.** `term.onScroll` (or `onWriteParsed`) drives a `scrolledUp` boolean in `TerminalBoard`;
render a `<button class="tb-jump-bottom">` in the well overlay (sibling to the find bar). Pure renderer;
no IPC, no schema, no addon. Touches `TerminalBoard.tsx` + a `terminal-jump.css` block.

**Tests.** `e2e/terminalJumpBottom.e2e.ts` (`@terminal`): write > viewport rows into a dead (`exit`) PTY,
scroll up via `term.scrollLines(-n)`, assert the badge is visible; click → `viewportY === baseY` and the
badge hides. Unit: a `shouldShowJumpBadge(viewportY, baseY)` pure helper if the logic grows.

---

### S1 — Save output to file  *(design artifact: menu wireframe below)*

**What.** Terminal ⋯ menu → **"Save output…"** → native save dialog → writes the full scrollback as a
`.txt` via MAIN `write-file-atomic`. Plain text only in S1 (zero new dep, ships first); the colored
`.html` option is added with the addon in S2.

**Design (ASCII wireframe — token-matched; needs sign-off before code).**

```
   terminal ⋯ menu                     native save dialog
   ┌────────────────────────┐          ┌───────────────────────────────────────┐
   │  Restart            ⟲   │          │  Save terminal output                 │
   │  Find…          Ctrl+F  │          │  ───────────────────────────────────  │
   │  ─────────────────────  │   →      │  Name:  terminal-20260625-142233.txt  │
   │  Save output…           │ ◀ NEW    │  Where: <project root>                │
   │  Copy all               │          │                       [ Cancel ][Save]│
   └────────────────────────┘          └───────────────────────────────────────┘
```

- Entry sits in the existing ⋯ menu (`buildTerminalMenu` / the TERM-07 context-menu builder), grouped
  with Find/Copy. Label "Save output…" (ellipsis = opens a dialog).
- Default filename `terminal-<YYYYMMDD-HHmmss>.txt` (board title slug if set: `<slug>-<stamp>.txt`).
- Default directory = project root; remembers last-used dir (app config, not the project).
- No format chooser in S1 — plain text. (S2 adds a "Save output ▸ Plain text (.txt) / With colors
  (.html)" submenu once `serializeAsHTML` is available.)

**Implementation.** Mirrors the whiteboard **`export:save`** IPC (W5):
1. Renderer collects the buffer as plain text by walking `term.buffer.active` (the
   `translateToString(true)` per-line approach already in `e2eHooks.readTerminal`) — **no addon needed**.
2. New frame-guarded IPC `terminal:saveOutput` (`main/shellIpc.ts` is the wrong home — add
   `main/terminalIpc.ts` or extend the export IPC module): renderer sends `{ text, suggestedName }`;
   MAIN shows `dialog.showSaveDialog` (default dir + name), and on confirm writes via `write-file-atomic`,
   returning the saved path (or `null` on cancel). Preload exposes `saveTerminalOutput`.
3. The write target is **user-chosen** (anywhere) — an export, not project data; so a save dialog, not a
   silent `.canvas/` drop (that pattern is for screenshots/assets).

**Security.** Reuses the existing export-write model (whiteboard already writes user-chosen files via
MAIN). The dialog is MAIN-driven (renderer can't pick an arbitrary path silently). No PTY involvement; no
sandbox/isolation change. Frame-guard the IPC like `clipboardIpc`/`shellIpc`.

**Tests.** `terminalSaveOutput.test.ts` (unit) — the filename/slug/stamp builder + the buffer→text
serializer (pure). `e2e/terminalSave.e2e.ts` (`@terminal`) — seed a dead PTY with known lines, invoke the
save path through a seam that **stubs the dialog** (return a temp path via `electronApp.evaluate`), assert
the written file contains every line (mirrors the Phase-4 `shell.openExternal` recorder pattern; the
literal dialog gesture is confirmed in the manual dev check).

---

### S2 — Resize backstop (lossless drag-resize)  *(no UI — flow only)*

**What.** On a `cols`-changing **drag-resize**, snapshot the buffer, resize, and write the snapshot back
so scrollback survives instead of hitting xterm's reflow trim/dup (#5319). This closes the last live
corruption path (Phase 1 closed the full-view toggle; the DOM renderer removes zoom-driven cols changes;
drag-resize is what's left).

**Flow.**

```
 ResizeObserver settle (cols delta detected, established grid)
   │
   ├─ pause PTY→term pump          (queue incoming bytes; do NOT drop)
   ├─ snapshot = serialize()       (addon-serialize; full scrollback, cursor opt)
   ├─ term.resize(newCols,newRows) (PTY resize → SIGWINCH as today)
   ├─ term.reset()                 (clear the reflow-mangled buffer)
   ├─ term.write(snapshot)         (re-parsed at the NEW width → clean wrap, no reflow trim)
   ├─ restore scroll (ydisp)       (keep scrolled-up position if user was reading; else tail)
   └─ resume PTY pump              (flush queued bytes)
```

**Edge cases (the risk lives here).**
- **In-flight PTY output.** Bytes arriving during the snapshot→write window must be **queued, not
  dropped** (briefly gate the `onData`→`term.write` pump and flush after restore). The pause is ~one
  frame; the resize is already debounced to the RO settle, not per-pixel.
- **Cursor.** `serialize({ scrollback })` with cursor handling — restore the cursor row/col so the live
  prompt isn't orphaned. If full fidelity is fragile, accept cursor-at-tail (the shell repaints its prompt
  on SIGWINCH anyway) — decide during impl with a real shell.
- **Scroll position.** Preserve `ydisp` when scrolled up (the user is reading); otherwise scroll to tail.
- **Cost.** `serialize()` of 50k lines is O(n) but runs only on a resize *settle*, not continuously. Cap
  the snapshot at the board's `scrollback` (Phase 3, ≤50k) — already bounded.
- **DOM renderer.** No reraster/atlas interaction (FREEZE is gone); a `term.refresh` after write is the
  only repaint nicety. Validate the DOM renderer reflows identically (it shares xterm core's Buffer).

**Implementation.** A `useTerminalResizeBackstop` hook (new) wired where the post-terminal-crisp fit logic
lives in `useTerminalSpawn.ts`. Adds `@xterm/addon-serialize` (loaded at construction; addon is passive
until `serialize()` is called). No PTY respawn. No schema. Detect a *real* cols delta only (skip
no-delta settles, exactly like Phase 1's established-grid guard) so an idle board never pays the cost.

**Tests.** `e2e/terminalResizeBackstop.e2e.ts` (`@terminal`) — the corruption repro: write `L000..L119`
into a dead PTY, **programmatically drag-resize** the board node much wider then much narrower (drive the
RF node width via the resize handle / a `setBoardSize` seam), assert **every** marker survives and no line
is duplicated, at zoom 1 and a non-1 zoom (extends the Phase-1 `terminalScrollback.e2e.ts` harness via the
`resetTerminalWrite`/`terminalCellPoint` seams). Unit: the snapshot/restore orchestration is mostly
addon-driven; cover the cols-delta guard + the pump-pause/flush queue as a pure state machine.

---

### S3 — Persist scrollback across restart  *(no UI — storage + restore)*

**What.** Persist the live buffer to a sidecar on save/park; restore it into an **idle/frozen** terminal
on reopen (no live PTY until the user hits Start). The user reopens a project and *sees their last
terminal output* — read-only until they choose to resume.

**Storage (ADR 0009 — fits the existing `.canvas/` data isolation).**
- `serialize()` → `<project>/.canvas/terminal/<boardId>.snapshot` (ANSI text). One sidecar per terminal
  board, keyed by board id.
- **No `canvas.json` schema change.** The snapshot is a side-file discovered by board-id convention —
  presence is derivable from the filesystem, so no `TerminalBoard.hasSnapshot?` field is needed (if we
  ever want one, it's an additive ADR 0007 writer-only bump, but recommend deriving from file existence).
- **git-ignored by default**, like `assets/` (it's regenerable session state, can be large). Cleaned on
  board delete; bounded by the board's `scrollback` cap (Phase 3, ≤50k lines).

**Lifecycle.**
- **Write** the snapshot on: debounced autosave / blur / `before-quit` while the terminal has content,
  **and** on park (the LOD/undo eviction path that already tears the term down — `nextStateAfterAdopt`).
- **Read** on board mount: if a sidecar exists and the board is *not* adopting a live MAIN session, write
  the snapshot into the term in a **frozen** state (reuse the recap-flip / idle-on-mount surface — a
  "paused, reconnect to resume" affordance). Start spawns a fresh PTY (or Resume where the agent supports
  it); the frozen buffer is replaced by live output on spawn.
- **Delete** the sidecar when the board is removed (and optionally on a successful live adopt, since the
  live session supersedes the snapshot).

**Relationship to recap (they coexist; different surfaces).**
- **Recap** = parsed *agent transcript* (JSONL) → semantic summary; agent-specific; only for CLIs that
  write a transcript.
- **Persist** = literal *xterm buffer* (raw ANSI) → exact screen; shell-agnostic; works for any session.
- A reopened terminal can show the persisted buffer immediately *and* offer recap if a transcript exists.
  No conflict; persist is the lower-level, always-available restore.

**Implementation.** New `main/terminalSnapshot.ts` (read/write/delete the sidecar via `write-file-atomic`,
under the `.canvas/` resolver) behind frame-guarded IPC; a `useTerminalSnapshot` renderer hook that writes
on the lifecycle events and reads on mount, integrating with the existing idle/adopt fork. Reuses
`addon-serialize` (added in S2). The `.canvas/terminal/` dir joins the File-Tree hide list + the
default-gitignore set alongside `assets/`/`memory/`.

**Tests.** `terminalSnapshot.test.ts` (unit) — path resolution under `.canvas/`, write/read/delete
round-trip, cap enforcement. `e2e/terminalPersist.e2e.ts` (`@terminal`) — seed a terminal, trigger the
snapshot write, **relaunch the `_electron` app** on the same userData/project (the persistent-userData
harness already carries state across specs), assert the reopened board shows the prior lines in a frozen
state and that Start spawns live. Cover the park→snapshot→adopt path.

---

## Cross-cutting

### Dependency
- **`@xterm/addon-serialize`** at the **xterm-5.5-compatible** version (REPORT §3 notes `0.14.0` for the
  5.5 line — **verify the peer range at install**, as in Phase 4). Added in S2; reused by S3 and the S1
  colored-export add-on. `devDependency` (Vite-bundled, like the other addons). `pnpm-lock.yaml` moves →
  **signal-merge with `-Lockfile`**; the Linux Docker leg's frozen install validates it. No heavy dep.

### Schema
- **No `schemaVersion` bump anywhere.** S1/S2/S4 persist nothing to `canvas.json`. S3 uses a sidecar by
  board-id convention (no doc-level key, no new board field). The two-tier floor (ADR 0007) is untouched.

### Security (never weaken)
- `contextIsolation`/`sandbox`/`nodeIntegration:false` unchanged. New IPC (`terminal:saveOutput`, the
  snapshot read/write) is thin, **frame-guarded**, MAIN-side (mirrors `clipboardIpc`/`shellIpc`).
- S1 writes a **user-chosen** path via a MAIN-driven save dialog (renderer never picks a path silently) —
  same model as the whiteboard export. S3 writes only under `<project>/.canvas/` (the sanctioned data dir).
- **Nothing here writes to the PTY channel.** Serialize reads the renderer buffer; save/persist are
  read-only w.r.t. the shell. The "browser content must never reach the PTY" invariant is unaffected, as
  is "terminal input is trusted-user-only."

### Structure & process
- Umbrella `feat/terminal-serialize-umbrella` (this worktree). Sub-PRs target the **umbrella**, not main;
  branch each off the **umbrella tip**. Umbrella → `main` **once**, full e2e matrix **both legs** at that
  single pre-merge gate (Parallel-sessions rule). `gh auth switch --user ch923dev` before any push.
- **Order:** S4 + S1 first (renderer-agnostic, no addon — can even be one PR), then S2 (adds the addon +
  the colored-export add-on for S1), then S3. Each sub-PR: gate (typecheck · lint · format:check · unit) +
  a manual **title-stamped** dev check (`CANVAS_DEV_TITLE='PR#NNN <slice>'`).
- **Design-before-code:** the S4 badge + S1 menu wireframes above need the user's nod before those slices
  are coded. If pixel fidelity is wanted, promote either to a token-matched HTML mock → PNG (the
  `scrollback-mock` precedent) per-slice. S2/S3 are invisible (flow specs only).

### Blocked-until note
Per **Coordination & sequencing** above, **do not start implementation until the terminal-crisp umbrella
is on `main`.** This spec is the design artifact; the umbrella worktree holds it until the dependency
clears, at which point the Phase 5 sub-PRs branch off the post-terminal-crisp `main`.

## Out of scope
- **xterm 6.0 bump** (REPORT B1) — the reflow bug is unfixed in 6.0 too; a bump buys only adjacent
  stale-render fixes at the cost of breaking changes. Independent decision, not Phase 5.
- **Ligatures / split panes / screen-reader mode** (REPORT §7 defer rows).
- **Recap changes** — persist coexists with recap; this phase does not modify the transcript/recap path.
