# Add external MCP servers — research + scope

**Date:** 2026-07-04 · **Branch:** `feat/mcp-add-server` · **Status:** research (pre-design)

A user-facing capability to register **external** MCP servers so Expanse's Terminal-board
agents can use them. Does **not** exist today. Fills the "Add server" affordance the settings
redesign's MCP tile currently stubs as *"coming in a later update"*
(`mcp-add-server-feature`, `settings-redesign-direction`).

> **Not the settings redesign.** The tile launcher (`feat/settings-tiles`) is a separate,
> contested lane (two competing builds — user must pick one). This feature is the MCP *content*
> that fills its read-only tile. The stray `feat/settings-panes` branch is unrelated — parked.

---

## 1. Ground truth (verified this session — do not re-derive)

### What exists in `src/main`
Every `mcp*` file is **Expanse acting AS an MCP server** (`mcp.ts`, `mcpRegistry`,
`mcpOrchestrator`, `mcpKanban`, `mcpPlanning`, …) — a loopback StreamableHTTP server
(`127.0.0.1:<port>/mcp` + bearer) that terminal agents drive over their cables.

Plus the **per-CLI Sync provisioners** (`src/main/cliProvisioners/{claude,gemini,codex,opencode}.ts`)
that write Expanse's **own** server (`canvas-ade`) into each CLI's config via **merge-not-clobber**.
These are the P3 layer of the Agent-Orchestration umbrella.

**There is no client-side registry for external servers.** This feature adds one.

### Key insight — the write mechanism already exists
The existing provisioners already do exactly the per-CLI merge-write we need. External servers =
**more entries written the same way** (a second owned-key set alongside `canvas-ade`), pointed at
the user's endpoints/commands directly. Expanse never proxies.

This is **independent** of the `mcp-not-wired-to-terminals` gap. That gap is only about Expanse's
**own** loopback server + its rotating auth token + the orchestrator authority tier. External
servers have no loopback, no token to mint, no Expanse authority — the agent CLI owns the live
connection to them. So **config-write fully closes the loop for external servers.**

**Decision (locked): wire via config-write.** Not a runtime proxy, not "registry only".

### Reusable machinery (shared helpers, `cliProvisioners/shared.ts`)
- `readJsonConfig` (throws on corrupt — never clobber), `writeJsonConfig` / `writeTextConfig`
  (atomic `write-file-atomic`, **0o600**, `enforceOwnerOnly` chmod on every write).
- `existingServersMap` (tolerates a malformed existing `mcpServers`/`mcp`), `isRecord`.
- `mcpUrl` / `bearer` (not needed for external — they build the loopback endpoint).
- `upsertCodexTable` / `removeCodexTable` (surgical TOML — parser-free; **generalize** to take a
  server name + body block for external servers).
- Home resolvers (`claudeHome`/`geminiHome`/`codexHome`/`opencodeHome`), `tildeify`, `dirExists`,
  `removeFileQuiet`.
- Divergent-dir tracking (`cliProvisioners/index.ts` + `provisionedDirStore.ts`): project-scoped
  configs land at the board's **cwd**, so on revoke we clean the root **and** every divergent cwd
  we wrote into. **Reuse this pattern** for external-server cleanup.

### Per-CLI config shapes (verified in the provisioners)
| CLI | File | Scope | HTTP entry | stdio entry |
|---|---|---|---|---|
| **claude** | `<project>/.mcp.json` + `.claude/settings.local.json` (`enabledMcpjsonServers`) | project | `mcpServers[name] = {type:'http', url, headers}` | `{type:'stdio', command, args, env}` |
| **gemini** | `~/.gemini/settings.json` | home | `mcpServers[name] = {httpUrl, headers}` (transport by KEY) | `{command, args, env}` |
| **codex** | `~/.codex/config.toml` | home | `[mcp_servers.<name>]` `url` + `http_headers = {…}` | `command`, `args`, `env` |
| **opencode** | `<project>/opencode.json` | project | `mcp[name] = {type:'remote', url, enabled, headers}` | `{type:'local', command:[cmd,...args], enabled, environment}` |

Gemini keys transport by property name: `httpUrl` ⇒ streamable HTTP, `url` ⇒ SSE, `command` ⇒ stdio.
OpenCode `local` folds command+args into a single `command:[...]` array; env is `environment`.

### Spawn-time hook (the write trigger)
`pty.ts` holds one injected `orchestrationSyncProvider` slot (`setOrchestrationSyncProvider`),
called inside a try/catch **before the launch line is written** (`pty.ts:751`). `index.ts` builds
it from `makeOrchestrationSyncProvider({getProjectDir, mintToken})`. On each spawn it: checks
`isOrchestrationEnabled`, detects the CLI from `launchCommand` (`cliIdForLaunchCommand`), writes the
`canvas-ade` entry at the board cwd, records the divergent dir.

