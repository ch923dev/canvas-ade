/**
 * BrowserInspector — the Browser board's per-type content for the Board Inspector (P1, the second
 * concrete consumer of the inspector toolkit after Terminal). Presentation-only: BrowserBoard owns
 * all state/handlers and portals this into the shell's slot, so every control here reuses the EXACT
 * same handler its URL-bar / title-bar counterpart uses (no duplication, no lifted state).
 *
 * Additive: the on-board URL bar + viewport control stay as-is; this surfaces the same controls as
 * labelled rows (plus the otherwise-buried network dock + the URL as config) — the visibility win.
 * Sections mirror docs/research/mocks/board-inspector-popover-mock (Browser hero); to keep the compact
 * popover short, Viewport + Navigation + Preview start expanded while Developer + Configuration start
 * COLLAPSED (click a header to expand). The shell owns the head (glyph/type/title/jump) + the
 * Duplicate foot, so this renders sections only.
 */
import type { ReactElement, ReactNode } from 'react'
import { Icon } from '../../Icon'
import type { BrowserViewport } from '../../../lib/boardSchema'
import { VIEWPORT_PRESETS } from '../../../lib/browserLayout'
import { volumeIcon } from '../../../lib/osrVolume'
import type { NetDock } from '../../../store/osrNetworkStore'
import {
  InspectorAction,
  InspectorMeta,
  InspectorRow,
  InspectorSection,
  InspectorSegmented,
  InspectorSlider,
  InspectorToggle
} from '../../inspector/primitives'

/** The connection status mapped to a semantic tone; CSS colours the dot off `data-tone`. */
export type ConnTone = 'ok' | 'warn' | 'err' | 'idle'

export interface BrowserInspectorProps {
  // Viewport
  viewport: BrowserViewport
  onViewport: (vp: BrowserViewport) => void
  // Navigation
  onBack: () => void
  onForward: () => void
  onReload: () => void
  canGoBack: boolean
  canGoForward: boolean
  // Preview status
  statusWord: string
  statusTone: ConnTone
  // Media — surfaced only while the page is playing audio (mirrors the on-board OsrVolumeControl).
  audible: boolean
  muted: boolean
  volume: number
  onMute: (next: boolean) => void
  onVolume: (v: number) => void
  // Actions
  onScreenshot: () => void
  screenshotDisabled: boolean
  onOpenExternal: () => void
  // Developer (network inspector)
  netOpen: boolean
  onToggleNet: (next: boolean) => void
  netDock: NetDock
  onNetDock: (dock: NetDock) => void
  // Configuration
  url: string
  onEditUrl: () => void
}

// Device-class segments (Mobile/Tablet/Desktop). The desktop tier (desktop/qhd/uhd) collapses to the
// single "Desktop" segment; the explicit size lives in the Size sub-row below.
const DEVICE_CLASS: ReadonlyArray<{ value: BrowserViewport; label: string; icon: ReactNode }> = [
  { value: 'mobile', label: 'Mobile', icon: <Icon name="mobile" size={13} /> },
  { value: 'tablet', label: 'Tablet', icon: <Icon name="tablet" size={13} /> },
  { value: 'desktop', label: 'Desktop', icon: <Icon name="desktop" size={13} /> }
]
const DESKTOP_SIZES: ReadonlyArray<{ value: BrowserViewport; label: string }> = [
  { value: 'desktop', label: '1280' },
  { value: 'qhd', label: '1440p' },
  { value: 'uhd', label: '4K' }
]
const DOCKS: ReadonlyArray<{ value: NetDock; label: string; icon: ReactNode }> = [
  { value: 'bottom', label: 'Bottom', icon: <Icon name="dock-bottom" size={13} /> },
  { value: 'right', label: 'Right', icon: <Icon name="dock-right" size={13} /> }
]

