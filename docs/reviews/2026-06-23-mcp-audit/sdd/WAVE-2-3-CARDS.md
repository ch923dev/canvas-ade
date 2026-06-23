# Wave 2 & 3 — task cards

Lighter than the Wave-1 specs (which are full `SPEC-*.md` files). Each card carries the per-task
template (CLAUDE.md / `roadmap-mcp.md`). **Expand a card into a full `specs/SPEC-W?-*.md` — with a
signed-off design artifact for any UI — before implementing it.** Sequencing + collisions are in
[`README.md`](README.md) §5.

Legend: 🔒 security-critical · 🧪 two-layer test (contract + live `@mcp`) · 🎨 needs a design
artifact first · ⛓ depends-on.

---

## Wave 2 — substrate + first user-visible value

### W2-A — `canvas-ade` operating-manual primer  (S2 · closes F25)
- **Problem.** A connected agent has the tool surface but **no manual** — it re-discovers the canvas
  grammar every session, and 3 of 4 CLIs don't read Claude's `SKILL.md`. `APP_TOOLS` (`appModel.ts`)
  has no compile-time sync guard with the live package tool list (F25).
- **Build.** A primer **generated from `appModel.ts`** (board types · tool catalog · tier model · the
  3 safety rules · the list of available prompt-playbooks). The provisioner writes it per CLI:
  `.claude/skills/canvas-ade/SKILL.md` (Claude) + an `AGENTS.md` section (Codex/Gemini/OpenCode).
- **Zones.** `resources/agent-skills/` (generated template) + `src/main/cliProvisioners/*` (write
  path) + a unit test asserting `primer.tools === APP_TOOLS` (closes F25).
- 🧪 **e2e/manual.** Provision a board → assert the primer file lands per CLI with the live tool list;
  a real Claude/Codex agent reads it on connect and can name the board types + safety rules.
