# ADR 0003 — LLM egress: the one new outbound call beyond loopback (opt-in, capped, passive)

- **Status:** Accepted (2026-06-03)
- **Context:** The Context subsystem's Tier-2 brain (`src/main/llmService.ts`, M-brain) summarizes board
  content by calling a user-chosen LLM provider (OpenRouter default; OpenAI / Anthropic / a local
  endpoint). This is the **first and only new outbound network egress beyond loopback** (the local dev
  server + the preview `WebContentsView`s). Until now the app made no third-party network calls. Board
  content — terminal scrollback, browser page text — flows **into** the request body, and a user API key +
  the user's spend are involved. Per the locked rule ("Add an ADR when a load-bearing decision lands; the
  LLM egress"), this records the egress contract and its guards. Lands with M-brain T-B3 (the budget guard).

## Decision

**MAIN may call a user-configured LLM endpoint to summarize the canvas — but only opt-in, only capped, and
the model's output is treated as untrusted passive context that never drives an action.** Concretely:

1. **Opt-in, never implicit.** No call is made without a configured provider key. `getProvider` returns
   `null` when no key is present (and the mock seam short-circuits in CI/e2e), so `runSummarize` yields
   `{ ok: false, reason: 'no-provider' }` and the app runs fully at Tier-1. Egress exists only after the
   user enters a key in Settings (T-B2 — `safeStorage`-encrypted in `userData`, never the project folder).
2. **Isolated behind one interface.** The only outbound `fetch` lives inside the real `Provider.summarize`
   in `llmService.ts`. No other module performs outbound I/O for the brain. The transport is injected
   (`ProviderDeps.fetch`) so it is unit-tested with a fake and e2e runs a mock provider (no real network).
3. **Spend is capped.** A per-calendar-day **call** budget (`src/main/llmBudget.ts`, T-B3) reserves a call
   **before** each request; over the cap → `{ ok: false, reason: 'budget-exceeded' }` → Tier-1. Default
   `DEFAULT_MAX_CALLS_PER_DAY = 200`, user-overridable via `maxCallsPerDay` in `llm-config.json`. The
   counter lives in `userData/llm-budget.json` (atomic write) — **never** a project folder / `.canvas/` /
   `canvas.json`. Reservation is before egress and is **not refunded** on a later provider error (count
   attempts, fail-closed) — a runaway loop degrades to Tier-1 rather than overspending. (One exemption:
   the operator-only `CANVAS_LLM_PING` dev probe in `index.ts` — gated on an env var + `!SMOKE`, one call
   per process start, not renderer-reachable — runs unbudgeted. It is a manual smoke check, not a loop.)
4. **Passive output only (lethal-trifecta).** Generated summaries are **untrusted, passive context** —
   written to disk + displayed (and later MCP-read) — and they **never trigger an action**. Board content
   reaching the model never returns to the PTY write channel or any tool. `runSummarize` returns text and
   the caller renders/stores it; nothing acts on it.
5. **Security posture unchanged.** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
   remain untouched. Browser-board content (a native `WebContentsView` with no preload and a separate
   session) cannot reach the `llm:*` channels. The API key crosses IPC **inbound only** (`llm:setKey`) and
   is never returned to the renderer (`llm:status` reports `hasKey` presence only). Every `llm:*` handler
   rejects foreign senders (`isForeignSender`).

## Consequences

- The app makes a third-party HTTPS call **only** when the user has configured a key **and** stayed under
  budget. A privacy-sensitive user simply sets no key and keeps full Tier-1 functionality.
- Spend is bounded by a daily cap the user controls; the guard is fail-closed (real egress always enforced;
  under the CI/e2e mock seam it stays uncapped unless a test opts in by setting a cap).
- The preload bridge mirrors the `budget-exceeded` result; every caller treats it like `no-provider`
  (degrade to Tier-1). No new secret crosses IPC or lands in `llm-budget.json`.

## Accepted residual risk

- **Renderer-set `local` `baseUrl` — RESOLVED (no longer an open residual).** Originally accepted as a
  renderer-trusted egress target. **Closed by BUG-001 (2026-06-04 hunt):** `isLoopbackBaseUrl` now hard-
  restricts the `local` `baseUrl` to an `http(s)` loopback host (`localhost`/`127.0.0.1`/`::1`) at all
  three layers — write (`llm:setConfig` rejects), read (`readLlmConfig` drops a poisoned on-disk value),
  and use (`buildRequest` throws). A renderer foothold can no longer point summaries at `file://`, the
  cloud IMDS (`169.254.169.254`), or an internal host. **Deliberate tradeoff:** a `local` endpoint on a
  *different* LAN box (not loopback) is no longer reachable — acceptable for the LM Studio / Ollama / dev-box
  case (all loopback). Revisit only if a real non-loopback local endpoint is needed (would need an explicit
  allowlist, not a blanket open).

- **M-expose: an LLM-generated summary served to agents is an untrusted-context / prompt-injection vector.**
  The Context subsystem's Tier-2 summaries (`board-<id>.md`) are model output, hence untrusted. M-expose
  serves them read-only over `canvas://memory` + `canvas://board/{id}/summary` (`boardMemory.ts`). On the
  desktop they stay passive (written + displayed + MCP-read, never action-triggering — `sanitizeSummary`
  also strips control chars + forged headings at write). But an **agent that consumes** a summary as context
  can be **prompt-injected** by its content. We accept this: it is inherent to exposing generated memory to
  agents, the desktop never acts on it, and the consuming agent's prompt-safety is that agent's
  responsibility (out of this app's trust boundary). Revisit if MCP ever gains a write/action path keyed off
  memory content. (M-expose closeout, 2026-06-05.)

## Out of scope (not decided here)

- The MCP server's **Host-header attack surface** (a separate egress/ingress concern; to be covered in a
  forthcoming MCP ADR — not yet written).
- **Token-dimension budgets** — deferred; the per-day call cap is the v1 guard (deterministic + always
  available; token usage would need per-provider response plumbing).
- Per-provider request hardening / retries / streaming.
