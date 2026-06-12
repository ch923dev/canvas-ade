# DX audit — implementation spec & plan (2026-06-13)

Companion to [`2026-06-13-dx-audit.md`](2026-06-13-dx-audit.md) (the assessment). This file is
the **per-slice spec/plan**: when implementation starts, it rides the `fix/dx-*` worktree
branch and is deleted in the PR that merges it (doc-lifecycle policy). No UI/UX is touched, so
no design artifact is required.

**Open decision (blocks PR-2 shape only):** whether the Linux e2e leg moves to GitHub Actions
(see §Decision D1 below). Everything else is decision-free.

---

## PR-1 — Reviewer tuning (QW-1 + QW-2 + QW-3)

**Branch:** `fix/dx-review-tuning` · **Files:** `.github/workflows/claude-code-review.yml`,
`CLAUDE.md` · **Effort:** ~1–2 h · **Risk:** low (prompt-only; no code paths)

### Spec

1. **Severity floor + budget (step 4 of the prompt).** Replace "For EACH NEW or
   still-unaddressed issue, post an inline comment" with:
   - Inline comments ONLY for `[critical]` and `[warning]` — the bar is "would a senior
     engineer block the merge on this?" Hard cap **5 inline comments per review**, ordered by
     importance; if more exist, list the remainder as one-line bullets in the summary.
   - `[nit]` is NO LONGER an inline severity. Nits go in the summary under a heading
     "Nits (non-blocking — no reply needed)", max 3 bullets, never re-raised on later rounds.
   - Add a do-not-comment list: anything ESLint/Prettier enforces; naming/style taste;
     comment phrasing; speculative "consider adding a test" without a concrete missed case;
     anything in generated files or lockfiles.
   - Add a verification bar: any behavioral claim must cite the file:line actually read to
     verify it — no inferences from naming alone.
2. **Incremental re-review (new step 2c + step 4 amendment).**
   - The summary marker becomes `<!-- claude-code-review:auto head:<reviewed-head-sha> -->`.
     (Inline-comment markers stay unchanged — the self-clear jq matches on the
     `claude-code-review:auto` substring, which still matches.)
   - New step 2c: extract `head:` from your previous summary before deleting it. If present
     AND `git merge-base --is-ancestor <that-sha> HEAD` succeeds, this is an **incremental
     review**: review only `git diff <that-sha>..HEAD` (opening surrounding files for context
     is still required). If absent or the ancestor check fails (force-push/rebase), do a full
     review.
   - **Convergence rule:** on any incremental review, post `[critical]`/`[warning]` only —
     no new nits at all, not even in the summary. State in the summary: "Incremental review
     of `<short>..<short>`."
3. **Paths filter (workflow `on:` block).** Enable:
   ```yaml
   on:
     pull_request:
       types: [opened, synchronize]
       paths:
         - 'src/**'
         - 'e2e/**'
         - '.github/**'
         - '*.ts'
         - '*.json'
         - '*.yml'
         - '.githooks/**'
   ```
   (Mirrors the pre-push docs-only skip: `docs/**` + `*.md` changes alone no longer trigger
   a review. Note GitHub semantics: if NO changed file matches, the workflow does not run.)
4. **CLAUDE.md amendment** ("Responding to the Claude PR reviewer" section): inline replies
   remain mandatory for every INLINE thread; summary-listed nits explicitly need no
   disposition. One sentence; keeps the disposition loop intact for findings that matter.

### Acceptance
- Dry-run the prompt once by opening a small test PR (or piggyback on the next real PR):
  ≤5 inline comments, all `[critical]`/`[warning]`; nits only in summary; summary carries
  `head:<sha>`; a second push produces an "Incremental review of …" summary that does not
  re-read unchanged files.
- The self-clear still works across the marker change (old-format comments from prior PRs
  still match the substring and get cleared).

---

## PR-2 — Pre-push scoping: Linux leg demotion (QW-4)

**Branch:** `fix/dx-prepush-scope` · **Files:** `.githooks/pre-push`, `CLAUDE.md` (merge
protocol line), optionally `.github/workflows/` (Decision D1) · **Effort:** ~1–2 h ·
**Risk:** medium (gate semantics — must fail open to full, never to skip)

### Decision D1 — where does the Linux leg live? (user to decide)