- **Effort** M · **Risk** med (writes into user agent-config files — reuse the `0o600`
  merge-not-clobber discipline; never clobber a user's existing `AGENTS.md`).
- ⛓ **C1/C2 wired (W1-G)** so the catalog the primer cites is accurate.

### W2-B — Flagship playbooks: `review-pr` + `fan-out-and-compare`  (S4, S3) 🧪
- **Problem.** With the prompts substrate live (W1-F) but no playbooks, the "skills" value isn't
  realized.
- **Build (package prompts on the W1-F substrate).**
  - **`review-pr`** (S4, effort S): read the diff (`git_diff`), spawn reviewer + tester workers, hand
    each a scoped prompt, `wait_for_all`, collect both verdicts → present a consolidated review **for
    the human**. Documents the `git_diff` orchestrator-tier asymmetry (connected callers fall back to
    shell `git diff` — see REPORT §8 open-q 2).
  - **`fan-out-and-compare`** (S3, effort M): spawn N workers **within the cap**, broadcast the same
    task (one confirm lists all N targets), `wait_for_all`, read each `canvas://board/{id}/result`,
    present a comparison table **for the human to pick**. **Never merges, never auto-acts** (renamed
    from "fan-out-and-merge" — no merge tool exists pre-M7 and auto-merge violates the trifecta rule).
- **Zones.** pkg `src/prompts/{reviewPr,fanOutAndCompare}.ts` + registry; contract tests.
- 🧪 **e2e/manual.** `prompts/get` returns a well-formed playbook; a real orchestrator agent runs it
  end-to-end and the canvas shows the spawned workers + the comparison.
- **Risk** med (composes gated tools — every dispatch still pays `runGatedWrite`; the playbook only
  *plans*, the human confirms each write). ⛓ **W1-F**.

### W2-C — Test-connection after Sync  (H2 · closes F15)
- **Problem.** After "Sync agent CLIs" there's no "did it work?" — silent misconfiguration; the
  loopback port rotates on restart so a stale `.mcp.json` points nowhere.
- **Build.** A new frame-guarded `orchestration:ping` IPC → MAIN invokes `orchestrator_ping` on the
  loopback server and returns reachable/latency or a typed error. **Token never crosses to the
  renderer** (MAIN does the call). Surface a "Test connection" button + result in the Sync modal.
- 🎨 **Artifact.** Inline status row in `OrchestrationSyncModal`:
  ```
  ┌ Sync agent CLIs ─────────────────────────────┐
  │ ✓ claude   synced · .mcp.json written         │
  │ ◦ codex    synced · AGENTS.md updated         │
  │                                               │
  │ [ Test connection ]   ● reachable · 4 ms      │   ← green dot = accent-ok; red = error text
  └───────────────────────────────────────────────┘
  ```
- **Zones.** `src/main/` (new IPC handler), `src/preload/index.ts`, `OrchestrationSyncModal.tsx`.
- **Effort** S · **Risk** low. ⛓ none.

### W2-D — Recipe launcher (human templates)  (S6) 🎨
- **Problem.** Every Command-board dispatch starts blank; `lastWorkerConfig` is ephemeral (resets on
  reload).
- **Build.** Built-in chips above the SubmitWell (Review PR · Implement · Test · Debug · Triage) that
  pre-fill task text + composition + `WorkerConfigDialog`; **user-saveable**; **persisted to
  `canvas.json`** as an **additive** field (ADR 0007 → writer bump only, no floor move).
- 🎨 **Artifact.** SubmitWell header:
  ```
  ┌ Command ─────────────────────────────────────────────┐
  │ [Review PR] [Implement] [Test] [Debug] [Triage]  [+]  │  ← chips; [+] saves current as a recipe
  │ ┌─────────────────────────────────────────────────┐  │
  │ │ Describe the task…                               │  │
  │ └─────────────────────────────────────────────────┘  │
  │ ◻ planning  ◻ browser            [ Dispatch ]         │
  └───────────────────────────────────────────────────────┘
  ```
- **Zones.** `src/renderer/src/lib/commandDispatch.ts`, `SubmitWell.tsx`, `WorkerConfigDialog.tsx`,
  `boardSchema.ts` (additive field + migration). **Renderer + schema only** — gated dispatch unchanged.
- **Effort** M · **Risk** low. ⛓ **W1-D** (build new command/state on the shared types first).

### W2-E — `canvas://connectors` read-only resource  (C4) 🧪
- **Problem.** An agent **cannot enumerate the orchestration cables it may relay along** — it must
  ask the user. This blocks self-verifiable relay/handoff (and is why several relay skills were killed).
- **Build (lockstep pkg+app, §3).** A strictly read-only/loopback resource returning
  `[{id, sourceId, targetId, kind}]` from the canvas connectors. Zero invariant risk (read-only).
  Outranks the killed task-graph for the same package-bump budget.
- **Zones.** pkg `Orchestrator.listConnectors` + resource registration; app `buildOrchestrator`
  binding + a renderer→MAIN mirror of the connectors. Contract + live `@mcp` probe.
- **Effort** S · **Risk** low. ⛓ **W1-D**; feeds the primer's cable-authorization section (W2-A).

### W2-F — ADR 0010: MCP transport security  (F13)
- **Problem.** The Origin+Host+bearer triple is live but **never written up**; ADR 0003 explicitly
  defers it (the T0.2 deliverable).
- **Build.** `docs/decisions/0010-mcp-transport-security.md` — loopback bind, Origin guard, Host
  allowlist (DNS-rebinding mitigation; the Browser-board-previews-malicious-localhost attack vector),
  static per-board bearer (no OAuth discovery), CVE refs (memory `mcp-spec-state-2026-06`). Note the
  F18 residual (Host-absent HTTP/1.0 bypass) as a tracked follow-up.
- **Effort** S · **Risk** low (docs). ⛓ none.

---

## Wave 3 — P1 / P2

### W3-A — `answer_permission` (M8) + attention-state emission  (C5 · re-pairs F11) 🔒🧪
- **Problem.** The sharpest single tool is unbuilt; `SCOPE_ANSWER_PERMISSION` was removed in W1-G
  precisely because the tool didn't exist. `blocked`/`awaiting-review` buckets are defined in
  `boardStatus.ts` but **never emitted** (dead until this lands).
- **Build.**
  - **T8.1 detection** — recognize a worker blocked-on-permission state (PTY-output heuristic,
    **Claude-only first**, document the per-CLI matrix) → emit `blocked` into `canvas://attention`.
  - **T8.2 `answer_permission(id, yes|no)`** (pkg tool + app, **re-add the scope**) — routed through
    `runGatedWrite` with an **unconditional** human-confirm + TOCTOU recheck. **Never** an
    orchestrator auto-answer (by construction — the trifecta's sharpest edge).
- **Zones.** pkg tool + scope re-add; app detection in `pty`/`boardStatus` + the gated write.
- 🧪 Drive a worker to a real permission prompt → surfaces as `blocked` → human confirms → worker
  proceeds; any auto-answer path is impossible. **Effort** M · **Risk** med. ⛓ **W1-G** (scope), M4/M5
  (both shipped).

### W3-B — Attention queue badge + panel (M5-T5.4)  (H3 · F24) 🎨
- **Problem.** The attention feed ships and is **unconsumed** — no glanceable "who needs me".
- **Build.** A chrome badge (count of boards in `failed`/`blocked`/`awaiting-review`) + a jump panel.
  Ships value for `failed` today; richens once W3-A emits `blocked`.
- 🎨 **Artifact.**
  ```
  top chrome:  … [ ⚠ 2 ]   ← badge; click → panel
  panel:  Needs you
          ● board “api worker”   failed        → jump
          ● board “tests”        blocked        → jump
  ```
- **Zones.** renderer (chrome + panel) consuming the existing attention selector. **Effort** M ·
  **Risk** low. ⛓ feed exists; pairs with W3-A.

### W3-C — Cancel queued task  (H4 · F17)
- **Problem.** No way to cancel a *queued* task; only deleting the board removes a waiting one.
- **Build.** A `discardTask` affordance on a `queued` `TaskCard` (frees the cap slot; nothing spawned
  yet → no MAIN call/gate). **Zones.** `commandStore.ts` (`discardTask`) + `TaskCard.tsx`. **Effort**
  S · **Risk** low. ⛓ none.

### W3-D — `get_changed_files` + diff coloring  (C6 · H5 · F16) 🧪🎨
- **Problem.** The diff panel — the **primary result artifact** — renders raw monochrome unified diff
  (unreadable at scale).
- **Build.**
  - **`get_changed_files`** (C6, pkg read-only tool): structured `[{path, +, −, status}]` from the
    existing `gitDiff.ts` + `parseDiffStat` (lift the pure parser to a MAIN-safe util). No M6 dep.
    *Scope to the tool only — defer the redundant `canvas://board/{id}/diff` resource (`git_diff`
    already returns raw text).*
  - **Diff coloring** (H5): a ~15-line pure span helper (+green / −red / `@@` accent), **functional
    color only**, no library; pairs with C6 for per-file grouping.
- 🎨 **Artifact.** `+ added line` in `--ok`/green, `- removed` in red, `@@ hunk @@` in `--text-2`;
  per-file collapsible group header `path  +12 −3`.
- **Zones.** pkg tool + contract/live test; renderer `TaskCard.tsx` + `CommandRecapView.tsx`.
  **Effort** M · **Risk** low. ⛓ none.

### W3-E — `await_settled` event-driven refactor  (C7 · F19)
- **Problem.** `awaitSettled` (`mcpOrchestrator.ts:748`) is the **only remaining busy-poll** (1 s) —
  `handoffPrompt`/`wait_for_all` are already event-driven.
- **Build.** Replace the poll with `subscribeStatus` + an `onResultSettled` signal, output-silence as
  the fallback. **Ship only the refactor** — drop the wire-register half (handoff/wait_for_all cover
  the agent wait case; REPORT §8). **Zones.** `src/main/mcpOrchestrator.ts`. **Effort** S · **Risk**
  low. ⛓ none.

### W3-F — Copy/rebrand + residual hardening  (H7 · F14, F26, F18, F21, F23, F20)
- **F14** make the Sync modal ".mcp.json / always" row conditional/accurate (false for non-Claude).
- **F26** "Canvas ADE" → "Expanse" on the consent/trust surface (consent + sync modals).
- **F18** `hostGuard` should require the Host header (HTTP/1.0 clients bypass) — pkg.
- **F21** `CANVAS_MCP_PLANNING_WRITE` env should be `NODE_ENV`-gated (no consent bypass in prod) — MAIN.
- **F23** prefix memory resources with an untrusted-provenance marker (LLM-generated context) — MAIN.
- **F20** fix the misleading `SYNC_PSEUDO_BOARD` "discarded" comment (token is tracked+rotated — no
  leak, but the comment invites a future regression) — MAIN.
- **Zones.** mixed renderer + MAIN + pkg; batch as one small hardening PR. **Effort** S · **Risk** low.

---

## Deferred — M6 Feature Workspaces (and the M7/M9/M10 it gates)

Not scheduled in this package. M6 (git-worktree-per-board-**zone**) carries the locked safety rules
(opt-in `git init`, reuse-if-exists, **never nest-init**, dirty-on-delete keep+prompt, always
`git worktree remove`). It **gates** M7 (`commit`/`merge`), M9 (best-of-N + merge queue), and M10
(task graph + 2026-07-28 stateless-RC migration). **Action item:** set an M6 start date to resolve the
CLAUDE.md vs `roadmap-mcp.md` ambiguity (REPORT §8). Until then, document that `close_board` does
**not** honor the dirty-worktree keep+prompt contract today.

**Do NOT build** (critics killed — REPORT §8): `judge_outputs`, `canvas://tasks`/`claim_task`
task-graph, `set-up-feature-zone` playbook (a single `spawn_group` call post-W1-G), standalone
Claude-only `.md` skills, the `/canvas-revoke` skill (build the W1-E MAIN fix instead), and the
`await_settled` wire-register half.
