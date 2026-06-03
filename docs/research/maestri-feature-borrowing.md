# Maestri (themaestri.app) — competitor teardown & feature-borrowing pass

> **Date:** 2026-06-03 · **Method:** deep-research workflow (96 agents, 2.8M tokens, ~19 min
> fan-out → fetch → adversarial-verify) + direct site fetch + grounding against this repo's
> `docs/feature-proposals.md` / `docs/roadmap.md` / `CLAUDE.md`.
> **Status:** research only — no code. Recommendations map onto **existing** proposals (SB-1/SB-2/SB-4/
> QW-4/FW-1); two are genuinely new (per-agent Roles, Cognograph canvas-as-context).
> Sibling docs: [`excalidraw-feature-borrowing.md`](./excalidraw-feature-borrowing.md),
> [`drawio-feature-borrowing.md`](./drawio-feature-borrowing.md).

> **Sourcing note:** Most facts come from Maestri's own docs (`themaestri.app/docs/*`). The
> load-bearing differentiators (agent-to-agent handoff, Roles, Portals, Floors) are independently
> corroborated by hands-on third parties (agent-finder.co, Setapp, Product Hunt, HuntScreens).
> Anything single-sourced or vendor-marketing is flagged inline. Sources current May–June 2026;
> Maestri is recently launched and evolving.

---

## TL;DR

**Maestri is Expanse's closest competitor** — and it validates our roadmap almost exactly. It is a
macOS-native ("no Electron, no web views") infinite canvas where each terminal node runs a
user-installed CLI agent (Claude Code / Codex / OpenCode / shell). Same core paradigm as Expanse,
Mac-native. It ships **two things we don't have**: **agent-to-agent PTY orchestration** (drag a cable
between two terminals → agents prompt/delegate each other) and **per-agent Roles**. Almost everything
worth borrowing is **already an Expanse proposal** — this research re-ranks them, not invents them.

**Sequence to ship:** `SB-4 connectors → agent-to-agent messaging → SB-1 status queue`.
**Our moat they can't copy:** cross-platform (Win/Mac/Linux). Their APFS/Metal mechanisms don't port.

---

## 1. What Maestri is

| Attribute | Value |
|---|---|
| Tagline | "An orchestration canvas for AI agents" |
| Platform | macOS 26.2+, Apple Silicon only; **100% native Swift / SwiftUI / Metal** (explicitly *no Electron, no web views*) |
| Category | Orchestration **layer**, not an agent. Agent-**agnostic** — runs user-installed CLIs |
| Pricing | Free (1 workspace, unlimited agents, all core features) · **Pro $18 one-time**, 2-Mac license, 7-day trial |
| Bundles agents? | **No** — you bring your own CLI agent |

### Core primitives
- **Terminals / Agents** — full interactive PTY shells; many run simultaneously on the canvas.
- **Notes** — **real markdown files on disk**, readable/writable by agents, persistent across sessions,
  chainable into trees agents traverse. (Key: notes are a *data interchange* surface, not just UI.)
- **Connections** — physics-animated cables between nodes; the substrate for orchestration.
- **Portals** — embedded browsers that **agents can control** (click/type/screenshot/navigate/read-DOM).
- **File Tree** — embedded project browser.
- **Ombro** — on-device AI assistant that monitors agent activity.
- **Floors** — instant **APFS copy-on-write** isolated per-branch workspace clones.

---

## 2. Head-to-head vs Expanse

### 2a. Where Maestri beats us — the borrow list

| Maestri capability | Detail | Expanse today | Borrow |
|---|---|---|---|
| **Agent-to-agent PTY orchestration** | Drag a cable between two terminals → Maestri installs a "Maestri Agent Skill" in each → one agent prompts/delegates/hands off to another over a real PTY bridge (stdout→stdin), agent-agnostic (Claude Code↔Codex↔OpenCode), **no APIs/middleware**. Independently measured **~70% autonomous-handoff reliability**; receiving agent must stay **unfocused** to be monitored. | nothing | **P2 — yes** |
| **Per-agent Roles** | Lead / Coder / Reviewer / Tester via a CLAUDE.md/AGENTS.md subdir + a portable `role.json` sidecar injected at agent startup. Agent-agnostic at the file level. | only free-text `launchCommand` | **P5 — yes, NEW to our backlog** |
| **Agent-controllable Portals** | Agents drive an embedded browser (fill forms, read DOM, screenshot). | Browser boards are **view-only** previews | **P6 — partial, security-gated** |
| **Floors** | APFS CoW per-branch workspace clones, instant. | deferred **FW-1 Feature Workspaces** (git worktrees) | already planned, **defer** |
| Notes as on-disk markdown agents read/write | Plan↔agent interchange over the filesystem. | Planning notes are in-app state, not files on disk | **P4 — yes** |

### 2b. Where WE beat Maestri — the moat

- **Cross-platform**: Win / Mac / Linux × x64/arm64 (CI matrix). Maestri is **macOS-Apple-Silicon-only**.
  Their APFS (Floors) and Metal mechanisms are **not portable** — we use git worktrees instead.
- **Already shipped**: JSON persistence + `.bak` fallback, runtime port-detection→preview, responsive
  device-frame previews (390/834/1280 reflow), whiteboard + interactive checklists, layout/tidy presets.