### Secret-at-rest pattern (`llmKeyStore.ts`)
Injected `Encryptor` (Electron `safeStorage` from `index.ts`, kept out of the store for
unit-testability). Ciphertext base64 in `<userData>/llm-keys.json`. `getKey` decrypts in MAIN only;
`hasKey` routes through the same decrypt (no split-brain). Renderer never sees key material —
`window.api.llm` exposes presence only. **Mirror this exactly** for external-server secrets.

### UI mount surface
The read-only tile is `settings/panes/McpPane.tsx` — **but only in the `feat/settings-tiles`
worktree**, which is unmerged + contested. `main`'s live surface is `SettingsModal.tsx` (has an
"Agent orchestration" section, **no** MCP-servers section). See §5 for the mount decision.

---

## 2. Data model + storage

```ts
type CliId = 'claude' | 'codex' | 'gemini' | 'opencode'
type Transport = 'http' | 'stdio'

interface NamedSecret { name: string; value: string } // value = base64(ciphertext) at rest

interface ExternalMcpServer {
  id: string                 // stable uuid (registry key; never the config key)
  name: string               // the CONFIG key — validated ident, reject 'canvas-ade' clash + dupes
  enabled: boolean
  transport: Transport
  // http:
  url?: string               // plaintext (shown in the row; users warned not to put secrets here)
  headers?: NamedSecret[]    // header values are secret → encrypted
  // stdio:
  command?: string
  args?: string[]            // not secret (plaintext)
  env?: NamedSecret[]        // env values are secret → encrypted
  targets: CliId[]           // which CLIs to write into (default: all DETECTED)
  lastTest?: { ok: boolean; at: number; detail?: string; toolCount?: number }
}
```

- **Store:** `<userData>/mcp-servers.json` — **NEVER** `canvas.json` / project folder (CLAUDE.md
  persistence rule). Atomic write, 0o600.
- **Secrets:** header values + env values encrypted via `safeStorage` (mirror `llmKeyStore`). URL,
  command, args, names, targets, lastTest stay plaintext. Decrypt in MAIN **only** at config-write
  and Test time.
- **Renderer never sees secret values.** `list()` returns each server with header/env **names**
  and a `hasValue` flag, values omitted. On save, a blank value = **keep existing** (the
  "leave blank to keep" pattern from `LlmPane`).

### Validation (reject at the IPC boundary, MAIN)
- `name`: non-empty, matches a safe config-key ident (`/^[A-Za-z0-9_.-]+$/`), **≠ `canvas-ade`**
  (would collide with the orchestration entry across every CLI), unique in the registry.
- `transport==='http'` ⇒ `url` required, `http(s):` only. `transport==='stdio'` ⇒ `command` required.
- `targets` ⊆ known CLIs; empty ⇒ default to detected set at write time.

---

## 3. Decisions settled

### D1 — Write-path gate: **independent of orchestration consent**
External servers are the **user's own** servers, not Expanse authority. The write gate is simply
**"server `enabled` AND this CLI ∈ `server.targets`"**. No `isOrchestrationEnabled` check — a user
who never enables orchestration can still attach their own MCP servers. (Contrast: the `canvas-ade`
entry stays consent-gated because it grants agents authority over *this* canvas.)

