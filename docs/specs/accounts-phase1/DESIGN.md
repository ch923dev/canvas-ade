# Phase 1 — Accounts · Design artifact (for sign-off)

*Built from the real tokens in `src/renderer/src/styles/tokens.css` and the existing `SettingsModal`/`Modal` primitives. Calm/dense, one accent (`--accent #4f8cff`), dark surfaces, no glow. ASCII wireframes for structural sign-off; a rendered HTML mock can follow if pixel review is wanted before code.*

## Product decision baked into this design

**Sign-in is OPTIONAL in Phase 1 (local-first).** The app still opens straight to Welcome/Canvas with no account — exactly as today. A small **account pill** in the chrome lets you sign in; signing in just adds identity + a plan badge (entitlement = `free` until billing lands in Phase 2). The hard gate (`__REQUIRE_ACCOUNT__`) is wired but **defaults off** — it only ever turns on later, behind a distribution build, once there's something to gate. This keeps the frictionless "open a folder and go" funnel intact. *← confirm this is the behavior you want.*

---

## Surface 1 — Account pill in the app chrome (next to the Settings gear)

```
SIGNED OUT                          SIGNED IN · Free                    SIGNED IN · Pro
┌───────────────────────┐          ┌───────────────────────┐          ┌───────────────────────┐
│            … ⊕ ⌂  ◔  ⚙ │          │        … ⊕ ⌂  (C) ⚙   │          │     … ⊕ ⌂  (C)ᴾ ⚙     │
│               │      │ │          │             │     │   │          │            │     │     │
│      [ Sign in ]─────┘ │          │      avatar ─┘     │   │          │  avatar+ring┘     │     │
│       ghost pill       │          │   click → Account  │   │          │  small "PRO" tag  │     │
└───────────────────────┘          └───────────────────────┘          └───────────────────────┘
  --text-2 on --surface-raised        circle, initial of email          accent ring (1px --accent)
  hover → --text                      24px, --border-strong ring         + 'PRO' micro tag --accent
```

- Lives in the existing control cluster, immediately **before** the Settings gear (`⚙`).
- Signed out → a `.ca-btn-ghost`-grammar **"Sign in"** pill.
- Signed in → a 24px **avatar circle** (email initial); click opens Settings scrolled to the Account section.
- Free vs Pro differ only by a 1px accent ring + a `t-micro` "PRO" tag — functional, no decoration.

---

## Surface 2 — "Account" section in the Settings modal (new, top of the modal)

Mirrors the existing section grammar exactly (`head` label, `divider`, the orch-row layout).

```
SIGNED OUT                                         SIGNED IN (Free)
┌──────────────────────────────────────┐          ┌──────────────────────────────────────┐
│ Account                               │          │ Account                               │
│                                       │          │                                       │
│ ┌──────────────────────────────────┐ │          │ ┌──────────────────────────────────┐ │
│ │ Sign in to sync settings and      │ │          │ │ (C)  you@email.com         [Free] │ │
│ │ unlock Pro features.              │ │          │ │      Signed in                    │ │
│ │                      [ Sign in ]  │ │          │ └──────────────────────────────────┘ │
│ └──────────────────────────────────┘ │          │  [ Manage subscription ]   [ Sign out ]│
│                                       │          │   (opens browser · Phase 2)   ghost    │
│ ──────────────────────────────────── │          │ ──────────────────────────────────────│
│ Context brain · LLM                   │          │ Context brain · LLM                   │
│  …existing settings unchanged below…  │          │  …existing settings unchanged below…  │
└──────────────────────────────────────┘          └──────────────────────────────────────┘
```

- **Signed out:** an inset card (same `--inset` bg, `--border-subtle`) + `.ca-btn-primary` "Sign in".
- **Signed in:** avatar + email (`--text`) + a plan badge pill (`[Free]` = `--text-3` on `--surface`; `[Pro]` = `--accent` on `--accent-wash`). "Signed in" sub line in `--text-3`.
- **"Manage subscription"** — `.ca-btn-ghost`; opens the Stripe Customer Portal in the browser (wired in Phase 2; shown disabled/"soon" in Phase 1).
- **"Sign out"** — `.ca-btn-ghost`; revokes + clears local tokens.

---

## Surface 3 — `SignInView` (the focused sign-in screen)

Used as a centered modal in Phase 1 (and reused full-screen as the future `__REQUIRE_ACCOUNT__` gate). Built on the shared `Modal` primitive.

```
IDLE                                               WAITING FOR BROWSER
┌──────────────────────────────────────┐          ┌──────────────────────────────────────┐
│                ╱╲                     │          │                ╱╲                     │
│               ╱  ╲   Expanse          │          │               ╱  ╲   Expanse          │
│                                       │          │                                       │
│   Sign in to Expanse                  │          │   Finish in your browser              │
│   Sync your settings across machines  │          │   ◔  Waiting for sign-in…             │
│   and unlock Pro.                     │          │                                       │
│                                       │          │   Completed it? This updates          │
│   ┌────────────────────────────────┐  │          │   automatically.                      │
│   │  ◉  Continue with Google       │  │  ←prim   │                                       │
│   └────────────────────────────────┘  │          │   [ Cancel ]    Didn't open? [Retry] │
│   ┌────────────────────────────────┐  │          └──────────────────────────────────────┘
│   │     Continue with email        │  │  ←ghost
│   └────────────────────────────────┘  │          ERROR · no keyring (safeStorage off)
│                                       │          ┌──────────────────────────────────────┐
│   By continuing you agree to the      │          │ ⚠ Can't store a session on this       │
│   Terms and Privacy Policy.           │          │   machine — no system keyring was     │
│                                       │          │   found. Sign-in is unavailable here. │
└──────────────────────────────────────┘          └──────────────────────────────────────┘
```

States: **idle** (provider buttons) → **waiting** (browser opened, spinner, Cancel/Retry, auto-advances on the `auth:statusChanged` push) → **success** (brief "Signed in as …", closes) → **error** (keyring unavailable, or callback/state-mismatch → "Sign-in failed, try again"). The `◔` is the existing spinner glyph; `⚠` uses `--warn`.

---

## Tokens / primitives reused (no new visual system)

| Element | Token / class |
|---|---|
| Modal scrim + card | shared `Modal` (`--scrim`, `--surface-overlay`, `--shadow-pop`) |
| Primary button | `.ca-btn-primary` (filled `--accent`, AA contrast) |
| Ghost button / pill | `.ca-btn-ghost` |
| Section header | `styles.head` (13px/600 `--text`) |
| Inset info card | `--inset` bg, `--border-subtle`, `--r-inner` |
| Plan badge | `[Free]` `--text-3`/`--surface` · `[Pro]` `--accent`/`--accent-wash`, `--r-pill` |
| Avatar | 24px circle, `--border-strong` ring (+ `--accent` ring for Pro) |
| Error notice | `styles.notice`/`error` grammar, `--warn` |

No new colors, no gradients, no glow — every value above already exists in `tokens.css`.
