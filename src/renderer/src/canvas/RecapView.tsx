/**
 * S1 (recap redesign): the two-zone recap back-face of a Terminal board, per the approved
 * mock (docs/superpowers/specs/2026-06-13-recap-redesign-mock.html). Zone 1 = the glance:
 * status word + session meta + Resume/refresh, session title, the narrative NOW (+ NEXT).
 * Zone 2 = the evidence: timeline beats, CHANGED/COMMANDS chips, the last-ask footer.
 *
 * Data = one `recap:get` bundle: LOCAL facts (always present - computed in MAIN with no
 * LLM/egress, so the face works with no API key) + the cached narrative sidecar when the
 * summary loop has produced one. Refresh still rides `memory:refresh` (the same budgeted
 * summarize the digest uses); facts re-read on every load so they are always live.
 * The front face (the xterm well) stays mounted behind the flip - loading here never
 * touches the PTY session.
 */
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode
} from 'react'
import { IconBtn } from './BoardFrame'
import { hhmm, relAge, spanLabel, baseName } from '../lib/recapFormat'

// Derived from the preload contract so there is no fourth mirror of the shapes.
type RecapBundle = NonNullable<Awaited<ReturnType<typeof window.api.recap.get>>>
type RecapFacts = RecapBundle['facts']

/** How many chips each evidence column shows (facts arrive recency-first, capped in MAIN). */
const CHIPS_SHOWN = 6

function statusMeta(facts: RecapFacts): { color: string; label: string } {
  switch (facts.status) {
    case 'waiting-on-you':
      return { color: 'var(--warn)', label: 'waiting on you' }
    case 'running':
      return { color: 'var(--ok)', label: 'running' }
    case 'spawning':
      return { color: 'var(--ok)', label: 'starting' }
    case 'spawn-failed':
      return { color: 'var(--err)', label: 'failed to start' }
    case 'exited':
      return typeof facts.exitCode === 'number' && facts.exitCode !== 0
        ? { color: 'var(--err)', label: `exited (code ${facts.exitCode})` }
        : { color: 'var(--text-3)', label: 'exited' }
    case 'idle':
      return { color: 'var(--text-3)', label: 'idle' }
  }
}

/** No claude session has ever touched this board: nothing to recap yet. */
function isEmptySession(b: RecapBundle): boolean {
  const f = b.facts
  return (
    !b.narrative &&
    f.turns.user + f.turns.agent === 0 &&
    !f.title &&
    !f.lastAsk &&
    f.files.length === 0 &&
    f.commands.length === 0
  )
}

const micro: CSSProperties = {
  fontSize: 'var(--fs-micro)',
  lineHeight: 'var(--lh-micro)',
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase'
}
const meta: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 'var(--fs-meta)',
  lineHeight: 'var(--lh-meta)',
  fontWeight: 450
}
const body: CSSProperties = {
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-body)',
  fontWeight: 400
}

function Dot({ color, size = 8 }: { color: string; size?: number }): ReactElement {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: color,
        flex: 'none',
        display: 'inline-block'
      }}
    />
  )
}

function SectionHead({ children }: { children: string }): ReactElement {
  return <div style={{ ...micro, color: 'var(--text-3)', marginBottom: 8 }}>{children}</div>
}

function Chip({ children }: { children: ReactNode }): ReactElement {
  return (
    <span
      style={{
        ...meta,
        padding: '2px 8px',
        borderRadius: 'var(--r-ctl)',
        background: 'var(--surface-raised)',
        border: '1px solid var(--border)',
        color: 'var(--text-2)',
        whiteSpace: 'nowrap'
      }}
    >
      {children}
    </span>
  )
}

