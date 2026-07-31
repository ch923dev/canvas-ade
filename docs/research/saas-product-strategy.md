# SaaS Product Strategy — Expanse (Canvas ADE)

**Date:** 2026-06-03
**Status:** Research / strategy. No decision committed. Single-source-of-truth for the "should we / how would we go SaaS" question.
**Method:** In-depth codebase portability audit (4 parallel layer reviews) + multi-source web research (deep-research workflow source-set, manually fetched + verified — the workflow's own verify stage hit a known StructuredOutput infra bug, so claims below were re-fetched and cross-checked by hand).

---

## TL;DR

1. **The niche is no longer empty.** [Maestri](https://www.themaestri.app/en) already ships Expanse's exact concept — an infinite canvas with one AI coding agent per terminal node (real PTY), agents you connect with lines to prompt each other, embedded browser "Portals" (click/type/screenshot/navigate), and scheduled-prompt automation. **But Maestri is deliberately macOS-only, local-only, BYO-agent, and explicitly _not_ cloud** ("no Electron, no web views, zero telemetry, no account"). Its top review complaint: "macOS-only locks out most professional development teams."
2. **That gap is the SaaS thesis.** Be the cross-platform + cloud + team product Maestri refuses to build. Expanse is already cross-platform (Electron). The differentiator (cloud/remote execution) is also the hardest, most expensive part — so scope it deliberately.
3. **One architectural fork decides everything: where does the user's code run?** Live terminals and localhost preview both assume code on the user's own machine. SaaS forces a choice between (1) keep it local, (2) move it to your cloud, (3) bridge via a local companion agent.
4. **Recommended: phase it.** Phase 1 monetizes the desktop app with cloud accounts/sync at ~$0 marginal compute and low risk. Phase 2 (cloud-hosted dev workspaces) only if Phase 1 gains traction — it is XL effort, security-dominated, and carries a real per-user compute floor.
5. **Two pricing levers that matter most:** charge for the canvas/orchestration/compute, and make the LLM **BYO-key / BYO-agent** — exactly how Maestri and Conductor dodge the margin trap that is squeezing Cursor and Replit.

---

## 1. Codebase portability audit (what we already have)

Four parallel read-only reviews of the current Electron app. Verdict per layer:

| Layer | Reusable for web SaaS | Effort to port | Notes |
|---|---|---|---|
| **Renderer / UI** — React Flow canvas, board chrome, Planning whiteboard (vendored `perfect-freehand`), Zustand stores, design tokens | **~70% as-is, zero Electron coupling** | adapter swap | The UI is essentially a web app already. The entire seam to Electron is one `window.api` preload contract (~30 methods). ~31% of renderer prod code touches it; ~69% has no `window.api` reference at all. |
| **Terminal / PTY** | xterm.js client + the `{t:'data'\|'input'\|'resize'\|'state'\|'exit'}` wire protocol are reusable; swap MessagePort → WebSocket = S–M | **XL** | The MAIN-process `node-pty` host is throwaway. SaaS needs remote sandboxed execution + orchestration + per-tenant isolation + resource quotas + scrubbed env. **Security dominates the estimate.** |
| **Browser preview** | pure camera-math, device-frame chrome, URL bar are reusable; iframe swap is actually _less_ code (M) | **XL (architectural)** | `WebContentsView` cannot exist in a browser. The real blocker is not rendering — it is "preview the user's running localhost," which is impossible from a server. See §4. |
| **Persistence** | schema / serialize / migrate are pure JSON → free to reuse | **M** (single-user multi-device); L–XL if collaborative | Local-folder `fs` transport is rebuilt → auth + per-tenant `(tenantId, projectId)` + DB (Postgres + JSONB) + repoint `useAutosave` to HTTP. `assets/` is documented in CLAUDE.md but never implemented. |

**Key architectural asset:** the renderer was built with a clean single-seam (`window.api`), a store-as-source-of-truth, pure `lib/` math, and a vendored whiteboard. A single `window.api`-shaped HTTP/WS client behind that exact interface lets most call sites stay untouched.

---

## 2. The fork that decides everything — where does the user's code run?

The product's magic (live agent terminals + live localhost preview) assumes code on the user's machine. Three SaaS models resolve this differently:

| Model | Code runs | Terminal | Preview | Compute cost | Effort | Risk |
|---|---|---|---|---|---|---|
| **1. Hybrid** — desktop app stays, add cloud accounts/sync/billing | User's machine (as today) | unchanged | unchanged (`WebContentsView`) | **~$0** | **M** (persistence port only) | low |
| **2. Cloud workspaces** — true web SaaS | Your infra (sandbox / microVM) | rebuild as remote host | port-forward proxy + iframe | **high** | **XL** | high |
| **3. Web + local companion agent** | User's machine, tunneled | small daemon on user box | `cloudflared` tunnel → iframe | low | L | medium |

Everything downstream — which sandbox, what preview path, what pricing — flows from this single choice.

---

## 3. Remote execution infrastructure (only relevant for Model 2 / 3)

Untrusted, arbitrary shell + agentic-CLI execution on the provider's infra is the security blast radius the terminal audit flagged. Market consensus: **microVM isolation is "the minimum bar" for genuinely untrusted code** ([Northflank](https://northflank.com/blog/best-platforms-for-untrusted-code-execution)). Standard containers share the host kernel, so a kernel exploit escapes the boundary.

| Technology | Isolation | Boot | Overhead | Notes |
|---|---|---|---|---|
| **Firecracker microVM** | Hypervisor (KVM), not host kernel — strongest | 125–200ms cold; **5–30ms snapshot-restore** | near-native | Powers e2b, Fly Sprites ([Spheron](https://www.spheron.network/blog/ai-agent-code-execution-sandbox-e2b-daytona-firecracker)) |
| **gVisor** | User-space syscall interception (Sentry) | sub-1s | **10–15% CPU**, no GPU passthrough | Used by Modal, Daytona |
| **Kata Containers** | VM-based | ~1s | moderate | Enterprise; selectable on Northflank |

**Per-session cost** ([Northflank pricing comparison](https://northflank.com/blog/ai-sandbox-pricing), [E2B](https://e2b.dev/pricing)):

| Platform | CPU | Memory | Free tier / caps |
|---|---|---|---|
| Northflank | $0.01667/vCPU-hr | $0.00833/GB-hr | — |
| **E2B** | $0.0504/vCPU-hr | $0.0162/GiB-hr | Free hobby + $100 credit; Pro $150/mo; **24h session cap** |
| Daytona | $0.0504/vCPU-hr | $0.0162/GiB-hr | — |
| Modal | $0.128/vCPU-hr (sandbox) | $0.0242/GiB-hr | Only option that holds a GPU |
| **Fly.io Sprites** | $0.07/CPU-hr | $0.04375/GB-hr | **$0 when idle** |
| Vercel Sandbox | $0.128/vCPU-hr | $0.0212/GB-hr | active CPU only |

**Reality check:** 200 concurrent persistent sandboxes ≈ **$7,200–$35,000/month** depending on provider and idle behavior. A developer leaving a 1-vCPU box up ~8h/day ≈ **$8–12/user/month in compute alone**, before any LLM cost. Fly Sprites' idle-billing model and Firecracker snapshot-restore are the levers that make this survivable.

**WebContainers (StackBlitz, in-browser WASM Node) — evaluated and rejected for the core use case.** [WebContainers](https://webcontainers.io/) run `npm`/`pnpm`/`yarn` in the browser at ~$0 server cost and up to 10× local speed. But they have **no native-binary support** (no C++, no `pip`, Python stdlib only, no git) — so they **cannot run an agentic CLI** like Claude Code / Codex, which are native processes. WebContainers fit "generate and preview a web app" tools (Bolt, v0); they do not fit "run any coding agent." Dead end for Expanse's core.

---

## 4. Live preview of a remote dev server

The preview audit proved a pure-browser app cannot reach `127.0.0.1` on the user's machine. Two real paths, each tied to a code-location answer:

- **Code in your cloud (Model 2): port-forward proxy.** [GitHub Codespaces](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace) auto-detects a printed `localhost:PORT` and exposes it at `https://NAME-PORT.app.github.dev`, with private (token via `X-Github-Token` header) / org / public visibility. The Browser board iframes that URL. **This is the clean answer — but it only exists once the code already runs remotely.**
- **Code on the user's machine (Model 3): outbound tunnel.** [Cloudflare Tunnel](https://developers.cloudflare.com/pages/how-to/preview-with-cloudflare-tunnel/) — the `cloudflared` daemon runs locally, makes an outbound connection, and yields a public `trycloudflare.com` URL to iframe. Free. But the user must run a daemon, which re-introduces a desktop dependency.
- **Cross-origin tax (both paths):** iframing arbitrary origins is subject to `X-Frame-Options` / CSP blocking, and you lose the back/forward/reload/URL-bar/fail-detection capabilities the native `WebContentsView` had. The audit confirmed the surrounding chrome, device frames, and camera-sync math are reusable; only the native-view host is rebuilt.

**Core takeaway:** there is no pure-browser way to preview a dev server running on the user's own machine. Any real web SaaS must either move the dev server into your infra (Model 2) or ship a local agent (Model 3).

---

## 5. Multi-tenancy, sync, and the desktop → web playbook

Expanse is locked single-user / no-multiplayer, so sync is **single-user multi-device, not collaborative** — the easy case. The persistence audit rates this **M**: schema/serialize/migrate are pure JSON (free to carry over); the rebuild is the transport — auth, per-tenant `(tenantId, projectId)` isolation, Postgres + JSONB for the canvas document, repoint `useAutosave` to an HTTP `PUT`, add ETag / optimistic-concurrency to catch two-device write races. The flush-before-quit IPC dance disappears (no process to hard-exit).

If collaboration is ever wanted, the playbook is **Figma's, not CRDT's**. [Figma](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) uses last-writer-wins per property with central-server authority, and explicitly **rejected OT and CRDTs** as needless complexity ("a combinatorial explosion of possible states" / "unavoidable performance and memory overhead"). Tree structure via parent-links, fractional indexing for sibling order — maps directly onto a board canvas. [Linear's sync engine](https://linear.app/now/scaling-the-linear-sync-engine) is the local-first cousin. **Do not reach for CRDTs.**

---

## 6. Pricing and compute economics

**Seat-based pricing is dead** for AI dev tools — value comes from compute consumed, not access granted; Cursor abandoned it ([Lago](https://getlago.substack.com/p/why-every-ai-coding-tool-gets-pricing)). The structural problem is margin compression: "users expect 20× more, the goalpost is sprinting away." Replit's margins swing **−14% to +36%** by usage pattern.

Market reference points:
- **[Replit](https://replit.com/blog/effort-based-pricing) — effort-based:** moved from a flat $0.25/checkpoint to a variable charge per "time + computation," with user-facing levers (high-power model, extended thinking).
- **Cursor:** dollar-denominated budget + published-rate overages.
- **[Devin](https://costbench.com/software/ai-coding-assistants/devin-ai/):** ACU (Agent Compute Unit) ≈ 15 min of active work ≈ $2.00–2.25; Core $20 pay-as-you-go, Team $500/mo (250 ACU). ACU = VM time + inference + bandwidth, normalized.
- **Maestri:** Pro ~$18–19; **BYO-agent** (user pays Claude Code ~$20 separately → real total $39–59/mo).

**The decisive lever for Expanse: BYO-key / BYO-agent.** Maestri and Conductor sidestep the LLM-margin trap by making the user bring their own agent subscription. Expanse should do the same — charge for the canvas / sync / orchestration (Model 1) or for compute (Model 2), and let the LLM token cost be the user's. This removes the single largest margin killer. Model 1's marginal cost is near zero → clean SaaS margins. Model 2 must be usage/credit-based to survive the sandbox compute floor.

---

## 7. Competitive landscape

The spatial-canvas-of-agents niche has filled in during 2026:

| Tool | UI model | Platform | Cloud? | Notes |
|---|---|---|---|---|
| **Maestri** | **Infinite canvas + PTY terminal nodes + browser Portals** | macOS only | **No** (local) | **Direct twin of Expanse.** ~$18–19; BYO-agent; APFS copy-on-write "Floors"; on-device "Ombro" assistant (Apple Foundation Models); 70% auto-handoff success |
| Conductor (Melty) | Dashboard | macOS | No | BYOK, free |
| Vibe Kanban | Kanban (card = worktree = agent) | cross-platform | No | Open source |
| Nimbalyst | Kanban + WYSIWYG, semi-spatial | desktop | No | Free + subscription |
| Claude Squad / Cline | tmux / CLI | cross-platform | No | Open source |
| Cursor / Windsurf / Codex app | Tiled panes | cross-platform | partial | IDE-centric, not canvas |

Sources: [nimbalyst roundup](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/), [Maestri on Product Hunt](https://www.producthunt.com/products/maestri), [agent-finder Maestri review](https://agent-finder.co/reviews/maestri).

**Read of the field:** the spatial canvas of agents is _validated_ (Maestri shipped, monetizes, gets reviewed) — but **every serious player is local / desktop / no-cloud.** Nobody owns cross-platform + cloud + team. That space is open. Expanse's defensible wedge: cross-platform today (Electron beats macOS-only) + cloud sync/sharing + team workspaces. The moat is the canvas-native multi-agent + integrated-browser-preview UX (hard to copy) combined with cloud reach (what the comps deliberately refuse).

---

## 8. Recommended path

### Phase 1 — "Expanse Cloud" (monetize the desktop, add accounts). Effort ~M. Do this first.
- Keep the Electron app as the execution engine — code stays on the user's machine, terminals and preview unchanged, **$0 marginal compute**.
- Add: auth / accounts, cloud-stored canvases (Postgres + JSONB; persistence audit = M), cross-device sync (single-user LWW), licensing + billing (Stripe), shareable / published canvas layouts.
- Pricing: flat subscription in the Maestri tier (~$15–25/mo) + **BYO-agent**. Clean margins.
- Out-flanks Maestri on day one: cross-platform + cloud, which it will not do.
- Leverages the audited 70%-portable renderer + thin `window.api` seam — wrap preload calls behind an HTTP/sync client without touching most call sites.

### Phase 2 — "Expanse Workspaces" (cloud-hosted dev environments). Effort XL. Gate on Phase 1 traction.
- For the zero-setup / team / "my laptop can't run it" segment.
- Remote sandbox per workspace on **Firecracker-based infra** (E2B, or Fly Sprites for idle billing). **Mandatory security posture** (the program the terminal audit flagged — non-negotiable, dominates the estimate): default-deny network egress, scrubbed environment (no host/service secrets), hard CPU/memory/PID/wall-clock quotas, ephemeral per-session filesystem, automatic idle reaping, per-tenant authorization on every session.
- Preview via port-forward proxy + iframe (Codespaces model — feasible now that code is remote).
- Pricing: usage / credit-based (compute pass-through) + BYO-key LLM. Mind the $8–35/user/month compute floor.

### Do not
- **WebContainers** — cannot run native agentic CLIs.
- **Collaborative CRDT layer** — out of scope; product is locked single-user.
- **Bundling LLM cost into the subscription** — margin death; make it BYO-key.

---

## Sources

**Remote execution / sandboxing**
- https://www.spheron.network/blog/ai-agent-code-execution-sandbox-e2b-daytona-firecracker
- https://northflank.com/blog/best-platforms-for-untrusted-code-execution
- https://northflank.com/blog/ai-sandbox-pricing
- https://e2b.dev/pricing
- https://webcontainers.io/

**Live preview**
- https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace
- https://developers.cloudflare.com/pages/how-to/preview-with-cloudflare-tunnel/
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options

**Multi-tenancy / sync**
- https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- https://linear.app/now/scaling-the-linear-sync-engine
- https://workos.com/blog/developers-guide-saas-multi-tenant-architecture

**Pricing / economics**
- https://getlago.substack.com/p/why-every-ai-coding-tool-gets-pricing
- https://replit.com/blog/effort-based-pricing
- https://costbench.com/software/ai-coding-assistants/devin-ai/
- https://blog.techforproduct.com/p/how-do-replit-v0-and-bolt-actually

**Competitive landscape**
- https://www.themaestri.app/en
- https://agent-finder.co/reviews/maestri
- https://www.producthunt.com/products/maestri
- https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/

---

*Caveat on method: the deep-research workflow's automated fetch + adversarial-verify stages failed on a known StructuredOutput harness bug (all claims returned "abstain", not refuted). The search/source-discovery stage worked; the 19 sources above were re-fetched and cross-checked manually. One source surfaced by the workflow — a "CVE-2026-5752 Cohere Terrarium" item from thehackernews.com — could not be corroborated and was discarded as likely fabricated. Treat the microVM/gVisor isolation and sandbox-pricing figures as cross-confirmed by ≥2 independent sources; treat single-source vendor pricing as point-in-time (June 2026).*
