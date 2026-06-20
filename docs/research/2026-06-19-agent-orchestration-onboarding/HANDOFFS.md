# Agent Orchestration Onboarding — handoff prompts

Three parallel, file-disjoint worktrees feeding the umbrella branch `feat/agent-orchestration`.
**Order:** seam-stub first (whoever opens the umbrella branch), then WT-authority ∥ WT-onboarding ∥ WT-provision. P4 lands in WT-authority after P0; P5 is the integration owner's closing task.

Common to all three: read `CLAUDE.md`, `docs/research/2026-06-19-agent-orchestration-onboarding/{REPORT,PLAN}.md`, the signed-off mock `.claude/mocks/agent-orchestration-modal-mock.png`, and the seam in PLAN §3. Create the worktree via `.claude/tools/new-worktree.ps1`; declare your zone in `.claude/coordination/ACTIVE-WORK.md`; rebase on the umbrella tip before pushing. Gate each phase: `pnpm typecheck && pnpm lint && pnpm format:check` + a manual dev check (`$env:CANVAS_DEV_TITLE='PR#… <phase>'; pnpm dev`). **Never log tokens; write provisioner files `0o600`; never weaken sandbox/isolation; keep the per-action ConfirmModal gate.** Design artifact is already signed off (the mock) — no new UI mock needed for the modals.

---

## Handoff 0 (do this once) — open the umbrella + stub the seam

> Open the integration branch `feat/agent-orchestration` off `main`. Add the **seam stubs** from PLAN §3 so all three worktrees compile immediately: a new `src/main/orchestration/seam.ts` (or co-located) exporting typed stubs for `mintTerminalToken`, `canRelay`, `isOrchestrationEnabled`/`setOrchestrationEnabled`, and the `CliProvisioner` interface (throwing `not-implemented` bodies where needed, but real signatures + the pure `canRelay` body). Commit. Push the umbrella branch. Signal it on `ACTIVE-WORK.md` as the rebase target. Do NOT implement phases here.

---

## Handoff A — WT-authority (P0 → P4)

