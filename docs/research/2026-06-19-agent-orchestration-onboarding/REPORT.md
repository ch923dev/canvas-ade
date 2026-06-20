# Agent Orchestration Onboarding — discussion & feature report

**Date:** 2026-06-19
**Status:** Research / discussion capture (uncommitted; lives on `main` working tree until a `feat/*` worktree is opened)
**Origin:** Session that started as "review the Command Board," pivoted to connector-aware routing, then to "why doesn't `relay_prompt` work in a real terminal?" — and ended with a **live end-to-end proof** of the fix path.

> This is the consolidated write-up the user asked for: *what we discussed, the potential
> features we surfaced, and how beneficial each is to the app.* Findings are marked **PROVEN**
> (verified live or by test), **ESTABLISHED** (read from code), or **PROPOSED** (design intent).

---

## 1. How we got here (the thread)

1. **Command Board review** — confirmed #182 (Phases A–E + orchestrator dock board) is **shipped and live**, but it is a *one-agent-per-task scripted dispatcher* driven **in-process** (the app's own IPC), not by agents typing in terminals.
2. **Connector-aware routing** — the user wanted relay/orchestration to follow the **visual cables** drawn on the canvas. We confirmed this is buildable **without** the Command Board and with **no schema change**.
3. **The real blocker surfaced** — the user tried `relay_prompt` from a real `claude` in a Terminal board and got *"that tool doesn't exist."* The agent only saw the global MCP servers (context7 / playwright / stripe). That exposed the core gap.
4. **Autonomous-injection hypothesis** — could the app wire the MCP into the agent automatically (like the recap consent flow), agent-agnostically?
5. **Live proof** — we proved the full chain by hand, then let the user drive it: a real `claude` → auto-connected to Expanse's MCP zero-prompt → read `canvas://boards` → called `relay_prompt` → the message **landed in board B through the confirm gate.** ✅
6. **Decision** — keep **recap** and **agent-orchestration** as **separate consents** (this turn). Build an onboarding so users stop misreading the MCP as broken.

---

## 2. What we established (findings)

### 2.1 The MCP is NOT wired to terminal agents — **PROVEN (live, 2026-06-19)**
Despite "MCP M0–M5 shipped," agents running *inside* Terminal boards have **no connection** to Expanse's MCP server. It's a **two-layer** gap:

| Layer | What's missing | Where |
|---|---|---|
| **Injection** | No MCP url/token written for the agent on spawn. PTY spawns with `{...process.env, ...recapEnv}` only. The worker-token minter's consumer ("a later `.mcp.json` slice") was **never built**. | `pty.ts:389`, `mcp.ts:41` |
| **Authority** | `relay_prompt` is **orchestrator-tier, bound to `boardId:'app'`**. A worker token doesn't even register it — only the single in-process 'app' orchestrator can drive cables. | `mcp.ts:99-112`, pkg `factory.ts:91` |

The wire surface itself works (loopback StreamableHTTP `127.0.0.1:<port>/mcp` + bearer) — it had just only ever been driven in-process, via the `CANVAS_E2E` test seams, or a hand-placed `.mcp.json`.

### 2.2 The autonomous fix works — **PROVEN (live)**
- The package already ships `writeMcpJson(dir, port, token)` → a correct `.mcp.json` (`type:'http'` + `Authorization: Bearer`, written `0o600`).
- Claude Code's project-server trust prompt is bypassed by `.claude/settings.local.json` → `enabledMcpjsonServers:["canvas-ade"]`.
- Mirror the **recap-consent pattern**: first-init modal/toggle → spawn-time provider (like `recapEnvProvider`) writes the config → cleanup on disable.
- **Key insight:** for relay, only the **source/orchestrator** terminal needs MCP — the target just receives a PTY write. So the real prerequisite isn't wiring, it's the **authority decision** (grant a terminal orchestrator-tier + relax the single-'app' binding).
- **Agent-agnostic caveat:** `.mcp.json` is Claude-Code-specific. Codex / Gemini / other CLIs use different MCP-config mechanisms → we need a **per-CLI provisioner**, not one file format.