export function BrowserInspector({
  viewport,
  onViewport,
  onBack,
  onForward,
  onReload,
  canGoBack,
  canGoForward,
  statusWord,
  statusTone,
  audible,
  muted,
  volume,
  onMute,
  onVolume,
  onScreenshot,
  screenshotDisabled,
  onOpenExternal,
  netOpen,
  onToggleNet,
  netDock,
  onNetDock,
  url,
  onEditUrl
}: BrowserInspectorProps): ReactElement {
  const isDesktopTier = viewport === 'desktop' || viewport === 'qhd' || viewport === 'uhd'
  // The device-class segment shows "Desktop" active for any desktop-tier size.
  const deviceValue: BrowserViewport = isDesktopTier ? 'desktop' : viewport
  const preset = VIEWPORT_PRESETS[viewport]
  const volPct = Math.round(volume * 100)

  return (
    <>
      <InspectorSection label="Viewport" persistKey="browser.viewport">
        <InspectorRow>
          <InspectorSegmented
            fill
            ariaLabel="Device class"
            value={deviceValue}
            options={DEVICE_CLASS}
            onChange={onViewport}
          />
        </InspectorRow>
        {isDesktopTier && (
          <InspectorRow label="Size">
            <InspectorSegmented
              ariaLabel="Desktop size"
              value={viewport}
              options={DESKTOP_SIZES}
              onChange={onViewport}
            />
          </InspectorRow>
        )}
        <InspectorMeta label="Size" value={`${preset.w} × ${preset.h}`} />
      </InspectorSection>

      <InspectorSection label="Navigation" persistKey="browser.navigation">
        <div className="ca-inspector-nav">
          <button
            type="button"
            className="ca-inspector-navbtn"
            title="Back"
            aria-label="Back"
            disabled={!canGoBack}
            onClick={onBack}
          >
            <Icon name="back" size={14} />
          </button>
          <button
            type="button"
            className="ca-inspector-navbtn"
            title="Forward"
            aria-label="Forward"
            disabled={!canGoForward}
            onClick={onForward}
          >
            <Icon name="forward" size={14} />
          </button>
          <button
            type="button"
            className="ca-inspector-navbtn"
            title="Reload"
            aria-label="Reload"
            onClick={onReload}
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>
      </InspectorSection>

      <InspectorSection label="Preview" persistKey="browser.preview">
        <InspectorRow label="Status">
          <span className="ca-inspector-status" data-tone={statusTone}>
            <span className="ca-inspector-status-dot" aria-hidden />
            {statusWord}
          </span>
        </InspectorRow>
        {audible && (
          <>
            <InspectorRow label="Mute">
              <InspectorToggle checked={muted} onChange={onMute} ariaLabel="Mute preview audio" />
            </InspectorRow>
            <InspectorRow label="Volume">
              <span className="ca-inspector-vol-ico" aria-hidden>
                <Icon name={volumeIcon({ muted, volume })} size={14} />
              </span>
              <InspectorSlider
                value={volume}
                onChange={onVolume}
                ariaLabel="Preview volume"
                valueText={`${volPct}%`}
              />
            </InspectorRow>
          </>
        )}
        <InspectorAction
          icon={<Icon name="camera" size={14} />}
          onClick={onScreenshot}
          disabled={screenshotDisabled}
          dataTest="inspector-screenshot"
        >
          Screenshot
        </InspectorAction>
        <InspectorAction icon={<Icon name="external" size={14} />} onClick={onOpenExternal}>
          Open in browser
        </InspectorAction>
      </InspectorSection>

      <InspectorSection label="Developer" defaultOpen={false} persistKey="browser.developer">
        <InspectorRow label="Network inspector">
          <InspectorToggle checked={netOpen} onChange={onToggleNet} ariaLabel="Network inspector" />
        </InspectorRow>
        {netOpen && (
          <InspectorRow label="Dock">
            <InspectorSegmented
              ariaLabel="Network panel dock"
              value={netDock}
              options={DOCKS}
              onChange={onNetDock}
            />
          </InspectorRow>
        )}
      </InspectorSection>

      <InspectorSection
        label="Configuration"
        defaultOpen={false}
        persistKey="browser.configuration"
      >
        <InspectorMeta label="URL" value={url} />
        <InspectorAction
          icon={<Icon name="pen" size={14} />}
          onClick={onEditUrl}
          dataTest="inspector-edit-url"
        >
          Edit URL…
        </InspectorAction>
      </InspectorSection>
    </>
  )
}
