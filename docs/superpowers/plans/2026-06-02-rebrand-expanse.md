# Rebrand Canvas ADE → Expanse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the product from "Canvas ADE" to "Expanse" across app strings, build/packaging/config identifiers, the internal package name, and all documentation — leaving the repo folder, worktree dirs, and git remote unchanged.

**Architecture:** Pure rename/refactor — no behavior change. Each task swaps a coherent group of strings, then verifies with a red/green **grep gate** (old string present → absent) plus typecheck/test where code is touched. Frequent commits. Two string edits (`src/main/index.ts`, `AppChrome.tsx`) are owned by active worktrees and are isolated into their own task; expect trivial merge conflicts when this branch merges **last**.

**Tech Stack:** Electron 33 + electron-vite + electron-builder, TypeScript, React 18, pnpm, vitest. Windows/PowerShell shell.

**Branch:** `chore/rebrand-expanse` (worktree `Z:\canvas-ade-rebrand-expanse`). Merges into `main` last.

**Spec:** `docs/superpowers/specs/2026-06-02-rebrand-expanse-design.md`

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `electron-builder.yml` | appId, productName (drives installer name) | 1 |
| `package.json` | internal package name | 1 |
| `electron.vite.config.ts` | CSP-meta plugin name | 2 |
| `src/renderer/index.html` | `<title>` + plugin-name comment | 2, 3 |
| `.github/workflows/build.yml` | CI artifact name | 2 |
| `src/renderer/src/canvas/WelcomeScreen.tsx` | welcome H1 + new tagline | 3 |
| `src/renderer/src/index.css` | token comment + `.welcome-tagline` style | 3 |
| `src/main/index.ts` | window title (**cross-zone**) | 4 |
| `src/renderer/src/canvas/AppChrome.tsx` | project-name fallback (**cross-zone**) | 4 |
| `CLAUDE.md`, `README.md`, `docs/**` | docs full rename + 1 breadcrumb | 5 |
| `design-reference/**` | product-name strings + file rename | 6 |
| memory `rebrand-expanse` + `ACTIVE-WORK.md` | final bookkeeping | 7 |

Run all commands from the worktree root `Z:\canvas-ade-rebrand-expanse`.

---

### Task 1: Build & packaging identifiers

**Files:**
- Modify: `electron-builder.yml:1-2`
- Modify: `package.json:2`

- [ ] **Step 1: Grep gate (red) — confirm old IDs present**

Run: `git grep -n "com.canvasade.app\|productName: Canvas ADE\|\"name\": \"canvas-ade\""`
Expected: 3 matches (electron-builder.yml ×2, package.json ×1).

- [ ] **Step 2: Edit `electron-builder.yml`**

Change the first two lines from:

```yaml
appId: com.canvasade.app
productName: Canvas ADE
```

to:

```yaml
appId: com.expanse.app
productName: Expanse
```

Leave `artifactName: ${productName}-${version}-${arch}.${ext}` untouched — it now resolves to `Expanse-<version>-<arch>`.

- [ ] **Step 3: Edit `package.json:2`**

Change:

```json
  "name": "canvas-ade",
```

to:

```json
  "name": "expanse",
```

- [ ] **Step 4: Grep gate (green)**

Run: `git grep -n "canvasade\|productName: Canvas ADE\|\"name\": \"canvas-ade\""`
Expected: no matches.

- [ ] **Step 5: Sanity — install metadata still parses**

Run: `pnpm typecheck`
Expected: PASS (no code touched; confirms nothing keyed off the package name breaks).

- [ ] **Step 6: Commit**

```bash
git add electron-builder.yml package.json
git commit -m "chore(rebrand): appId, productName, package name -> Expanse"
```

---

### Task 2: Config & CI identifiers

**Files:**
- Modify: `electron.vite.config.ts:33`
- Modify: `src/renderer/index.html:7`
- Modify: `.github/workflows/build.yml:94`

- [ ] **Step 1: Grep gate (red)**

