# MCP R1 — Publish the package + land M1–M4 on `main` — KICKOFF DOC

**Date:** 2026-06-04 · **Branch:** `feat/mcp-integration` (app) · **Pkg:** `@ch923dev/canvas-ade-mcp`
**Type:** release/integration gate (NOT a new milestone) · **Owner action required:** the user merges the PR.

> This is the **runbook**. The paired paste-to-start prompt is
> `2026-06-04-mcp-r1-publish-pin-next-session.md`.

---

## Goal

Land the already-built **M0–M4** (Observation → Spatial connectors → Lifecycle → Dispatch) on app
`main`. The code is feature-complete and fully green on `feat/mcp-integration`; the ONLY thing stopping
it from merging is **R1 — the version pin**. Resolve R1 by **publishing the package at the version the
app code needs**, bumping the app pin, and opening a PR that the **user merges**.

## Where things stand (verified 2026-06-04)

- **App `feat/mcp-integration` (pushed `bb73a9f`)** — M0–M4 complete; `origin/main` merged in (T0–T5
  testing overhaul); test migration done. Gate green: **852 unit/integration · Windows e2e 21 · Linux
  Docker e2e 21 · `CANVAS_SMOKE=mcp` full pass**. Worktree `Z:\canvas-ade-mcp-int`.
- **Pkg `Z:\canvas-ade-mcp`** — local **0.8.0**, **UNPUBLISHED**. Published tags: `v0.1.0`, `v0.2.0`,
  `v0.2.4`. Held chain on `feat/agent-to-agent`: `0.6.0` (T4.4) → `0.7.0` (T4.5 interrupt) → `0.8.0`
  (T4.6 relay_prompt). ⚠️ working tree is **dirty** (`docs/research/mcp-swarm-research.md` modified +
  `mcp-client-connection-matrix.md` untracked) — clean before tagging.
- **R1 (the blocker):** app pins `@ch923dev/canvas-ade-mcp` at `^0.2.4`; the committed lock resolves the
  **registry** `0.2.4` (portable — `build(e2e) bb73a9f`). But the app code uses M3/M4 APIs (`BoardOutput`/
  `BoardResult`/`MemoryDoc` + the fat `Orchestrator` interface) that exist only at ≥0.5.0. So:
  - Local dev typechecks because `pnpm mcp:link` overlays the 0.8.0 sibling source.
  - **Docker/CI build + e2e pass** because electron-vite uses esbuild (strips types — no typecheck).
  - **Actions `check` typecheck is RED** against the registry `0.2.4` → the merge-to-main blocker.
- **R2 (Host-header DNS-rebind):** already FIXED in the pkg (≥0.5.0). Not a blocker.

## The plan — two repos, one PR (user-merged)

### Phase A — publish the pkg (upstream; clears R1 at the source)

Work in `Z:\canvas-ade-mcp`.

1. **Clean the tree** — commit or stash the dirty research files (they are docs, not code):
   `git add docs/research && git commit -m "docs(research): swarm + client-connection matrix"`
   (or `git stash`). The tree MUST be clean before tagging.
2. **Gate the pkg** — `pnpm test` (contract) · `pnpm test:live` (real loopback) · `pnpm build`. All green.
3. **FF-merge the held chain into pkg `main`** — the release branch is `main`; the held tip is
   `feat/agent-to-agent` (0.8.0). `git switch main && git merge --ff-only feat/agent-to-agent`.
   (If not FF-able, rebase the chain onto `main` first — do NOT force-merge.)
4. **Tag + push to publish** — `git tag v0.8.0 && git push origin main v0.8.0`. The
   `.github/workflows/publish.yml` (`on: tags ['v*']`) builds/tests and publishes to GitHub Packages
   with the repo's `GITHUB_TOKEN`. **One tag publishes the cumulative version.**
   - **Publish is user-gated** — confirm with the user before pushing the tag (per memory
     `mcp-publish-gating`). The user has green-lit this gate; still surface the exact tag before pushing.
   - Watch the Actions run → green = `0.8.0` live on GitHub Packages.

### Phase B — bump the app pin + relock (clears R1 in the app; makes CI green)

Work in `Z:\canvas-ade-mcp-int` on `feat/mcp-integration`.

