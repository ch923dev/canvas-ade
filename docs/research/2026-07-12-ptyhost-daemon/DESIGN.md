# PTY-host daemon — PR 1 design (background survival core)

> Track: PLAN.md §10 (jarvis-voice-agent research dir) · spike GO `b42a6b36` · UX (close modal /
> tray / settings) is **PR 2** — approved mock `mock-background-sessions.html` on the spike branch.
> PR 1 = the invisible half: sessions survive **update installs and crashes**, reattach on relaunch.
> Normal window close keeps today's kill-everything behavior (no user-visible policy change until
> the PR-2 modal exists).

## Decisions (locked 2026-07-12, user-confirmed)

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Daemon runtime placement | **Staged Electron copy** in `%LOCALAPPDATA%\expanse-ptyhost\<appVersion>\` (~245 MB) | Measured: overwriting a running exe fails (`Device or resource busy`) — a daemon running from the install dir blocks NSIS update install, breaking the founding use case. Minimal run-as-node set measured at **4 files** (`electron.exe` + `icudtl.dat` + `v8_context_snapshot.bin` + `snapshot_blob.bin`); node-pty (Electron-ABI, no recompile) proven to spawn ConPTY from the staged copy. Alternative (plain Node + second node-ABI node-pty build, ~90 MB) rejected: dual-ABI build pipeline complexity + drift risk. |
| D2 | Rollout gate | **Runtime setting, default ON** (`Terminal sessions survive app restart`) | One binary, live escape hatch. Daemon-start failure ⇒ **explicit fallback** to in-proc pty + warning toast — never silent. |
| D3 | Output framing | NDJSON (JSON-escaped strings) for v1, control + data | Spike-proven; ~10–30 % escape overhead on VT-heavy output accepted for reviewability. Length-prefixed binary frames filed as a perf follow-up. |
| D4 | pty.ts integration shape | Daemon exposes an **IPty-shaped proxy** (`pid`, `onData`, `onExit`, `write`, `resize`, `kill`) | Keeps ALL session bookkeeping (park/adopt, flush watermark, lifecycle heuristics, ring) in MAIN exactly as-is; the diff swaps only the raw process handle. Riskiest-file blast radius minimized. |
| D5 | Close policy in PR 1 | Update-restart + crash survive; **normal close still kills** | The keep-vs-kill choice needs the PR-2 modal; until then user-visible close behavior is unchanged. `quitAndInstall` path sets a keep flag; `before-quit` dispose honors it. |
| D6 | Session identity | daemon session id == board id (today's `pty:spawn` id) | `pty:spawn` handler checks the daemon for a live session under that id first → attach + replay instead of spawn. Reuses the existing adopt/preface machinery (S3 snapshot preface + ring tail). |

## Components

```
src/main/ptyHost/
  protocol.ts       shared types + line codec (spawn/attach/input/resize/detach/kill/list ·
                    spawned/replay/output/exit/killed/error) + version + token handshake
  daemonMain.ts     daemon entry — bundled as its OWN electron-vite main entry
                    (out/main/ptyHostDaemon.js). Sessions map, 64 KB ring (line-boundary
                    trimmed replay), taskkill /T /F, lazy pid (ConPTY pid=0 at spawn —
                    spike caveat), idle-exit at zero sessions, owner-only state.
  runtimeStage.ts   stage the 4-file runtime + node-pty subset + ptyHostDaemon.js into
                    %LOCALAPPDATA%\expanse-ptyhost\<version>\ (copy-if-missing, hash-checked,
                    old-version sweep). Dev mode: node_modules/electron/dist source;
                    packaged: install dir + app.asar.unpacked.
  client.ts         MAIN-side: ensureDaemon() (read userData state file {pipe, token, pid,
                    version} → connect+handshake → else spawn fresh w/ new random pipe+token,
                    detached, from the STAGED runtime) · IPty-shaped SessionProxy ·
                    reconnect/attach · list.
```

- **Pipe name:** `\\.\pipe\expanse-ptyhost-<sha1(userDataPath)>-<random>` — per-profile isolation
  (dev instances / e2e / packaged never collide; profileIsolation.ts already splits userData).
- **Auth:** 32-byte random token minted by MAIN at daemon spawn, passed via argv? NO — via an
  env var to the child + persisted in the userData state file (`ptyhost-state.json`); every
  client line-0 must be `{op:'hello', token, version}` or the socket is dropped. argv is
  world-readable via process listing; env of a child is not enumerable by other users at our
  integrity level, and the state file inherits the user-profile ACL (PLAN §10 posture:
  trusted-user-only, never TCP).
- **Version handshake:** daemon replies `{ev:'hello', version, pid}`; MAIN on mismatch asks the
  daemon to drain (finish current sessions, accept no new spawns) and spawns a fresh daemon for
  new sessions (PLAN §10 non-goal: no daemon auto-update).

## Reattach flow (app boot)

1. `ensureDaemon()` connects to the existing daemon if the state file + handshake succeed.
2. `list` → live session ids (== board ids) cached in MAIN.
3. Board mounts fire `pty:spawn(id)` as today → handler sees a live daemon session under `id`
   → **attach** path: new SessionProxy, replay = S3 sidecar preface (if any) + daemon ring tail,
   pushed over the fresh MessagePort exactly like an adopt. State goes `running`.
4. No live session → normal spawn (through the daemon when the setting is ON, in-proc when OFF
   or after a surfaced daemon failure).

## Kill / park / dispose semantics

- `pty:kill` → daemon `kill` op (taskkill /T /F in the daemon, spike-proven on re-parented
  children) → proxy `onExit` fires → existing cleanup runs unchanged.
- Park/adopt: unchanged — parked sessions are just daemon sessions MAIN isn't forwarding;
  the park TTL reap calls the same daemon kill.
- `disposeAllPtys` (project switch): unchanged — kills through the daemon.
- `before-quit`: if `updateRestartPending` (set by the autoUpdate wiring around
  `quitAndInstall`) → **disconnect only**, daemon keeps sessions; else kill-all as today (D5).
- Crash: nothing runs in MAIN; daemon keeps sessions; next boot reattaches (step 3 above).

## e2e story (lane gate 6)

- Pipe name derives from userData → the per-checkout e2e profiles already isolate daemons.
- Teardown sweep: afterAll kills any daemon whose state file lives under the test profile
  (`taskkill` by recorded pid + pipe probe) so runs never leak daemons.
- New spec `@terminal ptyhostReattach`: spawn terminal → write marker → relaunch the Electron
  app (same profile) → assert board repaints marker via replay AND shell pid unchanged.

## Out of scope (PR 2+, filed)

Close modal / tray residency / settings UX (approved design) · binary output frames ·
mac/Linux daemon (`unix socket` transport slot exists in protocol) · wake-word-style
notifications on background exit (#314 integration).
