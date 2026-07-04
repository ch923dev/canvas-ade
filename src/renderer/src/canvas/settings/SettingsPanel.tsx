/**
 * SettingsPanel — the windowed **tile-launcher** settings surface (design-sign-off 2026-07-04,
 * `docs/specs/2026-07-04-settings-tiles/PLAN.md`). Opens to a grid of category tiles; clicking a
 * tile slides to that section's detail pane with a `‹ Settings` back chevron. Rides the shared
 * `Modal` (scrim/portal/Esc/focus-trap) at the same `zIndex={300}` + standard `--scrim` (0.5) the
 * old `SettingsModal` used — windowed over the live canvas.
 *
 * Phase 2: each tile's detail body is a real section pane (`SettingsSectionBody` → `panes/*`), and
 * `AppChrome` now renders THIS as the live Settings surface (the old `SettingsModal` is retired in
 * Phase 4 once its tests move here). `initialSection` opens drilled straight into a tile (the
 * account pill → 'account'); `onSignIn` reaches the Account pane's signed-out CTA.
 *
 * Esc contract: Modal closes on Esc. When drilled into a section we intercept Esc in the CAPTURE
 * phase to go back to the home grid FIRST (and stop it reaching Modal's bubble-phase close), so one
 * Esc = up one level, matching every other drill UI. A scrim click still closes outright.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { Modal } from '../Modal'
import { Icon } from '../Icon'
import { useCanvasStore } from '../../store/canvasStore'
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSectionId } from './settingsSections'
import { SettingsSectionBody } from './SettingsSectionBody'

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Last path segment of a project dir, for the home subtitle. */
function baseName(dir: string | null): string | null {
  if (!dir) return null
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : dir
}

