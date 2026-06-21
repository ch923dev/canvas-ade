# Manual-test bug log — per-board DevTools Network inspector (PR #210)

Found during the live manual dev check (2026-06-22). Status: ✅ fixed · 🔧 in progress · ⏳ queued.

| # | Bug | Severity | Status | Notes |
|---|---|---|---|---|
| B1 | **Network log froze after navigating** (localhost → youtube): showed the first page's requests only, never updated. | High | ✅ fixed `d08c8cd4` | Two causes: `did-start-navigation` read the wrong (positional) arg shape so clear-on-nav never fired; and a cross-process nav drops the CDP Network domain — capture wasn't re-armed. Fix: `isMainFramePageNav` (object args) + re-arm Network on every main-frame nav. Verified by a cross-host probe. |
| B2 | **Clear (🗑) doesn't delete all** rows. | Med | 🔧 investigating | Clear path (clearOsrNet → clearNet + emit `cleared`) looks correct in code. Leading theory: on a live **dev-server page** (localhost:5173 has an HMR socket + polling) the log refills from ongoing traffic the instant it clears, so it *looks* like nothing cleared. Needs repro on a static page to confirm vs. a real wiring bug. |
| B3 | **Panel overlaps the browser** in (full) view — should NOT cover it. Opening the inspector should keep the browser fully visible and **extend the board's size** to fit the panel (split, not overlay). | High | ✅ implemented `c0e0596c` | Reworked `.bb-stage` into a flex container: panel splits the stage (row=right dock / column=bottom dock), stable `.bb-stage-main` wrapper keeps the OSR `<canvas>` from remounting, `.bb-frame` becomes the aspect emulator when full-view OR panel-open. `.bb-net` is now a flex item, not an absolute overlay. Awaiting visual re-confirm. |
| B4 | **Inspector design looked awful** — the resource-type pills rendered unstyled (bare buttons). | Med | ✅ fixed (CSS added) | The pills JSX HMR'd in before their CSS landed. Added calm/one-accent pill styling + Initiator column + right-dock column hiding. Awaiting visual re-confirm. |
| B5 | **Typing doesn't work in full-view browser.** | High | ⏳ queued | Likely a focus issue (the page's composition-proxy `<textarea>` not regaining focus in the full-view portal, or the panel/region stealing it). Relates to the known `osr-typing-rf-focus-steal` class. Needs investigation in full-view specifically. |
| B6 | **Canvas crashed** ("Something went wrong — the canvas hit an unexpected error. Your last save is…") during testing. | High | ⏳ investigating | Co-occurs with B7 (save EPERM). The save-error path may be propagating into a render crash. Confirm whether the ErrorBoundary trip is the EPERM save or a render throw from the inspector. |
| B7 | **Autosave fails (EPERM)** on the test project: `rename …canvas.json.<tmp> → canvas.json` denied (`F:\Claude Projects\Entheos Electrical Services\.canvas\`). Board deletes / edits don't persist. | High (env) | ⏳ user action | Not the inspector — a **file lock** on the project folder. Likely cause: two app instances open on the same project (this PR dev + the user's normal app), or `F:` drive sync/AV holding the file. Mitigation: test on a scratch project; don't run two instances on one project. (A code hardening — turn a save EPERM into a toast, never a canvas crash — may be warranted for B6.) |

## Fix order
1. ~~**B3** layout (overlap → extend/split)~~ — ✅ done (`c0e0596c`), awaiting re-confirm.
2. **B5** full-view typing.
3. **B6/B7** save-EPERM resilience (don't crash on a save failure) — likely closes both.
4. **B2** clear — confirm repro on a static page; fix if it's a real wiring bug.

## "172 → 1 requests" — verdict (Chrome-fidelity research, 2026-06-22)

A research+audit workflow (see `CHROME-DEVTOOLS-FIDELITY.md`) confirmed: the **172 → 1 collapse
the user saw is *correct* Chrome behavior.** `localhost:5173 → youtube.com` is a hard
cross-document navigation; with **Preserve log OFF**, Chrome wipes the log and shows only the new
document's request(s). Our impl matches (`previewOsrNetwork.ts:369-378,389-391`). The *real* defect
in this area was the **frozen-at-172** symptom (log never cleared, capture died after page 1) — that
is **B1, already fixed**. To make the log *persist* across navigations, the user wants **Preserve
log** — which today skips the clear but lacks Chrome's boundary marker + `(unknown)` re-tagging
(lifecycle gaps, fix-plan slice **P2.6**). Full gap audit (1 blocker · 23 high · 34 med · 38 low)
and the prioritized P0–P3 slice plan are in `CHROME-DEVTOOLS-FIDELITY.md`.