| Option | Per-push cost | Cross-OS guarantee | Notes |
|---|---|---|---|
| **A. Linux leg → GitHub Actions, per-PR** (recommended IF Actions billing allows) | Windows-only locally (~1.5–2.5 min) | Linux runs on every PR push in CI, async — author never waits | ubuntu-latest + xvfb is EXACTLY what `Dockerfile.e2e` replicates; Linux minutes are the cheap tier. Kills the local Docker Desktop dependency + the tag-race/auto-update failure modes. The 2026-06-03 removal was billing-blocked — revisit that constraint first. |
| **B. Linux leg local, path-gated** (no billing dependency) | Windows-only on most pushes; +Docker leg when `src/main/**`, `e2e/**`, `Dockerfile.e2e`, `package.json`, `pnpm-lock.yaml`, `playwright.config.ts`, or `electron.vite.config.ts` change, or `E2E_FULL_MATRIX=1` | Full matrix once per PR at the pre-merge gate (already mandated by the merge protocol) | Pure shell edit in the hook; zero new infra. |

Either way the **Windows leg stays local and native** — it has the real GPU (see terminalCrisp
skip), real ConPTY, and is the leg that caught the pid-reuse `RangeError`. Do NOT move the
Windows leg to Actions: windows-latest runners are GPU-less (the WebGL tests would skip there
too), slower, and bill at 2× minutes on private repos.

### Spec (Option B shown; Option A replaces the Docker branch with a new `e2e-linux.yml` job)

In `.githooks/pre-push`, after the docs-only check:

```sh
# Linux Docker leg only when cross-platform-sensitive paths changed (or forced).
LINUX_SENSITIVE='^src/main/|^e2e/|^Dockerfile\.e2e$|^package\.json$|^pnpm-lock\.yaml$|^playwright\.config\.ts$|^electron\.vite\.config\.ts$|^\.githooks/'
if [ "${E2E_FULL_MATRIX:-}" = "1" ] || printf '%s\n' "$changed" | grep -qE "$LINUX_SENSITIVE"; then
  E2E_PRECOMMIT=1 pnpm test:e2e:matrix
else
  echo "[pre-push] renderer-scoped diff — Windows e2e leg only (Linux runs at the merge gate; force with E2E_FULL_MATRIX=1)."
  E2E_PRECOMMIT=1 pnpm test:e2e
fi
```
- `force-full` sentinel lines (BUG-018/068 fallbacks) match nothing in `LINUX_SENSITIVE`…
  they MUST run the full matrix — add `force-full` to the regex or check it first.
- Docker-daemon check moves inside the matrix branch (a Windows-only push must not require
  Docker running).
- CLAUDE.md merge-protocol sentence: "the full matrix (`pnpm test:e2e:matrix`) runs once per
  PR at the pre-merge gate" — making the existing practice an explicit contract.

### Acceptance
- Renderer-only push → hook log shows the Windows-only line; wall time ≤ ~2.5 min.
- `src/main/**` push, `E2E_FULL_MATRIX=1` push, and a force-full fallback → full matrix runs.
- Docs-only push behavior unchanged (skip).

---

## PR-3 — E2E tagging + path-scoped selection (MT-1)

**Branch:** `fix/dx-e2e-tags` · **Files:** all `e2e/*.e2e.ts` (title tags only),
`package.json` (scripts), new `scripts/e2e-scope.sh`, `.githooks/pre-push` ·
**Effort:** ~half a day · **Risk:** medium (selection bugs = silently untested pushes →
mitigations below)

### Spec

1. Tag every spec's `test.describe` title:
   - `@core`: `recovery`, `reset-isolation`, `placement`, `evidence`
   - `@terminal`: `terminal*`, `processTree`, `recap`
   - `@preview`: `browser*`, `preview*`, `fullview`, `previewLink`
   - `@planning`: `whiteboard`, `textCreate`, `textToolbar`, `noteTint`, `planningKeyboard`
   - `@chrome`: `menu*`, `modal`, `commandPalette`, `wayfinding`, `titleEdit`,
     `boardKeyboard`, `groups`
