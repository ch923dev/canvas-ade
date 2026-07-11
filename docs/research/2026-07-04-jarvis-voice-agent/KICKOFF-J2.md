# J2 kickoff — Jarvis playback + duplex (lane brief, 2026-07-11)

You are the **J2 lane** of the Jarvis voice-agent epic. This worktree
(`.worktrees/jarvis-j2-playback`, branch `feat/jarvis-j2-playback`) is based on
`feat/jarvis-umbrella` @ `abadee25` (= J1 merged + origin/main 0.14.1 merged in).
**PR target = `feat/jarvis-umbrella`, NOT main** — the umbrella collects J-lanes; one
umbrella→main PR at epic end pays the full e2e matrix.

## Read first (in this order)

1. `docs/research/2026-07-04-jarvis-voice-agent/REVIEW-2026-07-10.md` — §4.1 decisions
   (D1–D8, LOCKED — do not re-litigate) and §4.3 J2 scope.
2. `docs/research/2026-07-04-jarvis-voice-agent/PLAN.md` — epic structure J0–J5.
3. `src/main/voiceEngineHost.ts` — what J1 left you: `buildTtsConfig` (kokoro t4 / vits t2,
   `maxNumSentences: 1` = sentence-chunk streaming), `OfflineTtsLike` (its
   `generateAsync.onProgress` returning 0/false CANCELS remaining synthesis — that is your
   barge-in flush hook), spike `ttsOk`.
4. `src/main/voiceTtsModels.ts` + `voiceTtsManifest.json` — component catalog
   (downloadTtsModel/deleteTtsModel/ttsModelStatus/ttsModelPaths; shared espeak component).
5. `src/main/voiceIpc.ts` + `voiceEngine.ts` — the STT session pattern (utilityProcess host,
   MessagePort data plane, crash→re-broker-once policy) that J2 mirrors for TTS.

## J2 scope (REVIEW §4.3, amended by D2/D6)

- **TTS host session**: instantiate `OfflineTts` in the voice engine host via
  `buildTtsConfig` (Kokoro primary / Piper fallback per D2 — NEVER int8 on CPU); stream
  sentence chunks from `generateAsync.onProgress` over a MessagePort to the renderer.
- **IPC seam**: `voice:tts:*` control channels (speak / cancel / status) + TTS model
  download/delete/status wiring in `voiceIpc.ts` (mirror the STT `voice:models:*` shape) +
  Settings model rows (SettingsVoiceSection pattern; download progress push).
- **Renderer playback queue**: Web Audio playback of streamed Float32 chunks; queue with
  clause boundaries; **duck ≤100 ms** on barge-in.
- **Barge-in (D6 layers)**: transcription-gated interrupt PRIMARY (a confirmed partial from
  the STT session while TTS is speaking → cancel synth via onProgress-return-0 + flush
  queue + duck); half-duplex RMS fallback; **AEC = a verification test, not a dependency**
  (Electron AEC unreliable on Windows — electron#47043).
- **Filler WAVs + earcons**: pre-rendered short assets ("One moment…", ack chirps) to mask
  first-audio latency (Kokoro warm first-audio ≈ 456 ms measured).

Out of scope: brain/persona (J3), tool hands + notifications (J4), wake word/memory (J5),
conversation-view UI (needs the Exhibit F user nod first).

## Repo rituals (MUST)

- **Plan-viz first**: before any code, draw the J2 plan on the canvas via the `canvas-ade`
  MCP. The epic plan board already exists — `b78c90b3-1f09-46ff-9478-6f219b75bd38`
  ("Jarvis Agent Helper — Epic Plan"): read `canvas://board/{id}/planning`, tick the J1
  items that show merged, update the J2 items in place (`update_planning_element` — never
  re-append duplicates). If .mcp.json is stale, re-copy MAIN's and `/mcp` reconnect.
- **Version bump**: this lane's PR bumps `package.json` to **0.15.0** (minor — new
  subsystem slice; umbrella currently carries 0.14.1).
- **Manual dev check** before the PR: `$env:CANVAS_DEV_TITLE='J2 playback'; pnpm dev` —
  verify the title stamp, exercise speak + barge-in live, get the user eyeball.
- **Coordination**: your ACTIVE-WORK.md row exists (jarvis-j2-playback) — keep Status
  current; stay in your declared zone; cross-zone edits get noted on the board first.
- Unit tests beside the code (voiceTtsModels.test.ts shows the model-gated pattern via
  `CANVAS_VOICE_MODELS_ROOT`); e2e as feasible (TTS models are big — stub/model-gate like
  STT's @voice specs).

## Sharp edges (learned, do not rediscover)

- **NEVER `pnpm install`/`add` through this worktree's node_modules junction** — it targets
  MAIN's tree. Drop the junction first, or run from MAIN. pnpm via PowerShell background
  silently hangs on stdin — use bash for background pnpm.
- Don't redirect vitest TEMP to M: (ReFS dir-rename EPERM); use a long-form C: subdir.
- `pack:dir` output must go to C: (`--config.directories.output`) — ReFS+Defender EPERM.
- Full e2e matrix pre-push takes >10 min (Docker) — push `--no-verify` only with the matrix
  run manually and attributed in the PR body (repo precedent), or run it in background.
- Cold Kokoro init can block >10 s under load — keep long-init off the host loop (J1/V5
  worker pattern); budget test timeouts accordingly.
- The terminal-spawn `.mcp.json` token is CONNECTED-tier: plan-board tools work;
  orchestrator-tier tools (tidy_canvas etc.) are invisible BY DESIGN (D5 minting lands J4).

When the lane is done: PR → `feat/jarvis-umbrella`, claude-review dispositions inline,
delete this KICKOFF file in the PR (doc-lifecycle rule), update the plan board + write_result.
