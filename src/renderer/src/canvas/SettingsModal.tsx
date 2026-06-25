/**
 * T-B2: the LLM Settings modal. Choose a provider, override its model, optionally enter an
 * API key (masked, write-only into MAIN via llm.setKey — never read back). Rendered on the
 * shared Modal primitive (scrim/portal/Esc/focus — design-audit D1-B), design-token styled
 * (calm/dense, one accent). Provider/model persist via llm.setConfig; the key via llm.setKey;
 * Clear key via llm.clearKey. No multi-key/profiles.
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { Modal } from './Modal'
import { Icon } from './Icon'
import { AccountAvatar } from './AccountAvatar'
import { DEFAULT_MODELS } from '../lib/llmModels'
import { useCanvasStore } from '../store/canvasStore'
import { useAccountStore } from '../store/accountStore'
import { useOrchestrationStore } from '../store/orchestrationStore'

const PROVIDERS: Array<{ id: keyof typeof DEFAULT_MODELS; label: string }> = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'local', label: 'Local' }
]

/** T-F6: the env var each provider reads its key from when no keyring is available to encrypt one. */
const ENV_VAR: Record<keyof typeof DEFAULT_MODELS, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  local: 'OPENAI_API_KEY'
}

export function SettingsModal({
  onClose,
  onSignIn
}: {
  onClose: () => void
  /** Phase 1 accounts: the Account section's signed-out "Sign in" CTA. AppChrome closes Settings
   *  then opens SignInView (two shared Modals must not stack); optional so the modal stands alone. */
  onSignIn?: () => void
}): ReactElement {
  const [provider, setProvider] = useState<keyof typeof DEFAULT_MODELS>('openrouter')
  const [model, setModel] = useState<string>(DEFAULT_MODELS.openrouter)
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  // T-F6: default true so we don't flash a keyring warning before status resolves.
  const [encryptionAvailable, setEncryptionAvailable] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // MCP-05: the per-day LLM call cap (string-backed so the input can be cleared; '' = nothing
  // loaded yet) + a small usage peek (today's calls / the effective cap) read from llm.status().
  const [maxCalls, setMaxCalls] = useState('')
  const [usage, setUsage] = useState<{ calls: number; cap: number } | null>(null)

  const projectDir = useCanvasStore((s) => s.project.dir)
  const [recapConsent, setRecapConsent] = useState<'enabled' | 'declined' | 'undecided'>(
    'undecided'
  )

  // Agent Orchestration Onboarding (P1): the reactive consent cache + the cross-component modal
  // channel (the onboarding modals are hosted in AppChrome's <OrchestrationModals/>, not here).
  const orchestrationEnabled = useOrchestrationStore((s) => s.enabled)
  const setOrchestrationModal = useOrchestrationStore((s) => s.setModal)
  const setOrchestrationCache = useOrchestrationStore((s) => s.setEnabled)

  useEffect(() => {
    let cancelled = false
    void window.api.recap
      .getConsent()
      .then((c) => {
        if (cancelled) return
        setRecapConsent(c)
      })
      .catch(() => {
        if (!cancelled) setRecapConsent('undecided')
      })
    return () => {
      cancelled = true
    }
  }, [projectDir])

  useEffect(() => {
    // BUG-007(1): without a cancellation flag a slow llm.status() resolving AFTER the user has
    // already edited the provider/model silently clobbers their input back to the persisted values.
    // Mirror the prose-fetch guard pattern: skip the overwrite if the effect was cleaned up.
    let cancelled = false
    void window.api.llm
      .status()
      .then((s) => {
        if (cancelled) return
        setProvider(s.provider)
        setModel(s.model)
        setHasKey(s.hasKey)
        setEncryptionAvailable(s.encryptionAvailable !== false) // tolerate an older no-field status
        if (s.baseUrl) setBaseUrl(s.baseUrl)
        // MCP-05: prefill the cap field with the effective limit (configured override, else the
        // default) + the usage peek. Robust to an older status missing these fields → '' / no peek.
        const cap = s.maxCallsPerDay ?? s.defaultMaxCallsPerDay
        setMaxCalls(cap != null ? String(cap) : '')
        if (s.callsToday != null) setUsage({ calls: s.callsToday, cap: cap ?? 0 })
      })
      .catch(() => {
        // BUG-031: IPC rejection (channel unavailable, teardown race) must not produce an
        // unhandledRejection. Fall to the safe default: assume no key is set for this session.
        if (!cancelled) setHasKey(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onProvider = (p: keyof typeof DEFAULT_MODELS): void => {
    setProvider(p)
    setModel(DEFAULT_MODELS[p]) // prefill the cheap/fast default; still editable
    // BUG-007(3): hasKey tracked the load-time provider only, so after a dropdown change the
    // "· set" indicator (and a Clear-key target) stayed stale. Re-fetch the key presence for the
    // newly-selected provider. Guarded against an out-of-order resolve by re-reading current state.
    void window.api.llm
      .status()
      .then((s) => {
        setHasKey(s.provider === p ? s.hasKey : false)
      })
      .catch(() => {
        // BUG-031: IPC rejection must not produce an unhandledRejection. Safe default: no key.
        setHasKey(false)
      })
  }

  // BUG-065: the recap toggle was optimistic fire-and-forget — a resolved {ok:false} (MAIN dir
  // desync / frame guard) or a rejection (disk error, teardown race) left the checkbox showing a
  // state that never persisted (privacy-relevant on untick: the hook stays installed). Mirror the
  // llm save() pattern: check .ok, revert the optimistic state and surface the error on failure.
  const onRecapToggle = async (next: 'enabled' | 'declined'): Promise<void> => {
    const prev = recapConsent
    setRecapConsent(next)
    setError(null)
    try {
      const r = await window.api.recap.setConsent(next)
      if (!r.ok) {
        setRecapConsent(prev)
        setError('Could not update agent recaps — please try again.')
      }
    } catch {
      setRecapConsent(prev)
      setError('Could not update agent recaps — please try again.')
    }
  }

  // Orchestration toggle (annotation E): the toggle re-opens the informed Enable modal, the
  // "Sync" button re-opens Sync. Turning OFF is a direct revoke (a simple, safe action; P3
  // unsyncs the per-CLI configs). Turning ON routes through the Enable modal so consent is always
  // informed (capabilities + the security callout) — the grant itself happens there. Opening
  // either onboarding modal CLOSES Settings first: the modals are hosted in AppChrome's
  // <OrchestrationModals/>, and stacking them over Settings would duel the shared Modal's focus
  // trap + Esc handling. The revoke path stays in Settings (the switch flips reactively).
  const openOrchestrationModal = (view: 'enable' | 'sync'): void => {
    onClose()
    setOrchestrationModal(view)
  }
  const onOrchestrationToggle = async (): Promise<void> => {
    if (!orchestrationEnabled) {
      openOrchestrationModal('enable')
      return
    }
    // Guard the async revoke like `save`/`clear`: setBusy(true) + a busy-disabled button so a
    // rapid double-click can't fire two concurrent setConsent('declined') IPC calls whose
    // setError/setOrchestrationCache side-effects interleave in confusing order.
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.orchestration.setConsent('declined')
      if (!r.ok) {
        setError('Could not update agent orchestration — please try again.')
        setBusy(false)
        return
      }
      setOrchestrationCache(false)
    } catch {
      setError('Could not update agent orchestration — please try again.')
    }
    setBusy(false)
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // BUG-007(2): a non-throwing `{ ok: false }` (e.g. frame-guard 'forbidden', or a rejected
      // baseUrl) would otherwise fall through to setKey + onClose, silently closing the modal as if
      // the (un-persisted) config had saved. Guard on the result before going any further.
      // MCP-05: persist the cap when the field holds a valid non-negative integer; an empty/invalid
      // field omits it so MAIN preserves the existing cap (never silently wipes it to the default).
      const parsedMax = parseInt(maxCalls, 10)
      const cr = await window.api.llm.setConfig({
        provider,
        model,
        baseUrl: provider === 'local' && baseUrl ? baseUrl : undefined,
        maxCallsPerDay: Number.isInteger(parsedMax) && parsedMax >= 0 ? parsedMax : undefined
      })
      if (!cr.ok) {
        setError('Could not save settings — please try again.')
        return
      }
      // BUG-007(4): strip ALL whitespace (incl. embedded \r\n/tabs from a wrapped paste) before the
      // guard and before storage — `trim()` only removes the ends, so an embedded newline survived
      // and later threw an opaque "invalid header value" on every summarize.
      const cleanKey = key.replace(/\s+/g, '')
      if (cleanKey) {
        const r = await window.api.llm.setKey({ provider, key: cleanKey })
        if (!r.ok) {
          setError(
            r.reason === 'encryption-unavailable'
              ? 'Key not saved: no system keyring available to encrypt it. Provider/model were saved.'
              : 'Key could not be saved.'
          )
          return
        }
      }
      onClose()
    } catch {
      // An IPC rejection (channel gone, main-side throw, teardown race) would otherwise vanish
      // silently and leave the modal looking saved (H1). Surface it so the user can retry.
      setError('Could not save settings — please try again.')
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // BUG-029: guard on the returned {ok} before clearing UI state, mirroring save()'s pattern.
      // A non-throwing {ok:false} (e.g. frame-guard 'forbidden') must NOT clear hasKey — the key
      // is still in the keyring and the UI would show a false-cleared state until the next open.
      const r = await window.api.llm.clearKey({ provider })
      if (!r.ok) {
        setError('Could not clear the key — please try again.')
        return
      }
      setHasKey(false)
      setKey('')
    } catch {
      setError('Could not clear the key — please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    // BUG-007(5) rides on the shared Modal: while a save is in flight (closeDisabled) the
    // scrim swallows the close AND shows a 'wait' cursor so the lock is felt.
    <Modal
      label="LLM settings"
      onClose={onClose}
      closeDisabled={busy}
      zIndex={300}
      scrimProps={{ 'data-test': 'settings-scrim' }}
      cardProps={{ 'data-test': 'settings-modal' }}
      cardStyle={styles.card}
    >
      {/* Phase 1 accounts: identity + plan at the top of Settings (DESIGN.md › Surface 2). */}
      <AccountSection onSignIn={onSignIn} />

      <div style={styles.divider} />

      <div style={styles.head}>Context brain · LLM</div>

      <label style={styles.field}>
        <span style={styles.label}>Provider</span>
        <select
          aria-label="Provider"
          value={provider}
          onChange={(e) => onProvider(e.target.value as keyof typeof DEFAULT_MODELS)}
          style={styles.input}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label style={styles.field}>
        <span style={styles.label}>Model</span>
        <input
          aria-label="Model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          style={styles.input}
        />
      </label>

      {provider === 'local' && (
        <label style={styles.field}>
          <span style={styles.label}>Base URL</span>
          <input
            aria-label="Base URL"
            value={baseUrl}
            placeholder="http://127.0.0.1:1234/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
            style={styles.input}
          />
        </label>
      )}

      <label style={styles.field}>
        <span style={styles.label}>
          API key {hasKey && <span style={{ color: 'var(--accent)' }}>· set</span>}
        </span>
        <input
          aria-label="API key"
          type="password"
          value={key}
          placeholder={hasKey ? '•••••••• (leave blank to keep)' : 'Paste your key'}
          onChange={(e) => setKey(e.target.value)}
          style={styles.input}
        />
      </label>

      {!encryptionAvailable && provider !== 'local' && (
        <div role="note" data-test="settings-no-keyring" style={styles.notice}>
          No system keyring detected — a key can&apos;t be stored encrypted on this machine. Set the{' '}
          <code>{ENV_VAR[provider]}</code> environment variable instead.
        </div>
      )}

      {/* MCP-05: the per-day call cap was enforced in MAIN but had no UI — expose it + a usage peek. */}
      <label style={styles.field}>
        <span style={styles.label}>Max LLM calls / day</span>
        <input
          aria-label="Max LLM calls per day"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={maxCalls}
          placeholder="200"
          onChange={(e) => setMaxCalls(e.target.value)}
          style={styles.input}
        />
        {usage && (
          <span style={styles.hint} data-test="settings-usage-peek">
            {usage.calls} of {usage.cap} used today
          </span>
        )}
      </label>

      {error && (
        <div role="alert" data-test="settings-error" style={styles.error}>
          {error}
        </div>
      )}

      <div style={styles.divider} />

      <div style={styles.head}>Terminal</div>

      <label style={{ ...styles.field, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <input
          type="checkbox"
          data-test="settings-recap-toggle"
          checked={recapConsent === 'enabled'}
          disabled={projectDir === null}
          aria-label="Agent recaps (this project)"
          onChange={(e) => {
            void onRecapToggle(e.target.checked ? 'enabled' : 'declined')
          }}
          style={{
            marginTop: 2,
            accentColor: 'var(--accent)',
            cursor: projectDir === null ? 'not-allowed' : 'pointer'
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={styles.label}>
            Agent recaps (this project)
            {projectDir === null && (
              <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>
                {' '}
                — open a project to enable
              </span>
            )}
          </span>
          <span style={styles.hint}>
            Flip a terminal to a recap of what its agent is doing. Reads the session transcript
            locally; only a scrubbed slice is sent to your chosen LLM.
          </span>
        </div>
      </label>

      <div style={styles.divider} />

      <div style={styles.head}>Agent orchestration</div>

      {/* Annotation E: both onboarding states are reachable here — the toggle re-opens the
          informed Enable modal (or revokes), the "Sync" button re-opens Sync. */}
      <div style={styles.orchRow} data-test="settings-orchestration-row">
        <div style={{ flex: 1 }}>
          <div style={styles.orchTitle}>
            Agent orchestration
            {projectDir === null && (
              <span style={{ color: 'var(--text-3)', fontWeight: 400 }}> — open a project</span>
            )}
          </div>
          <div style={styles.orchSub}>
            Drive this canvas from terminal agents, along your cables.
          </div>
        </div>
        <button
          type="button"
          style={{ ...styles.syncBtn, ...(projectDir === null ? styles.ctlDisabled : null) }}
          disabled={projectDir === null}
          onClick={() => openOrchestrationModal('sync')}
          data-test="settings-orchestration-sync"
        >
          <Icon name="refresh" size={12} />
          Sync
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={orchestrationEnabled}
          aria-label="Agent orchestration (this project)"
          disabled={busy || projectDir === null}
          onClick={() => void onOrchestrationToggle()}
          data-test="settings-orchestration-toggle"
          style={{
            ...styles.toggle,
            background: orchestrationEnabled ? 'var(--accent)' : 'var(--border-strong)',
            cursor: projectDir === null ? 'not-allowed' : 'pointer',
            opacity: projectDir === null ? 0.5 : 1
          }}
        >
          <span
            style={{
              ...styles.toggleKnob,
              left: orchestrationEnabled ? 17 : 2
            }}
          />
        </button>
      </div>

      <div style={styles.row}>
        {/* STYLE-01: shared modal-button grammar (filled accent primary at AA contrast). */}
        <button className="ca-btn-ghost" disabled={busy} onClick={() => void clear()}>
          Clear key
        </button>
        <div style={{ flex: 1 }} />
        <button className="ca-btn-ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="ca-btn-primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  )
}

// Phase 1 accounts: the "Account" block at the top of Settings (DESIGN.md › Surface 2). Signed-out
// → a CTA card whose "Sign in" defers to the parent (close Settings → open SignInView). Signed-in →
// identity row + plan badge + Manage-subscription (disabled until billing, Phase 2) + Sign out.
// Own store subscription so a status push re-renders only this section.
function AccountSection({ onSignIn }: { onSignIn?: () => void }): ReactElement {
  const status = useAccountStore((s) => s.status)
  const email = useAccountStore((s) => s.email)
  const plan = useAccountStore((s) => s.plan)
  const [busy, setBusy] = useState(false)

  const signOut = async (): Promise<void> => {
    setBusy(true)
    try {
      // MAIN clears local tokens/session/entitlement and pushes auth:statusChanged, which flips
      // this section back to the signed-out CTA. A rejected IPC is non-fatal (state is local).
      await window.api.auth.signOut()
    } catch {
      // swallow — sign-out is best-effort local teardown
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div style={styles.head}>Account</div>
      {status === 'signed-in' ? (
        <>
          <div style={styles.acctRow} data-test="account-row">
            <AccountAvatar email={email} plan={plan} size={28} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={styles.acctEmail}>{email ?? 'Signed in'}</div>
              <div style={styles.acctSub}>Signed in</div>
            </div>
            <span style={plan === 'pro' ? styles.badgePro : styles.badgeFree}>
              {plan === 'pro' ? 'PRO' : 'FREE'}
            </span>
          </div>
          <div style={styles.row}>
            <button
              className="ca-btn-ghost"
              disabled
              title="Available when billing ships (Phase 2)"
              data-test="account-manage"
            >
              Manage subscription
            </button>
            <div style={{ flex: 1 }} />
            <button
              className="ca-btn-ghost"
              disabled={busy}
              data-test="account-signout"
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          </div>
        </>
      ) : (
        <div style={styles.acctCta} data-test="account-cta">
          <span style={styles.acctCtaText}>
            Sign in to sync settings across machines and unlock Pro.
          </span>
          <button
            className="ca-btn-primary"
            data-test="account-cta-signin"
            onClick={() => onSignIn?.()}
          >
            Sign in
          </button>
        </div>
      )}
    </>
  )
}

const styles: Record<string, CSSProperties> = {
  // Scrim + card chrome (surface/border/shadow) come from the shared Modal; only the
  // Settings-specific layout stays here.
  card: {
    width: 380,
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 12
  },
  head: { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 11, color: 'var(--text-3)', fontWeight: 600 },
  input: {
    height: 30,
    padding: '0 9px',
    borderRadius: 6,
    border: '1px solid var(--border-subtle)',
    background: 'var(--inset)',
    color: 'var(--text)',
    fontSize: 12.5,
    fontFamily: 'var(--ui)'
  },
  error: {
    fontSize: 11.5,
    lineHeight: '15px',
    color: 'var(--warn)',
    background: 'var(--inset)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 6,
    padding: '7px 9px'
  },
  notice: {
    fontSize: 11.5,
    lineHeight: '15px',
    color: 'var(--text-3)',
    background: 'var(--inset)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 6,
    padding: '7px 9px'
  },
  divider: { height: 1, background: 'var(--border-subtle)', margin: '2px 0' },
  hint: { fontSize: 11, lineHeight: '15px', color: 'var(--text-3)' },
  // Phase 1 accounts: the signed-in identity row + the signed-out CTA card + plan badges.
  acctRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    background: 'var(--surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-inner)',
    padding: '11px 13px'
  },
  acctEmail: {
    fontSize: 12.5,
    color: 'var(--text)',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  acctSub: { fontSize: 11, color: 'var(--text-3)', marginTop: 2 },
  acctCta: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    background: 'var(--inset)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-inner)',
    padding: '12px 13px'
  },
  acctCtaText: { flex: 1, fontSize: 12, color: 'var(--text-2)', lineHeight: '17px' },
  badgeFree: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.03em',
    color: 'var(--text-3)',
    background: 'var(--surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 4,
    padding: '2px 7px'
  },
  badgePro: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.03em',
    color: 'var(--accent)',
    background: 'var(--accent-wash)',
    border: '1px solid rgba(79,140,255,.4)',
    borderRadius: 4,
    padding: '2px 7px'
  },
  // Agent orchestration row (the mock's `.setrow`): description + Sync button + toggle.
  orchRow: {
    background: 'var(--surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-inner)',
    padding: '12px 13px',
    display: 'flex',
    alignItems: 'center',
    gap: 12
  },
  orchTitle: { fontSize: 12.5, color: 'var(--text)', fontWeight: 500 },
  orchSub: { fontSize: 11, color: 'var(--text-3)', lineHeight: '15px', marginTop: 2 },
  syncBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    fontWeight: 500,
    fontFamily: 'var(--ui)',
    color: 'var(--accent-hover)',
    border: '1px solid rgba(79,140,255,.4)',
    background: 'var(--accent-wash)',
    borderRadius: 'var(--r-ctl)',
    padding: '5px 11px',
    cursor: 'pointer'
  },
  ctlDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  toggle: {
    position: 'relative',
    width: 36,
    height: 21,
    flex: 'none',
    border: 'none',
    padding: 0,
    borderRadius: 999,
    transition: 'background 0.12s ease-out'
  },
  toggleKnob: {
    position: 'absolute',
    top: 2,
    width: 17,
    height: 17,
    borderRadius: 999,
    background: '#fff',
    transition: 'left 0.12s ease-out'
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }
  // STYLE-01: the former `ghost`/`primary` inline button styles moved to the shared
  // `.ca-btn-ghost` / `.ca-btn-primary` classes in index.css (hover + AA-contrast primary).
}
