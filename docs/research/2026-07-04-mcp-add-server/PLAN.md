# Add external MCP servers — implementation plan

**Branch:** `feat/mcp-add-server` · **Design:** approved 2026-07-04 (list + Add/Edit mock) ·
**Mount:** interim in `main`'s `SettingsModal.tsx` (approved). Companion: `REPORT.md` (decisions).

Five runnable/committed phases. Each ends green on `pnpm typecheck` + relevant unit tests.

---

## Shared model (`src/main/mcpServers/types.ts`)
```ts
export type CliId = 'claude' | 'codex' | 'gemini' | 'opencode'
export type Transport = 'http' | 'stdio'
export interface NamedSecret { name: string; value: string } // value = base64(ciphertext) at rest

export interface ExternalMcpServer {
  id: string
  name: string                 // config key: /^[A-Za-z0-9_.-]+$/, ≠ 'canvas-ade', unique
  enabled: boolean
  transport: Transport
  url?: string                 // http (plaintext)
  headers?: NamedSecret[]      // http — values secret
  command?: string             // stdio
  args?: string[]              // stdio (plaintext)
  env?: NamedSecret[]          // stdio — values secret
  targets: CliId[]
  lastTest?: { ok: boolean; at: number; detail?: string; toolCount?: number }
}

/** What crosses to the renderer — no secret VALUES, only names + presence. */
export interface MaskedServer {
  id; name; enabled; transport; url?; command?; args?; targets; lastTest?
  headers?: { name: string; hasValue: boolean }[]
  env?:     { name: string; hasValue: boolean }[]
}
```

---

## Phase 1 — Registry + encrypted store
**New:** `src/main/mcpServers/mcpServersStore.ts` (+ `types.ts`), `mcpServersStore.test.ts`.

- `createMcpServersStore(userDataDir, encryptor: Encryptor)` — reuse the `Encryptor` interface from
  `llmKeyStore.ts` (import the type; index.ts injects the same `safeStorage` shim). Electron-free.
- File `<userData>/mcp-servers.json`, atomic write (`write-file-atomic`), `mode: 0o600`.
- API: `list(): ExternalMcpServer[]` (raw, MAIN-only) · `listMasked(): MaskedServer[]` ·
  `getResolved(id): ResolvedServer | undefined` (decrypts secrets — MAIN-only, for writers/Test) ·
  `upsert(input): {ok; id} | {ok:false; reason}` · `remove(id)` · `setEnabled(id,on)` ·
  `recordTest(id, lastTest)`.
- **Save semantics:** on update, a secret with `value===''` **keeps** the stored ciphertext (the
  "leave blank to keep" contract); a non-empty value is re-encrypted; a removed name drops it.
- **Encryption unavailable:** `upsert` with any new secret returns `{ok:false, reason:'encryption-unavailable'}`
  and writes nothing (mirror `llmKeyStore.setKey`).
- **Validation** (in store, so IPC + tests share it): name regex, `≠ SERVER_NAME` ('canvas-ade'),
  unique; http⇒url required + `http(s):`; stdio⇒command required; targets ⊆ CliId.
- **Tests:** round-trip encrypt/decrypt; blank-keeps-secret; masking omits values; name clash +
  dupe + canvas-ade rejected; no-keyring path; corrupt-file tolerance.

**Commit:** `feat(mcp): external-server registry + encrypted userData store`

---

## Phase 2 — IPC + preload namespace
**New:** `src/main/mcpServers/mcpServersIpc.ts`. **Edit:** `src/preload/index.ts` (+ `index.d.ts`),
`src/main/index.ts` (register).

- `registerMcpServersHandlers(ipcMain, getWin, store, probe, detectClis)` — all frame-guarded
  (`isForeignSender`). Channels:
  - `mcp-servers:list` → `MaskedServer[]`
  - `mcp-servers:save` → `{ok; id?} | {ok:false; reason}` (validate in store)
  - `mcp-servers:remove` → `{ok}` (store.remove + resync-cleanup, Phase 3)
  - `mcp-servers:setEnabled` → `{ok}` (+ resync, Phase 3)
  - `mcp-servers:test` → `{ok; toolCount?; detail?}` (Phase 4 probe; also `store.recordTest`)
  - `mcp-servers:detectClis` → `Record<CliId, boolean>` (reuse `detectInstalled`)
- Preload: `window.api.mcpServers = { list, save, remove, setEnabled, test, detectClis }`; types in
  `index.d.ts`. **Only masked data crosses.**
- `index.ts` boot: build store with the existing `llmEncryptor` + `userData`; register handlers.
  (No `llmIsolated` temp-dir needed — but honor `CANVAS_E2E` isolation like llm to keep e2e clean.)

**Commit:** `feat(mcp): frame-guarded IPC + window.api.mcpServers preload`

---

## Phase 3 — Per-CLI external writers + spawn hook
**New:** `src/main/cliProvisioners/external.ts`, `external.test.ts`, `externalDirStore.ts`
(mirror `provisionedDirStore.ts`). **Edit:** `shared.ts` (generalize codex TOML), `index.ts` (main,
compose the provider).

- **Generalize codex TOML** in `shared.ts`: `upsertCodexTableNamed(existing, name, bodyLines[])`,
  `removeCodexTableNamed(content, name)` (parametrize the header regex over `name`). Keep the
  `canvas-ade` wrappers delegating to these — **no behavior change to the shipped path** (verify via
  existing `provisioners.test.ts`).
