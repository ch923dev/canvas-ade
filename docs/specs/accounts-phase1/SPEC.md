# Phase 1 — Accounts · Implementation Spec

Branch: `feat/accounts` · Worktree: `.worktrees/accounts` · Base: `main` @ `6d425476`
Design artifact: [`DESIGN.md`](./DESIGN.md) + [`accounts-mock.png`](./accounts-mock.png) (signed off)
Strategy context: [`docs/research/2026-06-26-saas-productization/REPORT.md`](../../research/2026-06-26-saas-productization/REPORT.md)

## 0. Scope & locked decisions

**Goal:** add cloud accounts to the Electron desktop app — sign in / out, identity in-app, and a cached entitlement record — as the foundation for billing (Phase 2) and gating (Phase 3). **No payments in Phase 1.**

| Decision | Value |
|---|---|
| Surface | Desktop app + cloud accounts (no web rewrite) |
| Buyer | Solo / indie devs |
| Auth provider | **WorkOS AuthKit** (official Electron + PKCE + deep-link example) |
| Token storage | Electron `safeStorage` (clone `llmKeyStore`) |
| Sign-in model | **Optional / local-first** — app opens with no account, exactly like today |
| Hard gate | `__REQUIRE_ACCOUNT__` build constant **wired but default OFF** (Phase 3 may flip it in distribution builds) |
| Billing | Stripe (Phase 2) |
| Entitlement (Phase 1) | Plain cached JSON + TTL (`entitlement.json`); signed-JWT upgrade deferred |

**Local-first consequence:** account state is **independent** of `ProjectStatus` (`'welcome' | 'loading' | 'open' | 'error'`, `canvasStore.ts:52`). Do **not** add `'unauthenticated'` to that union. Account state lives in a new `accountStore`.

## 1. Account & entitlement model

Two new files in `app.getPath('userData')` (NEVER in a `<project>/.canvas/` folder):

| File | Contents | Secrecy |
|---|---|---|
| `session.json` | `{ userId, email, expiresAt, plan }` (non-secret identity) | plaintext, atomic write |
| `auth-tokens.json` | `{ accessToken, refreshToken, expiresAt }` | **`safeStorage`-encrypted** (clone `llmKeyStore`) |
| `entitlement.json` | `{ plan: 'free'\|'pro', status, currentPeriodEnd, checkedAt }` | plaintext, atomic write |

- **Identity key = WorkOS `sub`** (immutable), never email.
- **Entitlement is cached + offline-tolerant:** read at startup; if `checkedAt` within TTL (e.g. 1h) use it; if stale AND network unreachable, **fall back to cache** (never hard-block on a network failure). Phase 1 always returns `plan: 'free'` from the stub backend.
- `safeStorage` unavailable (headless Linux, no keyring) → surface `encryptionAvailable: false`, **block sign-in with a clear message, never write plaintext tokens** (mirrors `llmKeyStore`).

## 2. Auth flow (PKCE + `expanse://` deep link)

1. Renderer calls `window.api.auth.signIn()`.
2. **MAIN** generates `code_verifier` (32B base64url), `code_challenge` (SHA-256), `state` (16B) via `crypto.randomBytes`; stores `{ verifier }` in an in-memory `Map` keyed by `state`, **5-min TTL** (`setTimeout` eviction). Never persisted, never sent over IPC.
3. MAIN builds the WorkOS authorize URL (**domain pinned in a MAIN constant**, never renderer-supplied) → `openExternalSafe(httpsUrl)` → system browser. **Never an embedded `BrowserWindow`** (RFC 8252 §8.12).
4. User authenticates; WorkOS redirects to `expanse://auth/callback?code=…&state=…`.
5. OS routes it back:
   - **macOS:** `app.on('open-url', (e, url) => handleAuthCallback(url))`.
   - **Windows/Linux:** `app.on('second-instance', (e, argv) => handleAuthCallback(argv.find(a => a.startsWith('expanse://'))))`. Also scan `process.argv` on cold start.
6. MAIN validates: `new URL(url)`, `protocol === 'expanse:'`, pathname, **`state` matches the stored nonce** → else reject + log.
7. MAIN exchanges `code` + `verifier` for tokens via **Node `fetch` (MAIN only)**; writes encrypted tokens + `session.json`; clears the nonce; fetches the entitlement; pushes `auth:statusChanged`.
8. Renderer `accountStore` updates from the push → pill + SignInView reflect signed-in.

## 3. Files to add / change

### Main process (new modules — each: injected `userDataDir` + `Encryptor`, atomic `write-file-atomic`, **no Electron import**, unit-tested)

