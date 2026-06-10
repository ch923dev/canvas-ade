# Build history — phases, slices & superseded plans

Point-in-time record of how Canvas ADE was built, phase by phase. **Not live truth** — the
durable contract is `CLAUDE.md`; the build order + current status is `docs/roadmap.md`.

Per-slice **specs, plans, and phase handoffs were collapsed into summaries on 2026-06-01 and again
on 2026-06-04** (docs centralization). The full documents remain in git history. To recover one:
`git log --all --oneline -- docs/superpowers/` or `-- docs/handoffs/`, then check out the path at that
commit. Two large initiatives have their own compiled build-logs in this folder — see Post-Phase-4 below.

## Phases (all shipped on `main`)

| Phase | What shipped | Landed |
|---|---|---|
| 0 — Toolchain proof | electron-vite + TS + React, secure defaults; React Flow / xterm+webgl / node-pty (ConPTY over MessagePort) / WebContentsView→localhost / electron-builder all verified e2e; CI matrix. | `4d057e0` |
| 1 — Preview feasibility gate | Native `WebContentsView` stays camera-correct under pan/zoom on Windows; steps 1-A…1-E (diagnostics, static overlay, live pan/zoom, detach+snapshot, N-views+responsive+lifecycle). Gate passed (ADR 0002). | (Phase 1 branches) |
| 2 — Core boards | Foundation 2.0 (tokens · store+schema · canvas+`BoardFrame`+`NodeResizer`+LOD · app chrome) then Terminal · Browser · Planning+Checklist in parallel. Checklist = Planning element, not a 4th type. | (Phase 2 branches) |
| 3 — Board actions & projects | Slice A persistence (`canvas.json` v2 + `.bak`, atomic write, autosave, recent-projects, project switch) · Slice B board actions (Full view, Duplicate, ⋯ menu) · Slice C′ port-detect→push-to-preview (git worktrees deferred to Feature Workspaces). | `139bc69` |
| 4 — Design pass & polish | Every DESIGN.md token / board-chrome rule / state / motion (+ `prefers-reduced-motion`); full-view motion; §6.1 top band descoped into the title-bar toggle. | `abd7fa2` (PR #9) |
| 5 — Packaging & release | **Not started.** CI matrix unsigned until here; signing (mac notarize + Win Authenticode), electron-updater feed, app icons. | — |

> **Note on the Phase 3 Full-view mechanism:** Phase 3-B originally shipped Full view via *live portal
> relocation*. That model was **superseded** by PR #14 (see Post-Phase-4) — full view now **detaches**
> every board's native `WebContentsView` (never `close()`, never portal-relocates) to preserve page state.

## Post-Phase-4 work (chronological)

- **Layout presets / smart tidy** (PR #13, `14f77d7`) — FancyZones-style layout presets + a one-press
  Tidy (shelf-pack to the pane aspect) + fit-to-frame; `t` shortcut. Memory `tidy-and-fit-feature`.
- **D1.1 — `trackedChange` undo-rail refactor** (PR #18, `f7ffbbf`) — collapsed the per-action
  `lastRecorded` phantom-undo discipline into one `trackedChange` helper routing add/remove/duplicate/
  tidy/undo-redo. A no-op gesture on add/remove/duplicate is a tolerated phantom edge (memory
  `undo-lastrecorded-phantom`). Opened the draw.io feature track (`docs/roadmap-drawio.md`).
- **Full-view preview state-preservation** (PR #14, `ad21389`) — toggling full view **restarted**
  Browser boards: `applyLiveness`'s full-view branch tore down native views with `webContents.close()`,
  which discards the page, so on exit `attachBoard` re-`openPreview`d at the durable `board.url`,
  snapping the navigated page back to root. Now both paths **detach** (snapshot + keep the live
  `WebContentsView`); exit re-attaches via `attachPreview` (no `loadURL`), state intact. Removed the
  now-dead `evictLiveBoard` (closed the PREV-A resurrection class). Added animated e2e harness path +
  `fullview-preserve`/`fullview-self-preserve` probes.
- **Round-3 review backlog cleared** (PR #15 `cd588be` + PR #20 `3be2c62`) — the 2026-06-01 6-dimension
  in-depth review's 12 findings (PTY-2 · WB-1 · STATE-1/2 · SEC-1/2 · PERSIST-A/B/C · PREV-A/B/C), all
  verified-fixed and on `main`. No open findings remain (`docs/reviews/README.md`). PREV-A was closed by
  the PR #14 fullview refactor; the rest by #15/#20.
- **Whiteboard epic (W1–W5)** — eraser/shortcuts · multi-select/snapping · align/lock/group · image
  assets · PNG/SVG export. Shipped on `main` via `feat/whiteboard` PR #34 (`9533f67`), schema → v4.
  Full compiled build-log: **`2026-06-03-whiteboard-epic.md`** (this folder).
- **Testing strategy T0–T5** — migrated the homegrown `CANVAS_SMOKE=e2e` harness to Playwright
  `_electron` + a local Windows-native/Linux-Docker pre-commit matrix; the GitHub Actions e2e/smoke job
  was retired. Full compiled build-log: **`2026-06-03-testing-strategy-initiative.md`** (this folder);
  living contract: `docs/testing/TESTING.md`.
- **Context subsystem (M-digest + M-brain + M-memory)** — desktop LLM brain + `.canvas/` project memory
  → instant per-board context digest on reopen, zero agents/MCP. Shipped on `main` via PR #39
  (`4c321c2`); ADR `0003-llm-egress.md`. Full compiled build-log: **`2026-06-04-context-subsystem.md`**
  (this folder). Only M-expose (MCP read resource) remains, deferred — `docs/roadmap.md` › Deferred.

## Per-slice specs, plans & handoffs (in git history)

Each slice followed the cadence **brainstorm → spec → plan → execute (subagent workflow)** with a
per-task handoff. Phases 0–4 plans/specs/handoffs were under `docs/superpowers/` and `docs/handoffs/`;
the whiteboard, context, and testing per-task docs were collapsed into the compiled build-logs above on
2026-06-04. All originals are recoverable from git history:
`git log --all --oneline -- docs/superpowers/ docs/handoffs/`, then check out the path at that commit.


## Post-Phase-4 landing log (migrated from CLAUDE.md Status, 2026-06-09)

> Committed PR-by-PR record. CLAUDE.md used to carry this inline and it churned every session, so it
> now points here instead. New landings get appended below; in-flight work is tracked in
> `.claude/coordination/ACTIVE-WORK.md`.

**Baseline:** `main` @ `51aae5c` (2026-06-08). Gate on that tree: typecheck - lint (0 err, 3
fast-refresh warns) - format - 1622 unit+integration / 130 files.

Since Phase 4 (all SHIPPED on `main`): MCP M0-M5 - Context subsystem - Whiteboard W1-W5 - Testing
T0-T5 - Electron 33->42 (T9) - review Waves 0-5 hardening - drag-to-create + dock-to-top redesign (#75).

Landed since #75 (2026-06-06 -> 06-08):
- **#81** `c9af28a` - full terminal I/O (selection-aware copy, smart paste, image paste, drag-drop, context menu, scale-correct selection).
- **#82** `1578ffe` - preview camera-sync fixes (native-view pan-freeze + digest-panel occlusion; CodeQL e2e-sanitization).
- **#83** `01da101` - e2e evidence harness + masked-bug reset() fix.
- **#84** `ea221ad` - Named Board Groups S0-S6 (schema v6).
- **#85** `aede88f` - bug-hunt 2026-06-07, 42/42 confirmed fixed (6 Med + 36 Low).
- **#86** `5a93a58` - browser quick-wins (auto-reconnect / auto-push / open-external / screenshot).
- **#87** `51aae5c` - text-font toolbar for the free-text element (schema v7).
- **#89** `668a783` - terminal-recap (flip a terminal board to an agent-CLI session recap).
- **#90** `c670732` - Shift+Enter sends LF.
- **#88/#91** - Claude PR-review CI (inline comments + triage).

Landed 2026-06-10:
- **#107** `cd1ac61` - 2026-06-10 full-app audit fix run: all 72 verified findings fixed (0 Crit / 4 High / 14 Med / 54 Low) via 16 collision-aware cluster agents over 4 waves + adversarial verify (5 amendments); ~130 new regression tests (unit suite -> 1906). 6 bot-review rounds, 12 inline findings all fixed + dispositioned. Findings package committed under `bug-hunt-findings/` (INDEX + 72 cards + FIX-REPORT).
- **#109** `1230b7f` - BUG-069 re-land: claude-review `gh api` allowlist narrowed to the 5 exact endpoint forms the prompt uses (was `gh api:*` — prompt-injection could self-approve PRs). Reverted from #107 because claude-code-action refuses to run when the PR edits the review workflow (anti-self-approval) — such PRs gate on the `check` job only. Plus `.worktrees/**` eslint ignore (session worktrees broke `pnpm lint` on main).
- **#108** `146fc76` - Design-audit Wave D0 quick wins (D0-1..D0-9): save-failure chip + retry (new `saveStatusStore`), `--text-3` contrast lighten + faint=disabled-only, `--scrim`/`--connector`/`--notch` tokens (DESIGN.md mirror updated), picker Esc/outside dismissal + dock tooltips + switcher viewport clamp, failure notes for export/screenshot/open-external (raw detail logged, fixed user-facing copy), sr-only live regions (transition-only announce), project-switch loading feedback, full-view Esc hint. 7 bot-review rounds, 15 inline findings all fixed/verified + dispositioned; mid-PR reconcile with #107/#109 via merge `d13da8a` (tree = verified rebase). Unit suite -> 1916. TerminalBoard max-lines ratchet held via `BrowserPickPanel`/`usePickerDismiss` extraction.
- **#110** `0f86f92` - docs reconcile: collapsed 134 shipped artifacts (-22.7k lines) to git history (root `bug-hunt-findings/` 72-card package -> summary `docs/reviews/2026-06-10-full-app-audit.md`; 23 shipped superpowers specs/plans/handoffs; 2026-06-04 bughunt pkg + main-audit + mcp-status-audit + 3 executed kickoffs; 3 shipped camera-sync research docs). Fixed roadmap-mcp-packaging GitHub-Packages staleness (public npmjs `^0.9.0`), reviews/README index gaps (06-07 hunt + 06-10 audit rows), roadmap stale claims, orphan refs. NEW: doc-lifecycle policy (`docs/README.md` > Conventions, surfaced in CLAUDE.md) - slice docs die on feature-PR merge, findings packages collapse when all fixed + land under `docs/reviews/` never repo root, indexes update same-PR. ALSO: CLAUDE.md no longer tracks the current-main SHA (killed the per-merge `docs(contract): bump` commit; ACTIVE-WORK.md Integration tip = the live pointer). 6 bot rounds, 0 Crit/Warn, 7 nits all fixed/dispositioned (1 accepted-deferred: Canvas.tsx:781 comment repoint, next code-touching PR).
- **#112** `5d63559` - Design-audit Wave **D1-A Toast primitive**: single transient-feedback channel — `toastStore` (FIFO, keyed replace-in-place) + `canvas/Toast.tsx` bottom-right island (status-dot variant, user-signed-off artifact; <=3 visible, 5s auto-dismiss from visibility, sticky+action, role=status / errors role=alert, reduced-motion gated). Island rect joins `chromeExclusionZones` while visible (ADR 0002, digest-panel pattern) — integration- and e2e-proven demote/restore. Migrated + deleted the old private surfaces: D0-8 save-failure chip (-> sticky Retry toast keyed `save-failure`), D0-5 export note, browser screenshot/open-external notes, Slice-C' port-detect note (`makePortDetectNote`), recap consent-save inline error (call site only; file is D1-B's). Rode-along fix the e2e caught: dir-less open project (e2e boot) no longer attempts autosave (killed a phantom sticky failure toast that occluded boards); `e2eHooks.reset()` clears toast/saveStatus stores. 4 bot-review findings (1 warning: island z-index under ConfirmModal 10000 -> 10100; 3 nits: stale chip comments, keyed browser/export toasts) all fixed + dispositioned inline. Unit suite -> 1947; e2e matrix green both legs.
- **#111** `9da926d` - Design-audit Wave **D1-B shared Modal primitive**: one scrim/portal/Esc/focus implementation (`canvas/Modal.tsx`) replaces the 3 hand-rolled copies — ConfirmModal / RecapConsentModal / SettingsModal migrated; FullViewModal deliberately excluded (0.66 full-bleed scrim). Kills the 3 hardcoded scrims (0.5/.45/.4 -> `--scrim`) + `#fff`-on-accent text (-> `--text`) + ConfirmModal's hardcoded shadow (-> `--shadow-pop`) + RecapConsent's off-scale 16px heading (-> `--fs-h`). A7 focus contract: trap (Tab wrap), initial focus (first focusable / `initialFocusRef`), restore-to-opener. BUG-005 `[data-confirm-active]` carried via `confirmGate`; Esc stays bubble-phase so the full-view capture listener keeps beating xterm. REAL BUG found by the new e2e: an Esc window-listener with `[onClose]` identity deps is REMOVED MID-DISPATCH (earlier keybindings listener -> sync uSES commit -> effect re-fire; DOM skips a listener removed during dispatch) so real-OS Esc never fired — fix = register once + read props via refs; jsdom-invisible, pinned by `e2e/modal.e2e.ts` (real `keyboard.press` + PR #93 occlusion regression guard). Backdrop dismiss unified on pointerdown (no down+click double queue-advance). Rebased over D1-A (RecapConsent error -> keyed toast). 4 bot rounds, 2 inline nits (DivProps handler/style Omits) + 1 summary contrast note, all fixed/dispositioned (`--text-on-accent` token logged as future contract delta). Unit suite -> 1959; e2e matrix green both legs (pre-push hook x2).
- **#113** `2f0a972` - Design-audit Wave **D1-C shared Menu shell**: one popover implementation (`canvas/Menu.tsx` + pure `menuPlacement.ts` clamp) replaces 6 hand-rolled copies — board ⋯ menu, Tidy picker, project switcher, GroupContextMenu, ElementContextMenu (+ the terminal well's context menu, an ECM instance). Body portal, measure-then-clamp (unified: ECM's flip-at-pointer + BoardMenu's trigger flip-above + D0-4 maxHeight scroll cap), Escape/outside-capture/resize dismissal, A8 `menuitem` roving tabindex + Arrow/Home/End/Tab nav (ArrowL/R alias = documented APG deviation for the Tidy grid), focus restore on close, ADR 0002 detach-live-previews token (PREV-C). Net-new: roles on board-⋯/switcher rows; arrow nav everywhere; ECM + switcher now detach previews (closes ECM's documented occlusion limitation); Tidy trigger re-click toggle fixed (BUG-045 class). TWO real bugs caught pre-merge: (1) mid-dispatch listener removal swallowed Escape (`groups.e2e.ts:150`; same class D1-B hit independently — fix = mount-stable listeners reading props via refs + a no-resubscribe unit regression); (2) focus-restore to xterm was a silent no-op mid-commit (`focus()` on a transiently-unfocusable textarea) — restore deferred one macrotask; both pinned by new `e2e/menuShell.e2e.ts` (3 real-input specs). MANUAL-CHECKS.md gains a Menus/popovers section. 6 inline findings over 3 bot rounds all fixed + dispositioned; merged-state rounds clean. Ops lesson: when main moved (D1-A) the PR went CONFLICTING and GitHub spawned NO `pull_request` runs at all (no merge ref) — check `mergeable` before chasing Actions. Unit suite -> 1984; e2e matrix green both legs (63 specs).
- **#106** `485220c` - docs(reviews): the 2026-06-10 design/UX audit package lands on `main` — `2026-06-10-design-ux-audit.md` (6-agent full-renderer review vs DESIGN.md: UX 3.5/5, UI 4.5/5; 1 data-loss-class High [silent save], discoverability + feedback gaps, 13 a11y items) + umbrella wave plan `2026-06-10-design-ux-audit-waves.md` (D0-D4). Landed AFTER D0/D1 shipped, so the status table records D0 #108 + D1 #111/#112/#113 merged, D2 next (A/D BoardFrame merge-order note). Rebase over #110 resolved the reviews/README index collision + repointed stale `bug-hunt-findings/` cross-refs to `2026-06-10-full-app-audit.md`; docs/README backlog line synced (doc-lifecycle policy: indexes update same-PR). 5 bot inline findings over 4 rounds all fixed + dispositioned (last 2: cite `useAutosave.ts:92` as the second silent-save path — `e5e5bfe`). Docs-only; check+analyze+CodeQL+claude-review green; e2e matrix ran green both legs on the rebase push (63x2).
- **#114** `0a45583` - Design-audit Wave **D2-A inline board title edit** (2026-06-11): closes the DESIGN.md §6 mandate ("Title is inline-editable on double-click") for all 3 board types via a `BoardTitle` component in the shared `BoardFrame` chrome. Double-click — or F2 while the board is the single selection — swaps the title span for an uncontrolled input (text preselected); Enter/blur commit, Esc cancels; commit = ONE undoable gesture (`beginChange` + `updateBoard`), empty/unchanged text cancels (no store write, no phantom undo step). Hard edges: mount-stable window listeners reading props via refs (the D1-B/C mid-dispatch removal class) — Esc on window CAPTURE so the cancel survives the full-view Esc listener's `stopPropagation`; F2 typing guard (INPUT/TEXTAREA/contentEditable incl. xterm's helper textarea) + single-selection guard; input carries `nodrag nopan` + keydown containment (canvas keymap / RF `deleteKeyCode` never see title keystrokes); the display span keeps `nopan` ONLY (review nit `cfdc628` — span is flex:1, dragging a board by its title text must keep working; dblclick has no movement so RF drag never engages). 11 unit tests + 4 real-input e2e (`titleEdit.e2e.ts`, incl. the Esc capture path + xterm F2 non-leak); MANUAL-CHECKS.md gains a title-edit section. 2 bot rounds: 4 CodeQL `js/bad-code-sanitization` e2e findings fixed `0b512fc` (structured-arg `page.evaluate`, the #82 pattern) + the span-nodrag nit fixed `cfdc628`, all dispositioned inline; final review 0/0/0. Unit suite -> 1995; e2e matrix green both legs (67 specs; one out-of-zone `browserReconnect` 60s-timeout on the first Win pass — passed alone, clean full re-run — and one pre-push Linux-leg failure that was a Docker Hub 522, not tests). Merged FIRST in wave D2 (BoardFrame.tsx shared with D2-D, which rebases).

MCP layer (SHIPPED to `main` 2026-06-05/06): PR #43 `2100022` (M0-M4) + M5 #70 `3824afc`
(board-status event source + event-driven handoff await-idle) + M5 app-adopt #73 `c440251`
(`Orchestrator.subscribeStatus`) + M-expose write->read proof #74 `97d356a`. App pins
`@expanse-ade/mcp ^0.9.0` on public npmjs (migrated `63cf10c` off GitHub Packages
`@ch923dev/canvas-ade-mcp`). Swarm layer done; Feature Workspaces unblocked.

Context subsystem (SHIPPED 2026-06-04 `4c321c2`, PR #39): desktop LLM brain + persistent `.canvas/`
memory (M-digest + M-brain + M-memory); Tier-1 heuristic digest upgraded to cached Tier-2 LLM prose;
ADR `0003-llm-egress.md`. M-expose (`canvas://memory` + `canvas://board/{id}/summary` read
resources) shipped with MCP M0-M4. Generated memory/summaries are untrusted passive context (never
drive an action; prompt-injection residual noted in ADR 0003).

Earlier Phase-4 anchors: Phases 0-4 + layout presets (`14f77d7`, PR #13); Phase 4 design pass
`abd7fa2` (PR #9); post-Phase-4 fixes PR #12 `ed1d551` (13 bugs), `94baab9` (4 med), `1a0c615`
(7 round-2); full-view preview-reset fix PR #14 (detach-not-close; `evictLiveBoard` deleted).

Round-3 in-depth review (2026-06-01): healthy, no Critical/High; all 12 residual Low/Nit/Info cleared
(`fix/round3-backlog` + `fix/round3-lows-remainder`); see `docs/reviews/2026-06-01-round3.md`.
