# Desktop Notifications — Design artifact (signed off 2026-07-07)

Built from the real tokens in `src/renderer/src/styles/tokens.css`. Single-theme **dark** — a
deliberate match to the app's committed visual world, not an omission. One accent (`--accent #4f8cff`),
status = 8px dots / rings on `--ok #3ecf8e` · `--warn #e8b339` · `--err #f2545b`. No glow, no gradient.

Published mock (pixel review): the four surfaces rendered together. This file is the durable record of
the decisions; the mock is the visual.

## Surface 1 — On-canvas board self-indicator (the new surface)

The point: distinguish "an agent is *working*" (calm, ignore) from "an agent *wants me*" (find it now).

| State | Dot | Frame | Badge | Pulse |
|---|---|---|---|---|
| running | `--ok` | normal border | — | calm spinner sliver only |
| **needs-input** | `--warn` | `--warn` ring (3px `--warn-wash`) | "● needs you" | slow attention pulse |
| done (unseen) | `--ok` | normal | "✓ done" | none (steady) |
| **error / focus** | `--err` | `--err` ring | "! error" | none (steady ring) |

- Maps to existing `boardStatus` buckets: `needs-input → awaiting-review`, `error → failed` (both already
  carry `--warn`/`--err` pills in `BUCKET_PILL`).
- Attention is **unseen-state**: it clears when the user selects/opens/focuses the board.
- `prefers-reduced-motion` → no pulse (ring + badge still show).

## Surface 2 — In-app toast

Routes the existing `toastStore` (kinds `ok` / `info` / `error`), rendered by the bottom-right
ToastIsland. Input + error toasts carry a **Focus** action button that pans to the board. Error is
sticky; done/input auto-dismiss.

## Surface 3 — Native OS notification

`new Notification` (Electron). Fires always (focused + minimized) unless "only when unfocused" is on and
the window is focused. Real look is OS-native (Windows Action Center / macOS banner); content:
- Title: `<phrase> — <agent>` — e.g. "Task done — claude", "claude needs your input".
- Body: `<board title> · <detail>`.
- Click → focus the Expanse window + pan/select the board.

## Surface 4 — Settings

"Notifications" section in the Settings modal, existing section grammar. Master switch, then per-event
(Task done / Needs input / Errors & focus), then "Only when window unfocused" (default **off**).
Per-board opt-out is the existing `monitorActivity` toggle on the Terminal board.

## Confirmed decisions

1. Agent-agnostic (Claude hooks + generic PTY heuristics).
2. All three events notify.
3. OS notification fires always; on-canvas indicator disambiguates *which* board.
4. Per-event mute so short-task "done" spam can be turned off without losing input/error.
