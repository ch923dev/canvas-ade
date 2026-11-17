/**
 * Workspace colour tokens → CSS (WS-4). The persisted value is a hue NAME (`WORKSPACE_COLORS`,
 * `shared/workspaceRules.ts`) so the palette can be retuned here without a format change. Muted
 * hues that sit on the dark surfaces next to the one functional accent — a workspace colour is a
 * marker (dot, swatch, later the WS-5 zone tint), never a control state.
 */
import type { WorkspaceColor } from '../../../../shared/workspaceRules'

export const WORKSPACE_COLOR_CSS: Record<WorkspaceColor, string> = {
  blue: '#5b8def',
  green: '#3ecf8e',
  amber: '#e8b339',
  violet: '#a78bfa',
  teal: '#2dd4bf',
  rose: '#f472b6'
}
