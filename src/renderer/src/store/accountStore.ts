/**
 * Phase 1 accounts: the renderer's view of sign-in state. Mirrors MAIN's `AuthStatus`
 * (presence + email + plan only — a token NEVER reaches the renderer). Hydrated at boot from
 * `window.api.auth.status()` and kept live by the `auth:statusChanged` push (useAccountSync,
 * wired in App.tsx alongside the recap subscription). Ephemeral session state — never serialized.
 *
 * `status` starts at 'checking' so the `__REQUIRE_ACCOUNT__` gate (App.tsx) does NOT flash the
 * sign-in screen before the real status resolves — it shows only on a CONFIRMED 'signed-out'.
 */
import { useEffect } from 'react'
import { create } from 'zustand'

export type AccountStatus = 'checking' | 'signed-in' | 'signed-out'
export type Plan = 'free' | 'pro'

/** The status payload pushed from MAIN (structurally identical to preload's AuthStatus). */
interface AuthStatusPayload {
  isLoggedIn: boolean
  email?: string
  plan?: Plan
  encryptionAvailable: boolean
}

interface AccountState {
  status: AccountStatus
  email?: string
  plan?: Plan
  /** safeStorage availability — false blocks sign-in (no plaintext tokens, mirrors llmKeyStore). */
  encryptionAvailable: boolean
  /** Fold a MAIN status payload into the store (boot hydrate + every push). */
  apply: (s: AuthStatusPayload) => void
}

export const useAccountStore = create<AccountState>((set) => ({
  status: 'checking',
  email: undefined,
  plan: undefined,
  // Optimistic until status resolves — mirrors SettingsModal's keyring default so we never
  // flash a "no keyring" error during the brief hydrate window.
  encryptionAvailable: true,
  apply: (s) =>
    set({
      status: s.isLoggedIn ? 'signed-in' : 'signed-out',
      email: s.email,
      plan: s.plan,
      encryptionAvailable: s.encryptionAvailable
    })
}))

/**
 * Hydrate the account store at boot, then subscribe to MAIN's `auth:statusChanged` push.
 * Mirrors App.tsx's `recap.onLearned` wiring — guarded for the non-electron smoke/test renders
 * where `window.api` is absent (there we settle to a safe signed-out shape so the chrome renders).
 */
export function useAccountSync(): void {
  const apply = useAccountStore((s) => s.apply)
  useEffect(() => {
    const auth = window.api?.auth
    if (!auth) {
      // No bridge (smoke render) — treat as signed-out, no keyring.
      apply({ isLoggedIn: false, encryptionAvailable: false })
      return
    }
    let cancelled = false
    void auth
      .status()
      .then((s) => {
        if (!cancelled) apply(s)
      })
      .catch(() => {
        // IPC rejection (channel unavailable, teardown race) — settle to signed-out so the
        // chrome shows the Sign-in pill rather than spinning on 'checking' forever.
        if (!cancelled) apply({ isLoggedIn: false, encryptionAvailable: false })
      })
    const off = auth.onStatusChanged((s) => apply(s))
    return () => {
      cancelled = true
      off()
    }
  }, [apply])
}