Run: `git grep -n "canvas-ade"`
Expected: matches in `electron.vite.config.ts:33`, `src/renderer/index.html:7`, `.github/workflows/build.yml:94`, `src/renderer/src/canvas/AppChrome.tsx:106` (AppChrome is handled in Task 4 — leave it).

- [ ] **Step 2: Rename the Vite plugin in `electron.vite.config.ts:33`**

Change:

```ts
    name: 'canvas-ade-csp-meta',
```

to:

```ts
    name: 'expanse-csp-meta',
```

- [ ] **Step 3: Update the plugin reference comment in `src/renderer/index.html:7`**

Change the comment text:

```html
      CSP is rewritten at build time by the `canvas-ade-csp-meta` plugin
```

to:

```html
      CSP is rewritten at build time by the `expanse-csp-meta` plugin
```

- [ ] **Step 4: Rename the CI artifact in `.github/workflows/build.yml:94`**

Change:

```yaml
          name: canvas-ade-${{ matrix.os }}
```

to:

```yaml
          name: expanse-${{ matrix.os }}
```

- [ ] **Step 5: Verify the build still wires the plugin**

Run: `pnpm build`
Expected: PASS — bundles main/preload/renderer to `out/` with no plugin-resolution error (confirms the renamed CSP plugin still runs).

- [ ] **Step 6: Commit**

```bash
git add electron.vite.config.ts src/renderer/index.html .github/workflows/build.yml
git commit -m "chore(rebrand): CSP plugin + CI artifact names -> Expanse"
```

---

### Task 3: User-facing strings (safe-zone files)

**Files:**
- Modify: `src/renderer/index.html:18`
- Modify: `src/renderer/src/canvas/WelcomeScreen.tsx:43`
- Modify: `src/renderer/src/index.css:21` (comment) and `~:664` (add `.welcome-tagline`)

- [ ] **Step 1: Grep gate (red)**

Run: `git grep -n "Canvas ADE" -- src/renderer`
Expected: matches at `index.html:18`, `WelcomeScreen.tsx:43`, `index.css:21`.

- [ ] **Step 2: Edit `src/renderer/index.html:18`**

Change `<title>Canvas ADE</title>` to:

```html
    <title>Expanse</title>
```

- [ ] **Step 3: Edit `src/renderer/src/canvas/WelcomeScreen.tsx:43`**

Change the heading and add a tagline line directly beneath it. From:

```tsx
      <h1>Canvas ADE</h1>
```

to:

```tsx
      <h1>Expanse</h1>
      <p className="welcome-tagline">An infinite surface for AI-assisted development.</p>
```

- [ ] **Step 4: Update the token comment in `src/renderer/src/index.css:21`**

Change the comment opening from `Canvas ADE design tokens` to:

```css
/* Expanse design tokens — faithful mirror of DESIGN.md §2-4 (authoritative
```

(Only the first two words change; keep the rest of the comment intact.)

- [ ] **Step 5: Add `.welcome-tagline` styling after the `.welcome h1` rule (~line 664) in `src/renderer/src/index.css`**

Insert:

```css
.welcome-tagline {
  margin: 8px 0 0;
  font-size: var(--fs-label);
  color: var(--text-2);
}
```

- [ ] **Step 6: Grep gate (green) + typecheck + tests**

Run: `git grep -n "Canvas ADE" -- src/renderer`
Expected: no matches.

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; **482 tests pass** (no test asserts the old string — verified during planning).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/index.html src/renderer/src/canvas/WelcomeScreen.tsx src/renderer/src/index.css
git commit -m "feat(rebrand): welcome screen + window title read Expanse + tagline"
```

---

### Task 4: Cross-zone strings (owned by active worktrees)

> These two lines live in files owned by `canvas-ade-wiring` (`src/main/index.ts`) and `canvas-ade-r3-backlog` (`AppChrome.tsx`). Apply them here; expect a 1-line merge conflict each when this branch merges **last**. Both are pure string swaps.

**Files:**
- Modify: `src/main/index.ts:42`
- Modify: `src/renderer/src/canvas/AppChrome.tsx:106`

- [ ] **Step 1: Grep gate (red)**

Run: `git grep -n "title: 'Canvas ADE'\|'canvas-ade'"`
Expected: `src/main/index.ts:42` and `src/renderer/src/canvas/AppChrome.tsx:106`.

- [ ] **Step 2: Edit `src/main/index.ts:42`**

Change:

```ts
    title: 'Canvas ADE',
