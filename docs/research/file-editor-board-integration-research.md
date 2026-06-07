# File Editor Board Integration — Research

> Research only (no decisions locked). Produced 2026-06-04 via a 7-agent workflow:
> 1 codebase scout → 5 parallel dimensions (embedded web editors · full-IDE embed ·
> external native editor · interop protocols · arch+security fit) → synthesis.
> Grounded in the actual Expanse board code + live web sources (see Sources).

## Executive summary

**Recommendation: ship an editor as a CodeMirror 6 HTML React Flow node (Approach A), harden it with an in-MAIN ACP/LSP protocol layer (Approach D), and add a thin "Open in external editor" launcher (Approach C, narrow form). Reject the full-IDE embed (Approach B) outright.**

- **v1 = CodeMirror 6 in an HTML node (shape-a).** It drops into the `BoardFrame` content slot exactly like `PlanningBoard`, so the camera transform clips/rounds/scales it for free — zero ADR-0002 occlusion, no `WebContentsView` cap, no snapshot tax. CM6 beats Monaco for Expanse: ~5–40× smaller bundle, no web workers (so no worker-under-`file://` risk), per-instance state (one canvas = many editor boards), and CSS-token theming. Both are MIT.
- **The killer feature is the live agent-edit diff.** Expanse runs coding agents in Terminal boards; those agents edit files on disk. An editor board with a live diff view (`@codemirror/merge` per-hunk accept/reject) turns the canvas into a review surface where the diff sits spatially next to the terminal that produced it. This is the single strongest justification for the board.
- **Approach D (ACP) is the AI-agent keystone.** Make Expanse an **ACP client in MAIN**, reusing the exact `node-pty` bridge (IPC control plane + MessagePort data plane + frame guards). ACP-native agents (Claude Code, Gemini, Codex, Copilot) then report edits/diffs/plans/permission-prompts *into* canvas-native UI, and their file writes route *through* Expanse's guarded `fs` layer for review-before-apply. Layer the existing `canvas-ade-mcp` underneath as the agent-facing tool plane.
- **Approach B is rejected on three independent disqualifiers:** (1) occlusion — re-pays the entire ADR-0002 native-layer cost on the worst-suited surface (you type in it; snapshot-on-motion freezes mid-edit); (2) security — a loopback code-server is a full filesystem+terminal+extension-host server, forcing relaxation of the http(s)-only `isAllowedPreviewUrl` allowlist and adopting the Host-header/DNS-rebind attack class; (3) licensing — the genuinely useful part (VS Code branding + Marketplace) is Microsoft-proprietary and now *runtime-self-rejecting* in forks, leaving only Open VSX.
- **Approach C is the only path that ever serves Zed users** (Rust/GPUI can never be embedded) and is the cleanest "use my real IDE" escape hatch. Ship it as a small `editor:open` launcher now; defer the rich VSCode companion-extension / ACP-agent-panel back-channel.

---

## Context — Expanse board architecture (the fit constraints)

A board type is a discriminated-union member in `src/renderer/src/lib/boardSchema.ts`: `BoardType = 'terminal' | 'browser' | 'planning'`, each extending `BoardCommon { id, type, x, y, w, h, title, z? }`. Adding a type is a fixed recipe: (a) add the literal to `BoardType` + an interface to the `Board` union; (b) add it to `DEFAULT_BOARD_SIZE`, `DEFAULT_TITLE`, and the `createBoard()` factory switch; (c) add a `case` to `assertBoard()` (and an element validator if it has sub-content); (d) bump `SCHEMA_VERSION` (currently **7** after the v7 text-typography slice + v6 board-groups; see ADR 0004 — next bump is v8) and add a no-op/backfill entry to `MIGRATIONS`; (e) whitelist patchable fields in `PATCHABLE_KEYS` in `canvasStore.ts` (~line 266) — only those keys survive `updateBoard()`; (f) add a `board.type === '…'` branch in `BoardNode.tsx` (a `lazy()` code-split chunk) plus a `TYPE_TAG`/glyph entry in `BoardFrame.tsx` + `TypeGlyph.tsx`.

There is exactly **one** React Flow node type — `nodeTypes = { board: BoardNode }` in `Canvas.tsx:69`. `BoardNode` is the universal custom RF node; it owns LOD/hover/resize/full-view-portal and dispatches by `board.type` to the per-type component, which fills the `BoardFrame` content slot.