### D2 — Write mechanism: **parallel spawn-time writer, composed into the existing pty hook**
Build a **new** set of external-server writers (do **not** touch the shipped `canvas-ade`
provisioners — they're single-key, token-minting, and load-bearing for orchestration). `index.ts`
composes both providers into the single `pty.ts` slot:

```ts
setOrchestrationSyncProvider((opts) => {
  orchestrationSync(opts)   // existing canvas-ade write (consent-gated)
  externalMcpSync(opts)     // NEW: enabled external servers (independent gate)
})
```

Each writer, given the launched CLI + target dir, upserts every enabled server that targets that
CLI (merge-not-clobber, reusing shared helpers), and records the dir for cleanup. `pty.ts` is
**unchanged** — composition happens in `index.ts`. Both are inside pty's spawn try/catch, so an
external-write failure can never break a spawn.

**Home-scoped nicety:** gemini/codex configs live in `~`, knowable without a cwd, so we **also**
write/rewrite them eagerly on save/enable/remove (immediate effect for already-running-elsewhere
agents). Project-scoped (claude/opencode) are cwd-bound ⇒ spawn-time only. A server added
mid-session appears in a project-scoped CLI on the **next terminal launch** (same restart story as
`canvas-ade`; acceptable, documented in the UI).

### D3 — Secret at rest: **mirror `llmKeyStore`** (safeStorage, injected Encryptor)
Header + env values encrypted. No keyring ⇒ `save` returns `{ok:false, reason:'encryption-unavailable'}`
and the pane shows the same "no system keyring" notice `LlmPane` uses. Never log secret values.

### D4 — Test/connect lifecycle: **point-in-time, `@modelcontextprotocol/sdk` client**
`@modelcontextprotocol/sdk` is already a dependency. Test spawns a MAIN-side client:
- **http** → `StreamableHTTPClientTransport(url, {requestInit:{headers}})`.
- **stdio** → `StdioClientTransport({command, args, env})` (decrypted env; kill on close).

Sequence: `client.connect()` (does MCP `initialize`) → `client.listTools()` → record
`lastTest = {ok, at, toolCount, detail}` → `client.close()` (stdio: kill the child tree). Bounded by
a timeout (~10s) so a hung endpoint can't wedge. **No** live Expanse-held connection — "health" is
the recorded `lastTest`; the agent CLI owns the real connection.

### D5 — Remove / disable
- **disable:** flip `enabled=false`, re-sync (rewrite) every tracked dir + home configs so the key
  is dropped from live configs; keep the registry row (secrets retained for re-enable).
- **remove:** delete the registry row (+ its secrets), then `removeServer(name)` from every CLI
  config in every tracked dir + home (reuse the divergent-dir cleanup). Idempotent, best-effort.

### D6 — No new persisted board/schema field
This is `userData`-only. No `canvas.json`, no `schemaVersion` bump, no `PATCHABLE_KEYS` change.

---

## 4. Surface to build

**MAIN (new files):**
- `mcpServersStore.ts` — encrypted registry (createStore(userDataDir, encryptor)), CRUD + masking +
  validation. Electron-free (injected Encryptor), unit-testable. Mirrors `llmKeyStore`.
- `cliProvisioners/external.ts` (+ per-CLI writers, or extend the four files with `writeServers`/
  `removeServer`) — external-server upserts reusing shared helpers; generalize `upsertCodexTable`.
- `mcpServersIpc.ts` — frame-guarded handlers: `list` · `save` · `remove` · `setEnabled` · `test` ·
  `detectClis`. + the composed spawn-time `externalMcpSync` provider.
- `mcpClientProbe.ts` — the Test-lifecycle client (SDK http+stdio, timeout, cleanup). MAIN-only.

**PRELOAD:** `window.api.mcpServers = { list, save, remove, setEnabled, test, detectClis }`
(+ types in `index.d.ts`). Frame-guarded in MAIN; only masked data crosses.

**RENDERER:**
- `store/mcpServersStore.ts` (zustand) — cache + actions over `window.api.mcpServers`.
- `settings/McpServersManager.tsx` — **self-contained** component (list + per-row status +
  Add/Edit/Remove/Test; Add/Edit form: name, transport toggle, url/headers **or** command/args/env,
  target CLIs, Test button; secrets masked). Host-agnostic so any settings shell can mount it.

**Wiring:** compose `externalMcpSync` into the pty provider in `index.ts`; bind the store's
userData + encryptor at boot; register the IPC.

---

## 5. Open decision for sign-off — v1 UI mount

The intended final home is the settings-tiles `McpPane`, but that lane is **unmerged and contested**
(two builds; user picks one). This feature must not block on that. Options:

- **A (recommended):** Build `McpServersManager` self-contained + backend-complete; **interim-mount**
  it into `main`'s live `SettingsModal.tsx` as a new "MCP Servers" section so it ships + dev-checks
  now. When settings-tiles lands, its `McpPane` swaps its read-only body for `<McpServersManager/>`
  (a ~2-line change). Cost: a small merge touch on `SettingsModal.tsx` (which tiles later deletes).
- **B:** Backend + component only, no live mount on `main`; final mount deferred to whichever
  settings lane wins. Cost: no manual-dev-check surface until then (violates the every-PR dev-check
  convention).

→ **Raise at the design-artifact gate.** Recommend A.

---

## 6. Security invariants (never weaken)
- Secret values **never** cross to the renderer (masked names only) and are **never logged**.
- Commands / URLs / headers are **trusted-user-only** input; Browser-board content must never reach
  them (this is Settings UI — user-typed only, no cross-channel path).
- MAIN-only: `node:fs` · `node:child_process` (stdio Test) · `@modelcontextprotocol/sdk` client ·
  `safeStorage`. All behind **frame-guarded** IPC (`isForeignSender`).
- Files **0o600**, **atomic** writes (mirror shared helpers + llmKeyStore).
- `contextIsolation` / `sandbox` / `nodeIntegration` unchanged.

---

## 7. Build phases (each runnable + committed)
1. **Registry + encrypted store** (`mcpServersStore.ts` + model + validation) — unit tests.
2. **IPC + preload namespace** — frame-guarded handlers + `window.api.mcpServers` + types.
3. **Per-CLI external writers** — 4 CLIs, http+stdio, generalized codex TOML; spawn-time
   `externalMcpSync` composed into the pty hook; divergent-dir cleanup — unit tests.
4. **Test/connect lifecycle** — SDK client probe (http+stdio), timeout, kill, persist `lastTest`.
5. **UI** — `McpServersManager` + interim mount + renderer store; e2e; title-stamped dev check.

Plan-viz-first: draw this on the canvas (Planning board + checklist) via the `canvas-ade` MCP
**before** phase-1 code.
