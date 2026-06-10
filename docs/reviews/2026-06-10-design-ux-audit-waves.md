# Design/UX audit — umbrella wave plan (kickoff, 2026-06-10)

Tackle plan for [`2026-06-10-design-ux-audit.md`](2026-06-10-design-ux-audit.md). Same umbrella
model as the 2026-06-04 consolidated backlog (Waves 0–5): **one umbrella, sequential waves, each
wave = file-disjoint lanes run in parallel worktrees, merged into `main` sequentially with the full
gate + e2e matrix after EACH merge.**

## Ground rules (apply to every lane)

1. **One session per worktree** (`.claude/tools/new-worktree.ps1 -Name <lane> -Zone "<files>"`).
   Cap ~4 live. Branch naming: `fix/design-w<N>-<lane>` (or `feat/` for net-new UI).
2. **Design artifact before code** (CLAUDE.md rule): any lane that adds or changes visible UI MUST
   produce an ASCII wireframe / static mock matching `src/renderer/src/index.css` tokens and get
   the user's nod BEFORE implementation. Lanes flagged 🎨 below.
3. **Contract deltas need sign-off first** (flagged ⚠️): token value changes touch
   `design-reference/project/DESIGN.md` mirror — present the delta, get approval, then build.
4. Gate per lane: `pnpm typecheck · lint · format:check · unit` green before PR; e2e matrix runs on
   push (watch the new-branch first-push skip — run `pnpm test:e2e:matrix` manually).
