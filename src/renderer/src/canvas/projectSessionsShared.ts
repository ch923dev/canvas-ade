/**
 * Shared project-session UI helpers (Background Project Sessions, Phase 4/4b) — the bits the
 * ProjectSwitcher (§2–3) and the ProjectDock (§4) both speak: name derivation, the counts
 * badge, the close-confirm body copy, the dock's membership/order model, and the two
 * pick-a-folder flows behind "Open folder…" / "Create project…". Extracted (not duplicated)
 * under the max-lines ratchet when the dock landed.
 */
import type { BackgroundProjectInfo } from '../../../preload'
import { showToast } from '../store/toastStore'

/** Last path segment as a display name (Windows + POSIX separators). */
export function basenameOf(dir: string): string {
  return (
    dir
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || dir
  )
}

/** Row/card badge: mono micro counts, non-zero parts only (PHASE4-UX-DESIGN §2). */
export function bgBadge(bg: { terminalsRunning: number; previews: number }): string {
  const parts: string[] = []
  if (bg.terminalsRunning > 0) parts.push(`${bg.terminalsRunning} term`)
  if (bg.previews > 0) parts.push(`${bg.previews} prev`)
  return parts.join(' · ')
}

/** Close-confirm body: what actually dies, singular/plural, non-zero parts only (§3). */
export function closeBody(bg: { terminalsRunning: number; previews: number }): string {
  const parts: string[] = []
  if (bg.terminalsRunning > 0)
    parts.push(
      `${bg.terminalsRunning} running ${bg.terminalsRunning === 1 ? 'terminal' : 'terminals'} (their processes are killed)`
    )
  if (bg.previews > 0)
    parts.push(`closes ${bg.previews} ${bg.previews === 1 ? 'preview' : 'previews'}`)
  return parts.join(' and ')
}

/** One project-dock card (PHASE4-UX-DESIGN §4). */
export interface ProjectDockCard {
  dir: string
  name: string
  terminalsRunning: number
  previews: number
  active: boolean
}

/**
 * Dock membership + order: SESSION projects only — the active project first, then the
 * backgrounded residents most-recently-backgrounded first (the project just left sits next
 * to the active card — the A⇄B case). Cold recents NEVER appear (§4 locked). The active
 * card's counts come from `project:askOnSwitchInfo` (residents carry their own); a null
 * info (welcome boot, partial test mock) degrades to a countless active card.
 */
export function dockCards(
  active: { dir: string | null; name: string | null },
  activeCounts: { terminals: number; previews: number } | null,
  bg: BackgroundProjectInfo[]
): ProjectDockCard[] {
  const cards: ProjectDockCard[] = []
  if (active.dir !== null) {
    cards.push({
      dir: active.dir,
      name: active.name ?? basenameOf(active.dir),
      terminalsRunning: activeCounts?.terminals ?? 0,
      previews: activeCounts?.previews ?? 0,
      active: true
    })
  }
  const residents = bg
    .filter((b) => b.dir !== active.dir)
    .sort((a, b) => b.backgroundedAt - a.backgroundedAt)
  for (const r of residents) {
    cards.push({
      dir: r.dir,
      name: r.name,
      terminalsRunning: r.terminalsRunning,
      previews: r.previews,
      active: false
    })
  }
  return cards
}

/**
 * The live-decoration state the ProjectSwitcher rows and the ProjectDock cards both render:
 * backgrounded residents + the persisted keep-forever set. One fetch (review dedup) so the
 * two surfaces can never drift on how residents are loaded. Promise.resolve().then wrappers:
 * a partial window.api mock (integration tests stub only what they use) must degrade to
 * empty lists, not throw before .catch can attach.
 */
export async function fetchLiveDecorations(): Promise<{
  bg: BackgroundProjectInfo[]
  forever: string[]
}> {
  const [bg, forever] = await Promise.all([
    Promise.resolve()
      .then(() => window.api.project.listBackground())
      .catch(() => [] as BackgroundProjectInfo[]),
    Promise.resolve()
      .then(() => window.api.project.keepForeverDirs())
      .catch(() => [] as string[])
  ])
  return { bg, forever }
}

/**
 * Surface a 'locked' switch outcome (review [warning], both rounds): the pipeline owns the
 * other outcomes ('save-failed' raises the global chip; 'cancelled' is the user's own act),
 * but a switch dropped because ANOTHER one is mid-flight had no surface on any entry point —
 * the dock/switcher UI closes on click, so the user just saw nothing happen. Keyed toast so
 * rapid repeats update in place. Shared by the dock cards, the + tile, and the switcher rows.
 */
export function toastLockedSwitch(outcome: string): void {
  if (outcome !== 'locked') return
  showToast({
    id: 'project-switch-locked',
    message: 'A project switch is already in progress — try again in a moment'
  })
}

/** A picked folder resolved to the switch-pipeline load thunk + display name. */
export interface PickedProject {
  load: () => Promise<unknown>
  name: string
}

/** The shared "pick a folder" preamble (review dedup): null = cancelled/unavailable.
 *  Promise.resolve().then wrapper: partial window.api mocks must degrade to null, not throw. */
async function pickFolder(): Promise<string | null> {
  return Promise.resolve()
    .then(() => window.api.dialog.openFolder())
    .catch(() => null)
}

/** "Open folder…": pick a dir → open it as a project. Null = picker cancelled/unavailable. */
export async function pickOpenFolder(): Promise<PickedProject | null> {
  const dir = await pickFolder()
  if (!dir) return null
  return { load: () => window.api.project.open(dir), name: basenameOf(dir) }
}

/** "Create project…": pick a dir → create a project named after it. Null = cancelled. */
export async function pickCreateProject(): Promise<PickedProject | null> {
  const dir = await pickFolder()
  if (!dir) return null
  const name = basenameOf(dir)
  return { load: () => window.api.project.create(dir, name, {}), name }
}