> **Role:** implement the authority layer + connector-aware live routing for the Agent Orchestration umbrella. Branch off `feat/agent-orchestration` as `feat/agent-orch-authority` via `new-worktree.ps1`.
>
> **Read:** PLAN §2 (authority model), §3 (seam), §6 (security); `mcp-not-wired-to-terminals.md`; current `src/main/mcp.ts`, `src/main/mcpOrchestrator.ts` (relay path ~803-876), and the sibling package `Z:\canvas-ade-mcp` `src/factory.ts`.
>
> **Zone (own exclusively):** app `src/main/mcp.ts`, `src/main/mcpOrchestrator.ts`; pkg `Z:\canvas-ade-mcp` (`factory.ts` tier/tool registration + a version bump + publish via the OIDC trusted-publish flow — see `mcp-publish-gating.md`).
>
> **P0 — authority:**
> 1. Add tier `'connected'`. `mintTerminalToken(boardId)` mints a token bound to that boardId at tier `connected`.
> 2. In the pkg factory, register `relay_prompt`, `spawn`/`configure`, and `add_planning_elements` for the `connected` tier (today they're orchestrator/`'app'`-only or flag-gated).
> 3. Relax the single-`'app'` relay binding. Relay authorization for a `connected` token = `canRelay(src,dst,connectors)` (pure, reads the persisted connector graph) **AND** the existing TOCTOU pre-write re-check **AND** the per-action ConfirmModal. Spawn/configure/plan-write for a `connected` token = ConfirmModal only (no cable).
> 4. `planningWriteEnabled()` also returns true when orchestration consent is granted (consume `isOrchestrationEnabled` from the seam) — replacing the dev-only flag in prod. Still ConfirmModal-gated per write.
> 5. Leave the in-process Command Board `'app'` orchestrator path untouched (verify #182 still works).
>
> **P4 — connector-aware live routing (after P0):** make a real `connected` terminal's `relay_prompt` route+land in the cabled target end-to-end (same files — no separate worktree). Add the umbrella e2e in `e2e/mcp.e2e.ts` building on `:603-669`: consent on → A relays along an `orchestration` cable A→B → sentinel in B's xterm; reverse rejected; non-cabled relay rejected.
>
> **Gate:** unit + the new e2e (Windows leg locally; full matrix at pre-merge). Bump + publish the pkg, then pin the app to the new version. Reply-inline to any bot review comments. Merge into `feat/agent-orchestration` when green.

---

## Handoff B — WT-onboarding (P1 → P2)

> **Role:** implement the orchestration **consent state + Settings + Enable modal**. Branch off `feat/agent-orchestration` as `feat/agent-orch-onboarding` via `new-worktree.ps1`.
>
> **Read:** PLAN §3 (seam), §4 (P1/P2 rows, the AppChrome coordination note); the mock (Enable modal = Step 1 + the Settings row in annotation E); the recap-consent template (`terminal-recap-feature.md`, `RecapConsentModal`, the `userData/recap-consent.json` per-project pattern).
>
> **Zone (own exclusively):** new `src/main/orchestrationConsent.ts` (per-project consent store in `userData`, mirroring recap-consent) + its IPC; Zustand state for `orchestrationEnabled`; `SettingsModal` (add the toggle + a "Sync" button row); `AppChrome` (mount an `<OrchestrationModals/>` host — also mounts WT-provision's exported `OrchestrationSyncModal`); new `OrchestrationConsentModal.tsx`.
>
> **P1:** implement `isOrchestrationEnabled`/`setOrchestrationEnabled` (replace the seam stub) + IPC + store + Settings toggle. Guard against showing UI when no project is open (the recap-modal bug class).
> 2. **P2:** build the Enable modal exactly per the mock (tokens, `Modal` primitive, accent-wash security callout, all-4-CLI "works with" list, capability bullets, footer Not now / Enable orchestration). First-init trigger: fires once per project with undecided consent, on project open. Enable → sets consent → opens the Sync modal (WT-provision's component) next; Not now → dismiss, re-openable from Settings.
>
> **Coordination:** you own `AppChrome`; expose where `OrchestrationSyncModal` mounts so WT-provision plugs in. Don't implement provisioners or the Sync modal body.
>
> **Gate:** typecheck/lint/format + manual dev check (confirm the modal renders over a dimmed canvas, matches the mock, fires once). Reply-inline to bot comments. Merge into `feat/agent-orchestration` when green.

---

## Handoff C — WT-provision (P3)

> **Role:** implement the **per-CLI provisioners + the Sync modal + spawn-time auto-sync**. Branch off `feat/agent-orchestration` as `feat/agent-orch-provision` via `new-worktree.ps1`.
>
> **Read:** PLAN §3 (seam, esp. `CliProvisioner` + the pty.ts hook), §7 (the Codex transport caveat); the mock (Sync modal = Step 2: endpoint row, per-CLI target rows with detect badges, Sync now); pkg `Z:\canvas-ade-mcp` `src/config/mcpJson.ts` (`writeMcpJson`) + `recapEnvProvider` in `src/main/pty.ts` (the spawn-time seam to mirror).
>
> **Zone (own exclusively):** new `src/main/cliProvisioners/` (`claude.ts`, `codex.ts`, `gemini.ts`, `opencode.ts`, an index + the `detect()` logic); `src/main/pty.ts` (add the spawn-time auto-sync hook before `launchCommand` write); new `src/renderer/.../OrchestrationSyncModal.tsx` (exported for WT-onboarding to mount).
>
> **Tasks:**
> 1. Implement each `CliProvisioner` (PLAN §3). claude → reuse pkg `writeMcpJson` + `.claude/settings.local.json` `enabledMcpjsonServers:["canvas-ade"]`; gemini → `~/.gemini/settings.json` `mcpServers` (http url); opencode → `opencode.json` remote MCP; codex → `~/.codex/config.toml` **— verify transport first; if remote-http isn't supported, stub with a clear "needs shim" status and ship the other three.** All writes `0o600`; implement `unsync`. `detect()` from config dir presence.
> 2. **Spawn-time hook** in `pty.ts`: if `isOrchestrationEnabled(dir)` (from seam), call the matching provisioner's `sync(dir, mintTerminalToken(boardId))` before writing the launch command. This is the "auto-fires on terminal start" behavior — **the thing that fixes the stale-endpoint-after-restart failure.**
> 3. **Sync modal** per the mock: endpoint row (host:port + masked token + "rotates on restart"), one row per CLI (checkbox + config path + detected/not-installed badge), a "This project → .mcp.json" row, Sync now / Later. Sync now → run enabled provisioners; show per-row result. Re-openable from the Settings "Sync" button (WT-onboarding wires that).
>
> **Coordination:** export `OrchestrationSyncModal` for WT-onboarding's `AppChrome` host. Consume the seam's `mintTerminalToken` (real impl arrives from WT-authority; code against the stub until then).
>
> **Gate:** typecheck/lint/format + manual dev check (Enable → Sync modal lists your installed CLIs with correct detect badges; Sync writes the configs; restart re-syncs on next terminal spawn). **Never log the token in the modal or logs** (mask it). Reply-inline to bot comments. Merge into `feat/agent-orchestration` when green.
