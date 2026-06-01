# Rebrand: Expanse → Expanse — Design Spec

**Date:** 2026-06-02
**Branch:** `chore/rebrand-expanse` (merges into `main` **last**, after all in-flight worktrees)
**Status:** approved design → ready for implementation plan

---

## 1. Goal

Rename the product from **"Expanse"** to **"Expanse"** across the app, build/packaging
identifiers, internal package name, and all documentation. Marketing teaser assets already use
Expanse (`marketing/teaser/`); this spec covers the application + repo metadata + docs so the brand
is consistent everywhere a user, installer, or contributor sees it.

**Why "Expanse":** "Canvas" collides with Canvas LMS, Canva, and HTML `<canvas>` — generic,
unownable, no SEO/trademark headroom. "ADE" was an obscure acronym. Decided 2026-06-02 (user). See
memory `rebrand-expanse`.

## 2. Identity (locked)

| Attribute | Value |
|---|---|
| Product name | **Expanse** (single word, capital E) |
| Tagline | *An infinite surface for AI-assisted development.* |
| appId (reverse-DNS) | `com.expanse.app` (was `com.canvasade.app`) |
| Internal package name | `expanse` (was `canvas-ade`) |
| Accent / glyph | **unchanged** — blue `#4f8cff`, nested-frames glyph (name-agnostic) |

## 3. Scope

### In scope
- **User-facing app strings** — window title, HTML `<title>`, welcome-screen H1 + new tagline.
- **Build/packaging IDs** — `productName`, `appId`, installer artifact name (auto-follows
  `productName`), `package.json` `name`, and every `canvas-ade` identifier in build/CI/config that is
  not a filesystem path or git remote.
- **All documentation** — full text rename Expanse → Expanse across `CLAUDE.md`, `README`,
  `docs/**` (including `docs/archive/` history and `docs/research/`), and the `design-reference/`
  bundle (including renaming the file `design-reference/project/Expanse.html` → `Expanse.html` and
  its internal references). Design *content* (layout, tokens, prototype visuals) is unchanged — only
  the product-name string is swapped.
- **One breadcrumb retained:** a single "(formerly Expanse)" note in `CLAUDE.md` for git
  archaeology / newcomer context. This is the only place the old name survives intentionally.

### Out of scope (this pass — deliberate)
- **Repo folder** `Z:\Expanse` — stays. Renaming to a space-free path is *safer* for node-pty long
  term but is a big-bang move that breaks worktree `node_modules` junctions and absolute paths in the
  coordination board. Separate chore, separate session, quiet tree.
- **Worktree directories** `Z:\canvas-ade-*` and the **git remote** — filesystem/remote plumbing, no
  user/brand impact, high disruption. Left as-is.
- **Runtime partition strings** `preview-<id>` — not name-derived; no change needed.

## 4. Change inventory (file-level intent; exact lines resolved during implementation)

### Tier 1 — user-facing strings
| File | Change | Note |
|---|---|---|
| `src/renderer/index.html` | `<title>Expanse` → `Expanse` | safe zone |
| `src/renderer/src/canvas/WelcomeScreen.tsx` | `<h1>` → `Expanse`; add tagline subtitle | safe zone |
| `src/main/index.ts` (~L42) | window `title` → `Expanse` | ⚠ **cross-zone**: owned by `canvas-ade-wiring`. 1-line change, resolve at merge. |

### Tier 2 — build / packaging / config identifiers
| File | Change | Note |
|---|---|---|
| `electron-builder.yml` | `productName: Expanse`, `appId: com.expanse.app` | installer artifact name auto-updates to `Expanse-<ver>-<arch>` |
| `package.json` | `name: canvas-ade` → `expanse` | internal; verify nothing imports the name string |
| `electron.vite.config.ts` | swap `canvas-ade` refs (out dir / build ids) if present | confirm no path breakage |
| `.github/workflows/build.yml` | swap `canvas-ade` refs (artifact/job names) | CI only |
| `src/renderer/src/canvas/AppChrome.tsx` | swap `canvas-ade` ref (class/data hook) | ⚠ **cross-zone**: owned by `r3-backlog`. 1-line, resolve at merge. |
| `src/renderer/src/index.css` (~L21) | comment header "Expanse design tokens" | cosmetic |

### Tier 3 — documentation (full rename)
| Target | Change |
|---|---|
| `CLAUDE.md` | title + prose → Expanse; keep ONE "(formerly Expanse)" breadcrumb |
| `README.md`, `docs/README.md` | product name → Expanse |
| `docs/roadmap.md`, `docs/reviews/README.md`, `docs/feature-proposals.md` | product name → Expanse |
| `docs/archive/build-history.md`, `docs/research/*` | product name → Expanse (history rewrite, per decision) |
| `design-reference/**` | product-name strings → Expanse; rename `project/Expanse.html` → `Expanse.html` + fix internal refs. Design content untouched. |

## 5. Verification (definition of done)

1. `pnpm typecheck` — clean.
2. `pnpm test` — green (expected 482+; no functional code touched).
3. `pnpm build` — succeeds.
4. `pnpm pack:dir` — spot-check the produced installer/dir name is `Expanse-*` (not a full signed build).
5. Grep gate: **zero** "Expanse" / "canvas-ade" in shipping surfaces (src/**, electron-builder.yml,
   package.json, index.html). Only the single CLAUDE.md breadcrumb may remain.
6. e2e harness (`CANVAS_SMOKE=e2e`) — same pass rate as baseline (known browser-trio env flake aside).
7. Manual: launch app → window title, taskbar, and welcome screen all read **Expanse**.

## 6. Risks & mitigations

- **appId change** (`com.canvasade.app` → `com.expanse.app`): changes the OS app identity + userData
  dir + future update-feed channel. **Safe now** — pre-release, no installed users, no electron-updater
  feed wired yet (that's Phase 5). Doing it before release avoids a painful post-release migration.
- **Cross-zone conflicts** (`src/main/index.ts`, `AppChrome.tsx`): two 1-line string edits owned by
  active worktrees. Mitigated by merge-last ordering; note both in `ACTIVE-WORK.md` now.
- **Worktree cap** (~4 live; currently 5 + this one): this worktree is doc-only until the in-flight
  branches teardown; execution runs on a quieter tree.
- **package `name` rename**: low risk, but confirm no tooling/script keys off the literal `canvas-ade`
  package name (CI cache keys, out-dir paths). Grep verifies.
- **History rewrite in archive docs**: intentional per decision; the CLAUDE.md breadcrumb preserves
  discoverability of the former name.

## 7. Sequencing

1. Land Tier 2 + Tier 3 + Tier 1 (safe files) on `chore/rebrand-expanse`.
2. Apply the two cross-zone 1-liners; expect trivial merge conflicts.
3. Wait for the 5 in-flight worktrees to merge into `main` sequentially.
4. Merge `chore/rebrand-expanse` **last**; re-run full gate + e2e after merge.
5. Update memory `rebrand-expanse`: scope now includes code + package + docs (folder/remote still
   deferred).
