/** Auto-name for a new group: the lowest free "Group N". Pure. */
import type { NamedGroup } from './boardSchema'

export function nextGroupName(groups: NamedGroup[]): string {
  const taken = new Set(groups.map((g) => g.name))
  let n = 1
  while (taken.has(`Group ${n}`)) n++
  return `Group ${n}`
}
