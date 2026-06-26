import { ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * Phase 1 accounts: the preload `auth` namespace + its status type, factored out of preload/index.ts
 * to stay under the max-lines ratchet. MIRRORS main `AuthStatus` (src/main/authService.ts) — presence
 * + email + plan only; a token NEVER crosses this boundary. Keep in lockstep with main.
 */
export interface AuthStatus {
  isLoggedIn: boolean
  email?: string
  plan?: 'free' | 'pro'
  encryptionAvailable: boolean
}

export const authApi = {
  /** Current sign-in status (presence + email + plan). Hydrate on mount + after each change. */
  status: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
  /** Start PKCE sign-in (opens the system browser). Resolves immediately; await onStatusChanged. */
  signIn: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('auth:signIn'),
  /** Sign out — clears the local session / tokens / entitlement. */
  signOut: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('auth:signOut'),
  /** Subscribe to status changes pushed by main. Returns an unsubscribe fn (like update.onStatus). */
  onStatusChanged: (listener: (status: AuthStatus) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, status: AuthStatus): void => listener(status)
    ipcRenderer.on('auth:statusChanged', handler)
    return () => ipcRenderer.removeListener('auth:statusChanged', handler)
  }
}
