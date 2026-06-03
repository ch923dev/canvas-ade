# MCP R1 — Publish + land M1–M4 on `main` — next-session kickoff prompt

You are continuing the Canvas ADE × MCP integration. **M0–M4 (Observation · Spatial connectors ·
Lifecycle · Dispatch) are COMPLETE** on `feat/mcp-integration`, already merged with current `main`
(T0–T5 testing overhaul), test-migrated, and fully green (852 unit/integration · Windows e2e 21 ·
Linux Docker e2e 21 · `CANVAS_SMOKE=mcp` full). Pushed at `bb73a9f`.

**This session is a RELEASE/INTEGRATION GATE, not a new milestone.** Resolve **R1 (the version pin)** so
M1–M4 can land on app `main`: publish the package at the version the code needs, bump the app pin, and
**open a PR that the USER merges**.

## 🚦 HARD RULES

- **DO NOT MERGE the PR. DO NOT use `--admin`.** Open it; the **user merges it**. CI `check` must be
  green on the PR first.
- **Publish is user-gated** — confirm the exact `v*` tag with the user before pushing it.
- **Never commit a `link:` lockfile entry.** `excludeLinksFromLockfile:false` means `pnpm mcp:link`
  rewrites the lock to `link:../canvas-ade-mcp` (→ frozen-install ENOENT on CI/Docker). After the pin
  bump the link is unnecessary; if you re-link, `git checkout -- pnpm-lock.yaml`.
- **Never run feature work in `Z:\Canvas ADE`** (app main dir = integration only).

## REPOS / RUNTIME

- **APP (work here):** `Z:\canvas-ade-mcp-int` — branch `feat/mcp-integration`. Its `node_modules` is its
  own (de-junctioned); normal pnpm. Token for the private pkg: `gh auth token` (the user's env has
  `NODE_AUTH_TOKEN`; the Bash subprocess does NOT inherit it — pass it explicitly).
- **PKG (work here):** `Z:\canvas-ade-mcp` — `@ch923dev/canvas-ade-mcp`. Local **0.8.0 UNPUBLISHED**;
  last published tag `v0.2.4`. Held chain on `feat/agent-to-agent` (0.6.0→0.7.0→0.8.0). Tree is dirty
  (research docs) — clean before tagging.

## READ FIRST

1. `docs/superpowers/handoffs/2026-06-04-mcp-r1-publish-pin-gate-kickoff.md` — the full runbook (Phases
   A/B/C, gates, risks, the security fast-follow decision). **This prompt is the short form of it.**
2. `Z:\Canvas ADE\CLAUDE.md` — durable contract (sequential-merge rule; security model).
3. `docs/roadmap-mcp-packaging.md` § Release & publish — the `pnpm link` dev loop vs the `v*`-tag publish.
4. `docs/reviews/` (newest) — the open dispatch-path findings (the security fast-follow).

## STEPS

**A — publish the pkg (`Z:\canvas-ade-mcp`):**
1. Clean the tree (commit/stash the research docs).
2. Gate: `pnpm test` · `pnpm test:live` · `pnpm build` — all green.
3. FF-merge the held tip into `main`: `git switch main && git merge --ff-only feat/agent-to-agent`.
4. **Confirm the tag with the user**, then `git tag v0.8.0 && git push origin main v0.8.0` →
   `publish.yml` publishes to GitHub Packages. Watch Actions → green.

**B — bump the app pin + relock (`Z:\canvas-ade-mcp-int`, `feat/mcp-integration`):**
1. Drop the dev link: `cmd /c "rmdir node_modules\@ch923dev\canvas-ade-mcp"`.
2. `package.json`: `"@ch923dev/canvas-ade-mcp": "^0.2.4"` → `"^0.8.0"`.
3. `NODE_AUTH_TOKEN="$(gh auth token)" pnpm install` → lock resolves registry `0.8.0` (real dir, M4 types).
4. Full gate: `pnpm typecheck` (now GREEN — R1 cleared) · `pnpm test` (852) · `pnpm lint` · `pnpm format:check`.
5. e2e matrix: `pnpm test:e2e` + (`NODE_AUTH_TOKEN`/`DOCKER_BUILDKIT=1`) `pnpm test:e2e:linux` → 21/21;
   `CANVAS_SMOKE=mcp pnpm start` → full pass.
6. Commit: `build(mcp): consume published 0.8.0 — bump pin ^0.2.4→^0.8.0 + relock (R1)`. Push.

**C — open the PR (USER merges):**
1. `gh pr create` `feat/mcp-integration` → `main`. Body: M0–M4 landed · merged main + test migration ·
   e2e matrix · R1 resolved. Link the kickoff doc + `docs/reviews/`.
2. Verify CI `check` green. **Stop. Hand back to the user to merge.**
3. (Post-merge, user's turn / next session) re-run gate + e2e on `main`; update `docs/roadmap.md`.

## SECURITY FAST-FOLLOW (decide with the user)

Default: **land M1–M4 as-is** (dispatch already requires human confirm) and file these as a tracked
fast-follow — **High: sanitize dispatch payload** (reject `\r`/`\n` + strip C0 before `pty.write`);
Med: reap re-entrancy guard; Med: audit-log hash chain. If the user wants, fold the High one into Phase B.

## DONE WHEN

Pkg `0.8.0` published · app pin `^0.8.0` + registry lock (no `link:`) · typecheck GREEN · 852 +
e2e 21/21 + mcpSmoke full · **PR open, CI green, awaiting the user's merge.**

## NEXT (after this gate)

**M5 — Barriers + event-driven attention** (`docs/roadmap-mcp.md` §M5): SSE `canvas://attention`
subscribe · `wait_for_idle`/`wait_for_all` (replaces the interim 5-min busy-poll in `handoffPrompt`) ·
on-canvas "needs-you" attention queue (SB-1).