- **`ResolvedServer` → per-CLI entry** builders (http + stdio) matching the verified shapes:
  - claude `.mcp.json`: `{type:'http',url,headers}` / `{type:'stdio',command,args,env}` + add name to
    `enabledMcpjsonServers`.
  - gemini `~/.gemini/settings.json`: `{httpUrl,headers}` / `{command,args,env}`.
  - codex `~/.codex/config.toml`: table `url`+`http_headers` / `command`+`args`+`env`.
  - opencode `opencode.json`: `{type:'remote',url,enabled,headers}` / `{type:'local',command:[cmd,...args],enabled,environment}`.
- **`writeExternalServers(cliId, dir, servers: ResolvedServer[])`** — upsert every server's key
  (merge-not-clobber via `existingServersMap`); **`removeExternalServers(cliId, dir, names[])`**.
- **`makeExternalMcpSyncProvider({ getProjectDir, getResolvedEnabled })`** — same `OrchestrationSyncProvider`
  shape. On spawn: `cliId = cliIdForLaunchCommand(launchCommand)`; if none, return. Collect enabled
  servers whose `targets` include `cliId`; `writeExternalServers` at the target dir
  (`cwd ?? projectDir` for project-scoped; home CLIs ignore dir); record dir in `externalDirStore`.
  **No consent gate.**
- **Compose in `index.ts`:** wrap both providers into the single `setOrchestrationSyncProvider` slot:
  ```ts
  const orchSync = makeOrchestrationSyncProvider({...})
  const extSync  = makeExternalMcpSyncProvider({...})
  setOrchestrationSyncProvider((o) => { orchSync(o); extSync(o) })
  ```
  Each already internally try/caught by pty.ts's spawn guard.
- **Eager home-scoped write** on save/enable/remove (gemini/codex only — home dir known): resync so a
  running-elsewhere agent picks up the change without waiting for a spawn. Project-scoped stays
  spawn-time.
- **Cleanup on remove/disable:** rewrite every tracked dir with the current enabled set +
  `removeExternalServers` for the dropped name (idempotent, best-effort). Mirror `unsyncProvisioners`.
- **Tests:** http+stdio entry shape per CLI; merge preserves foreign keys + canvas-ade; remove drops
  only the named key; codex named-table upsert/remove; targets filter; divergent-dir cleanup.

**Commit:** `feat(mcp): per-CLI external writers + spawn-time sync + cleanup`

---

## Phase 4 — Test / connect lifecycle
**New:** `src/main/mcpServers/mcpClientProbe.ts`, `mcpClientProbe.test.ts` (stdio via a tiny fake
server script; http mock optional).

- `probeExternalServer(resolved: ResolvedServer, { timeoutMs = 10_000 }): Promise<{ok; toolCount?; detail?}>`.
- **http:** `new Client(...)` + `StreamableHTTPClientTransport(new URL(url), { requestInit:{ headers } })`.
- **stdio:** `StdioClientTransport({ command, args, env: { ...process.env, ...env } })`.
- Sequence: `await client.connect(transport)` (MCP `initialize`) → `await client.listTools()` →
  `{ok:true, toolCount}`; always `finally` → `await client.close()` (stdio transport kills the
  child). Race against a timeout → `{ok:false, detail:'timed out after 10s'}`. Map errors to a short
  `detail` (**never** echo header/env values).
- IPC `mcp-servers:test`: `store.getResolved(id)` → `probeExternalServer` → `store.recordTest` →
  return masked result.

**Commit:** `feat(mcp): point-in-time Test via @modelcontextprotocol/sdk client`

---

## Phase 5 — UI component + interim mount
**New:** `src/renderer/src/canvas/settings/McpServersManager.tsx` (+ styles), renderer
`store/mcpServersStore.ts` (zustand), tests. **Edit:** `SettingsModal.tsx` (add "MCP Servers"
section mounting `<McpServersManager/>`), an e2e spec.

- Component states from the mock: **list** (row: status dot ← `lastTest`, transport badge, target
  chips, Test/Edit/Remove, enable toggle) + **Add/Edit form** (name, transport segmented control,
  http: url + headers table / stdio: command + args + env table, target-CLI chips with detected
  badge, Test bar, Save/Cancel). Secrets masked; blank = keep (`placeholder="•••• (leave blank to keep)"`).
- Renderer store wraps `window.api.mcpServers`; optimistic-safe (re-fetch masked list after mutations).
- Match `SettingsModal`/`paneStyles` idiom + `index.css` tokens. Keyring-unavailable notice on the
  `encryption-unavailable` save reason (mirror `LlmPane`).
- **e2e** (`@chrome` tag): open Settings → MCP Servers, add an http server, assert it lists; the store
  round-trips via IPC (Test can hit a local fixture or assert the error path).
- **Manual dev check:** `$env:CANVAS_DEV_TITLE='PR#NNN mcp-add-server'; pnpm dev` — add/edit/remove/test
  live; confirm the window title.

**Commit:** `feat(mcp): external MCP servers UI in settings (interim mount)`

---

## Verify (pre-PR)
Full cheap trio + unit + **full e2e matrix** at pre-merge (src/main touched ⇒ Linux leg required;
note the known `file.e2e` Linux-Docker pre-existing fail if it appears). Title-stamped dev check.
Then open the PR; keep the canvas plan board live (tick items as phases land).

## Doc lifecycle
`REPORT.md` + `PLAN.md` + `design-mock.html` are per-slice specs → **deleted in the merging PR**
(build-history line is the residue). This is feature work — stays on `feat/mcp-add-server`, never `main`.
