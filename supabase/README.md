# Expanse backend (Supabase) — Phase 1 accounts

This is the **entitlement layer only**. WorkOS handles sign-in entirely in the Electron main
process (PKCE, **no backend, no API secret**). This backend just verifies a WorkOS access token and
returns the plan — and is where Stripe-driven entitlements land in Phase 2.

## What's here

| File | Purpose |
|---|---|
| `migrations/20260626000000_init.sql` | `users` + `subscriptions` tables (RLS on, service-role only) |
| `functions/license/index.ts` | verifies the WorkOS JWT via JWKS → `{ active, plan }` |
| `.env.example` | the one function env var (`WORKOS_CLIENT_ID`, public) |

## Deploy (one-time) — run from the repo root

Prereqs: the Supabase CLI (`scoop install supabase`) and your **project ref**
(Dashboard → Settings → General → Reference ID).

```bash
supabase login
supabase init                              # creates supabase/config.toml alongside these files
supabase link --project-ref <your-project-ref>
supabase db push                           # applies migrations/ to the remote DB

cp supabase/.env.example supabase/.env      # then put your real client_... value in supabase/.env
supabase secrets set --env-file supabase/.env

supabase functions deploy license --no-verify-jwt
```

`--no-verify-jwt` lets the WorkOS token through Supabase's own JWT gate so the function can verify it
itself (the alternative is `[functions.license]\nverify_jwt = false` in `config.toml`).

The deployed URL is **`https://<project-ref>.functions.supabase.co/license`** — hand that back so the
app can wire `LICENSE_API_URL` (step 4).

## Verify it's live

```bash
curl -i https://<project-ref>.functions.supabase.co/license -H "Authorization: Bearer not-a-real-token"
# → 401 {"active":false,"error":"invalid token"}   (proves the function is deployed + rejecting bad tokens)
```

A real access token minted by the app's sign-in returns `{"active":true,"plan":"free","userId":"user_..."}`.
