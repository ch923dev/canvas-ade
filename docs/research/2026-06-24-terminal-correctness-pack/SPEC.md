# Phase 4 — Terminal correctness pack: clickable links + Unicode 11

> Part of the terminal-capabilities sequence (`docs/research/2026-06-23-terminal-scrollback-reflow/REPORT.md` §7).
> Phase 1 (full-view freeze) + Phase 2 (find-in-terminal) shipped via #235; Phase 3 (configurable +
> persisted scrollback) shipped via #237. This phase = **single PR** (`feat/terminal-correctness-pack`),
> no umbrella. Phase 5 (serialize/restore + save-to-file) follows.

## Problem

Two correctness gaps remain in the terminal, both low-effort and independent of the Phase 1 fix:

1. **URLs in agent/log output are dead text.** Reading agent logs is the stated goal of the whole
   sequence; build URLs, `localhost` dev links, and doc links are printed constantly and the user has to
   hand-copy them. xterm ships `@xterm/addon-web-links` for exactly this.
2. **Wide glyphs misalign.** Without `@xterm/addon-unicode11`, xterm uses a basic width table, so emoji /
   CJK / combining characters compute the wrong cell width — visible misalignment **and** a wrap miscount
   that *feeds* the reflow drift Phase 1 fought. `allowProposedApi` is already enabled.

## Design (signed off 2026-06-24)

No pixel mock required — the interaction has **no visible chooser** (modifier + smart default), so the
report's "Design artifact? No" stands. Decisions locked with the user:

### Clickable links — destination routing

A clicked link routes to **either an in-canvas Browser board or the external system browser**, chosen by a
smart default on the URL host, with a modifier override:

- **Gesture:** `Ctrl/Cmd+click` activates a link. Plain click is reserved for the selection shim
  (unchanged). Hover shows an underline + pointer cursor (addon default; one CSS line to match tokens).