```

to:

```ts
    title: 'Expanse',
```

- [ ] **Step 3: Edit `src/renderer/src/canvas/AppChrome.tsx:106`**

This is the displayed fallback when a project has no name. Change:

```tsx
          {name ?? 'canvas-ade'}
```

to:

```tsx
          {name ?? 'Expanse'}
```

- [ ] **Step 4: Grep gate (green) + typecheck**

Run: `git grep -n "Canvas ADE\|canvas-ade" -- src/`
Expected: no matches anywhere under `src/`.

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/renderer/src/canvas/AppChrome.tsx
git commit -m "feat(rebrand): window title + chrome fallback -> Expanse (cross-zone)"
```

---

### Task 5: Documentation full rename + breadcrumb

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `docs/README.md`, `docs/roadmap.md`, `docs/reviews/README.md`, `docs/feature-proposals.md`, `docs/archive/build-history.md`, `docs/research/*` (every `.md` containing the old name)

- [ ] **Step 1: List the doc targets (red)**

Run: `git grep -l "Canvas ADE" -- '*.md'`
Expected: the docs set above (plus `design-reference/**`, handled in Task 6 — skip those here).

- [ ] **Step 2: Bulk replace in docs (exclude design-reference)**

For each markdown file under `CLAUDE.md`, `README.md`, and `docs/` (NOT `design-reference/`), replace every occurrence of `Canvas ADE` with `Expanse`. PowerShell one-liner:

```powershell
Get-ChildItem -Path CLAUDE.md,README.md,docs -Recurse -Filter *.md |
  ForEach-Object {
    (Get-Content $_.FullName -Raw).Replace('Canvas ADE','Expanse') |
      Set-Content $_.FullName -NoNewline
  }
```

(If `README.md` does not exist at root, omit it from the `-Path` list.)

- [ ] **Step 3: Add the single breadcrumb to `CLAUDE.md`**

In `CLAUDE.md`, change the top heading line from:

```markdown
# Expanse
```

to:

```markdown
# Expanse  <!-- formerly "Canvas ADE" — renamed 2026-06-02 (see docs/superpowers/specs/2026-06-02-rebrand-expanse-design.md) -->
```

(If the original heading was `# CLAUDE.md — Canvas ADE`, it will now read `# CLAUDE.md — Expanse`; append the same breadcrumb comment.)

- [ ] **Step 4: Grep gate (green) for docs**

