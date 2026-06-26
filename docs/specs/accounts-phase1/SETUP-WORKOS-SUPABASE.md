# Phase 1 — WorkOS + Supabase setup checklist (unblocks step 4)

Founder-facing. These are the **external accounts + dashboard config** the live PKCE flow (step 4)
needs. Verified 2026-06-26 against the official `workos/electron-authkit-example` + WorkOS/Supabase docs.

## Architecture (confirmed — simpler than first drafted)

- **Sign-in needs NO backend.** WorkOS's official Electron example does the code→token exchange **in
  the Electron main process** using **only the Client ID + PKCE** — **no WorkOS API key (`sk_…`)** is
  used. PKCE replaces the client secret, so there's nothing secret to ship in the binary.
- **Redirect = custom scheme `expanse://auth/callback`** — supported (the official example uses
  `workos-auth://callback`). This is exactly what step 3 already registers + handles. *(Loopback
  `http://127.0.0.1:<port>/callback` is the documented RFC 8252 fallback if a Production env ever
  rejects the custom scheme.)*
- **Supabase = entitlement layer ONLY**, not part of login. The app calls a `license` Edge Function
  with the WorkOS access token; the function verifies it via **WorkOS JWKS** and returns the plan.
  Scaffolded + ready in **`supabase/`** (see `supabase/README.md`).

```
Electron MAIN: PKCE → system browser → WorkOS → expanse://auth/callback → authenticateWithCode
              (Client ID only, no secret) → store tokens in safeStorage → GET license fn (Bearer token)
Supabase license fn: verify WorkOS JWT via JWKS → { active, plan }   ← entitlement, not auth
```

---

## A. WorkOS (auth) — dashboard

- [ ] **Sign up** at dashboard.workos.com → you're in the **Staging** environment.
- [ ] **Authentication** (left nav) → **Google OAuth** → *Configure* → use WorkOS's **demo
      credentials** to test instantly (swap in your own Google Cloud OAuth client before Production).
- [ ] **Redirects** tab → add the redirect URI **exactly**: `expanse://auth/callback`
      *(custom scheme — confirmed supported. If Production ever rejects it, switch to the loopback fallback.)*
- [ ] **API Keys** → copy the **Client ID** (`client_…`). **This is the only WorkOS value the app
      needs**, and it's public (safe to share + ship). The **Secret Key (`sk_…`) is NOT used by the
      desktop sign-in** — leave it server-side; you don't need it for Phase 1.
- [ ] **PKCE:** there's no toggle — it's activated by *how the app calls the API* (`code_challenge` +
      `S256` on authorize, `code_verifier` with no secret on authenticate). Adding the redirect URI is
      what authorizes the native flow.

**Endpoints the app (step 4) will use** (FYI — fixed, nothing to configure):
`GET https://api.workos.com/user_management/authorize` and
`POST https://api.workos.com/user_management/authenticate` (PKCE: `code_verifier`, no `client_secret`).
JWKS for the license fn: `https://api.workos.com/sso/jwks/<CLIENT_ID>`; issuer `https://api.workos.com/`.

## B. Supabase (entitlements) — project + deploy

- [x] **Project created** — `ExpanseDB` (org "Expanse Devs", Free). ✅
- [ ] Note the **project ref** (Settings → General → Reference ID) and **Project URL** (Settings → API).
- [ ] **Install the CLI:** `scoop bucket add supabase https://github.com/supabase/scoop-bucket.git` then `scoop install supabase`.
- [ ] **Deploy the scaffolded backend** (`supabase/` is already in this branch) — run from the repo root:
  ```bash
  supabase login
  supabase init
  supabase link --project-ref <your-project-ref>
  supabase db push
  cp supabase/.env.example supabase/.env      # put your real client_... in it
  supabase secrets set --env-file supabase/.env
  supabase functions deploy license --no-verify-jwt
  ```
  Full notes in **`supabase/README.md`**.
- [ ] Note the deployed function URL: **`https://<project-ref>.functions.supabase.co/license`**.

## C. Values to hand back (so I can wire step 4)

| Value | Secret? | Where it goes |
|---|---|---|
| **WorkOS Client ID** (`client_…`) | No (public) | pinned MAIN constant (`authConfig.ts`) + the Supabase secret |
| **`license` function URL** | No | pinned MAIN constant (`LICENSE_API_URL`) |
| ~~WorkOS API key~~ | — | **not needed** for the desktop flow |
| Supabase project ref / URL | No | (you set the function secret; the app only calls the function URL) |

> The WorkOS Secret Key and Supabase service_role key are **not** needed for Phase 1 sign-in or the
> license stub. Keep them private; you won't paste them anywhere in the app or this chat.

## D. Smoke-test step 3 BEFORE any step-4 code

Once §A's redirect URI is set:
1. `pnpm pack:dir`, run `release/win-unpacked/Expanse.exe` once (registers the `expanse://` handler).
2. In a browser, open the WorkOS authorize URL (Client ID + `redirect_uri=expanse://auth/callback`) and finish Google sign-in.
3. The app logs **`[auth] deep-link received: auth/callback`** (the step-3 handler — it deliberately
   does NOT log the code/state). Seeing that = OS routing + scheme registration + handler all work.

## E. Security guardrails (carry into step 4)

System browser only (never embedded webview) · **no `client_secret`/API key in the binary** (PKCE) ·
`code_verifier` + `state` in MAIN memory only · deep-link validated + state-matched in MAIN · tokens
in `safeStorage`, never over IPC · license fn validates signature+issuer+expiry, **never `aud`**.

## F. Still mine to build in step 4 (once §C values exist)

Add `@workos-inc/node` (on MAIN, then merge) · `authConfig.ts` (pin Client ID + authorize base +
license URL) · `workosAuth.ts` (PKCE gen, authorize URL, `authenticateWithCode`) · upgrade the
step-3 `handleAuthDeepLink` from log-only to state-match + exchange · `authIpc.ts` + preload `auth`
namespace · fetch the license fn into `entitlementCache` (already built in step 2).