- **Smart default by host:**
  - **Local** — `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, `*.local`, and private LAN ranges
    (`10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`) → **Browser board** (these are the user's running
    app — what the OSR preview engine exists for).
  - **Remote** — every other `http`/`https` URL → **external browser** (`shell.openExternal`).
- **Override:** `Shift+Ctrl/Cmd+click` flips the destination (force a localhost link external, or force a
  remote link into a Browser board).
- **Browser-board target:** reuse a Browser board already showing the **same origin** (route + focus it);
  otherwise spawn a new Browser board offset to the **right** of the terminal board. Mirrors the existing
  port-detect→preview behavior (`terminalPreview.ts` / `previewStore.ts`).
- **`mailto:`** → external browser (no board).

### Unicode 11

Load `Unicode11Addon` and set `term.unicode.activeVersion = '11'` at construction. No UX surface; the only
risk is the interaction with the FREEZE whole-cell-fit math (`fitWhole`), covered by an e2e probe.

## Security (web-links)

The deny-in-app-nav / `shell.openExternal` rule is the core constraint — clickable links cross the
renderer→OS boundary, so they are the riskiest part of this phase.

- **Scheme allowlist (enforced in MAIN):** only `http:`, `https:`, `mailto:` are openable. Reject
  `file:`, `javascript:`, `data:`, and any custom scheme. The renderer-side classifier pre-filters, but
  **MAIN re-validates** before `shell.openExternal` (never trust the renderer for an OS-level open).
- **Renderer never opens directly.** The web-links handler runs in the renderer; it resolves the
  destination and either (a) calls the Browser-board create/route path (in-process, OSR-sandboxed) or
  (b) invokes the validated `shell:openExternal` IPC. No `window.open`, no in-app navigation.
- **PTY write channel untouched.** Links flow renderer→IPC→shell or renderer→store→Browser board; nothing
  about this feature writes to the PTY. The "browser content must never reach the PTY" invariant is
  unaffected.
- **No sandbox/isolation weakening.** `contextIsolation`/`sandbox`/`nodeIntegration:false` unchanged; the
  new IPC is a thin, frame-guarded, scheme-validated channel.
- The Browser-board path loads the URL in the existing OSR engine (which already loads arbitrary URLs via
  the editable URL bar) — no new surface beyond what Browser boards already do.

## Implementation (mirrors the Phase 2 search-addon load + the `fontSize?`/`terminalSearch.ts` precedents)

1. **Dependencies** — add `@xterm/addon-web-links` + `@xterm/addon-unicode11` at the **xterm-5.5-compatible
   versions** (verify the peer range at install — addon majors track xterm; the 5.5 line today is
   `addon-search@0.15` / `addon-webgl@0.18`). `pnpm-lock.yaml` moves → signal-merge with `-Lockfile`; the
   Linux Docker leg's frozen install is the validation. **No new heavy deps** (official xterm addons).
2. **`terminalLinks.ts`** (NEW, pure — mirrors `terminalSearch.ts`): `classifyLinkHost(url)` → `'local' |
   'remote'`, an `isLocalHost` predicate over the ranges above, `isOpenableScheme(url)` (the allowlist),
   and `resolveLinkDestination(url, { shiftKey })` → `'board' | 'external'`. No side effects; fully
   unit-tested.
3. **`useTerminalSpawn.ts`** (beside fit/search, ~`:530`): load `Unicode11Addon` + set
   `term.unicode.activeVersion='11'`; load `WebLinksAddon(handler)` where `handler(event, uri)` =
   `isOpenableScheme` guard → `resolveLinkDestination` → call the board path (#4) or the external IPC (#5).
   The handler is stable (board id + store refs), not a spawn dep.
4. **Browser-board path** — reuse `addBoard('browser', pos, { url })` for the create case and a same-origin
   lookup over `canvasStore.boards` (type `'browser'`) to route an existing one (focus + navigate via
   `previewStore`/`navigatePreview`). Spawn position = terminal board rect offset right. Factor the
   create-or-route into a small helper so the port-detect flow and the link flow share it.
5. **`shell:openExternal` IPC** (`preload/index.ts` + `main/index.ts`) — a new shared, scheme-validated
   channel for the external path. MAIN enforces the allowlist before `shell.openExternal`. (The existing
   `preview:openExternal` stays preview-scoped; do not overload it.)

**No `schemaVersion` bump** (no persisted state added). **No PTY respawn** (addons load at construction;
the Restart/respawn path reuses the term — unaffected).

## Tests

- **`terminalLinks.test.ts`** (unit): `isLocalHost` across all local forms + private LAN ranges vs public
  IPs/hosts; `isOpenableScheme` allows http/https/mailto and rejects file/javascript/data/custom;
  `resolveLinkDestination` (local→board, remote→external, Shift flips both).
- **`e2e/terminalLinks.e2e.ts`** (`@terminal`):
  - print a `localhost` URL → `Ctrl/Cmd+click` → a Browser board is created/routed to it (assert via
    `getBoards()` + the preview store); same-origin reuse on a second click (no duplicate board).
  - print a remote URL → `Ctrl/Cmd+click` → the `shell:openExternal` IPC fires with that URL (spy); **no**
    board created.
  - `Shift+Ctrl/Cmd+click` flips both directions.
  - a `file://` link → **no open** (allowlist reject).
  - **unicode11:** `term.unicode.activeVersion === '11'`; print an emoji/CJK line and assert no `fitWhole`
    clip / wrap miscount (spot-check cell width via the buffer API).

## Process

- Branch `feat/terminal-correctness-pack` off current `main` (`3663fa79`, post-#239), isolated worktree
  **with** the node_modules junction (dep install + gate run needed).
- Manual title-stamped dev check (`CANVAS_DEV_TITLE='PR#NNN correctness-pack'`) — eyeball: localhost link →
  Browser board, remote link → external browser, Shift-flip, an emoji line aligns.
- **Full e2e matrix both legs** mandatory at the pre-merge gate; lockfile moved → `-Lockfile` on
  signal-merge.

## Out of scope

- **Ligatures** (`@xterm/addon-ligatures`) — not supported under WebGL; would force a renderer downgrade.
  Declined (report §7).
- Phase 5 — serialize/restore live buffer + save-to-file (`@xterm/addon-serialize`).