| File | Clone from | Purpose |
|---|---|---|
| `src/main/authTokenStore.ts` | `llmKeyStore.ts` (`createKeyStore`, `Encryptor`) | encrypted token get/set/clear; surface presence only |
| `src/main/authSession.ts` | `llmConfig.ts` (`read/writeLlmConfig`) | `session.json` read/write |
| `src/main/entitlementCache.ts` | `llmConfig.ts` + `recapConsent.ts` | cached plan/status; **synchronous `getEntitlements()`** for MAIN-side gates |
| `src/main/workosAuth.ts` | (new) | PKCE param gen, authorize-URL build, code→token exchange, refresh; pure-ish, fetch injected for tests |
| `src/main/authIpc.ts` | `llmIpc.ts` (`registerLlmHandlers`) + `autoUpdate.ts` (push) | the IPC surface + `auth:statusChanged` push |

### Main process (wire into `src/main/index.ts`)

- **`app.requestSingleInstanceLock()` BEFORE `app.whenReady()`** — if it returns false, `app.quit()`. (Required for the Windows/Linux `second-instance` deep-link path; a no-op if called after `whenReady`.)
- `app.setAsDefaultProtocolClient('expanse')`.
- `app.on('open-url', …)` + `app.on('second-instance', …)` → `handleAuthCallback`; buffer a callback that arrives before the window is ready.
- Build the `Encryptor` exactly like the existing `llmEncryptor` (the `safeStorage` adapter already in `index.ts`) and reuse it for `authTokenStore`.
- Register auth IPC next to the existing `registerLlmHandlers(...)` call:
  `registerAuthHandlers(ipcMain, () => mainWindow, userDataDir, { tokenStore, session, entitlement, workos })`.
- **Do NOT touch `buildMainWindowWebPreferences` (`windowSecurity.ts`)** — no new `webPreferences`.

### IPC surface (`authIpc.ts`) — `isForeignSender(e, getWin)` first line of **every** handler

| Channel | Returns | Notes |
|---|---|---|
| `auth:status` | `{ isLoggedIn, email?, plan?, subStatus?, encryptionAvailable }` | **never a token** (presence-only, like `llm.hasKey`) |
| `auth:signIn` | `{ ok }` immediately | kicks off PKCE; renderer waits on the push |
| `auth:signOut` | `{ ok }` | revoke + clear `authTokenStore`/`session`/`entitlement` + push |
| `auth:statusChanged` | push (`wc.send`, destroyed-window-guarded — copy `autoUpdate.ts:69-74`) | fired on sign-in / refresh / sign-out |

### Preload (`src/preload/index.ts` + `src/preload/index.d.ts`)

- Add an `auth` namespace to the `api` object mirroring the `update`/`llm` namespaces:
  `auth: { status(): Promise<AuthStatus>, signIn(): Promise<{ok:boolean}>, signOut(): Promise<{ok:boolean}>, onStatusChanged(cb): () => void }`.
- `onStatusChanged` returns an unsubscribe exactly like `recap.onLearned` / `onPreviewEvent` (`ipcRenderer.on` + `removeListener`).
- Export an `AuthStatus` interface; `CanvasApi = typeof api` already flows to `index.d.ts`. **No token type ever crosses preload.**

### Renderer

| File | Change |
|---|---|
| `src/renderer/src/store/accountStore.ts` | **new** Zustand (mirror `canvasStore` `create()` shape): `{ status:'checking'\|'signed-in'\|'signed-out', email?, plan?, encryptionAvailable }`; hydrate at boot via `window.api.auth.status()`; subscribe to `onStatusChanged` |
| `src/renderer/src/canvas/SignInView.tsx` | **new** — built on the shared `Modal`; idle / waiting / error states (per `DESIGN.md`) |
| `src/renderer/src/canvas/AppChrome.tsx` (`CameraCluster`) | add the account pill/avatar **before** the Settings gear; click → open Settings at the Account section (or open `SignInView` when signed out) |
| `src/renderer/src/canvas/SettingsModal.tsx` | add a new **"Account"** section at the top using the existing `styles.head` + `styles.divider` grammar (signed-out CTA card / signed-in row + Manage-subscription [disabled in P1] + Sign out) |
| `src/renderer/src/App.tsx` | render `<SignInView/>` as a forced gate **only** `if (__REQUIRE_ACCOUNT__ && accountStore.status === 'signed-out')`, before the `status === 'open' ? <Canvas/> : <WelcomeScreen/>` branch. Default-off, so Phase 1 behaves exactly like today. |
| `src/renderer/src/env.d.ts` | `declare const __REQUIRE_ACCOUNT__: boolean` |

### Config

