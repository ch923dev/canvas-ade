/**
 * SettingsPanel — the windowed Settings surface (design sign-off 2026-07-04). A row of **top group
 * tabs** (You · Application · Agents & AI · System); the active tab's panel stacks that group's
 * sections, each under its own heading. Rides the shared `Modal` (scrim/portal/Esc/focus-trap) at
 * `zIndex={300}` + the standard `--scrim` (0.5) — windowed over the live canvas.
 *
 * History: this replaced an earlier tile-launcher → drill-in shell (rejected on a live dev check —
 * the drill felt clunky). The section panes themselves (`SettingsSectionBody` → `panes/*`) are
 * unchanged; only the shell swapped a grid+slide for a flat tab bar. `AppChrome` renders this as the
 * live Settings surface; `initialSection` opens the tab that OWNS that section (the account pill →
 * the "You" tab); `onSignIn` reaches the Account pane's signed-out CTA.
 *
 * Keyboard/a11y: a real `tablist` — ArrowLeft/ArrowRight roves between tabs (roving tabindex), the
 * active tab is the only tab in the Tab order, and each tab controls its `tabpanel`. Esc closes
 * (Modal's bubble-phase listener — there is no nesting to unwind). A scrim click closes too.
 */
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import { Modal } from '../Modal'
import { Icon } from '../Icon'
import { useCanvasStore } from '../../store/canvasStore'
import {
  SETTINGS_GROUPS,
  groupIdForSection,
  type SettingsGroupId,
  type SettingsSectionId
} from './settingsSections'
import { SettingsSectionBody } from './SettingsSectionBody'

/** Last path segment of a project dir, for the header subtitle. */
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
  /** Open on the tab that owns this section (e.g. the account pill → the "You" tab via 'account'). */
  initialSection?: SettingsSectionId | null
}): ReactElement {
  const projectName = useCanvasStore((s) => baseName(s.project.dir))
  const [activeGroup, setActiveGroup] = useState<SettingsGroupId>(
    initialSection ? groupIdForSection(initialSection) : SETTINGS_GROUPS[0].id
  )

  // Roving-tabindex refs so ArrowLeft/Right can move focus with the selection; `activeTabRef` is the
  // Modal's initial-focus target so opening Settings lands on the current tab, not the close button.
  const tabRefs = useRef(new Map<SettingsGroupId, HTMLButtonElement | null>())
  // Typed as HTMLElement to match Modal's `initialFocusRef` param exactly (a button IS an element).
  const activeTabRef = useRef<HTMLElement | null>(null)

  const selectAt = (index: number): void => {
    const next = SETTINGS_GROUPS[(index + SETTINGS_GROUPS.length) % SETTINGS_GROUPS.length]
    setActiveGroup(next.id)
    requestAnimationFrame(() => tabRefs.current.get(next.id)?.focus())
  }
  const onTabKey = (e: ReactKeyboardEvent, index: number): void => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      selectAt(index + 1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      selectAt(index - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      selectAt(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      selectAt(SETTINGS_GROUPS.length - 1)
    }
  }

  const group = SETTINGS_GROUPS.find((g) => g.id === activeGroup) ?? SETTINGS_GROUPS[0]

  return (
    <Modal
      label="Settings"
      onClose={onClose}
      zIndex={300}
      initialFocusRef={activeTabRef}
      scrimProps={{ 'data-test': 'settings-scrim' }}
      cardProps={{ 'data-test': 'settings-panel' }}
      cardStyle={styles.card}
    >
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>Settings</h2>
          <div style={styles.sub}>{projectName ?? 'No project open'}</div>
        </div>
        <button
          type="button"
          aria-label="Close settings"
          data-test="settings-close"
          onClick={onClose}
          style={styles.close}
        >
          <Icon name="x" size={15} />
        </button>
      </div>

      <div role="tablist" aria-label="Settings sections" style={styles.tabs}>
        {SETTINGS_GROUPS.map((g, i) => {
          const selected = g.id === activeGroup
          return (
            <button
              key={g.id}
              type="button"
              role="tab"
              id={`settings-tab-${g.id}`}
              aria-selected={selected}
              aria-controls={`settings-tabpanel-${g.id}`}
              tabIndex={selected ? 0 : -1}
              data-test={`settings-tab-${g.id}`}
              ref={(el) => {
                tabRefs.current.set(g.id, el)
                if (selected) activeTabRef.current = el
              }}
              onClick={() => setActiveGroup(g.id)}
              onKeyDown={(e) => onTabKey(e, i)}
              style={{ ...styles.tab, ...(selected ? styles.tabActive : null) }}
            >
              {g.label}
            </button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        id={`settings-tabpanel-${group.id}`}
        aria-labelledby={`settings-tab-${group.id}`}
        data-test="settings-tabpanel"
        style={styles.body}
      >
        {group.sections.map((s, i) => (
          <section
            key={s.id}
            data-test={`settings-section-${s.id}`}
            style={{ ...styles.sectionBlock, ...(i > 0 ? styles.sectionDivided : null) }}
          >
            <h3 style={styles.sectionHead}>{s.label}</h3>
            <SettingsSectionBody id={s.id} onClose={onClose} onSignIn={onSignIn} />
          </section>
        ))}
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

  // header
  header: {
    position: 'relative',
    flex: 'none',
    padding: '15px 18px 11px'
  },
  title: { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--text)' },
  sub: {
    marginTop: 2,
    fontSize: 11.5,
    color: 'var(--text-3)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 'calc(100% - 30px)'
  },
  close: {
    position: 'absolute',
    top: 12,
    right: 12,
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

  // tab strip
  tabs: {
    flex: 'none',
    display: 'flex',
    gap: 2,
    padding: '0 12px',
    borderBottom: '1px solid var(--border-subtle)'
  },
  tab: {
    padding: '9px 11px',
    fontSize: 12.5,
    fontFamily: 'var(--ui)',
    fontWeight: 500,
    color: 'var(--text-3)',
    background: 'transparent',
    border: 'none',
    // -1 bottom margin overlaps the strip's bottom border so the active underline sits on top of it.
    borderBottom: '2px solid transparent',
    marginBottom: -1,
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  },
  tabActive: { color: 'var(--text)', borderBottomColor: 'var(--accent)' },

  // active group's panel
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 18px 20px',
    overscrollBehavior: 'contain',
    display: 'flex',
    flexDirection: 'column',
    gap: 16
  },
  sectionBlock: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
  sectionDivided: { borderTop: '1px solid var(--border-subtle)', paddingTop: 16 },
  sectionHead: { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text)' }
}
