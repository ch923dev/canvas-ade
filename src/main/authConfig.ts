/**
 * Phase 1 (accounts): pinned WorkOS + entitlement config. These are PUBLIC values for a PKCE public
 * client — the Client ID and the authorize/redirect/license URLs are safe to ship in the binary.
 * There is NO secret here. (Staging values; a Production switch can come later behind a build flag.)
 */
export interface AuthConfig {
  /** WorkOS public Client ID (client_…). */
  clientId: string
  /** Must match the redirect URI registered in the WorkOS dashboard EXACTLY. */
  redirectUri: string
  /** Supabase `license` Edge Function — verifies the WorkOS token (JWKS) + returns the plan. */
  licenseUrl: string
}

export const AUTH_CONFIG: AuthConfig = {
  clientId: 'client_01KW003AES5TSQ5ZB48GM01602',
  redirectUri: 'expanse://auth/callback',
  licenseUrl: 'https://csmbslgomkcompdsrxsi.functions.supabase.co/license'
}
