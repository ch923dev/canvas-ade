# Manual-test bug log — per-board DevTools Network inspector (PR #210)

Found during the live manual dev check (2026-06-22). Status: ✅ fixed · 🔧 in progress · ⏳ queued.

| # | Bug | Severity | Status | Notes |
|---|---|---|---|---|
| B1 | **Network log froze after navigating** (localhost → youtube): showed the first page's requests only, never updated. | High | ✅ fixed `d08c8cd4` | Two causes: `did-start-navigation` read the wrong (positional) arg shape so clear-on-nav never fired; and a cross-process nav drops the CDP Network domain — capture wasn't re-armed. Fix: `isMainFramePageNav` (object args) + re-arm Network on every main-frame nav. Verified by a cross-host probe. |
| B2 | **Clear (🗑) doesn't delete all** rows. | Med | 🔧 investigating | Clear path (clearOsrNet → clearNet + emit `cleared`) looks correct in code. Leading theory: on a live **dev-server page** (localhost:5173 has an HMR socket + polling) the log refills from ongoing traffic the instant it clears, so it *looks* like nothing cleared. Needs repro on a static page to confirm vs. a real wiring bug. |
| B3 | **Panel overlaps the browser** in (full) view — should NOT cover it. Opening the inspector should keep the browser fully visible and **extend the board's size** to fit the panel (split, not overlay). | High | ⏳ queued (next) | Current panel is an absolute overlay over `.bb-stage`. Needs a layout rework: on-canvas = grow the board node when open; full-view = split the screen (browser + panel side-by-side). Biggest remaining item. |
| B4 | **Inspector design looked awful** — the resource-type pills rendered unstyled (bare buttons). | Med | ✅ fixed (CSS added) | The pills JSX HMR'd in before their CSS landed. Added calm/one-accent pill styling + Initiator column + right-dock column hiding. Awaiting visual re-confirm. |
| B5 | **Typing doesn't work in full-view browser.** | High | ⏳ queued | Likely a focus issue (the page's composition-proxy `<textarea>` not regaining focus in the full-view portal, or the panel/region stealing it). Relates to the known `osr-typing-rf-focus-steal` class. Needs investigation in full-view specifically. |
| B6 | **Canvas crashed** ("Something went wrong — the canvas hit an unexpected error. Your last save is…") during testing. | High | ⏳ investigating | Co-occurs with B7 (save EPERM). The save-error path may be propagating into a render crash. Confirm whether the ErrorBoundary trip is the EPERM save or a render throw from the inspector. |
| B7 | **Autosave fails (EPERM)** on the test project: `rename …canvas.json.<tmp> → canvas.json` denied (`F:\Claude Projects\Entheos Electrical Services\.canvas\`). Board deletes / edits don't persist. | High (env) | ⏳ user action | Not the inspector — a **file lock** on the project folder. Likely cause: two app instances open on the same project (this PR dev + the user's normal app), or `F:` drive sync/AV holding the file. Mitigation: test on a scratch project; don't run two instances on one project. (A code hardening — turn a save EPERM into a toast, never a canvas crash — may be warranted for B6.) |

## Fix order
1. **B3** layout (overlap → extend/split) — the headline UX issue.
2. **B5** full-view typing.
3. **B6/B7** save-EPERM resilience (don't crash on a save failure) — likely closes both.
4. **B2** clear — confirm repro on a static page; fix if it's a real wiring bug.