export function SettingsPanel({
  onClose,
  onSignIn,
  initialSection = null
}: {
  onClose: () => void
  /** Account section's signed-out "Sign in" CTA — the parent closes Settings then opens SignInView
   *  (two shared Modals must not stack). Optional so the panel stands alone in unit tests. */
  onSignIn?: () => void
  /** Open drilled directly into a section (e.g. the account pill → 'account'). */
  initialSection?: SettingsSectionId | null
}): ReactElement {
  const [active, setActive] = useState<SettingsSectionId | null>(initialSection)
  const projectName = useCanvasStore((s) => baseName(s.project.dir))
  const reduce = prefersReducedMotion()

  // Focus targets: the tile that opened a section (restore on back) + the detail's back button
  // (receive focus on drill). `activeRef` keeps the once-registered capture Esc listener reading the
  // live section without deps-churning it off mid-dispatch (the Modal.tsx lesson).
  const activeRef = useRef(active)
  const tileRefs = useRef(new Map<SettingsSectionId, HTMLButtonElement | null>())
  const backRef = useRef<HTMLButtonElement>(null)
  // Sync the ref AFTER commit — never write a ref during render (react-hooks/refs).
  useEffect(() => {
    activeRef.current = active
  })

  const goHome = (): void => {
    const from = activeRef.current
    setActive(null)
    // Restore focus to the originating tile (next paint — it re-mounts with the home pane).
    if (from) requestAnimationFrame(() => tileRefs.current.get(from)?.focus())
  }
  const openSection = (id: SettingsSectionId): void => setActive(id)

  // Esc → up one level when drilled (capture phase, registered once — beats Modal's bubble close).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || activeRef.current === null) return
      e.preventDefault()
      e.stopImmediatePropagation()
      goHome()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Move focus to the back button when a section opens (skip on initial mount-into-a-section, where
  // Modal's own initial-focus already lands inside the card).
  const didMount = useRef(false)
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true
      return
    }
    if (active) backRef.current?.focus()
  }, [active])

  const activeDef = active ? SETTINGS_SECTIONS[active] : null

  return (
    <Modal
      label="Settings"
      onClose={onClose}
      zIndex={300}
      scrimProps={{ 'data-test': 'settings-scrim' }}
      cardProps={{ 'data-test': 'settings-panel' }}
      cardStyle={styles.card}
    >
      <div style={styles.viewport}>
        <button
          type="button"
          aria-label="Close settings"
          data-test="settings-close"
          onClick={onClose}
          style={styles.close}
        >
          <Icon name="x" size={15} />
        </button>

        <div
          style={{
            ...styles.track,
            transform: active ? 'translateX(-50%)' : 'translateX(0)',
            transition: reduce ? 'none' : 'transform 0.26s cubic-bezier(0.22,1,0.36,1)'
          }}
        >
          {/* ── home: category grid ── */}
          <section style={styles.pane} aria-hidden={active !== null}>
            <div style={styles.homeHead}>
              <div style={styles.homeTitle}>Settings</div>
              <div style={styles.homeSub}>{projectName ?? 'No project open'}</div>
            </div>
            <div style={styles.homeBody}>
              {SETTINGS_GROUPS.map((group) => (
                <div key={group.label} style={styles.group}>
                  <div style={styles.groupLabel}>{group.label}</div>
                  <div style={styles.grid}>
                    {group.sections.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        data-test={`settings-tile-${s.id}`}
                        ref={(el) => {
                          tileRefs.current.set(s.id, el)
                        }}
                        onClick={() => openSection(s.id)}
                        style={styles.tile}
                        tabIndex={active === null ? 0 : -1}
                      >
                        <span style={styles.tileIcon}>
                          <Icon name={s.icon} size={17} />
                        </span>
                        <span style={styles.tileLabel}>{s.label}</span>
                        <span style={styles.tileBlurb}>{s.blurb}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ── detail: the drilled section ── */}
          <section style={styles.pane} aria-hidden={active === null}>
            <div style={styles.detailHead}>
              <button
                type="button"
                ref={backRef}
                data-test="settings-back"
                onClick={goHome}
                style={styles.back}
                tabIndex={active === null ? -1 : 0}
              >
                <Icon name="back" size={15} />
                Settings
              </button>
              {activeDef && <span style={styles.detailTitle}>{activeDef.label}</span>}
            </div>
            <div style={styles.detailBody} data-test="settings-detail">
              {active && <SettingsSectionBody id={active} onClose={onClose} onSignIn={onSignIn} />}
            </div>
          </section>
        </div>
      </div>
    </Modal>
  )
}

const styles: Record<string, CSSProperties> = {
  card: {
    width: 'min(680px, 92vw)',
    height: 'min(560px, 82vh)',
    padding: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column'
  },
  viewport: { position: 'relative', flex: 1, display: 'flex', overflow: 'hidden' },
  close: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 2,
    width: 26,
    height: 26,
    display: 'grid',
    placeItems: 'center',
    border: '1px solid transparent',
    borderRadius: 'var(--r-ctl)',
    background: 'transparent',
    color: 'var(--text-3)',
    cursor: 'pointer'
  },
  track: { flex: 1, display: 'flex', width: '200%', minHeight: 0 },
  pane: { flex: '0 0 50%', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },

  // home
  homeHead: { padding: '16px 18px 8px' },
  homeTitle: { fontSize: 14, fontWeight: 600, color: 'var(--text)' },
  homeSub: {
    marginTop: 2,
    fontSize: 11.5,
    color: 'var(--text-3)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  homeBody: { flex: 1, overflowY: 'auto', padding: '6px 18px 20px', overscrollBehavior: 'contain' },
  group: { marginTop: 12 },
  groupLabel: {
    fontSize: 10,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-3)',
    fontWeight: 600,
    marginBottom: 9
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 14,
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-inner)',
    background: 'var(--surface)',
    color: 'var(--text)',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'var(--ui)'
  },
  tileIcon: {
    width: 30,
    height: 30,
    borderRadius: 'var(--r-inner)',
    display: 'grid',
    placeItems: 'center',
    background: 'var(--accent-wash)',
    color: 'var(--accent)'
  },
  tileLabel: { fontSize: 12.5, fontWeight: 500, color: 'var(--text)' },
  tileBlurb: { fontSize: 10.5, lineHeight: '14px', color: 'var(--text-3)' },

  // detail
  detailHead: {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '14px 16px',
    borderBottom: '1px solid var(--border-subtle)'
  },
  back: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-2)',
    fontSize: 12.5,
    fontFamily: 'var(--ui)',
    cursor: 'pointer',
    padding: '4px 6px',
    borderRadius: 'var(--r-ctl)'
  },
  detailTitle: { fontSize: 13.5, fontWeight: 600, color: 'var(--text)' },
  detailBody: { flex: 1, overflowY: 'auto', padding: '16px 18px', overscrollBehavior: 'contain' }
}