5. Reviewer dispositions: inline reply on EACH bot comment (CLAUDE.md convention).
6. ~~Coordinate with `fix/bug-hunt-2026-06-10`~~ — resolved: that lane merged (#107/#109) before
   D0 landed; rule kept for the record. Standing version: do not touch `src/main/index.ts` from
   design lanes; declare shared files on ACTIVE-WORK before editing.

## Wave D0 — quick wins (1 lane, single session)

Small, low-risk, no new UI surfaces (except one transient hint). One worktree, one PR.

| ID | Item | Files (approx) | Sev | Notes |
|---|---|---|---|---|
| D0-1 | Fix ghost token `var(--text-1)` | `canvas/edges/OrchestrationEdge.tsx:37` | Bug | Map to `--text` |
| D0-2 ⚠️ | Contrast pass: lighten `--text-3` (~#7b7b81); restrict `--text-faint` to disabled-only uses | `index.css` + faint-text call sites | High (A1/A2) | Contract delta — sign-off, then sync DESIGN.md note |
| D0-3 | Tokenize connector colors `#e6e6e6`/`#5a6573`, danger-hover rgba, notch `#15161a`; add `--scrim` token (consumed by Wave D1-B) | `Canvas.tsx`, `ElementContextMenu.tsx`, browser CSS, `index.css` | Med | |
| D0-4 | Dock `title` hints; port-picker Esc + outside-close; project-switcher viewport clamp | `AppChrome.tsx`, `TerminalBoard.tsx` picker | Low | |
| D0-5 | Export + screenshot failures → visible message (interim: reuse `.ca-preview-note`) | `ExportPopover.tsx`, `BrowserBoard.tsx` | Med | Final home = D1 toast |
| D0-6 | `role="status"`/`aria-live="polite"` on terminal status cluster + browser connect state | `TerminalBoard.tsx`, `BrowserBoard.tsx` | Med (A5/A9) | |
| D0-7 | Project-switch loading state (dim + spinner in switcher pill) | `AppChrome.tsx` | Med | |
| D0-8 | **Save-failure interim surface** — error chip in switcher pill on `save()===false` | `AppChrome.tsx`, `useAutosave.ts` | **High** | Data-loss class; do first. Coordinate w/ bug-hunt lane |
| D0-9 🎨 | Full-view "Esc to exit" transient hint (first entry per session) | `FullViewModal.tsx` | Low | Tiny artifact: one-line pill wireframe in PR |

## Wave D1 — primitives (3 lanes, parallel, file-disjoint)

Foundational components the later waves consume. Merge order within wave: A → B → C (any order
works; A first so B/C can route their errors through it).

| Lane | Scope | Zone | Effort |
|---|---|---|---|
| D1-A 🎨 | **Toast primitive** — single transient channel: queue, `role="status"`, auto-dismiss + dismiss button, bottom-right island per §8. Migrate: save failure (replaces D0-8 chip), export/screenshot notes, port-detect note, consent save errors | new `canvas/Toast.tsx` + call sites | M |
| D1-B | **Shared `<Modal>`** — `--scrim` token, portal, Esc, focus trap, initial focus, focus-restore. Migrate ConfirmModal / RecapConsentModal / SettingsModal; kill 3 hardcoded scrims + `#fff` text (A7) | new `canvas/Modal.tsx` + 3 modals | M |
| D1-C | **Shared `<Menu>`** — `menuitem` roles, roving tabindex / arrow keys, unified viewport clamp (lift ElementContextMenu's algorithm). Migrate project switcher, BoardMenu, GroupContextMenu, ElementContextMenu, terminal context menu (A8) | new `canvas/Menu.tsx` + 5 menus | M-L |

## Wave D2 — board chrome + feedback parity (4 lanes, parallel)

| Lane | Scope | Zone | Effort |
|---|---|---|---|
| D2-A | **Inline board title edit** — double-click on title (all 3 types) + F2; input swap, Enter commit / Esc cancel. Closes DESIGN.md §6 mandate | `BoardFrame.tsx` | M |
| D2-B | Terminal polish: config-popover unsaved-changes guard · spawning-state sliver · restart-menu auto-close · 🎨 first-run launchCommand hint line · recap-flip focus transfer (A6) | terminal/* | M |
| D2-C | Browser resilience: `render-process-gone` → crashed state + Reload CTA · snapshot-until-ready reattach · URL sanity check (inline error) · evicted "paused" badge · status word beside dot · auto-push URL accent flash | browser/* + `main/preview.ts` | M-L |
| D2-D | Motion polish: LOD-boundary 100ms crossfade · focus-dim 120ms ease · gate remaining inline hover transitions + checklist progress anim under reduced-motion (A12) | `BoardFrame.tsx`, `BoardNode.tsx`, css | S |

`?` shortcut overlay 🎨 rides in D2 as a 5th mini-lane if capacity allows (keymap already
centralized in `useCanvasKeybindings.ts` + `tools.ts`) — else it folds into D4-A.

## Wave D3 — whiteboard category gaps (3 lanes)

| Lane | Scope | Zone | Effort |
|---|---|---|---|
| D3-A 🎨 | **Note tint picker** — swatch row in element context menu + on-hover swatches; tint patch = one undo step | planning/* (NoteCard, ElementContextMenu) | S-M |
| D3-B 🎨 | **Arrow endpoint editing** — drag handles on selected arrow to rebind endpoints; defer head/tail styles | planning/* (WhiteboardSvg, usePlanningPointer) | M-L |
| D3-C | Keyboard nudge: arrow keys move selected planning elements (1px, Shift=10) + Shift+F10 context menu + checkbox `role="checkbox"` (A4 partial, A10) + planning Ctrl+G/Ctrl+Shift+G group/ungroup | planning/* | M |

D3-D 🎨 **selection contextual bar** (Figma-style mini-bar above selection: tint/align/lock/
duplicate) is the stretch lane — spec + artifact first; absorbs D3-A's picker if both run.

## Wave D4 — discoverability backbone (major, sequential)

| Lane | Scope | Effort |
|---|---|---|
| D4-A 🎨 | **Command palette (Ctrl+K)** — searchable verbs w/ shortcuts: board create/navigate/rename, group ops, align, camera, terminal restart, export. Spec + artifact + plan before code; new island per §8 | L |
| D4-B | **Keyboard-first canvas** — Tab-cycle boards, arrow move/resize, Enter=focus, F2=rename (needs D2-A), focus-return from native preview (A3, A4) | L |
| D4-C 🎨 | **Wayfinding** — minimap (spec §8 optional) vs board list: present both as wireframes, user picks | M-L |

## Sequencing + status

```
D0 (1 session) → D1 (A,B,C parallel) → D2 (A–D parallel) → D3 (A–C) → D4 (A→B→C)
```

| Wave | Status |
|---|---|
| D0 | ✅ merged — #108 squash `146fc76` (2026-06-10); D0-1..D0-9 all landed (7 review rounds, 15 inline findings dispositioned). `--scrim` token now defined; D0-8 chip + D0-5 notes are interim surfaces D1-A migrates. |
| D1 | ✅ merged — A Toast #112 (`5d63559`) · B Modal #111 (`9da926d`) · C Menu #113 (`2f0a972`), all 2026-06-10. D0-8 chip deleted (sticky save-failure toast + Retry); 3 modals on shared `Modal.tsx` (`--scrim`, focus trap/restore); 6 menus on shared `Menu.tsx` (menuitem roles + roving tabindex + unified clamp + ADR 0002 detach). 2 real cross-lane bug classes found by e2e: mid-dispatch listener removal (B+C, refs pattern) · deferred xterm focus-restore (C). Post-D1 main gate green: unit 1984 + e2e matrix Win 63/Linux 63. |
| D2 | not started — **next up** (4 lanes A–D parallel; note D2-A and D2-D both touch `BoardFrame.tsx` → merge A before D, D rebases). |
| D3 | not started |
| D4 | not started — D4-A/C need spec + design artifact + sign-off first |

Update this table + ACTIVE-WORK.md as lanes land; append landings to
`docs/archive/build-history.md` per convention.