2. Scripts: `"test:e2e:smoke": "playwright test --grep @core"` and a
   `scripts/e2e-scope.sh` that reads the changed-path list on stdin and prints either a
   `--grep` expression or `FULL`:
   - `src/renderer/src/canvas/boards/terminal/**` or `src/main/pty*` → `@core|@terminal`
   - browser/preview paths (`usePreviewManager`, `BrowserBoard`, `src/main/preview*`,
     `localServer`) → `@core|@preview`
   - planning paths (`PlanningBoard`, `planning/**`, vendored freehand) → `@core|@planning`
   - chrome paths (`AppChrome`, `SettingsModal`, menu/modal/toast primitives) →
     `@core|@chrome`
   - **Anything else — including `canvasStore`, `boardSchema`, `Canvas.tsx`, `BoardFrame`,
     `e2e/**`, `src/main/index.ts`, configs, unknown paths — → `FULL`.** Fail OPEN to full.
3. Pre-push consumes it: scoped grep on the Windows leg; the Linux/matrix decision from PR-2
   composes on top (a scoped push never runs the Linux leg; a `FULL` verdict follows PR-2's
   rules).
4. Guard: a vitest unit test for the scope script's mapping table (it's a pure function of a
   path list — test it like one).

### Acceptance
- Touch only `noteTint`-adjacent source → hook runs `@core|@planning` subset (≲1 min).
- Touch `canvasStore.ts` → `FULL`.
- Scope-script unit test in the `check` gate; mapping documented in `docs/testing/TESTING.md`.

---

## PR-4 — Thin pure-renderer e2e specs (MT-2)

**Branch:** `fix/dx-e2e-thin` · **Files:** `e2e/{menu,modal,noteTint,titleEdit,textToolbar,
boardKeyboard,planningKeyboard,commandPalette}.e2e.ts` + new/extended
`*.integration.test.tsx` + `docs/testing/TESTING.md` · **Effort:** ~1–2 days · **Risk:**
medium — do NOT delete the real-input probes that exist because jsdom provably misses their
class (mid-dispatch listener removal, coordinate transforms, real Ctrl+V paste).

### Spec
Per spec file: keep exactly ONE real-input sliver per interaction pattern (one Esc-dismiss,
one roving-tabindex arrow walk, one real-click-through-camera, one real paste); migrate
variant/state assertions (all tint values, all shortcut bindings, label/badge states) to
jsdom integration tests. Update TESTING.md's keep-set table in the same PR. Target: ~100 →
~60–70 e2e tests with zero loss of e2e-only classes.

### Acceptance
- Every migrated assertion exists in a jsdom test before its e2e copy is removed (move, not
  delete — verify by diffing assertion inventories in the PR description).
- Full matrix green both legs; unit count rises accordingly.

---

## PR-5 — `e2e/mcp.e2e.ts` port (MT-4, already a tracked TESTING.md follow-up)

Ports the `CANVAS_SMOKE=mcp` harness (`src/main/mcpSmoke.ts`, 1221 lines, pinned 1000) to a
Playwright spec tagged `@mcp`; retires the last `CANVAS_SMOKE` exception and deletes the
mcpSmoke pin from `eslint.config.mjs`. Scope/effort: ~1–2 days; sequence after PR-3 so it
lands tagged.

## Ongoing — god-file paydown cadence (LT-1) + decision-rule enforcement (LT-2)

Not a PR; a convention line added (in PR-1's CLAUDE.md edit or a follow-up): when a feature
PR touches a pinned/near-cap file, prefer landing one Tier-1 seam extraction from
`docs/research/2026-06-09-god-file-maintainability.md` in or alongside it, lowering the pin
in the same PR. Order: Canvas.tsx (779) → TerminalBoard (631) → PlanningBoard (666) → the
comment-dense near-cap set. LT-2 adds one reviewer-prompt line (flag new e2e tests provable
at a lower tier as `[warning]`) — fold into PR-1.

---

## Sequencing & measurement

```
PR-1 (review tuning)  ──┐  independent, ship first — biggest churn lever
PR-2 (pre-push scope) ──┤  needs Decision D1; independent of PR-1
PR-3 (tags + scope)   ──┴→ after PR-2 (composes with its branch logic)
PR-4 (thinning)       ───→ after PR-3 (migrated specs land pre-tagged)
PR-5 (mcp port)       ───→ after PR-3
```

Track over the next 5 PRs: review rounds (target ≤2) · inline comments/round (≤3, all
warning+) · pre-push wall time (≤2 min scoped) · full-matrix runs per PR (exactly 1, at the
merge gate). Escalate to on-demand-only reviews (MT-3 in the audit doc) only if rounds still
exceed 2 after PR-1 has had 5 PRs of data.
