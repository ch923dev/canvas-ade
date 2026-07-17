/**
 * Model combobox for the Context·LLM pane — a free-text input with a type-to-filter dropdown
 * fed by `llm.models.list` (the MAIN-side catalog). Free text is ALWAYS valid: typing calls
 * onChange immediately and never blocks on the list, so the no-key / offline / unknown-model
 * paths degrade to exactly the old bare input. Picking a row fills the input. The list is
 * fetched lazily on first open per provider (the catalog caches cloud lists for 1 h in MAIN).
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type KeyboardEvent
} from 'react'
import type { LlmModelEntry, LlmModelsListResult, LlmStatus } from '../../../../../preload'
import { pane } from '../paneStyles'

type Provider = LlmStatus['provider']

/** Rows rendered per filter pass — 344 OpenRouter models scroll fine; 2000 would jank. */
const MAX_VISIBLE = 200

/** 1048576 → "1M", 200000 → "200K", 8192 → "8K" (ctx sizes are round enough to floor). */
export function formatContext(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace('.0M', 'M')
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/** "just now" / "N min ago" / "N h ago" for the refresh footer. */
export function formatAge(fetchedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - fetchedAt) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.floor(m / 60)} h ago`
}

const HINTS: Record<'no-key' | 'no-base-url' | 'provider-error', string> = {
  'no-key': 'Add an API key to load the model list — custom ids still work.',
  'no-base-url': 'No local server configured — set the Base URL, or type the model id.',
  'provider-error': "Couldn't load the model list — custom ids still work."
}

const styles: Record<string, CSSProperties> = {
  wrap: { position: 'relative', display: 'flex', flexDirection: 'column' },
  list: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    zIndex: 20,
    marginTop: 3,
    maxHeight: 236,
    overflowY: 'auto',
    background: 'var(--surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-inner)',
    boxShadow: '0 6px 20px rgba(0,0,0,.35)',
    padding: 3
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 8px',
    borderRadius: 5,
    fontSize: 12,
    fontFamily: 'var(--ui)',
    color: 'var(--text)',
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  },
  rowId: { overflow: 'hidden', textOverflow: 'ellipsis', flex: '1 1 auto', minWidth: 0 },
  chip: { flex: 'none', fontSize: 10, color: 'var(--text-3)' },
  foot: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 8px',
    marginTop: 2,
    borderTop: '1px solid var(--border-subtle)',
    fontSize: 10.5,
    color: 'var(--text-3)'
  },
  footBtn: {
    border: 'none',
    background: 'none',
    padding: 0,
    fontSize: 10.5,
    fontFamily: 'var(--ui)',
    color: 'var(--accent-hover)',
    cursor: 'pointer'
  },
  degrade: { padding: '7px 8px', fontSize: 11, lineHeight: '15px', color: 'var(--text-3)' }
}

export interface ModelComboboxProps {
  provider: Provider
  value: string
  onChange: (model: string) => void
}

export function ModelCombobox({ provider, value, onChange }: ModelComboboxProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<LlmModelsListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(-1)
  // Filter only what the user TYPED since opening — a picked/persisted value would otherwise
  // filter the reopened list down to itself.
  const [typed, setTyped] = useState<string | null>(null)
  // "now" snapshot for the fetched-N-ago footer, captured on open/load (render must stay pure).
  const [now, setNow] = useState(0)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const loadedFor = useRef<Provider | null>(null)
  // Monotonic request seq: a resolving fetch only lands if it is still the LATEST request —
  // a slow response for the previously-selected provider (or a superseded refresh) is dropped
  // instead of overwriting the list with the wrong provider's models.
  const seq = useRef(0)

  // Provider switch invalidates the loaded list (next open refetches; MAIN cache absorbs it)
  // and supersedes any in-flight fetch for the old provider. Keyed on the provider VALUE
  // itself — not loadedFor — so a fetch that is still in flight (loadedFor not yet set) is
  // superseded too, not just an already-landed list.
  const prevProvider = useRef<Provider>(provider)
  useEffect(() => {
    if (prevProvider.current !== provider) {
      prevProvider.current = provider
      seq.current++
      setResult(null)
      setLoading(false)
      loadedFor.current = null
      setOpen(false)
      setTyped(null)
    }
  }, [provider])

  const load = (refresh: boolean): void => {
    const mySeq = ++seq.current
    const forProvider = provider
    setLoading(true)
    window.api.llm.models
      .list({ provider: forProvider, ...(refresh ? { refresh: true } : {}) })
      .then((r) => {
        if (seq.current !== mySeq) return // superseded (provider switch / newer request)
        setResult(r)
        setNow(Date.now())
        loadedFor.current = forProvider
      })
      .catch(() => {
        if (seq.current !== mySeq) return
        // IPC rejection (teardown race) — degrade like a provider error; free text still works.
        setResult({ ok: false, reason: 'provider-error' })
        loadedFor.current = forProvider
      })
      .finally(() => {
        if (seq.current === mySeq) setLoading(false)
      })
  }

  /** Kick a fetch if the loaded list isn't this provider's — shared by every open gesture. */
  const ensureLoaded = (): void => {
    if (loadedFor.current !== provider && !loading) load(false)
  }

  const openList = (): void => {
    setOpen(true)
    setActive(-1)
    setTyped(null)
    setNow(Date.now())
    ensureLoaded()
  }

  const close = (): void => {
    setOpen(false)
    setActive(-1)
    setTyped(null)
  }

  const filter = (typed ?? '').toLowerCase()
  const all = result?.ok ? result.models : []
  const matches = filter
    ? all.filter(
        (m) => m.id.toLowerCase().includes(filter) || (m.label ?? '').toLowerCase().includes(filter)
      )
    : all
  const visible = matches.slice(0, MAX_VISIBLE)

  const pick = (m: LlmModelEntry): void => {
    onChange(m.id)
    close()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) openList()
      else setActive((a) => Math.min(a + 1, visible.length - 1))
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, -1))
    } else if (e.key === 'Enter' && open) {
      // Enter with no highlighted row keeps the free text (and just closes the list).
      e.preventDefault()
      if (active >= 0 && active < visible.length) pick(visible[active])
      else close()
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      // One Esc, one layer: consume it here so the window-level Modal Esc handler doesn't also
      // close the whole Settings surface while the user only meant to close the list.
      e.stopPropagation()
      close()
    }
  }

  return (
    <div ref={wrapRef} style={styles.wrap} data-test="model-combobox">
      <input
        aria-label="Model"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls="model-combobox-list"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setTyped(e.target.value)
          setActive(-1)
          // Open WITHOUT openList(): its setTyped(null) would win the same React batch and
          // wipe this keystroke's filter (the tab-focus-then-type path never clicks first).
          if (!open) {
            setOpen(true)
            setNow(Date.now())
            ensureLoaded()
          }
        }}
        onClick={() => {
          if (!open) openList()
        }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          // Clicking inside the list fires blur first — don't close before the row's onClick.
          if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) close()
        }}
        style={pane.input}
      />
      {open && (
        <div
          id="model-combobox-list"
          role="listbox"
          style={styles.list}
          data-test="model-combobox-list"
        >
          {loading && <div style={styles.degrade}>Loading models…</div>}
          {!loading && result && !result.ok && (
            <div style={styles.degrade} data-test="model-combobox-degrade">
              {HINTS[result.reason]}
            </div>
          )}
          {!loading && result?.ok && visible.length === 0 && (
            <div style={styles.degrade}>No matching models — free text is fine.</div>
          )}
          {!loading &&
            visible.map((m, i) => (
              <div
                key={m.id}
                role="option"
                aria-selected={i === active}
                data-test={`model-option-${m.id}`}
                style={{
                  ...styles.row,
                  background: i === active ? 'var(--accent-wash)' : 'transparent'
                }}
                // preventDefault keeps focus in the input so blur doesn't close before the pick.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(m)}
                onMouseEnter={() => setActive(i)}
              >
                <span style={styles.rowId} title={m.label ?? m.id}>
                  {m.id}
                </span>
                {m.contextLength != null && (
                  <span style={styles.chip}>{formatContext(m.contextLength)} ctx</span>
                )}
                {m.toolUse === true && <span style={styles.chip}>⚒ tools</span>}
              </div>
            ))}
          {!loading && matches.length > MAX_VISIBLE && (
            <div style={styles.degrade}>…{matches.length - MAX_VISIBLE} more — keep typing.</div>
          )}
          {!loading && result?.ok && (
            <div style={styles.foot}>
              <button
                type="button"
                style={styles.footBtn}
                data-test="model-combobox-refresh"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => load(true)}
              >
                ↻ Refresh
              </button>
              <span>
                fetched {formatAge(result.fetchedAt, now)}
                {result.stale ? ' · offline — showing cached list' : ''}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
