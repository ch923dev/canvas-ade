// Supabase Edge Function: license  (Phase 1 accounts — entitlement check)
//
// WorkOS handles sign-in entirely in the Electron main process (PKCE, no backend, no API secret).
// This function is the ENTITLEMENT layer: it verifies the caller's WorkOS access-token JWT against
// WorkOS's JWKS (no shared secret) and returns the plan. Phase 1 returns 'free' for any verified
// user; Phase 2 (Stripe) looks the plan up in public.subscriptions.
//
// DEPLOY with `--no-verify-jwt` (or set `[functions.license] verify_jwt = false` in config.toml) so
// Supabase's built-in Supabase-JWT gate doesn't reject the WorkOS token before this code runs.
//
// SECURITY: validate signature (JWKS) + issuer + expiry ONLY. Do NOT validate `aud` — default
// AuthKit access tokens carry no `aud` claim, so an audience check would reject every token.

import { createRemoteJWKSet, jwtVerify } from 'https://deno.land/x/jose@v5.9.6/index.ts'

const WORKOS_CLIENT_ID = Deno.env.get('WORKOS_CLIENT_ID')
const ISSUER = 'https://api.workos.com/' // trailing slash per WorkOS

if (!WORKOS_CLIENT_ID) {
  console.error('[license] WORKOS_CLIENT_ID secret is not set — set it with `supabase secrets set`')
}

// jose caches + auto-rotates the key set; the JWKS URL is keyed by the WorkOS Client ID.
const JWKS = createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${WORKOS_CLIENT_ID}`))

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const header = req.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return json({ active: false, error: 'missing token' }, 401)

  try {
    // Signature (JWKS) + issuer + expiry. NO audience check (see security note above).
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER })
    const userId = payload.sub as string

    // Phase 1: every verified user is on the free plan. Phase 2 looks this up in
    // public.subscriptions (service-role) and returns the Stripe-driven plan/status.
    return json({ active: true, plan: 'free', userId }, 200)
  } catch {
    return json({ active: false, error: 'invalid token' }, 401)
  }
})