Run: `git grep -n "Canvas ADE" -- '*.md' ':!design-reference'`
Expected: exactly **one** match — the breadcrumb comment in `CLAUDE.md`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md docs
git commit -m "docs(rebrand): Canvas ADE -> Expanse across docs (+1 breadcrumb)"
```

---

### Task 6: design-reference bundle rename + file rename

**Files:**
- Modify: `design-reference/**` (all files containing the old name)
- Rename: `design-reference/project/Canvas ADE.html` → `design-reference/project/Expanse.html`

> Design *content* (layout, tokens, visuals) is unchanged — only the product-name string and the one filename.

- [ ] **Step 1: List targets (red)**

Run: `git grep -l "Canvas ADE\|canvas-ade" -- design-reference`
Expected: `README.md`, `chats/chat1.md`, `project/Canvas ADE.html`, `project/DESIGN.md`, `project/Frames Overview.html`, `project/icons.jsx`, `project/app.jsx`.

- [ ] **Step 2: Bulk replace strings in design-reference**

```powershell
Get-ChildItem -Path design-reference -Recurse -File |
  Where-Object { $_.Extension -in '.md','.html','.jsx' } |
  ForEach-Object {
    $c = Get-Content $_.FullName -Raw
    $c = $c.Replace('Canvas ADE','Expanse').Replace('canvas-ade','expanse')
    Set-Content $_.FullName $c -NoNewline
  }
```

- [ ] **Step 3: Rename the prototype HTML file (git-tracked move)**

```bash
git mv "design-reference/project/Canvas ADE.html" "design-reference/project/Expanse.html"
```

- [ ] **Step 4: Fix any internal references to the renamed file**

Run: `git grep -n "Canvas ADE.html"`
For each hit, replace `Canvas ADE.html` with `Expanse.html`. (Likely in `design-reference/README.md` and/or `DESIGN.md`.)

- [ ] **Step 5: Grep gate (green)**

Run: `git grep -n "Canvas ADE\|canvas-ade" -- design-reference`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add design-reference
git commit -m "docs(rebrand): rename design-reference bundle Canvas ADE -> Expanse"
```

---

### Task 7: Final verification gate + bookkeeping

**Files:**
- Modify: memory `C:\Users\De Asis PC\.claude\projects\Z--Canvas-ADE\memory\rebrand-expanse.md`
- Modify: `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (shared board — update this worktree's row)

- [ ] **Step 1: Whole-repo grep gate (green)**

Run: `git grep -n "Canvas ADE\|canvas-ade\|canvasade"`
Expected: exactly **one** match — the `CLAUDE.md` breadcrumb. Nothing else.

- [ ] **Step 2: Full local gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: typecheck clean · 482 tests pass · build succeeds.

- [ ] **Step 3: Installer-name spot check (not a full signed build)**

Run: `pnpm pack:dir`
Expected: `electron-builder --dir` produces output under `release/` named with `Expanse` (e.g. `release/win-unpacked/Expanse.exe`). Confirm the `Expanse` prefix; do not run a full signed `build:win`.

- [ ] **Step 4: Board smoke (renders the renamed welcome + title)**

Run: `pnpm build`, then in PowerShell: `$env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_DONE` with the same pass rate as baseline (22/25; the 3 browser-trio failures are the known `WebContentsView` env flake, not a regression — see memory `e2e-browser-trio-flake`). Re-run once if the trio flakes.

- [ ] **Step 5: Update memory `rebrand-expanse.md`**

Edit the memory body so "scope so far" reads: code + app strings + build IDs + package name + all docs + design-reference are renamed; **folder, worktree dirs, and git remote remain deferred**.

- [ ] **Step 6: Update the coordination board row**

In `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md`, set this worktree's row Status to `done` and Notes to "rebrand complete; awaiting merge-last after in-flight worktrees; 2 cross-zone 1-liners (index.ts, AppChrome.tsx) to resolve at merge."

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(rebrand): final verification + bookkeeping"
```

---

## Merge (separate step, after in-flight worktrees land)

> Not a task in this plan's execution — run from `Z:\Canvas ADE` (main, integration-only) once `canvas-ade-wiring`, `r3-backlog`, `whiteboard-w1`, `fullview-reset`, and the MCP branches have merged.

1. `git checkout main && git pull`
2. `git merge chore/rebrand-expanse`
3. Resolve the 2 expected 1-line conflicts (`src/main/index.ts` title, `AppChrome.tsx` fallback) — keep the Expanse value.
4. Re-run the full gate + e2e (memory `e2e-before-handoff`).
5. Tear down the worktree via `.claude/tools/remove-worktree.ps1`.

---

## Self-review (planner)

- **Spec coverage:** Identity §2 → Tasks 1,3,4. Tier-1 strings → Tasks 3,4. Tier-2 build/config → Tasks 1,2. Tier-3 docs → Tasks 5,6 (incl. design-reference + file rename + breadcrumb). Out-of-scope (folder/worktrees/remote/partition) → untouched. Verification §5 → Task 7. Risks §6 → cross-zone isolated in Task 4, appId in Task 1, package-name sanity in Task 1 Step 5. ✅ no gaps.
- **Placeholder scan:** every code/string step shows exact before/after; commands have expected output. ✅
- **Consistency:** `expanse-csp-meta` (Task 2) referenced consistently in config + html comment; `.welcome-tagline` defined in CSS (Task 3 Step 5) and used in TSX (Task 3 Step 3); grep gates use the same literals throughout. ✅