1. **Drop the dev link** so the registry resolves the real published pkg:
   `cmd /c "rmdir node_modules\@ch923dev\canvas-ade-mcp"`.
2. **Bump the pin** in `package.json`: `"@ch923dev/canvas-ade-mcp": "^0.2.4"` → `"^0.8.0"`.
3. **Install from the registry** (token needed — it is in the user's env / `gh auth token`):
   `pnpm install`. The lock now resolves `@ch923dev@0.8.0` from GitHub Packages — a **real dir with the
   M4 types**. The `pnpm mcp:link` overlay is **no longer required** (registry == the version the code
   needs); only re-link if you are actively editing the pkg for M5+.
4. **Re-run the full gate** — `pnpm typecheck` (now GREEN against 0.8.0) · `pnpm test` (852) · `pnpm lint`
   · `pnpm format:check`.
5. **Re-run the e2e matrix** — `pnpm test:e2e` (Win) + `pnpm test:e2e:linux` (Docker; needs
   `NODE_AUTH_TOKEN` + `DOCKER_BUILDKIT=1`). Both 21/21. `CANVAS_SMOKE=mcp pnpm start` → full pass.
6. **Commit** — `build(mcp): consume published 0.8.0 — bump pin ^0.2.4→^0.8.0 + relock (R1)`.

### Phase C — open the PR (the user merges)

1. **Push** `feat/mcp-integration`.
2. **Open a PR `feat/mcp-integration` → `main`** via `gh pr create`. Title + body summarize: M0–M4
   landed, the merge of main + test migration, the e2e matrix, R1 resolved (0.8.0 published + pinned).
   Link this kickoff doc + `docs/reviews/` for the open findings.
3. **DO NOT MERGE. DO NOT `--admin`.** The **user merges** the PR. CI `check` (typecheck · lint ·
   format · unit + integration) must be **green** on the PR first (it now will be — R1 resolved).
4. After the user merges: re-run the full gate + e2e matrix on `main` once (CLAUDE.md sequential-merge
   rule), update `docs/roadmap.md` status + the coordination board, and tear down the worktree if done.

## Gates / done-when

- [ ] Pkg `0.8.0` published to GitHub Packages (Actions green).
- [ ] App pin `^0.8.0`; lock = registry `0.8.0` (NO `link:` entry).
- [ ] `pnpm typecheck` GREEN against the registry pkg (R1 cleared).
- [ ] 852 unit/integration · Windows e2e 21 · Linux Docker e2e 21 · `CANVAS_SMOKE=mcp` full.
- [ ] PR `feat/mcp-integration → main` open, CI `check` green, **awaiting the user's merge**.

## Risks / gotchas

- **`excludeLinksFromLockfile: false`** → any `pnpm mcp:link` rewrites the committed lock to
  `link:../canvas-ade-mcp` (dangling symlink → frozen-install ENOENT on CI/Docker). After Phase B the
  link is unnecessary; if you ever re-link, `git checkout -- pnpm-lock.yaml` to keep the registry lock.
- **Package read-access:** app CI installs the private pkg via `NODE_AUTH_TOKEN`/`GITHUB_TOKEN`. The
  `canvas-ade` repo was already granted read access for `v0.2.4`; the grant is package-level so `0.8.0`
  inherits it. If CI install 404s, re-check Package → Settings → Manage Actions access.
- **Publish is user-gated** — never push a `v*` tag without confirming the exact version.
- **Never run feature work in `Z:\Canvas ADE`** (app main dir = integration only; shared-dir collisions
  hit this project twice).

## Security hardening — fold in, or fast-follow?

The round of review flagged items on the dispatch path. None *block* landing M1–M4 (dispatch already
requires a mandatory human confirm), but decide explicitly:

- **High — sanitize the dispatch payload** before `pty.write`: reject embedded `\r`/`\n` + strip C0
  control chars (one approval currently injects N shell commands). **Recommended: fast-follow as the
  first commit after landing, or the first M5 task** — small, isolated, high value.
- **Med — reap re-entrancy guard** (`mcpOrchestrator.ts:228`, `reapIdle` double-close).
- **Med — audit-log hash chain** (tamper-resistance vs the agent shell it dispatches into).

Default recommendation: **land M1–M4 as-is, file the three above as a tracked fast-follow** (they are
hardening, not regressions). If the user prefers, fold the High one into Phase B before the PR.