| File | Change |
|---|---|
| `electron.vite.config.ts` | add to **`renderer.define`** (new block): `__REQUIRE_ACCOUNT__: JSON.stringify(process.env.REQUIRE_ACCOUNT === '1')` — same precedent as `__ENABLE_AUTO_UPDATE__` in `main.define` (`:86`). Default false. |
| `electron-builder.yml` | add top-level `protocols:\n  - name: Expanse\n    schemes:\n      - expanse` (near `npmRebuild:`, `:25`). No block exists today. |

## 4. Minimal backend (Phase 1 slice only)

Full Stripe wiring is Phase 2. Phase 1 needs only:
- A **WorkOS** application configured with redirect `expanse://auth/callback` (+ a Google connection).
- One table `users(id, workos_user_id, email)`.
- `GET /api/license` → `{ active: true, plan: 'free' }` stub (Supabase Edge Function verifying the WorkOS JWT via JWKS).

(Provider = Supabase per the strategy doc; the desktop talks to WorkOS for auth + this one stub endpoint for entitlement.)

## 5. Build sequence (verify at each step; commit per step)

| # | Step | Verify |
|---|---|---|
| 1 | `__REQUIRE_ACCOUNT__` define (renderer) + `env.d.ts` declare; default false | `pnpm typecheck`; `pnpm dev` unchanged |
| 2 | `authTokenStore.ts` + `authSession.ts` + `entitlementCache.ts` + **unit tests** (injected dir/encryptor) | `pnpm test` green; no Electron import |
| 3 | `protocols:` in `electron-builder.yml` + `setAsDefaultProtocolClient` + single-instance lock + `open-url`/`second-instance` handlers (log-only) | `pnpm pack:dir`; clicking an `expanse://test` link logs the URL in MAIN |
| 4 | `workosAuth.ts` (PKCE, authorize URL, exchange) + `authIpc.ts` (every handler `isForeignSender`) wired in `index.ts` | sign-in opens system browser; callback validated (state-checked); encrypted token lands in `safeStorage` |
| 5 | Preload `auth` namespace + `AuthStatus` type | `pnpm typecheck` (node + preload + web) |
| 6 | `accountStore.ts` + `SignInView.tsx` + the (default-off) `App.tsx` gate | with `REQUIRE_ACCOUNT=1`: signed-out → SignInView → after sign-in → canvas; default: unchanged |
| 7 | Account section in `SettingsModal` + pill in `AppChrome`; sign-out (revoke + clear + push) | **manual dev check**, `$env:CANVAS_DEV_TITLE='PR#NNN accounts'; pnpm dev`; confirm the title stamp |
| 8 | e2e specs (`@core`/`@chrome` tags) for pill + Settings Account section + signed-out↔in; **full matrix** at pre-merge | `pnpm test:e2e` (Win); `pnpm test:e2e:matrix` both legs at the pre-merge gate (`src/main`/`src/preload`/`electron-builder.yml` are `LINUX_SENSITIVE`) |

## 6. Security guardrails (non-negotiable — restate at review)

System browser only (never embedded webview) · no `client_secret` in the binary (public client + PKCE) · PKCE verifier + `state` in MAIN memory only, never persisted/IPC'd · tokens never on the IPC wire (presence-only `auth:status`) · code→token exchange in MAIN via Node `fetch` · deep-link URL fully validated + nonce-checked in MAIN · `requestSingleInstanceLock()` before `whenReady()` · authorize domain pinned in a MAIN constant · `safeStorage` unavailable → block sign-in, never plaintext · `isForeignSender` on every handler · `buildMainWindowWebPreferences` untouched.

## 7. Testing

- **Unit (Vitest, no Electron):** `authTokenStore` (encrypt round-trip via a fake `Encryptor`, presence-only), `authSession`, `entitlementCache` (TTL + offline fallback), `workosAuth` (PKCE challenge derivation, authorize-URL shape, callback validation incl. state mismatch + wrong protocol rejected).
- **e2e (Playwright `_electron`, tags `@core`/`@chrome`):** signed-out chrome shows the Sign-in pill; opening Settings shows the Account CTA; (mock the auth push) signed-in shows avatar + email + plan badge; sign-out returns to signed-out. The OAuth round-trip itself is mocked at the IPC boundary (no live WorkOS in e2e).
- **Manual dev check:** mandatory before opening the PR (title-stamped build).

## 8. Deferred to later phases (out of Phase 1 scope)

Stripe Checkout/Portal/webhooks + real entitlement (Phase 2) · feature gating + paywall + `__REQUIRE_ACCOUNT__` flip + MCP plan-awareness (Phase 3) · Sentry/PostHog (Phase 4) · settings cloud-sync + signed-JWT entitlement + stable `projectId` (Phase 5) · API-key cloud sync (never — `safeStorage` ciphertext is machine-local by design).