### 2.3 Connector-aware routing is independent & cheap — **ESTABLISHED**
- Connectors `{id, sourceId, targetId, kind:'preview'|'orchestration'}` are already persisted at **doc-level since schema v5**.
- Routing relay along an `orchestration` cable needs **no schema change** and **no Command Board** — the cable graph is already in the document.

### 2.4 Recap vs orchestration — separate concerns, with real MCP overlap — **ESTABLISHED**
- **Recap** = consent-to-**READ** the agent's transcript + LLM-summarize it (privacy/egress grant). Today it's **MCP-free**: a SessionStart hook records `boardId → transcript path`, the app watches the file and summarizes. Works passively, even with a non-cooperating agent.
- **Orchestration** = consent-to-**GRANT** the agent canvas-driving tools (capability grant). Per-action confirm gate; an agent can only relay along cables you draw.
- **Overlap that's already real:** the recap **read side** is already on MCP via `canvas://board/{id}/summary` (M-expose). The **write side** *could* be re-sourced from the agent calling the existing worker-tier `write_result` tool instead of transcript scraping.
- **Decision (this turn): keep them separate.** Moving recap onto MCP would couple it to MCP-being-on + a cooperating agent, and lose the passive, continuous-timeline richness. Documented as considered-and-deferred (§3, Feature E).

---

## 3. Potential features (the deliverable)

Ordered roughly by dependency. Benefit / effort / risk are relative.

### Feature A — **Agent Orchestration Onboarding** (headline)
**What:** A first-run consent modal + a **spawn-time MCP provisioner** that auto-injects the right per-CLI MCP config (and auto-approval) so terminal agents can actually reach Expanse's MCP (`relay_prompt`, board spawn/configure, plan/diagram writes) **with zero manual setup**. Includes a short "what the Expanse MCP is" explainer so users stop reading it as broken.

**How:** Mirror the recap-consent architecture — per-project consent stored in `userData`, a spawn-time provider that writes `.mcp.json` + `settings.local.json` (Claude Code) / equivalent for other CLIs, cleanup on disable. Agent-agnostic via a **per-CLI provisioner** interface.

| | |
|---|---|
| **Benefit** | **Closes the #1 broken-promise gap.** "MCP M0–M5 shipped" but no real agent could reach it. This is what makes orchestration cables work for actual users and kills the "2 setup issues: MCP" confusion the user hit. |
| **Effort** | Medium. The hard parts (token minting, `writeMcpJson`, the wire surface, the recap-pattern template) already exist. |
| **Risk** | Medium — security-sensitive (token handling, never log secrets, never weaken sandbox/isolation). Per-CLI matrix adds surface. |
| **Depends on** | Feature B (authority) for relay specifically; standalone for read-only tools. |

### Feature B — **Authority / tier model for live relay**
**What:** Decide and implement how a *real terminal* (not just the in-process Command Board) gets **orchestrator-tier**, and **relax the single-`'app'` binding** so a terminal agent can drive cables — safely and scoped.

| | |
|---|---|
| **Benefit** | Unlocks **terminal→terminal relay for real users.** Today only the in-process orchestrator can relay; this makes the canvas cables drivable by an agent you're actually talking to. |
| **Effort** | Medium. Mostly a design/authorization decision + token-scope plumbing; the per-cable authorization model already exists (the cable IS the authorization, with a TOCTOU re-check). |
| **Risk** | **Highest of the set** — this is the privilege boundary. Needs a deliberate authority decision (which terminal is "the orchestrator," can there be more than one, how is it revoked) before code. |
| **Depends on** | Pairs with Feature A. |

### Feature C — **Connector-aware routing**
**What:** Make relay/orchestration honor the **visual `orchestration` cables** as the routing+authorization graph: draw a cable A→B and a relay A→B is both routed and authorized by that cable.

| | |
|---|---|
| **Benefit** | The **canvas becomes the wiring diagram** for multi-agent flows — intuitive, visual, no scripting. Strong differentiator vs. competitors (e.g. Maestri). Makes the cables *mean something* live. |
| **Effort** | Low–Medium. **No schema change** (connectors persisted since v5); reads the existing graph. |
| **Risk** | Low (data model exists) — but inherits Feature B's authority risk for anything that actually *drives* an agent. |
| **Depends on** | Feature B for the live-driving case; the visual/routing layer is independent. |