- Locked, audited security model (contextIsolation/sandbox/no-nodeIntegration; Browser content never
  reaches the PTY write channel).

### 2c. Secondary comparator — Cognograph (AGPL-3.0, self-hostable)
- **Edges feed model context** via breadth-first graph traversal — claims **60–85% fewer tokens**
  (⚠️ **unvalidated** — no disclosed methodology; verify vote 2-1, treat as marketing).
- **13 "Spatial Triggers"** — canvas layout itself becomes executable automation (canvas-as-logic).
- Direction neither Expanse nor Maestri has: **canvas-as-context / canvas-as-logic**. Research signal
  only; decide alongside the `canvas-ade-mcp` spec.

---

## 3. Prioritized recommendations

All map onto existing entries in `docs/feature-proposals.md` unless marked **NEW**. This research
**validates and re-ranks**; `feature-proposals.md` already lists Maestri as a surveyed competitor
(line 5) and already cites it under SB-4 (line 359).

| Pri | Feature | Why now | Effort / risk |
|---|---|---|---|
| **P1** | **SB-4 board-to-board connectors** (typed, persisted edges) | Highest leverage, lowest dependency. Pure renderer/state; persistence already shipped (Phase 3); precedent exists (`PreviewEdge` from `BrowserBoard.previewSourceId`). React Flow makes typed/persisted edges near-free. **Substrate for P2/P4.** | Medium / low |
| **P2** | **Agent-to-agent messaging over connectors** | Maestri's verified signature. Reuses our existing `pty.write`-over-MessagePort path (same plumbing as SB-2). Relay terminal A's output → terminal B's input. | Medium / **security-critical** |
| **P3** | **SB-1 status states + "needs-you" attention queue** | Repo calls it the "highest-leverage single feature, medium effort, answers the #1 multi-agent pain." Maestri's monitor-unfocused-terminals pattern validates the need. | Medium / low |
| **P4** | **Agent-readable shared notes / SB-2 Run-on-Agent** | Closes the plan→agent loop Maestri demonstrates. Mirror Maestri: make Planning notes **real markdown files on disk** in the project folder. | Medium |
| **P5** | **Per-agent Roles (instruction-injection layer)** — **NEW** | Not in our backlog. Agent-agnostic at the CLAUDE.md-file level; dovetails with existing `cwd` threading. Lead/Coder/Reviewer/Tester presets + portable sidecar. | Medium |
| **P6** | **QW-4 console capture** (zero-dep, no-CDP) **+ agent-controlled Portals** | Console capture = cheap first step. Agent-Portal control = higher effort + security-sensitive (one-directional only). | Low → High |

### Defer
- **FW-1 Feature Workspaces / Floors-equivalent** — gated on `canvas-ade-mcp`; MUST use git worktrees
  (Maestri's APFS CoW is Mac-only, not portable).
- **Cognograph-style canvas-as-context / spatial triggers** — research signal; decide with the
  `canvas-ade-mcp` spec.

---

## 4. Hard constraints (do not violate while borrowing)

1. **Cross-platform stays non-negotiable.** Maestri's APFS/Metal mechanisms are NOT portable. Any
   Floors-equivalent uses git worktrees.
2. **Locked security model.** Browser-board content must **never** reach the PTY write channel.
   Keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. Agent-to-agent messaging
   (P2) and agent-controlled Portals (P6) are the two riskiest borrows — relay must be terminal→terminal
   only, one-directional, never Browser→PTY.
3. **Agent-agnostic.** Match Maestri: borrow at the file/PTY level (CLAUDE.md, `role.json`, stdout→stdin),
   never bind to one vendor's API.

---

## 5. Caveats

- Agent-to-agent handoff is **~70% reliable, not flawless**; receiving agent must stay *unfocused* to be
  monitored — scaling past 4+ interconnected agents is unverified.
- Cognograph's 60–85% token figure has **no disclosed methodology** — do not cite as fact.
- Most recommendations **already exist** as Expanse proposals citing Maestri — this validates/reprioritizes,
  it does not invent. Only 2 net-new ideas: **per-agent Roles (P5)** and **Cognograph canvas-as-context**.
- Sources current May–June 2026; Maestri recently launched and evolving — re-verify before building.

---

## 6. Open questions

1. How does Maestri's PTY relay scale past the "receiving agent must stay unfocused" constraint with
   4+ interconnected agents?
2. Can Expanse drive agent-controlled Portals **one-directionally** without breaching the Browser→PTY
   boundary?
3. Should SB-4 connectors adopt Cognograph's **edges-feed-context** semantics? (decide alongside the
   `canvas-ade-mcp` spec)
4. Maestri's exact free-tier limits over time (confirmed it does NOT bundle agents).

---

## 7. Sources

- `https://www.themaestri.app/` and `/docs/{intro,terminals,connections,portals}` — vendor (primary)
- agent-finder.co — independent hands-on (agent-to-agent reliability measurement)
- setapp.com/apps/maestri · Product Hunt · HuntScreens — independent listings/reviews
- cognograph.app — secondary comparator (vendor)
- This repo: `docs/feature-proposals.md`, `docs/roadmap.md`, `CLAUDE.md` (grounding)
