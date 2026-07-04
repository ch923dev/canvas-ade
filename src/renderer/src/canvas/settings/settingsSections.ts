/**
 * Settings tile-launcher registry — the single source of truth for the settings panel's
 * categories, their grouping, tile icon, and one-line blurb. `SettingsPanel` renders the home
 * grid from `SETTINGS_GROUPS` and looks a section up by id from `SETTINGS_SECTIONS` when drilled.
 *
 * Scope: maps to EXISTING settings only (design-sign-off 2026-07-04, `docs/specs/2026-07-04-
 * settings-tiles/PLAN.md`). The MCP tile is read-only until the separate "add external MCP
 * server" session ships (memory `mcp-add-server-feature`) — no "Add server" affordance here.
 */
import type { IconName } from '../Icon'

export type SettingsSectionId =
  | 'account'
  | 'billing'
  | 'appearance'
  | 'terminal'
  | 'voice'
  | 'llm'
  | 'orchestration'
  | 'mcp'
  | 'about'

export interface SettingsSectionDef {
  id: SettingsSectionId
  label: string
  icon: IconName
  /** One-line description shown on the tile and above the section detail. */
  blurb: string
}

export interface SettingsGroup {
  label: string
  sections: SettingsSectionDef[]
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: 'You',
    sections: [
      { id: 'account', label: 'Account', icon: 'user', blurb: 'Profile and current session' },
      { id: 'billing', label: 'Billing', icon: 'card', blurb: 'Plan, credits, and payment' }
    ]
  },
  {
    label: 'Application',
    sections: [
      {
        id: 'appearance',
        label: 'Appearance',
        icon: 'wallpaper',
        blurb: 'Wallpaper and canvas backdrop'
      },
      { id: 'terminal', label: 'Terminal', icon: 'agent-shell', blurb: 'Shell and agent behavior' },
      { id: 'voice', label: 'Voice', icon: 'mic', blurb: 'Local-first dictation' }
    ]
  },
  {
    label: 'Agents & AI',
    sections: [
      { id: 'llm', label: 'Context · LLM', icon: 'cpu', blurb: 'The local context brain' },
      {
        id: 'orchestration',
        label: 'Orchestration',
        icon: 'connector',
        blurb: 'Drive this canvas from agents'
      },
      { id: 'mcp', label: 'MCP Servers', icon: 'plug', blurb: 'Model Context Protocol servers' }
    ]
  },
  {
    label: 'System',
    sections: [{ id: 'about', label: 'About', icon: 'info', blurb: 'Version and updates' }]
  }
]

/** Flat id → definition lookup (drill target resolution). */
export const SETTINGS_SECTIONS: Record<SettingsSectionId, SettingsSectionDef> = Object.fromEntries(
  SETTINGS_GROUPS.flatMap((g) => g.sections).map((s) => [s.id, s])
) as Record<SettingsSectionId, SettingsSectionDef>