### Feature D — **First-run "what is the Expanse MCP" education** (UX, folds into A)
**What:** A small explainer surface (in the onboarding modal + maybe a board hint) so users understand the MCP is *theirs and intentional*, not a missing/broken server.

| | |
|---|---|
| **Benefit** | Directly fixes the **actual user pain** ("don't let users misinterpret the MCP"). Cheap trust win. |
| **Effort** | Low — copy + one modal section. |
| **Risk** | Minimal. |
| **Depends on** | Ships *as part of* Feature A. |

### Feature E — **Recap-over-MCP** (considered → **DEFERRED**)
**What:** Re-source recaps from the agent self-reporting via `write_result` instead of transcript scraping (read side already on MCP via `canvas://board/{id}/summary`).

| | |
|---|---|
| **Benefit (if done)** | Unified agent↔canvas channel; **no transcript egress** (agent writes its own summary — no API key needed); less brittle (no hook/file-watch/JSONL parsing per CLI). |
| **Cost** | Couples recap to MCP-being-on **and** a cooperating agent; lower fidelity than the continuous NOW+timeline; needs per-CLI instruction to emit `write_result`. |
| **Decision** | **Keep separate / deferred.** Recap stays MCP-free and passive. Revisit only if/when a unified "agent integration" surface is desired. |

---

## 4. Recommended sequencing

```
  B (authority decision)  ──►  A (onboarding + provisioner)  ──►  C (connector-aware live routing)
        ▲                            │
        └── must be decided first    └── D (education) ships inside A
   E (recap-over-MCP) — deferred, not on the path
```

1. **Decide Feature B's authority model first** — it's the privilege boundary everything else stands on.
2. **Build Feature A** (onboarding + spawn-time provisioner + education D), starting Claude-Code-first, with a per-CLI provisioner interface so Codex/Gemini slot in later.
3. **Layer Feature C** so the cables drive real relays.
4. Leave **E** documented and parked.

---

## 5. Locked design constraints (carry into implementation)

- **Never weaken** `contextIsolation` / `sandbox` / `nodeIntegration:false`.
- **Never log tokens** (a temp `is.dev` token log was flagged [HIGH] and fully reverted this session).
- **Per-action confirm gate stays** — every orchestration action is shown to the user before it runs.
- **The cable is the authorization** — an agent can only relay along cables the user drew (directed A→B), with a TOCTOU re-check.
- **Agent-agnostic** — design for a per-CLI provisioner, not Claude-Code-only.
- **Recap and orchestration are separate consents** (decided 2026-06-19).
- **Design artifact before code** — the "Enable agent orchestration?" modal needs a signed-off ASCII wireframe + HTML pixel mock (in `.claude/mocks/`) before implementation (per CLAUDE.md UI rule).

---

## 6. Open decisions (need user sign-off before build)

1. **Authority model (B):** is there exactly one "orchestrator" terminal per canvas, or can multiple be promoted? How is orchestrator-tier granted/revoked in the UI?
2. **Onboarding trigger (A):** first-init modal (recap-style) vs. a Settings toggle vs. both?
3. **Per-CLI scope (A):** ship Claude-Code-first and stub the others, or design the full provisioner interface up front?
4. **Modal copy/visual (D):** sign off the "Enable agent orchestration?" wireframe + HTML mock.
5. **Feature title / branch:** proposed **"Agent Orchestration Onboarding"** → `feat/agent-orchestration-onboarding` (alts: "Live Agent Orchestration", "Orchestration Enablement").

---

## 7. Cross-references

- Memory: `mcp-not-wired-to-terminals.md` (the two-layer gap + live proof), `terminal-recap-feature.md` (the consent-pattern template), `canvas-ade-mcp.md`, `orchestrator-harness.md`.
- Code anchors: `pty.ts:389`, `mcp.ts:41/99-112`, pkg `config/mcpJson.ts:36`, pkg `factory.ts:91`, `recapEnvProvider` (recap spawn-time seam), `e2e/mcp.e2e.ts:603-669` (the green relay test).
- Decision: recap vs orchestration kept separate (this session).
