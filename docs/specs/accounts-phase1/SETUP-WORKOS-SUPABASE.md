# Phase 1 — WorkOS + Supabase setup checklist (unblocks step 4)

Founder-facing. These are the **external accounts + dashboard config** the live PKCE flow (step 4)
needs. None of this is code — it produces a handful of values the app + backend consume. Do the
**Staging** environment first; repeat for Production before launch.

> The authoritative implementation reference is the official **`workos/electron-authkit-example`**
> on GitHub — step 4 mirrors it. Use it to resolve any exact-endpoint/SDK detail; the steps below are
> the dashboard setup it assumes.

---

## A. WorkOS (auth)

- [ ] **Create a WorkOS account** → it starts in the **Staging** environment. (Free; AuthKit is free to 1M MAU.)
- [ ] **Enable AuthKit** (User Management) for the environment.
- [ ] **Add a social login: Google** — AuthKit → Authentication → enable **Google OAuth**. (WorkOS provides shared dev Google creds in Staging; add your own Google OAuth client before Production.)
- [ ] **Register the redirect URI** exactly: **`expanse://auth/callback`**
      (AuthKit → Redirects / Authentication → Redirect URIs). This is the custom scheme step 3 already registers + handles. WorkOS must allow a custom-scheme redirect for the desktop public client.
- [ ] **Treat the desktop app as a PUBLIC client (PKCE, no secret).** Confirm AuthKit allows the
      Authorization Code + PKCE flow for this app. The `code_challenge_method` is **S256**.
- [ ] **Collect these values:**
  - `WORKOS_CLIENT_ID` — **public**, safe to ship in the desktop binary (pin it in a MAIN constant).
  - AuthKit **authorize base URL** — the hosted authorization endpoint (public; pin in MAIN). The app builds `…/authorize?client_id=…&redirect_uri=expanse://auth/callback&response_type=code&code_challenge=…&code_challenge_method=S256&state=…`.
  - `WORKOS_API_KEY` (secret, `sk_…`) — **backend ONLY** (Supabase function secret). **NEVER** in the desktop binary or any renderer code.
- [ ] **Decide where the code→token exchange runs.** WorkOS's `authenticate` (code exchange) call
      typically needs the **API key** → so the exchange must happen on the **backend** (the Supabase
      function below), not in the desktop. Flow: desktop gets `code` on the `expanse://` callback →
      POSTs `{ code, code_verifier }` to your backend → backend calls WorkOS with the API key →
      returns the user + a session the desktop stores. (Confirm against the Electron example; if it
      shows a no-secret desktop exchange, we can do it in MAIN instead. **This single choice decides
      whether step 4 needs the backend exchange endpoint or just the license stub.**)

## B. Supabase (backend + DB + entitlement)

- [ ] **Create a Supabase project** (free tier fine for dev; note the **region** + the **project URL** and **anon key**). Upgrade to **Pro ($25/mo)** before/at launch (the strategy doc's recommendation).
- [ ] **Create the `users` table** (SQL editor):
  ```sql
  create table public.users (
    id uuid primary key default gen_random_uuid(),
    workos_user_id text unique not null,
    email text not null,
    plan text not null default 'free',
    created_at timestamptz not null default now()
  );
  ```
- [ ] **Edge Function `license`** — returns the cached-entitlement shape the desktop reads
      (`GET /api/license` in the spec). Phase 1 stub: verify the caller's WorkOS JWT via **JWKS**, then
      return `{ active: true, plan: 'free' }`. (Real Stripe-driven plan is Phase 2.)
- [ ] **(Only if §A says the exchange is backend-side)** Edge Function `auth-exchange` — accepts
      `{ code, code_verifier }`, calls WorkOS `authenticate` with `WORKOS_API_KEY`, upserts the
      `users` row, returns `{ userId, email, plan, accessToken, refreshToken, expiresAt }`.
- [ ] **Set function secrets:** `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` (Supabase → Edge Functions → Secrets). Never commit these.
- [ ] **Note the function base URL** (e.g. `https://<ref>.functions.supabase.co`) → this is the app's `LICENSE_API_URL` / `AUTH_API_URL`.

## C. Values the app will consume (collected from A + B)

| Value | Secret? | Where it lives |
|---|---|---|
| `WORKOS_CLIENT_ID` | No (public) | pinned MAIN constant (`src/main/authConfig.ts`, step 4) |
| AuthKit authorize base URL | No (public) | pinned MAIN constant |
| `expanse://auth/callback` | No | already in `electron-builder.yml` + `index.ts` (step 3) |
| Backend base URL (`AUTH_API_URL` / `LICENSE_API_URL`) | No | pinned MAIN constant (per environment) |
| `WORKOS_API_KEY` | **YES** | **Supabase function secret only** — never in the app |

> Public ≠ secret: a PKCE public client's `client_id` and the authorize/redirect URLs are meant to be
> visible. The only secret is the WorkOS API key, and it stays server-side.

## D. Verify against step 3 (already shipped) — a real end-to-end smoke

Once §A's redirect URI is set, you can prove the deep-link round-trip **before** any step-4 code:
1. `pnpm pack:dir` and run `release/win-unpacked/Expanse.exe` once (so Windows registers the
   `expanse://` handler via the NSIS/packaged registration).
2. In a normal browser, open the WorkOS authorize URL (build it with your `client_id` +
   `redirect_uri=expanse://auth/callback`) and complete Google sign-in.
3. The browser hands off to `expanse://auth/callback?...`; the running app logs
   **`[auth] deep-link received: auth/callback`** (the step-3 handler; it deliberately does **not**
   log the code/state). Seeing that line = the OS routing + scheme registration + handler all work.

## E. Security guardrails (carry into step 4)

- WorkOS **API key only on the backend** (Supabase secret). No `client_secret` in the binary.
- **System browser only** for the authorize step (never an embedded `BrowserWindow`).
- PKCE `code_verifier` + `state` generated + held in **MAIN memory** only; the deep-link is
  **validated + state-matched in MAIN** (step 3 validates the scheme; step 4 adds the `state` check).
- Tokens land in `safeStorage` via `authTokenStore` (step 2); **never crossed over IPC** (presence-only).

## F. Still mine to build in step 4 (once A–C exist)

`src/main/workosAuth.ts` (PKCE param gen + authorize-URL build + the exchange call — to MAIN or to the
backend per §A) · `src/main/authConfig.ts` (the pinned public values) · `src/main/authIpc.ts`
(`auth:status` / `auth:signIn` / `auth:signOut` + the `auth:statusChanged` push) · wire the real
`handleAuthDeepLink` to do the state-match + exchange instead of log-only · the preload `auth`
namespace (step 5) · the `license` fetch into `entitlementCache` (step 2 module, already built).

---

**Hand me back:** the four public values in §C (client id, authorize base URL, backend base URL, and
which exchange model §A landed on). With those, step 4 is unblocked — I pin them in `authConfig.ts`
and wire the live flow.
