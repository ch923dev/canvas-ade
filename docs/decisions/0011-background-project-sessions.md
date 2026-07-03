# ADR 0011 — Background Project Sessions (in-app-run keep-alive on project switch)

- **Status:** Accepted (2026-07-03)
- **Context:** Maestri-style resume — switch project A→B→A within one app run and A's
  terminals are STILL RUNNING (same PTYs, live reattach) and its previews still alive with
  in-page state intact. Built as the bg-sessions epic (Phases 1–5 on `feat/bg-sessions`);
  full per-phase history in `docs/archive/build-history.md`.

## Decision

1. **Lifetime = in-app-run only.** Backgrounded sessions live in MAIN's memory (typed
   `background` parks with NO TTL; frozen offscreen preview windows) and die with the app.
   There is NO survive-quit broker/daemon in v1 — quit (and the crash sinks) drain every
   live + parked tree (`disposeAllPtys`), the darwin last-window close reaps PTYs
   explicitly (window-all-closed is a no-op there — the macOS orphan fix), and what
   persists across runs is the continuity DATA (see 4), never the processes.
2. **Budgets/caps.** Preview keep-alive is bounded by `GLOBAL_OSR_MAX = 8` offscreen
   windows app-wide (backgrounded-only eviction, oldest `backgroundedAt` first — the
   foreground is never starved) on top of the foreground `MAX_LIVE ≈ 4` paint gate. PTY
   parks are unbounded by count but each ring is capped (256KB) and exit residue is
   bounded (32 entries, insertion-order eviction). Snapshot sidecars cap at 64MB
   (skip-not-truncate — slicing ANSI mid-sequence garbles restores).
3. **Dialog policy (ask-on-switch ladder).** Default `'ask'` → dialog when the outgoing
   project has live resources; Keep = session-remembered; the forever checkbox persists to
   `userData/background-keep.json` (app preference, NEVER the project folder); ∞ badge
   forgets policy only; ✕/close resets. Stop is one-shot and never remembered. Stop is the
   SCOPED `closeActiveLiveResources` — never the dispose-all (which would reap other
   residents).
4. **Scrollback continuity = sidecar snapshot + ring-watermark splice.** The switch-away
   flush serializes the full xterm buffer to `.canvas/terminal/<id>.snapshot`; the park
   records `OutputRing.written`. A background switch-back replays sidecar-preface +
   post-watermark tail (`readRingSince`) — full scrollback, no duplication, no 256KB
   ceiling. Missing sidecar degrades to the classic full-ring replay; undo parks keep
   full-ring replay. Bytes emitted between the serialize and the park sit in neither
   (accepted micro-window; watermark-at-park is the approved semantics). A background park
   that EXITS leaves consume-on-read residue (post-park tail + exit code, compound-keyed
   `(owningDir, boardId)`), surfaced by the restored bar as "Exited in background
   (code N)". At quit/darwin-close, every background park's post-watermark tail is
   appended (sync, capped) to its owning project's sidecar before the drain.
5. **No schema bump.** Everything rides existing persistence: sidecars are
   filesystem-derivable (ADR 0009), parks/registry/policy are runtime or userData state,
   and `canvas.json` is untouched (stays v18).
6. **darwin = quit-equivalent for PTYs.** Closing the last macOS window reaps PTY trees
   (after the ring-tail append) even though the app object survives — an orphaned,
   token-burning agent behind no window is strictly worse than losing the keep-alive.
7. **Identity is project-scoped, never bare board id (R1).** Board UUIDs collide across
   git-cloned projects, so parks, adopts, residue, sidecar dir-pins (R2), and counts are
   all `(owningDir, id)`-scoped. Two deliberate id-keyed exceptions, accepted for v1:
   - **Board results** (`boardResults.ts`) are id-keyed; switches prune to the union of
     active live boards + background-parked ids so a resident's verdict survives to its
     switch-back. A clone whose id collides with a resident can therefore be served the
     resident's result until its own boards are observed. Follow-up: dir-scope the store.
   - **Recap map** entries carry no project dir; the re-arm loop skips ids that are also
     background-parked (the collision case), and full dir-scoping of the map (hook script +
     parser) is a follow-up.

## v1 limitations + follow-ups (explicitly out of scope now)

- **MCP is single-project.** Terminal-board agents and the MCP registry see the ACTIVE
  project only; residents are invisible to `list_boards`/relay while backgrounded
  (parked sessions are excluded from `listPtySessions` by construction). Multi-project
  awareness is a follow-up on the MCP layer.
- **Survive-quit broker** (processes outliving the app) — rejected for v1; revisit only
  with a real daemon design.
- **Downloads hold-and-resolve:** downloads are DENIED while a preview is backgrounded;
  queue-and-resume is a follow-up.
- **Remember-my-choice granularity** (per-project Stop memory) — deliberately not offered;
  Stop stays one-shot.
- **Quit-relaunch e2e** (quit with background work → relaunch restores snapshot+tail,
  zero survivors): the mechanism is unit-covered (`persistBackgroundRingTailsCore`,
  `appendTerminalSnapshot` cap tests) and the splice path is e2e-proven in-run
  (`projectBackgroundContinuity.e2e.ts`); a full relaunch harness (second `_electron`
  launch mid-spec) does not exist yet — same deferred class as the auto-update e2e.

## Hard-won constraints (do not re-learn)

- **`webContents.capturePage(rect)` on the app window KILLS the app under GPU load**
  (3/3 full e2e legs, Phase 4b). Thumbnails therefore capture the FULL page and crop
  CPU-side (`nativeImage.crop`), downscale ~2×, and cache as PNG at
  `userData/project-thumbs/<sha1(dir)>.png` (app cache, never the project folder), served
  session-set-only with a 1/s throttle and a 400ms renderer time-box — capture failure is
  a NORMAL outcome (placeholder path).
- Park BEFORE the `setProjectLoading()` unmount — park is what turns each board unmount's
  `pty:kill`/`preview:osrClose` into a no-op.
- The switch-transition overlay (Phase 4c) is presentation-only: armed after the
  flush-save, settled off the real landing, force-cleared by a 4s watchdog — it can never
  gate or block the pipeline.
