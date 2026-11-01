import type { McpCommand, McpCommandAck } from './mcpCommand'
import { McpToolError } from './mcpToolError'

/**
 * 🔒 P2 canvas-tidy method — the orchestrator's `tidyCanvas` loopback, factored OUT of
 * `mcpOrchestrator.ts` (which sits at the max-lines cap) and spread into its return object, the
 * extract-on-touch pattern `createBoardCardsMethod` (P3b) / `createVisualizeMethod` (P5a) use.
 *
 * It forwards a `tidyBoards` command to the renderer's already-built, already-undoable
 * `canvasStore.tidyBoards` packer and returns the moved count the applier reports on the ack (0 ⇒ the
 * canvas was already tidy). Reposition-only, content-less, ONE host undo step — no cap, no mint, no
 * sanitize, no nonce, no audit.
 *
 * 🔒 D1 gate (spatial SPEC, `@expanse-ade/mcp` ≥ 0.27.0): the package registers `tidy_canvas` for the
 * LEAD and CONNECTED tiers too, and binds the caller's token-derived `sourceBoardId` on those calls.
 * `sourceBoardId` present ⇒ ONE approve/deny human confirm BEFORE anything moves; declined ⇒ a
 * `declined` tool error and nothing changes. Absent ⇒ the orchestrator tier (and the Jarvis facet),
 * un-gated as before. Presence is `!== undefined`, so an empty / malformed id still gates (fail closed).
 *
 * 🔒 No silent degrade: 0.27's wire accepts `mode` fit/roles/tile and `scope` / `template` /
 * `overflow` / `primary` / `resize` / `fit:false`, but the renderer applier only runs the legacy
 * packers and always reframes the camera. Until I2 wires them, MAIN rejects those inputs with
 * `invalid_input` — validated BEFORE the confirm, so the human is never asked to approve a call that
 * cannot run. An omitted `mode` keeps today's `smart` default (D8 a's implicit `roles` lands with I2).
 *
 * Pure host module (no electron value import) — unit-tested through the orchestrator harness.
 */

/** The tidy modes this app version's renderer applier can run (`spatialMcpApply.applyTidyBoards`). */
export const SUPPORTED_TIDY_MODES = ['smart', 'by-type', 'grid'] as const
type SupportedTidyMode = (typeof SUPPORTED_TIDY_MODES)[number]

/** 0.27 wire modes the applier cannot run yet (I2 wires `fitLayout` / `roleLayout` / tile). */
export const PENDING_TIDY_MODES: ReadonlySet<string> = new Set(['fit', 'roles', 'tile'])

/** 0.27 wire fields the applier would drop on the floor today (I2 forwards them, C5). */
const PENDING_TIDY_FIELDS = ['scope', 'template', 'overflow', 'primary', 'resize'] as const

/**
 * The host's `tidyCanvas` input — the package's `TidyCanvasInput`, typed loosely (`unknown`) for the
 * fields MAIN only checks for presence, because a raw caller can reach this method too.
 */
export interface TidyCanvasHostInput {
  mode?: string
  template?: unknown
  scope?: unknown
  overflow?: unknown
  fit?: unknown
  primary?: unknown
  resize?: unknown
  /** 🔒 A lead / connected caller's token-derived board id (set by the package tool, never client input). */
  sourceBoardId?: string
}

/** The command channel + the D1 confirm seams the tidy method needs. */
export interface TidyMethodDeps {
  sendCommand: (cmd: McpCommand) => Promise<McpCommandAck>
  /** MAIN-owned, fail-closed human confirm (the same modal every gated write uses). */
  confirm: (req: { title: string; body: string }) => Promise<{ approved: boolean }>
  /** The live renderer mirror — names the requesting board, so the human confirms a name, not a UUID. */
  listBoards: () => Array<{ id: string; type: string; title: string }>
}

const notSupported = (what: string): McpToolError =>
  new McpToolError(
    'invalid_input',
    `tidy_canvas: ${what} is not supported by this app version yet — omit it (or use mode smart / by-type / grid)`
  )

/** Validate the input against what the applier can run; returns the mode to forward (if any). */
function supportedMode(input: TidyCanvasHostInput): SupportedTidyMode | undefined {
  const mode = input.mode
  if (mode !== undefined) {
    if (PENDING_TIDY_MODES.has(mode)) throw notSupported(`mode '${mode}'`)
    if (!(SUPPORTED_TIDY_MODES as readonly string[]).includes(mode)) {
      throw new McpToolError('invalid_input', `tidy_canvas: unknown mode '${String(mode)}'`)
    }
  }
  for (const field of PENDING_TIDY_FIELDS) {
    if (input[field] !== undefined) throw notSupported(`'${field}'`)
  }
  // The applier always reframes the camera on the result (G4), so only fit:false would be dropped.
  if (input.fit !== undefined && input.fit !== true) throw notSupported('fit:false')
  return mode as SupportedTidyMode | undefined
}

export function createTidyMethod(deps: TidyMethodDeps): {
  tidyCanvas(input: TidyCanvasHostInput): Promise<{ moved: number }>
} {
  return {
    async tidyCanvas(input) {
      const args = input ?? {}
      const mode = supportedMode(args)
      if (args.sourceBoardId !== undefined) {
        const source = deps.listBoards().find((b) => b.id === args.sourceBoardId)
        const who = source ? `The agent in "${source.title}"` : 'A terminal agent'
        const { approved } = await deps.confirm({
          title: 'Tidy the canvas?',
          body:
            `${who} asked to rearrange the canvas${mode ? ` (${mode})` : ''}. ` +
            'Boards are repositioned only: nothing is created, resized or deleted, and one ' +
            'Ctrl+Z undoes it.'
        })
        if (!approved) {
          throw new McpToolError('declined', 'tidy_canvas: declined by the user — nothing moved')
        }
      }
      const ack = await deps.sendCommand({ type: 'tidyBoards', ...(mode ? { mode } : {}) })
      if (!ack.ok) throw new Error(`tidy_canvas failed: ${ack.error}`)
      // The applier reports the moved count on a successful ack; default to 0 defensively.
      return { moved: typeof ack.moved === 'number' ? ack.moved : 0 }
    }
  }
}