export function RecapView({
  boardId,
  canResume,
  onResume
}: {
  boardId: string
  canResume?: boolean
  onResume?: () => void
}): ReactElement {
  const [bundle, setBundle] = useState<RecapBundle | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const out = await window.api.recap.get(boardId)
    setBundle(out)
    setLoaded(true)
  }, [boardId])
  useEffect(() => {
    // `load` only setStates AFTER its await resolves - not a synchronous in-effect
    // setState - but the lint rule can't see through the async boundary (matches the
    // BoardNode.tsx fetch-on-mount precedent).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])
  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.memory.refresh(boardId)
      await load()
    } finally {
      setBusy(false)
    }
  }, [boardId, load])

  const facts = bundle?.facts
  const narrative = bundle?.narrative

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        padding: '14px 16px',
        overflow: 'auto',
        background: 'var(--surface)',
        color: 'var(--text)'
      }}
      data-test="recap-view"
    >
      {!loaded ? null : !bundle || isEmptySession(bundle) ? (
        <div data-test="recap-empty">
          <div style={{ ...body, color: 'var(--text-2)' }}>No agent session on this board yet.</div>
          <div style={{ ...meta, color: 'var(--text-3)', marginTop: 4 }}>
            {busy
              ? 'Updating…'
              : 'Launch claude here, with Agent recaps enabled in Settings, to get one.'}
          </div>
          <div style={{ position: 'absolute', top: 12, right: 14 }}>
            <IconBtn
              name="refresh"
              title="Refresh recap"
              active={busy}
              onClick={() => void refresh()}
            />
          </div>
        </div>
      ) : (
        facts && (
          <>
            {/* ── zone 1: the glance ──────────────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-test="recap-status">
              <Dot color={statusMeta(facts).color} />
              <span style={{ ...micro, color: statusMeta(facts).color }}>
                {statusMeta(facts).label}
              </span>
              {facts.sessionStart && facts.lastActivity ? (
                <>
                  <span style={{ ...meta, color: 'var(--text-faint)' }}>·</span>
                  <span style={{ ...meta, color: 'var(--text-2)' }}>
                    {spanLabel(facts.lastActivity - facts.sessionStart)} session
                  </span>
                </>
              ) : null}
              <span style={{ ...meta, color: 'var(--text-faint)' }}>·</span>
              <span style={{ ...meta, color: 'var(--text-3)' }}>
                {narrative
                  ? `as of ${hhmm(narrative.asOf)}`
                  : facts.lastActivity
                    ? `active ${relAge(facts.generatedAt - facts.lastActivity)}`
                    : 'no activity'}
              </span>
              <span style={{ flex: 1 }} />
              {canResume && onResume ? (
                <button
                  type="button"
                  onClick={onResume}
                  data-test="recap-resume"
                  style={{
                    fontFamily: 'var(--ui)',
                    fontSize: 'var(--fs-label)',
                    lineHeight: 'var(--lh-label)',
                    fontWeight: 500,
                    padding: '4px 10px',
                    borderRadius: 'var(--r-ctl)',
                    background: 'var(--accent-wash)',
                    color: 'var(--accent)',
                    border: '1px solid rgba(79, 140, 255, 0.28)',
                    cursor: 'pointer'
                  }}
                >
                  Resume ⏎
                </button>
              ) : null}
              <IconBtn
                name="refresh"
                title="Refresh recap"
                active={busy}
                onClick={() => void refresh()}
              />
            </div>

            {facts.title ? (
              <div
                style={{
                  fontSize: 'var(--fs-h)',
                  lineHeight: 'var(--lh-h)',
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  marginTop: 12
                }}
                data-test="recap-title"
              >
                {facts.title}
              </div>
            ) : null}

            {narrative ? (
              <>
                <div
                  style={{
                    marginTop: 10,
                    display: 'grid',
                    gridTemplateColumns: '34px 1fr',
                    gap: 8
                  }}
                  data-test="recap-now"
                >
                  <span style={{ ...micro, color: 'var(--text-3)', paddingTop: 3 }}>Now</span>
                  <span style={body}>{narrative.now}</span>
                </div>
                {narrative.next ? (
                  <div
                    style={{
                      marginTop: 10,
                      padding: '8px 12px 8px 11px',
                      background: 'var(--accent-wash)',
                      borderLeft: '3px solid var(--accent)',
                      borderRadius: 'var(--r-inner)',
                      display: 'grid',
                      gridTemplateColumns: '34px 1fr',
                      gap: 8
                    }}
                    data-test="recap-next"
                  >
                    <span style={{ ...micro, color: 'var(--accent)', paddingTop: 3 }}>Next</span>
                    <span style={body}>{narrative.next}</span>
                  </div>
                ) : null}
              </>
            ) : (
              <div style={{ marginTop: 10 }} data-test="recap-facts-only">
                <div style={{ ...body, color: 'var(--text-2)' }}>
                  No narrative yet — showing live session facts.
                </div>
                <div style={{ ...meta, color: 'var(--text-3)', marginTop: 4 }}>
                  The narrative needs Agent recaps + an LLM key in Settings.
                </div>
              </div>
            )}

            <hr
              style={{
                border: 'none',
                borderTop: '1px solid var(--border-subtle)',
                margin: '14px -16px 0'
              }}
            />

            {/* ── zone 2: the evidence ────────────────────────────────────── */}
            {narrative && narrative.beats.length > 0 ? (
              <div style={{ paddingTop: 12 }}>
                <SectionHead>Timeline</SectionHead>
                {narrative.beats.map((b, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '44px 14px 1fr',
                      columnGap: 8,
                      marginBottom: 9
                    }}
                    data-test="recap-beat"
                  >
                    <span style={{ ...meta, color: 'var(--text-3)', textAlign: 'right' }}>
                      {hhmm(b.ts)}
                    </span>
                    <span
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        paddingTop: 5
                      }}
                    >
                      <Dot
                        color={b.role === 'user' ? 'var(--accent)' : 'var(--border-strong)'}
                        size={6}
                      />
                      {i < narrative.beats.length - 1 ? (
                        <span
                          style={{
                            width: 1,
                            flex: 1,
                            background: 'var(--border-subtle)',
                            marginTop: 4
                          }}
                        />
                      ) : null}
                    </span>
                    <span style={{ ...body, color: 'var(--text-2)' }}>
                      {b.role === 'user' ? (
                        <span style={{ color: 'var(--text)', fontWeight: 500 }}>You: </span>
                      ) : null}
                      {b.text}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {facts.files.length > 0 || facts.commands.length > 0 ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 16,
                  marginTop: narrative && narrative.beats.length > 0 ? 14 : 12
                }}
                data-test="recap-chips"
              >
                <div>
                  {facts.files.length > 0 ? <SectionHead>Changed</SectionHead> : null}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {facts.files.slice(0, CHIPS_SHOWN).map((f) => (
                      <Chip key={f.path}>
                        <span style={{ color: 'var(--text)', fontWeight: 500 }}>
                          {baseName(f.path)}
                        </span>
                        {f.op === 'write' ? (
                          <span style={{ color: 'var(--ok)' }}> new</span>
                        ) : f.count > 1 ? (
                          <span> ×{f.count}</span>
                        ) : null}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div>
                  {facts.commands.length > 0 ? <SectionHead>Commands</SectionHead> : null}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {facts.commands.slice(0, CHIPS_SHOWN).map((c) => (
                      <Chip key={c.label}>
                        {c.label}
                        {c.count > 1 ? <span> ×{c.count}</span> : null}
                      </Chip>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {!narrative && facts.turns.user + facts.turns.agent > 0 ? (
              <div style={{ ...meta, color: 'var(--text-3)', marginTop: 14 }}>
                <span style={{ color: 'var(--text-2)' }}>
                  {facts.turns.user + facts.turns.agent} turns
                </span>
                {' — '}
                {facts.turns.user} you · {facts.turns.agent} agent
              </div>
            ) : null}

            {facts.lastAsk ? (
              <div
                style={{
                  ...meta,
                  margin: '14px -16px -14px',
                  padding: '9px 16px',
                  borderTop: '1px solid var(--border-subtle)',
                  background: 'var(--inset)',
                  color: 'var(--text-3)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
                data-test="recap-lastask"
              >
                <span style={{ color: 'var(--text-2)' }}>Last ask: </span>“{facts.lastAsk}”
              </div>
            ) : null}
          </>
        )
      )}
    </div>
  )
}