**Persistence:** the whole canvas is one `canvas.json` (`CanvasDoc = { schemaVersion, viewport, boards }`); `toObject()` deep-clones boards, `fromObject()` validates+migrates+clamps on load. The **scene/session split is strict** — only those three keys are serialized; selection/tool/draft/hover stay in Zustand and must never be routed into a board or a patch key (Excalidraw's `cleanAppStateForExport` discipline). Heavy blobs go to `assets/<sha1>.<ext>` by path (e.g. `ImageElement.assetId`, stored relative), never inlined.

**Two integration "shapes" already exist:**
- **(a) HTML React Flow node (Planning).** `PlanningBoard.tsx` is plain HTML/SVG inside `BoardFrame`'s content slot, living inside `.react-flow__viewport` — so it is clipped, rounded, rotated, z-ordered, and camera-scaled for free. It is a sandboxed renderer DOM: no Node, no native widgets, no filesystem. Pointer→board mapping is `screenToBoard` (subtract well origin ÷ camera zoom). Edits persist via `store.updateBoard(id, { elements })`.
- **(b) Native `WebContentsView` (Browser).** `src/main/preview.ts` creates one `WebContentsView` per board keyed by id (`partition: preview-${id}` for per-board zoom isolation). It is a native OS layer that paints **above all HTML** — unclippable, no z-index vs HTML (occlusion, ADR-0002). The renderer syncs `setBounds()`+`setZoomFactor()` to the camera via a single rAF batch (`preview:setBoundsBatch`). Mitigations: detach+`capturePage()` snapshot on pan/zoom/LOD/menu-open (`detachAllPreviews`); cap **~4 live**; `webContents.close()` on removal (no `destroy()` → renderer leak).

**Bridges available:**
- **IPC control plane** — `ipcRenderer.invoke(...)` exposed as typed `window.api` methods via `contextBridge`; every MAIN handler is frame-guarded by `isForeignSender()`.
- **MessagePort data plane** — for high-volume/binary streams. MAIN mints a `MessageChannelMain`, transfers `port2` via `webContents.postMessage('pty:port', {id}, [port2])`; preload re-posts it into the main world with `window.postMessage(..., e.ports)` (ports can't cross `contextBridge`); renderer reads `event.ports[0]`.
- **Event push** — `webContents.send('preview:event', …)` → preload `onPreviewEvent` subscriber (payload-only, never the `IpcRendererEvent`).
- **Where Node/native runs** — ONLY in MAIN: `node-pty` (`pty.ts`), `simple-git`, all `fs` (`projectStore.ts`/`projectIpc.ts`). Renderer never touches Node.

**Security invariants a new board MUST respect:** `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, thin preload only; all new IPC frame-guarded with `isForeignSender`; any URL/scheme reaching a native view is allowlisted (`isAllowedPreviewUrl` = http(s) only; `file:`/`data:`/custom rejected); external links → `shell.openExternal` via `setWindowOpenHandler`; Browser-board (untrusted) content must never reach the PTY write channel; path-safety mandatory for any fs IPC (`isUnsafeProjectDir` rejects non-absolute / `..`-traversal).

---

## Approach A — Embedded web editor (Monaco / CodeMirror 6)

This is the **shape-(a)** path and the recommended editor surface. The editor lives inside `.react-flow__viewport`, inheriting the camera `translate()/scale()` transform plus CSS clip/round/z-index for free, identical to `PlanningBoard`.

### Monaco vs CodeMirror 6 decision

| Dimension | Monaco | CodeMirror 6 | Winner |
|---|---|---|---|
| Bundle (gzip) | ~2–5 MB + heavy TS worker | ~50–200 kB modular | **CM6** (5–40×) |
| Web workers | Yes (editor + per-language) — `file://` care | None for core; LSP runs in MAIN anyway | **CM6** |
| electron-vite setup | `?worker` imports + `base:'./'` + CSP `worker-src` | Plain ESM import | **CM6** |
| TS/JS IntelliSense OOTB | Full (hover types, go-to-def, rename) via bundled TS worker | Syntax only; semantic needs external LSP | **Monaco** |
| Multi-instance (many boards) | Global language/theme state → cross-instance conflicts (Sourcegraph Notebooks pain) | Per-instance, fully independent | **CM6** |
| Theming to design tokens | Hardcoded hex in JS theme object | `EditorView.theme` → CSS vars directly | **CM6** |
| Large-file perf | Good once loaded; startup overhead | Incremental viewport render, million-line docs | **CM6** (slight) |
| Diff/merge view | Built-in `DiffEditor`, polished, near-zero work | `@codemirror/merge` (`MergeView` + `unifiedMergeView`) with per-chunk accept/reject gutters | **Tie** (Monaco easier; CM6 more controllable) |
| LSP integration | `monaco-languageclient` v10.7.0, mature but now **requires `@codingame/monaco-vscode-api` v31 shim** (heavy) | `@marimo-team/codemirror-languageserver` (lighter, no VS Code shim) | **CM6** for this context |

**Verdict: CodeMirror 6** is the better default for Expanse's product-embedded, multi-board, CSS-token-themed, bundle-conscious case. Monaco wins only if VS Code-grade TS IntelliSense without a server, or a polished near-free DiffEditor, is a hard requirement.

### Mechanics (electron-vite, Electron `file://`, sandbox)

- **Monaco loader:** use the **ESM `?worker` plugin-free pattern** (Vite emits hashed same-origin worker chunks), NOT `vite-plugin-monaco-editor` (its `monacoeditorwork/` public path resolves wrong under `file://` unless `customDistPath` is set) and NOT the AMD/`min/vs` path (forces a custom `app-asset://` protocol + `bypassCSP`/`webSecurity:false`, violating the security invariants). Set `base: './'` in the renderer config or worker URLs 404 under `file://`. Workers spawned via `?worker` are same-origin module workers — no Node, no `contextBridge`, no `nodeIntegrationInWorker`; CSP needs `worker-src 'self'` + `script-src 'self'` (and must NOT require `unsafe-eval`). Code-split behind the existing `BoardNode.tsx` `lazy()` chunk.
- **CodeMirror 6:** no workers for the core editor or highlighting (synchronous Lezer incremental parsing, fine at 100k+ lines) → the entire worker-under-`file://` problem class evaporates. Pure ESM, tree-shakes cleanly, no special Vite config.

### File I/O under the security model

Editor runs in the sandboxed renderer with no Node; all `fs` goes through new frame-guarded `invoke` handlers mirroring `projectIpc.ts`/`projectStore.ts`, reusing `write-file-atomic`, scoped to the project dir via `isUnsafeProjectDir` + a `withinProject` allowlist on *every* handler.

```ts
// preload → window.api.editor:
editor.open(path): Promise<{ text; mtimeMs; encoding:'utf8' }>
editor.save(path, text, baseMtimeMs?): Promise<{ ok:true; mtimeMs } | { ok:false; reason:'stale'|'unsafe' }>
editor.list(dirPath): Promise<Array<{ name; isDir }>>
editor.watch(path) / editor.unwatch(subId)
```

MAIN handlers: `isForeignSender(e.sender)` guard → `isUnsafeProjectDir(path) || !withinProject(path)` reject → optional `baseMtimeMs` stat check returning `'stale'` (optimistic concurrency vs agent edits) → `writeFileAtomic`. **File watch** uses **chokidar** (not raw `fs.watch`) in MAIN, debounced, keyed by board id, pushed via `webContents.send('editor:change', payload)` → preload subscriber (the `onPreviewEvent` pattern, payload-only).

### LSP plan (deferred fast-follow)

An LSP server is just another MAIN-spawned child process (like `node-pty`): `child_process.spawn(... --stdio)` for `typescript-language-server`, `pyright-langserver`, `rust-analyzer`, `gopls`, etc. MAIN owns lifecycle (spawn/kill-tree, same `taskkill /T /F`). **Bridge over a MessagePort** (the `pty:port` pattern) — strictly better than the websocket transport every public tutorial shows (those assume a remote server; no extra port to secure). Renderer client lib: `@marimo-team/codemirror-languageserver` (CM6, lightweight, no VS Code shim) pointed at the MessagePort. **Run one server per `(language × projectRoot)`, not per board** — multiple editor boards share one instance via per-file `textDocument/didOpen`, ref-counted, shut on last close. Lazy-spawn, debounce `didChange`, cap concurrency (~3–4). `tsserver`/`pyright` are RAM/CPU heavy and slow to cold-start — defer LSP past first ship.

### Diff / agent-edit angle (the killer feature)

`@codemirror/merge`: `unifiedMergeView({ original })` renders deletions as inline widgets with **per-chunk accept/reject gutter buttons** (`mergeControls`), plus `collapseUnchanged` and `highlightChanges`; `MergeView` gives side-by-side. Maps perfectly onto "here's what the agent changed — keep or revert this hunk." **Diff source:** compute in MAIN (where `simple-git` lives) — `git diff` for tracked files, or a "last-seen snapshot per watched file" diff for the live-edit case; stream the patch to the renderer over the event/port channel.

### Effort (CM6 / Monaco)

Board scaffolding ~0.5d regardless of engine. A (read-only viewer) ~1.5–2d / ~2.5–3d · B (editable + atomic save) ~1–1.5d each · C (watch + live reload) ~1d each · D (tabs/multi-file) ~1.5–2d each · E (agent-edit diff) ~2–3d / ~1.5–2d · F (LSP fast-follow) ~3–4d / ~4–5d. **MVP (A–C):** ~3.5–4.5d CM6, ~4.5–5.5d Monaco. **Full editor + diff (A–E):** ~7–9d CM6, ~8–10d Monaco.

---

## Approach B — Full-IDE embed (code-server / OpenVSCode / Theia / vscode.dev)

**Verdict: strategic dead-end for an on-canvas editor board.** Every viable variant (a) legally cannot ship/connect to Microsoft's proprietary stack for a commercial product, dropping to the thinner Open VSX ecosystem, AND (b) inherits every ADR-0002 occlusion + ~4-live-cap + camera-sync/snapshot tax of the native `WebContentsView` path, AND (c) costs ~one full Node server + one full browser workbench per board (~250–500 MB+ each).

| | code-server (Coder) | OpenVSCode (Gitpod) | Eclipse Theia | vscode.dev (MS-hosted) |
|---|---|---|---|---|
| What | Code-OSS patched as a long-lived web server; batteries-included | Upstream `microsoft/vscode` + minimal HTTP-serve delta | Framework to *build your own IDE* (workbench reimpl., consumes VS Code ext API + Monaco) | Microsoft's own hosted browser VS Code |
| License (engine) | **MIT** | **MIT** | **EPL-2.0** | **MS proprietary, hosted** — no redistribution |
| Marketplace | Open VSX only (legally) | Open VSX only | Open VSX only | Full MS Marketplace but web-extensions only, *because MS is the host* |
| Cost/board | ≥2 GB RAM + 2 cores (Coder floor); node grows even idle | Same class | Comparable or more | One heavy Chromium SPA renderer (your cost) |
| FS access | Full native FS (server user) | Native FS | Native FS | **No native FS** — File System Access API (Chromium-only, per-folder prompt every session, no silent write) |
| Terminal | Built-in (duplicates Expanse Terminal boards + own PTY) | Built-in (dup) | Built-in (dup) | None |
| Canvas fit | Native `WebContentsView` only → full occlusion | Same | Same | Could iframe — but framing breaks GitHub auth + CSP |
| Net | Heaviest, Open-VSX-locked, occludes | Leanest engine, you build auth/proxy | Only one designed for commercial embed/white-label, but "build an IDE" scale | **Not shippable** |

**Licensing landmines (can kill the approach):**
1. **Code-OSS (MIT) ≠ Visual Studio Code (proprietary).** MS builds VS Code from the MIT repo + a customized `product.json` (telemetry, gallery URL, branding) released under a proprietary, trademarked license. Forks ship the clean MIT source → legal, but lose MS branding, Marketplace, and MS-only extensions.
2. **Marketplace Terms forbid non-Microsoft clients** — Offerings are "intended for use only with Visual Studio Products and Services." Confined to **Open VSX** (~10k+ exts, vendor-neutral, missing the big proprietary ones).
3. **(DECISIVE, 2025) MS now runtime-enforces this.** **C/C++ extension v1.24.5 (Apr 3, 2025)** added an environment check: closed-source binaries (`cpptools`, `cpptools-srv`) detect the host app ID and **refuse to run** outside official MS products — broke VSCodium, Cursor, and any code-server/OpenVSCode/Theia build. **Pylance** has done this for years and is not on Open VSX. The **C# debugger** is licensed to MS VS Code only. Even side-loaded, the high-value extensions self-reject → you ship a measurably weaker editor and must say so.
4. **MS "VS Code Server" / Remote Tunnels** license prohibits hosting-as-a-service and is account-bound — cannot legally wrap as Expanse's backend.

**Occlusion verdict:** a full workbench is strictly *worse* than a Browser board, which is already the constrained case. An IDE is the worst possible content for the snapshot-on-motion model — it's a continuous-interaction surface (typing, hover tooltips, autocomplete popups), and its own internal popups are native-view paints that occlude canvas chrome (the ADR-0002 failure mode, multiplied). The ~2 GB/instance memory wall caps you at ~1–2 live workbenches, far under the 4-view cap, *competing for RAM with the agent CLIs in Terminal boards*. The iframe escape doesn't exist for the embeddable options (only `vscode.dev`, and its framing/auth are broken + non-redistributable).

**Other fit problems:** terminal duplication (two PTY stacks bypassing the `isForeignSender` guards and the "Browser content must never reach PTY" invariant); the workbench's server has its own *unscoped* FS access (backwards from Expanse's project-scoped `isUnsafeProjectDir` design); you must relax `isAllowedPreviewUrl` for the loopback server.

**Effort:** vscode.dev iframe = days then abandon (net negative). code-server/OpenVSCode in a view = 3–6 weeks to a rough demo, then months to de-jank, still Open-VSX-only. Theia = multi-month sub-project. **If a literal full VS Code is ever a hard requirement, scope it as a separate full-window "IDE mode" launching self-hosted code-server/OpenVSCode (MIT) with Open VSX — explicitly off the canvas and outside the ~4-live native-view budget — and document the limitation.**

---

## Approach C — External native editor (VSCode / Zed / JetBrains)

Thesis: Expanse does not embed an editor; it **spawns/signals the user's existing native editor** as a separate OS app via the shell (NOT via the PTY data channel), optionally with a companion extension phoning back into the canvas. This is the **only viable route for Zed**.

| Capability | VSCode | Zed | JetBrains |
|---|---|---|---|
| Launcher | `code` | `zed` | `idea`/`pycharm`/`webstorm`… (`idea64.exe` Win) |
| Open at line:col | `code -g <file>:<line>:<col>` | `zed app.ts:42:10` (positional) | `idea --line N --column N <file>` (separate flags) |
| Reuse window | `-r`/`--reuse-window` | `-r`/`--reuse`; `-a`/`--add` | auto if file in open project; else LightEdit |
| Block until close | `-w`/`--wait` | `-w`/`--wait` (exit code = save) | via wrapper |
| Diff | `--diff a b` | `--diff old new` | `diff a b` |
| Remote | `--remote ssh-remote+host`; VSCode Server | `zed ssh://…` native | JetBrains Gateway |
| URI deep-link | `vscode://file/<abs>:<line>:<col>` (rich `UriHandler`) | `zed://`, `file://`, `ssh://` (no rich line deep-link — line via CLI) | none first-class — use CLI |
| Extension API (observe) | **Rich** — full Node host: `window.tabGroups.all`, `onDidChangeTabs`, `TabInputText.uri`, `activeTextEditor`, `onDidChangeActiveTextEditor`, `TextEditor.selection`, `workspace.onDidChangeTextDocument` | **WASM, sandboxed** — no general Node host; back-channel is **ACP**, not editor-state observation | JVM plugin SDK (powerful but heavyweight) |
| Embeddable in canvas? | partially (vscode-web = Approach B) | **NO — GPUI renders direct to GPU shaders, no webview/DOM. External-only is the sole route.** | NO (JVM/native) |

**The Zed/ACP angle (uniquely fits Expanse):** Zed's two-way story is the **Agent Client Protocol (ACP)** — JSON-RPC over stdio, the editor-side mirror of MCP. Zed already runs Claude Code/Gemini/Codex as ACP agents (`agent_servers` in `settings.json`). **Expanse-as-ACP-agent/bridge** lets Zed (or JetBrains, which adopted ACP across IntelliJ/PyCharm/WebStorm by early 2026) point an `agent_servers` entry at an Expanse shim and surface canvas context/diffs/tasks into the editor's agent panel — the one integration turning "editor outside the canvas" into a real bidirectional loop without embedding, reusing Expanse's stdio-JSON-RPC competence. (ACP boundaries: forwards model/mode/env/MCP servers; no profiles/tool-permissions, no message-edit/thread-resume/checkpointing for external agents yet.)

**Companion VSCode extension (best two-way bridge of the three, VSCode-only):** the extension host is a full Node process → observe via `tabGroups`/selection/edit listeners; control via `commands.executeCommand('vscode.diff', …)`/`revealLine`/`UriHandler`; talk back via a local `ws://127.0.0.1` server or (cleaner) the app's existing MCP. MAIN relays to the renderer via `webContents.send('editor:change', …)`. Zed has no equivalent (WASM); JetBrains via a costly full plugin.

**UX sketch:** Primary = an "Open in editor" affordance (button/context-menu on Terminal boards for cwd/referenced file; `file:line` anchor on Planning notes/checklist items). Settings store a path-safe command template (`code -g {file}:{line}:{col}`, `zed {file}:{line}:{col}`, `idea --line {line} --column {col} {file}`). MAIN `child_process.spawn` via a new frame-guarded `editor:open` handler with `isUnsafeProjectDir` path-safety. **Prefer the CLI over URI schemes** for line-targeting (more reliable reuse-window; Zed/JetBrains line-targeting *only* exists via CLI). Optional secondary = an "External Editor" status board (HTML node, shape-a) mirroring what the editor has open, fed by companion-extension → MCP/local-ws → MAIN → `editor:change` push — a launcher/mirror, not an editor, so zero occlusion.

**Pros:** zero embedding/rendering tax; full native editor power for free (real extensions/keybindings/LSP/debuggers/AI); the only Zed path; respects the user's setup; composes with MCP/ACP. **Cons:** breaks the single-surface thesis (editor is a separate OS window); OS-specific + setup-fragile launcher detection; weak two-way state by default (rich back-channel exists only per-editor via three different mechanisms); no camera/composite integration; security surface (allowlisted launcher templates, path-safety, localhost-only + origin checks on any back-channel).

**Effort:** **S (days)** = `editor:open` launcher + Settings picker + Terminal/Planning anchors (covers all three editors). **M (1–2 wks)** = companion VSCode extension + status mirror (VSCode-only). **L (weeks, post-MCP)** = ACP bridge so Zed/JetBrains agent panels talk to the canvas (highest value for Zed cohort, reuses stdio-JSON-RPC).

---

## Approach D — Interop protocol layer (ACP / LSP / DAP / MCP) — the AI-agent keystone

This is a *layer, not a surface* — it composes with A (the editor board) or C (external editor). The single highest-leverage move: make **Expanse itself an ACP client**, turning the canvas from a passive shell hosting a CLI into the **hub** between human, agents, and a structured editor surface.

### ACP (Agent Client Protocol)

- **What:** open **JSON-RPC 2.0 over stdio** standard decoupling editors from coding agents (1:N, "the LSP for AI coding agents"). Introduced by **Zed, Aug 2025**; JetBrains joined within weeks. **Apache-2.0**; stable wire `protocolVersion: 1` (negotiated at `initialize`, independent of SDK version, TS SDK at v0.24.x). **Client** = editor/UI (owns environment, user, screen, **filesystem**; launches the agent as a subprocess over stdio). **Agent** = the AI program (Claude Code, Gemini, Codex…) as that subprocess.
- **Lifecycle:** `initialize` (negotiate version + capabilities: client `fs.readTextFile`/`fs.writeTextFile`/`terminal`, agent `loadSession`/`promptCapabilities`) → `authenticate` → `session/new` (can declare `mcpServers` — the ACP↔MCP bridge) / `session/load` → `session/prompt` (returns a stop reason) → `session/cancel` → `session/set_mode`.
- **Agent→Client (the canvas-rendering half):** `session/update` (notification streaming message chunks, **thought** chunks, **tool calls + updates**, **plans**, commands, mode changes) · `session/request_permission` (one permission UI in the editor for *every* agent) · **`fs/read_text_file`** + **`fs/write_text_file`** (agent asks the CLIENT to read/write — incl. unsaved buffers) · `terminal/create|output|wait_for_exit|kill|release`.
- **The diff payload:** a `tool_call` carries `path`, `oldText` (`null` for new file), `newText`; plus `status` (pending/in_progress/completed/failed), `kind` (read/edit/delete/move/search/execute/think/fetch), and `locations[]` (`{path, line?}` → **follow-along** highlight of the exact file+line the agent is touching). Exactly the data an editor/diff board needs — no ANSI parsing.
- **Ecosystem (2026):** clients = Zed, JetBrains AI Assistant, Neovim/Emacs/VS Code community ports. Agents Expanse would consume = **Claude Code (`claude-code-acp`), Gemini CLI, Codex (`codex-acp`), GitHub Copilot CLI (public preview 2026-01-28)**, plus Goose/OpenCode/OpenHands/Cursor/Cline and ~20 more. The same agents Expanse users already type into Terminal boards ship ACP modes.

**Expanse-as-ACP-client maps onto the repo bridge ~1:1:** ACP client lives in **MAIN** (where `node-pty`/`simple-git`/`fs` live), using the SDK's `ClientSideConnection` over the agent subprocess's stdio. Spawn the agent as a *new "Agent board" mode* (structured chat+plan+diff UI) **and** keep the existing PTY Terminal board (ACP is additive, the always-works fallback). Wiring: control plane = frame-guarded IPC (`acp:spawn`/`prompt`/`cancel`/`setMode`/`permissionResponse`); data plane = MessagePort per session (transfer `port2` like `pty:port`); permission prompts = event-push → canvas modal → resolve over IPC.

**The decisive insight — `fs/*` is CLIENT-side.** Agent edits route *through* Expanse: show the diff, gate behind a review board, persist atomically (`write-file-atomic`/`project:save`) — all *before* disk if desired. Every `fs/*` request funnels through `isUnsafeProjectDir`, project-scoped — strictly safer and more observable than the bare-CLI-writes-to-disk model. **Unlocks:** live agent-edit diffs · follow-along auto-pan · unified cross-agent permission UX · agent plans/reasoning as a Planning checklist · agent-agnostic by construction · multi-agent (N sessions = N child processes). **Caveat:** ACP is young, SDK pre-1.0; gate every feature on the `initialize` capability handshake, keep PTY as fallback, flag the Agent board as experimental (`session/prompt` has an observed silent-fail on session-limit — handle stop-reasons defensively).

### LSP

Run the language server as a MAIN child process; renderer = LSP client (`@marimo-team/codemirror-languageserver` for CM6, or `monaco-languageclient` v10.7.0 + `vscode-ws-jsonrpc` for Monaco — the latter now needs the heavy `@codingame/monaco-vscode-api` shim). Route JSON-RPC over a **MessagePort**; spawn/stop over frame-guarded IPC (`lsp:start`/`lsp:stop`); `publishDiagnostics` pushed → squiggles. **One server per `(projectRoot, languageId)`, ref-counted** — the LSP spec assumes one-server-per-tool with no support for sharing one server across *different workspaces*; multiple boards in the *same* project share one instance (correct — shared document store), but never fake a shared client across roots.

### DAP (deferred)

Debug Adapter Protocol — JSON-based (header+content over stdio, *similar to but NOT wire-compatible with* LSP's JSON-RPC). Future "Debug board" / editor overlay: MAIN spawns the debug adapter (node-pty lifecycle), renderer drives breakpoints/stepping over a MessagePort. Synergy: an ACP agent launches a debug session, canvas surfaces DAP stack frames + agent reasoning side-by-side. **Defer to post-LSP**; design the IPC namespace (`editor:*`, `lsp:*`, `dap:*`, `acp:*`) with room now. Keep adapters separate — don't share a generic JSON-RPC client across LSP/DAP/ACP.

### MCP vs ACP — complementary, not competing

**"MCP gives the agent *tools*; ACP gives the agent an *editor*."** They compose: at `session/new`, the ACP client passes `mcpServers` to the agent.

| | MCP | ACP |
|---|---|---|
| Question | What tools/data can the agent reach? | How does the editor talk to the agent + surface its work? |
| "Server" is | The tool provider (`canvas-ade-mcp`) | The agent responds; the editor is the client |
| Filesystem | Agent calls an `fs` *tool* you expose | Agent calls `fs/write_text_file` **on the client** |
| Maturity (2026) | Large — thousands of servers | Newer (Aug 2025), growing fast, Apache-2.0 |
| Expanse asset | `@expanse-ade/mcp` 0.8.0 (M0–M4) | Not yet — the proposed keystone |

**Best architecture = do both, layered:** Expanse-as-ACP-client for the human-facing per-agent session UX (richest with ACP-native CLIs — diffs/follow-along/plans/permissions for free); `canvas-ade-mcp` tools (extended with `read_file`/`write_file`/`apply_patch`/`list_diff` scoped via `isUnsafeProjectDir`) as the agent-facing, canvas-aware capability set passed in via `session/new`'s `mcpServers` — the channel for *any* agent (including non-ACP/headless/swarm) and for canvas-specific affordances. (Naming caution: Zed's *Agent Client* Protocol ≠ IBM's *Agent Communication* Protocol, folded into A2A Aug 2025 — document the distinction in an ADR.)

### File-watch + diff loop (reconciling three edit sources)

Sources of truth: (1) human editor-board edits, (2) PTY Terminal-board agent edits (bare CLI writes straight to disk), (3) ACP agent edits (`fs/write_text_file` through MAIN). **Watch layer:** chokidar in MAIN scoped to the project dir (ignoring `node_modules`/`.git`/`assets`), debounced/coalesced (the `preview:setBoundsBatch` discipline), pushed via `webContents.send('editor:change', …)`. Editor board hot-reloads a *clean* buffer, shows a "changed on disk — reload/keep/diff" banner for a *dirty* one. **Precedence (avoid write-fight loops):** ACP edits arrive as a diff before disk → apply, persist, tag self-originated (path+hash recent-set) and **suppress** the watcher echo; PTY edits only via watcher (CLI owns disk); editor saves via `write-file-atomic`, self-tagged. **Diff/review:** ACP `tool_call` diff *is* the review unit (per-hunk accept/reject; permission + diff are the *same* moment); PTY fallback = compute diff in MAIN via `simple-git` against HEAD/a pre-prompt snapshot. Review state stays session/ephemeral (Zustand), never serialized.

---

## Comparison matrix

Ratings = quality-of-fit for Expanse (High = strong / low risk). AI-agent synergy weighted HIGH per the product thesis.

| Dimension | **A — Monaco/CM6 HTML node** | **B — Full-IDE embed (WebContentsView)** | **C — External native editor** | **D — Protocol layer (ACP/LSP/MCP)** |
|---|---|---|---|---|
| **Fit** (board union, camera-sync, canvas.json) | **High** — `BoardFrame` slot like Planning; camera clips/scales free; one new `BoardType` | **Low** — native view outside the viewport; rAF `setBoundsBatch` + detach/snapshot; editor scroll fights camera | **Med** — editor off-canvas; canvas holds a light proxy/status board only | **N/A (layer)** — MAIN child process; touches board model via a thin status field |
| **Occlusion** (ADR-0002, ~4-live cap) | **High** — renderer DOM, fully composited; no cap, no snapshot | **Low** — paints above all HTML; ~4-live cap; freeze-snapshot on the worst surface (you type in it); internal popups occlude chrome | **High** — nothing native on canvas; real editor is a separate OS window | **High** — invisible, no surface |
| **Security** (sandbox/no-Node; attack surface; Host-header) | **High** — sandboxed renderer; new `invoke` cloned from `asset:*` + `isUnsafeProjectDir`; editor executes nothing | **Low** — loopback full FS+terminal+ext-host server; must relax `isAllowedPreviewUrl`; Host-header/DNS-rebind class | **Med** — editor outside sandbox (not Expanse's surface); allowlisted spawn + bridge socket = new trust boundary | **High/Med** — ACP/LSP = stdio JSON-RPC (node-pty trust model, no net surface); MCP-over-HTTP reintroduces Host-header |
| **Effort** | **Med** — 6-step recipe + integration; CM6 leaner; LSP deferred | **High** — ship/version/patch a per-OS IDE runtime + ext story; months to de-jank | **Med-High** — per-editor launch/detect/bridge differs; ACP collapses much of it | **Med** — MAIN client + renderer diff/status; reusable across A & C; highest leverage |
| **AI-agent synergy** *(weighted HIGH)* | **High** — first-class diff/merge; agent edits stream over MessagePort next to the Terminal board | **Med** — IDE's *own* agent features, siloed, uncomposable | **Med-High** — Zed/JetBrains speak ACP (Expanse could drive the real editor) but off-canvas | **High** — THE enabler: ACP live diffs, LSP intelligence, `canvas-ade-mcp` swarm |
| **Cross-platform** | **High** — pure web + Electron, identical 3-OS | **Med** — runtime cross-platform but per-OS maintenance | **Low** — depends on user's installed editor; detect/bridge differs per editor per OS | **High** — stdio/JSON-RPC OS-agnostic, ships with the app |
| **Licensing** | **High (safe)** — Monaco MIT, CM6 MIT | **Low (risky)** — code-server/OpenVSCode MIT but VS Code branding + Marketplace proprietary (Open-VSX only, runtime-self-rejecting exts); Theia EPL-2.0; vscode.dev non-redistributable | **Med** — user installs editor (clear); JetBrains/commercial EULA nuance for programmatic driving | **High (safe)** — ACP Apache-2.0, LSP open, MCP open |

---

## Security & occlusion analysis

**Occlusion (ADR-0002) is the load-bearing constraint.** A `WebContentsView` is a native OS layer that paints above ALL HTML — unclippable, unrounded, unrotatable, no z-index vs HTML. Expanse already paid this tax once for the Browser board with an elaborate detach/`capturePage()`-snapshot/~4-live-cap regime. An editor is the *worst* surface to re-pay it on: it's a continuous-interaction surface where freeze-on-motion happens mid-keystroke, and its own popups (IntelliSense, command palette, hover) are native paints that occlude canvas chrome. The HTML-node path (A) eliminates ~100% of the camera-sync/snapshot/detach/cap/per-board-session machinery and removes the occlusion class entirely. **This is why A is correct and B is rejected.**

**Filesystem trust boundary.** A general file editor is a bigger blast radius than the asset writer — path-safety is load-bearing, not incidental:
- Every new fs IPC (`editor:open/save/list/watch`, `acp:*` `fs/*`, MCP `read_file`/`write_file`) MUST frame-guard with `isForeignSender` AND scope to the project dir via `isUnsafeProjectDir` + a `withinProject` allowlist (reject non-absolute, reject `..`-traversal, reject outside root). Extend `isUnsafeProjectDir` to per-file paths.
- Browser-board (untrusted) content must never reach the write channel — same invariant as the PTY channel.
- **The ACP `fs/*`-is-client-side property is a security *win*:** the agent's reads/writes route through MAIN under the project sandbox, more observable and gateable than the bare-CLI-writes-to-disk model.

**Host-header / DNS-rebind.** Tracked in memory `mcp-spec-state-2026-06` ("Host-header CVE = browser-board attack vector, add ADR"). **Approach B triggers it** (a malicious page could reach a loopback IDE server with FS+shell) — a primary disqualifier. **Prefer stdio transports** for ACP/LSP/MCP to keep zero new network surface; any MCP-over-HTTP must get its own ADR + host-allowlist before a localhost server is loaded into a view.

**Concurrent-write races.** Agent and user can both write the same file → optimistic concurrency (`baseMtimeMs` → `'stale'`), conflict prompt, and lean on the watch+diff flow so external changes are always visible. Self-originated-write tagging (path+hash) suppresses watcher echo reloads. MessagePort/process lifecycles (ACP sessions, LSP servers, view ports) must tear down on board close (the node-pty "kill the tree" + preview "close, never leak" discipline).

**Camera-transform hit-testing (A's top risk).** A text editor's virtualized scroll, cursor hit-testing, IME, and autocomplete popovers live inside a `scale()`d, translated parent — expect coordinate/hit-test bugs at non-1.0 zoom (the class the project hit with native views and synthetic-vs-real input; memories `e2e-sendinputevent-vs-dispatchevent`, `paste-fires-at-document`). Mitigation: snap to integer zoom when an editor board is focused, or render the editor at a fixed internal scale and scale only the frame. **CM6 is the safer bet than Monaco** (Monaco's worker model + absolute-positioned layers are more brittle under a scaled parent).

---

## Recommended path (phased)

**Verdict: A as v1, hardened by D, with C as a lightweight escape hatch. B rejected.**

- **Phase 1 (v1) — Editor board = CodeMirror 6 HTML React Flow node.** Add `'editor'` to `BoardType` via the 6-step recipe. File read/write/watch through new frame-guarded `invoke` handlers cloned from `asset:write`/`asset:read`, scoped via `isUnsafeProjectDir` (extended to file paths), reusing `write-file-atomic`. CM6 over Monaco (MIT, leaner lazy chunk, friendlier under the camera transform). Shippable on its own as a viewer/light editor.
- **Phase 2 — Protocol bridge (D), the synergy layer.** Run an ACP agent and/or a language server as a MAIN child process (the exact `node-pty` shape: spawn in MAIN, control over `ipcRenderer.invoke`, high-volume edit/diagnostic streams over a MessagePort, change-push via `webContents.send`). Compute diffs in MAIN; render as CM6 inline decorations / `@codemirror/merge` views with per-hunk accept/reject — co-located with the Terminal board running the agent. **Prefer stdio transports** (zero new network surface). Dovetails with the in-flight `canvas-ade-mcp` swarm layer (PR #32) and Context subsystem (PR #39).
- **Phase 3 (low effort) — "Open in VSCode/Zed" external affordance (C, narrow form).** A board action launching the user's real editor at the file/folder (MAIN `shell`/`spawn`, allowlisted args, path-safe template). Don't build a full bridge; if the target speaks ACP, the Phase-2 layer can drive it. Serves power users (and Zed users, who can never be embedded) without making Expanse depend on it for the core feature.
- **Rejected — B (full-IDE embed).** Fails on occlusion, security (Host-header), and licensing — any one disqualifying. The cost is "ship and version a second editor product"; the canvas fit is the worst of all four.

---

## What an editor board persists (canvas.json / schemaVersion)

An editor board persists **only view/session pointers, never file contents** — file bytes live on disk in the project dir (single source of truth, read/written through the `asset:*`-style IPC; consistent with the `assets/` blob-by-path rule).

The `EditorBoard` interface carries: `filePath` (project-relative POSIX path — like `ImageElement.assetId` is relative, never absolute, so the folder stays portable), `cursor` (`{ line, col }` or offset), `scrollTop`/`scrollLeft` (or first-visible line), light view config (`language`/`wrap`/`readOnly`), and optionally `tabs: filePath[]` + `activeTab`. `PATCHABLE_KEYS.editor` whitelists exactly these.

**Never serialize** the document text, in-flight diff/agent-edit state, selection, or LSP diagnostics — those are session state and must stay in React/Zustand per the strict scene/session contract enforced in `toObject` and `PATCHABLE_KEYS` (Excalidraw's `cleanAppStateForExport`). This keeps autosave cheap and avoids `canvas.json` ballooning with — or going stale against — file contents that change on disk underneath it. Cursor/scroll `viewState` is best-effort.

**Migration:** adding `'editor'` is additive (a brand-new union member, all-new fields) → the existing no-backfill pattern. Bump `SCHEMA_VERSION 4 → 5` and add `MIGRATIONS[4] = (doc) => ({ ...doc, schemaVersion: 5 })`, exactly like v3→v4 (image-element) and v2→v3 (locked/groupId). Old docs have no editor boards → nothing to backfill. `assertBoard` gains an `'editor'` case validating `filePath` is a non-empty string and cursor/scroll are finite. **Caveat:** a persisted `filePath` whose file no longer exists must NOT fail the load — clear-or-mark-missing on read, mirroring the existing dangling-`previewSourceId` cleanup in `fromObject` (drops a stale reference rather than throwing).

---

## Open questions

- **CM6 vs Monaco final call** is "CM6 unless first-class TS semantic IntelliSense-without-a-server becomes a hard requirement." If the LSP-in-MAIN layer (Phase 2) lands reliably, CM6's only Monaco gap closes — confirming CM6. [unverified: whether `@marimo-team/codemirror-languageserver` over a MessagePort transport is as turnkey as advertised; public docs assume WebSocket]
- **Camera-transform editing UX:** does snapping to integer zoom on focus, or fixed-internal-scale rendering, fully resolve hit-test/IME/popover bugs under `scale()`? Needs a spike with real `sendInputEvent` probes (synthetic dispatch gives false-greens here — memory `e2e-sendinputevent-vs-dispatchevent`). [unverified]
- **ACP SDK stability:** TS SDK is pre-1.0 (v0.24.x) and fast-moving; pin a version and re-validate the `initialize` capability set per agent. The `claude-agent-acp` silent-fail on session-limit (issue #146) needs a defensive stop-reason handler. [partially verified — issue exists]
- **Contradiction to resolve — "share one LSP server across boards":** Approach A's finding says "share one server across boards (per project root)"; Approach D clarifies the LSP spec *forbids* sharing across *different workspaces* but *supports* sharing across boards in the *same* workspace root. **Resolution: one server per `(projectRoot, languageId)`, ref-counted; boards in the same project share, boards in different projects get separate servers.** No real contradiction — both findings agree once "same project" is made explicit.
- **Diff-source unification:** ACP gives structured `oldText`/`newText`; PTY agents need a MAIN-computed `simple-git` diff. Should the editor board render both through one diff component fed by a normalized patch shape? (Recommended, but the normalization layer is unspecified.) [unverified]
- **MCP file-tools vs ACP `fs/*` overlap:** if both are active, which is authoritative for a write, and how is double-application prevented? (Likely: ACP `fs/*` for ACP-native sessions, MCP tools only for non-ACP/swarm agents — but the arbitration is unspecified.) [unverified]
- **Companion-extension distribution:** an Open-VSX/Marketplace listing + an in-app "Install companion extension" affordance is real surface area for the VSCode two-way bridge (Approach C, Phase M); scope and update-coupling to VSCode's API are open. [unverified]
- **Bundle budget:** confirm the CM6 + `@codemirror/merge` + lang-packs lazy chunk size against the renderer budget once language coverage is chosen. [unverified]

---

## Sources

**Embedded editors (Monaco / CodeMirror)**
- https://github.com/vdesjs/vite-plugin-monaco-editor/blob/master/README.md
- https://www.npmjs.com/package/vite-plugin-monaco-editor
- https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md
- https://github.com/microsoft/monaco-editor/blob/main/samples/browser-esm-vite-react/src/userWorker.ts
- https://github.com/vitejs/vite/discussions/1791
- https://github.com/vitejs/vite/discussions/21426
- https://www.jameskerr.blog/posts/offline-monaco-editor-in-electron/
- https://github.com/microsoft/monaco-editor/issues/2285
- https://electron-vite.org/guide/assets.html
- https://electron-vite.org/guide/build
- https://vite.dev/guide/assets
- https://sourcegraph.com/blog/migrating-monaco-codemirror
- https://www.pkgpulse.com/guides/monaco-editor-vs-codemirror-6-vs-sandpack-in-browser-2026
- https://agenthicks.com/research/codemirror-vs-monaco-editor-comparison
- https://github.com/TypeFox/monaco-languageclient
- https://www.npmjs.com/package/monaco-languageclient
- https://www.typefox.io/blog/monaco-languageclient-v10/
- https://www.npmjs.com/package/vscode-ws-jsonrpc
- https://www.typefox.io/blog/teaching-the-language-server-protocol-to-microsofts-monaco-editor/
- https://www.npmjs.com/package/@marimo-team/codemirror-languageserver
- https://github.com/marimo-team/codemirror-languageserver
- https://github.com/FurqanSoftware/codemirror-languageserver
- https://github.com/codemirror/merge
- https://www.npmjs.com/package/@codemirror/merge
- https://codemirror.net/docs/ref/

**Full-IDE embed (code-server / OpenVSCode / Theia / vscode.dev) + licensing**
- https://github.com/coder/code-server/blob/main/LICENSE
- https://github.com/coder/code-server/discussions/6026
- https://coder.com/docs/code-server/requirements
- https://github.com/coder/code-server/issues/814
- https://github.com/coder/code-marketplace
- https://github.com/gitpod-io/openvscode-server
- https://github.com/coder/code-server/discussions/4267
- https://blogs.eclipse.org/post/mike-milinkovich/eclipse-theia-and-vs-code-differences-explained
- https://eclipsesource.com/blogs/2024/07/12/vs-code-vs-theia-ide/
- https://newsroom.eclipse.org/news/community-news/eclipse-open-vsx-free-marketplace-vs-code-extensions
- https://en.wikipedia.org/wiki/Open_VSX
- https://github.com/VSCodium/vscodium
- https://vscodium.com/
- https://code.visualstudio.com/license
- https://www.theregister.com/2025/04/24/microsoft_vs_code_subtracts_cc_extension/
- https://github.com/VSCodium/vscodium/issues/2300
- https://github.com/microsoft/pylance-release/issues/4886
- https://open-vsx.org/extension/muhammad-sammy/csharp
- https://code.visualstudio.com/docs/remote/vscode-server
- https://www.amitmerchant.com/how-vscode-dev-interacts-with-user-local-filesystem/
- https://github.com/microsoft/vscode/issues/150152
- https://blog.mattbierner.com/vscode-webview-web-learnings/
- https://underjord.io/the-best-parts-of-visual-studio-code-are-proprietary.html

**External native editor (VSCode / Zed / JetBrains)**
- https://code.visualstudio.com/docs/configure/command-line
- https://github.com/Microsoft/vscode/issues/27997
- https://huami.ng/2025/7/20/vs-code-cli-and-url-schemes/
- https://code.visualstudio.com/api/references/vscode-api
- https://zed.dev/docs/reference/cli
- https://zed.dev/acp
- https://zed.dev/docs/ai/external-agents
- https://zed.dev/blog/acp-registry
- https://blog.jetbrains.com/ai/2025/10/jetbrains-zed-open-interoperability-for-ai-coding-agents-in-your-ide/
- https://github.com/zed-industries/agent-client-protocol
- https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md
- https://coderoasis.com/zed-1-0-electron-cpu-ram-problem-rust-gpu-editor-2026/
- https://www.jetbrains.com/help/idea/opening-files-from-command-line.html
- https://www.jetbrains.com/help/idea/working-with-the-ide-features-from-command-line.html
- https://www.jetbrains.com/help/idea/remote-development-a.html

**Interop protocols (ACP / LSP / DAP / MCP)**
- https://agentclientprotocol.com/get-started/introduction
- https://agentclientprotocol.com/protocol/overview
- https://agentclientprotocol.com/protocol/session-modes
- https://agentclientprotocol.com/protocol/file-system
- https://agentclientprotocol.com/protocol/tool-calls
- https://agentclientprotocol.com/get-started/clients
- https://agentclientprotocol.com/get-started/agents
- https://github.com/agentclientprotocol/agent-client-protocol
- https://agentclientprotocol.github.io/typescript-sdk/
- https://agentclientprotocol.github.io/typescript-sdk/classes/ClientSideConnection.html
- https://www.jetbrains.com/help/ai-assistant/acp.html
- https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/
- https://blog.marcnuri.com/agent-client-protocol-acp-introduction
- https://github.com/agentclientprotocol/claude-agent-acp/issues/146
- https://www.contextstudios.ai/blog/acp-vs-mcp-the-protocol-war-that-will-define-ai-coding-in-2026
- https://zylos.ai/research/2026-03-26-agent-interoperability-protocols-mcp-a2a-acp-convergence
- https://www.morphllm.com/agent-client-protocol
- https://en.wikipedia.org/wiki/Model_Context_Protocol
- https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
- https://github.com/microsoft/language-server-protocol/issues/1160
- https://medium.com/dailyjs/the-language-server-with-child-threads-38ae915f4910
- https://microsoft.github.io/debug-adapter-protocol/
- https://github.com/microsoft/debug-adapter-protocol/blob/main/overview.md
