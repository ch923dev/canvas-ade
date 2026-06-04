# MCP packaging & serving model

> How the `@ch923dev/canvas-ade-mcp` library gets into the app during **dev** and **release**, and how
> it is **served** at runtime. Decided 2026-06-03 after the publish→reinstall dev loop proved too heavy
> (it forced a node_modules de-junction to consume a new version — see memory `mcp-publish-gating`).

## The reframe: it's a library-in-MAIN, not a hosted service

`createMcpHttpServer(deps)` runs **inside Electron MAIN on loopback** (roadmap-mcp.md §0). There is **no
backend to host**. The shipped desktop app *contains* the library and serves it itself on `127.0.0.1`
to the Terminal-board CLI agents (bearer-token + Origin/Host guarded). So the only real question is
**how the app gets the library code** — and that splits into three layers, of which only the first was
ever a pain:

| Layer | Mechanism | Notes |
|---|---|---|
| **Dev loop** (edit pkg → see it in app) | **`pnpm link` to the sibling repo** | no publish, no reinstall |
| **Release** (shipped installer) | electron-vite **bundles** the dep into the MAIN bundle | end users never touch a registry |
| **Runtime serving** | MAIN hosts loopback HTTP + per-board bearer token | **locked**, unchanged |

## Current state (2026-06-03)

- Package lives in a **separate sibling repo** `Z:\canvas-ade-mcp` (`@ch923dev/canvas-ade-mcp`), with
  its own contract + live tests and a `v*`-tag publish workflow.
- App consumes it as a **published GitHub Packages dep** `^0.2.4` (committed `package.json` + lockfile).
- For **dev**, the app worktree is **`pnpm link`ed** to the sibling so edits flow without publishing.

## Dev workflow — `pnpm link` (no publish)

The app's `node_modules/@ch923dev/canvas-ade-mcp` is a **symlink → the sibling working tree**, so
whatever the sibling has built in `dist/` is what the app runs. `package.json`/lockfile stay on the
**published** `^0.2.4` so **CI is unaffected** (CI has no sibling checkout — that's why a raw `file:`
dep was abandoned, pkg commit `f0aa561`).

```bash
# one-time per worktree (and after any `pnpm install`, which resets the symlink):
pnpm mcp:link            # = pnpm link ../canvas-ade-mcp

# inner loop while developing a pkg change:
#   edit Z:\canvas-ade-mcp/src ...
pnpm mcp:build           # build the sibling dist  (= pnpm --dir ../canvas-ade-mcp build)
pnpm build && CANVAS_SMOKE=mcp pnpm start   # app now runs the edited library

# or in one shot:
pnpm mcp:dev             # mcp:build + mcp:link
```

Rules:
- **Never commit** a `link:../canvas-ade-mcp` entry in `package.json`/`pnpm-lock.yaml` — it breaks CI.
  After `pnpm link` dirties the lockfile, `git checkout pnpm-lock.yaml` (the symlink stays active).
- The sibling repo's branch is whatever you have checked out there — switch it to the pkg task branch
  (e.g. `feat/board-output`) and `pnpm mcp:build` to test that branch's library against the app.
- Releases still go through **publish** (below); `pnpm link` is dev-only.

## Release & publish

- **Bundling:** electron-vite inlines the dep into the MAIN bundle at `pnpm build`, so the installer
  ships the library. The runtime needs **no registry** and no separate process.
- **Publish (versioning / external reuse only):** FF-merge the held pkg branch chain into pkg `main`,
  then `git tag vX.Y.Z && git push origin vX.Y.Z` → `.github/workflows/publish.yml` builds/tests and
  publishes to GitHub Packages with the repo's own `GITHUB_TOKEN`. One tag publishes the cumulative
  version. App CI installs the published dep for a clean, reproducible build.
- So publish is the **release** mechanism, not the **dev** mechanism. (2026-06-03: v0.2.4 = the M0/M1
  chain, published.)

## Roadmap

1. **Now — `pnpm link` dev loop.** ✅ done. Kills the publish→reinstall friction for day-to-day work.
2. **Per release — tag + publish + consume.** Bump the pkg, `v*` tag → CI publishes; bump the app's
   `^0.2.x` floor + regen lockfile (in a worktree with its own `node_modules`, not a junction).
3. **Verify bundling before the first signed release (Phase 5).** Confirm electron-vite actually inlines
   `@ch923dev/canvas-ade-mcp` into `out/main` (it's a `dependencies` dep, dynamic-`import()`ed) and the
   packaged app has **no runtime registry dependency**. Add a packaged-app smoke if needed.
4. **Optional clean-up — monorepo / pnpm workspace.** Because *every* MCP task spans both repos (they
   always change together), co-locating the package as `packages/canvas-ade-mcp` with `workspace:*`
   would remove the link **and** publish **and** junction friction, and make cross-repo changes atomic
   (one PR). Cost: a one-time git-history/CI merge of the two repos. Defer until the link loop's friction
   justifies it; revisit at an M-boundary.
5. **Deferred — remote / standalone host.** Only if a multi-machine swarm is ever wanted (roadmap-mcp.md
   §Deferred). Then it's a thin standalone Node host wrapping the **same** `createMcpHttpServer` — not
   needed for the single-user desktop app.

## Open questions

- **Workspace vs sibling repos** (item 4): the sibling-repo split keeps the package independently
  publishable/testable; the workspace makes the dev loop trivial. Pick when item-1 friction warrants it.
- **Packaged-app verification** (item 3): is a dedicated packaged smoke (run the built installer with
  `CANVAS_SMOKE=mcp`) worth it, or does the dev smoke suffice? Resolve at Phase 5.
