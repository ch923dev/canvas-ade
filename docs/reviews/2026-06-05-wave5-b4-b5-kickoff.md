# Kickoff — Wave-5 B4 (perf) + B5 (god-file splits)

**Date:** 2026-06-05 · **For:** the next session picking up the Wave-5 remainder on `main`.
**Read first:** `.claude/coordination/ACTIVE-WORK.md` (live board, SessionStart-injected) +
`docs/reviews/2026-06-04-CONSOLIDATED-backlog.md` (Wave 5 section) +
`docs/reviews/2026-06-04-main-branch-full-audit.md` (per-finding evidence).
Supersedes the Wave-5 B1/B2/B3 portion of `docs/reviews/2026-06-05-post-t9-backlog-kickoff.md` (DONE, #61).

---

## Where things stand — `main` @ `2fb3e7c`

Shipped to `main` this session: **Task A / Wave-4 remainder (#60)** + **Wave-5 B1+B2+B3 (#61)** —
CSP/secure-defaults hardening (`src/main/csp.ts`, `windowSecurity.ts` pins), the `isForeignSender`→
`src/main/ipcGuard.ts` hoist, and the crash-orchestration extraction (`makeCrashHandler` in `quit.ts`).
Branch/worktree hygiene done (Task C). main CI green (check + 6-target packaging + codeql). Local `main`
ref is current.

**This kickoff = the last two Wave-5 slices**, both touching the renderer hot paths / god-files. They were
deliberately deferred because they want **e2e verification** (the preview/whiteboard sync paths), which needs
the provisioned token'd recipe — a junctioned worktree can only run vitest + lint + web-typecheck.

## ⚠️ Provisioned token'd gate recipe (REQUIRED for B5; recommended for B4)

A junctioned worktree shares the main dir's `node_modules`, which is currently **pre-T9** (vitest 2 / electron
33 — the main dir sits on `feat/expanse-site`). So locally you get vitest 2 (the v4 `test.projects` config is
ignored → `.tsx` tests need a `// @vitest-environment jsdom` first line) + node-typecheck fails on the private
`@ch923dev/canvas-ade-mcp` dep. To run the FULL `typecheck`/`build`/`test:e2e:matrix`:

```
# in the worktree:
rm node_modules                                   # drop the junction (it's a symlink)
NODE_AUTH_TOKEN=$(gh auth token) pnpm install      # resolves the private MCP dep; node-pty rebuilds vs Electron 42
pnpm typecheck && pnpm build && pnpm test:e2e:matrix   # matrix needs Docker (present) + MSVC Spectre libs (Windows)
# teardown: git worktree remove --force  (de-junctioned node_modules is a real dir)
```

CI (token'd ubuntu) runs the full `check` gate on every PR — but **e2e is NOT in CI** (it's the local
pre-commit matrix). So a behavior-touching renderer change (B5 especially) is only e2e-covered via this recipe.
Commit `--no-verify` in a junctioned worktree (the pre-commit matrix can't build). Memory:
`worktree-junction-stale-deps`.

---

## Task B4 — perf (lower risk; START HERE)

Four hot-path allocations from the consolidated backlog. `file:line` on the **post-#61 tree** (re-confirm
before editing; these were captured 2026-06-05 on `origin/main 2fb3e7c`):

| Finding | File:line | Fix |
|---|---|---|
| `previewlayer-reconcile-on-every-viewport-frame` | `BrowserPreviewLayer.tsx:878` (`useCanvasStore.subscribe((s) => …)`) | The whole-store subscription fires the reconcile on EVERY store change (incl. per-frame viewport). Narrow it to the `boards` slice — subscribe with a selector/equality so a viewport-only change doesn't reconcile. **The only B4 item not colliding with #61's files.** |
| `nodes-memo-data-object-churn` | `Canvas.tsx:310` (`const nodes = useMemo<BoardFlowNode[]>`) | The memo rebuilds a fresh `data` object per board every recompute → new refs → every `BoardNode` re-renders. Memoize per-id `data` (stable ref unless that board's inputs change). |
| `onnodeschange-perframe-snap-allocation` | `Canvas.tsx:376` & `:412` (`const others = boards…` inside the snap pass) | `onNodesChange` recomputes the `others` rect array every drag frame. Precompute `others` once at gesture-start (drag-begin), reuse across the drag. |
| `fittoboards-repeated-minmax-spread` | `Canvas.tsx:501` (`fitToBoards = useCallback`) | Repeated `Math.min/max(...spread)` over boards. Precompute/memoize the bounds. |

**Approach:** TDD where unit-observable (memo stability can be asserted; a `computeBounds`/`snapOthers`
helper can be extracted pure + unit-tested — follow the Wave-4 `cameraShortcut.ts`/`terminalPreview.ts`
precedent of extracting the used helper so the test isn't a replica). The perceptual win (no per-frame
reconcile/churn) is **e2e/visual** — verify with the provisioned recipe + a manual run. Lowest-collision item
(BrowserPreviewLayer subscribe) is independent; the three `Canvas.tsx` items share a file → sequence them.

**Risk:** Medium. These rewrite the drag/viewport render loop; a subtle equality bug = stale boards or missed
snaps. Keep each change minimal + behavior-preserving; re-run the e2e matrix (browser/preview + whiteboard
drag probes) after.

## Task B5 — god-file splits (HIGH risk; needs e2e recipe)

Behavior-preserving extractions. Current LOC on `main`:

| File | LOC | Extract |
|---|---|---|
| `src/renderer/src/canvas/boards/PlanningBoard.tsx` | **1215** | `usePlanningPointer` (the well pointer/draft/erase/marquee handlers) |
| `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx` | **982** | a `PreviewManager` class (the imperative view lifecycle + rAF reconcile loop) |
| `src/renderer/src/canvas/Canvas.tsx` | **1064** | `useFullView` · `useTidyTile` · `useCanvasKeybindings` |

**These rewrite the EXACT preview/whiteboard sync paths** (the native `WebContentsView` ↔ camera rAF loop;
the planning pointer state machine). No new behavior — pure extraction. **Must be e2e-verified** (the
provisioned recipe). There is no `canvas/hooks/` dir yet — the extractions are net-new files; `cameraShortcut.ts`
(imported at `Canvas.tsx:78`) is the existing precedent for an extracted-and-tested helper.

**Approach:** one extraction at a time, each its own commit (or small PR), e2e matrix green after EACH. Do NOT
batch all four into one PR — a regression would be hard to bisect. Strongly prefer subagent-driven with a
per-extraction holistic review (these are the riskiest Wave-5 items per the original backlog). **Scope-confirm
with the user before starting B5** — confirm the split boundaries (e.g. exactly which handlers move into
`usePlanningPointer`) so the extraction matches their mental model.

**Risk:** HIGH. Rewrites the sync paths e2e covers; the preview layer has documented gotchas (full-view
DETACH-not-close, the browser-trio capturePage env flake — memories `fullview-detach-not-close`,
`e2e-browser-trio-flake`). Don't change preview lifecycle semantics during the extraction.

---

## Working rules (don't re-decide)
- App fixes on a `fix/*` **worktree off `main`** via `.claude/tools/new-worktree.ps1` (junctions node_modules).
  **Base off `origin/main`** if local `main` is ever behind. `main` = integration-only.
- Subagent-driven (TDD + per-task spec+quality review) is the cadence. **Real coverage, not replica tests** —
  extract the used helper and test THAT (a Wave-4 review caught false-green replicas). Workflow subagents:
  sonnet for mechanical, opus for integration/judgment; **never haiku** (memory `workflow-model-sonnet-not-haiku`).
- Merge sequentially; re-run the gate after EACH merge (CI is the green gate). Commit `--no-verify` in a
  junctioned worktree.
- **Recommended order: B4 → B5.** B4 is lower-risk and partly unit-coverable; B5 needs the provisioned e2e recipe
  stood up first (and a scope-confirm). Both want a real e2e run before merge.
- **Rebrand #17 still MERGES LAST.** Don't touch `chore/rebrand-expanse`.

## Pointers
- Findings + evidence: `docs/reviews/2026-06-04-CONSOLIDATED-backlog.md` (Wave 5) ·
  `docs/reviews/2026-06-04-main-branch-full-audit.md`.
- Memories: `worktree-junction-stale-deps`, `e2e-sendinputevent-vs-dispatchevent`,
  `fullview-detach-not-close`, `e2e-browser-trio-flake`, `planning-fullview-camera-fit`,
  `tidy-and-fit-feature`, `paste-fires-at-document`.
- Also still open (not this kickoff): **Task D** dependabot npm-registry creds (needs the user to create the PAT/
  secret) · **Task E** Phase 5 packaging/signing · `canvas-ade-mcp` **M5** (Barriers/attention, off `main`).
