/**
 * Settings section registry — the single source of truth for the panel's sections and their
 * grouping. `SettingsPanel` renders one top tab per group from `SETTINGS_GROUPS` and stacks that
 * group's sections in the active tab's panel.
 *
 * Scope: maps to EXISTING settings only (design-sign-off 2026-07-04). The MCP section is read-only
 * until the separate "add external MCP server" session ships (memory `mcp-add-server-feature`) —
 * no "Add server" affordance here.
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
  /** One-line description of the section (metadata; not rendered by the current tab shell). */
  blurb: string
}

/** The top-level tab ids (one per group). Stable keys for the tab strip + `data-test`s. */
export type SettingsGroupId = 'you' | 'application' | 'agents' | 'voice' | 'system'

export interface SettingsGroup {
  id: SettingsGroupId
  label: string
  sections: SettingsSectionDef[]
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: 'you',
    label: 'You',
    sections: [
      { id: 'account', label: 'Account', icon: 'user', blurb: 'Profile and current session' },
      { id: 'billing', label: 'Billing', icon: 'card', blurb: 'Plan, credits, and payment' }
    ]
  },
  {
    id: 'application',
    label: 'Application',
    sections: [
      {
        id: 'appearance',
        label: 'Appearance',
        icon: 'wallpaper',
        blurb: 'Wallpaper and canvas backdrop'
      },
      { id: 'terminal', label: 'Terminal', icon: 'agent-shell', blurb: 'Shell and agent behavior' }
    ]
  },
  {
    id: 'agents',
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
    id: 'voice',
    label: 'Voice',
    sections: [
      { id: 'voice', label: 'Voice', icon: 'mic', blurb: 'Local-first dictation & history' }
    ]
  },
  {
    id: 'system',
    label: 'System',
    sections: [{ id: 'about', label: 'About', icon: 'info', blurb: 'Version and updates' }]
  }
]

/** Which group tab owns a section — used to open the right tab from `initialSection`. */
export function groupIdForSection(section: SettingsSectionId): SettingsGroupId {
  const group = SETTINGS_GROUPS.find((g) => g.sections.some((s) => s.id === section))
  return group ? group.id : SETTINGS_GROUPS[0].id
}
