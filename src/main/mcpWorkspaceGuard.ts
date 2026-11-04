/**
 * WS-7 — workspace confinement as ONE decorator over the host orchestrator. `mcp.ts` wraps
 * `buildOrchestrator(...)` with it, so the package's tools, the Jarvis facet, the swarm executor and
 * the e2e seams all pass the same checks. The policy (scopes, path containment, the refusal
 * sentences) lives in `./workspaceScope`; this file only decides WHERE each check runs.
 * (`mcpOrchestrator.ts` sits at the max-lines gate, so the guard wraps it rather than growing it.)
 *
 * - spawn_board / spawn_group: the new board's workspace comes from the CALLER's scope — a
 *   `workspaceId` in the input is dropped. Its cwd must stay inside that workspace (or the project).
 * - configure_board: the new cwd stays inside the TARGET's workspace (else the project). Only the
 *   known config keys pass through, so a configure patch can never carry `workspaceId`.
 * - relay_prompt / relay_prompts (incl. a lead's assign): refused into another workspace's
 *   terminal — per row for the batch, so one bad row never sinks the others.
 * - configure / close / planning / card writes: a target check on the optional trailing `caller`.
 *   `@expanse-ade/mcp` 0.28.x does not pass it yet, so these checks wait for the package (WS-9).
 * - tidy_canvas / arrange_main_board: a workspace caller that names no scope arranges its own
 *   workspace's boards.
 */
import type { BoardId, PlanningElementsSpec } from '@expanse-ade/mcp'
import type { AuditInput } from './auditLog'
import type { HostOrchestrator } from './mcpDispatchBatch'
import type { McpLifecycle, SpawnGroupInput } from './mcpLifecycle'
import type { RelayItem, RelayResult } from './mcpRegistry'
import type { PlanningEditPatch } from '../shared/mcpTypes'
import {
  assertConfigureCwd,
  assertCwdInScope,
  assertTargetInScope,
  callerScope,
  placeSpawn,
  targetScopeError,
  workspaceBoardIds,
  type ScopeCaller,
  type WorkspaceScopeDeps
} from './workspaceScope'

export interface WorkspaceGuardDeps extends WorkspaceScopeDeps {
  audit(input: AuditInput): Promise<void>
}

type SpawnInput = Parameters<McpLifecycle['spawnBoard']>[0]
type ConfigureInput = Parameters<HostOrchestrator['configureBoard']>[1]
type CardSpec = Parameters<HostOrchestrator['addCard']>[1]
type CardPatch = Parameters<HostOrchestrator['updateCard']>[2]

/** The guarded writes as WS-9 will call them: the caller's board id as a trailing argument. */
export interface CallerScopedWrites {
  configureBoard(boardId: string, config: ConfigureInput, caller?: ScopeCaller): Promise<void>
  closeBoard(boardId: BoardId, caller?: ScopeCaller): Promise<void>
  addPlanningElements(
    boardId: BoardId,
    spec: PlanningElementsSpec,
    caller?: ScopeCaller
  ): Promise<void>
  updatePlanningElement(
    boardId: string,
    elementId: string,
    patch: PlanningEditPatch,
    caller?: ScopeCaller
  ): Promise<void>
  removePlanningElement(boardId: string, elementId: string, caller?: ScopeCaller): Promise<void>
  addCard(boardId: string, spec: CardSpec, caller?: ScopeCaller): Promise<{ id: string }>
  moveCard(boardId: string, cardId: string, toColumnId: string, caller?: ScopeCaller): Promise<void>
  updateCard(boardId: string, cardId: string, patch: CardPatch, caller?: ScopeCaller): Promise<void>
  removeCard(boardId: string, cardId: string, caller?: ScopeCaller): Promise<void>
}

/** The host orchestrator after the guard: the writes above replace their caller-less forms. */
export type GuardedOrchestrator = Omit<HostOrchestrator, keyof CallerScopedWrites> &
  CallerScopedWrites

/** The durable config keys configure_board may write — everything else is dropped. */
const CONFIG_KEYS = ['shell', 'launchCommand', 'cwd', 'columnAxis', 'axisLabel'] as const

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function guardWorkspaceScope(
  inner: HostOrchestrator,
  deps: WorkspaceGuardDeps
): GuardedOrchestrator {
  /** Record a scope refusal like every other pre-write rejection (an audit failure never masks it). */
  const auditRejected = (tool: string, targetId: string, detail: string): Promise<void> =>
    deps
      .audit({ type: tool, targetId, prompt: '', nonce: '', status: 'rejected', detail })
      .catch(() => {})
  const rejected = async (tool: string, targetId: string, err: unknown): Promise<never> => {
    await auditRejected(tool, targetId, message(err))
    throw err
  }

  /** The trailing-caller target check (a no-op until the package passes `caller`). */
  const checkCaller = async (
    tool: string,
    targetId: string,
    caller: ScopeCaller | undefined
  ): Promise<void> => {
    const source = caller?.sourceBoardId
    if (typeof source !== 'string' || source.length === 0) return
    try {
      assertTargetInScope(deps, callerScope(deps, source), targetId, tool)
    } catch (err) {
      await rejected(tool, targetId, err)
    }
  }

  /** A W caller with no scope arranges W; an explicit scope (or a PROJECT caller) is unchanged. */
  const defaultScope = <T extends { scope?: unknown; sourceBoardId?: string }>(
    input: T,
    primary?: unknown
  ): T => {
    if (input?.scope !== undefined) return input
    const scope = callerScope(deps, input?.sourceBoardId)
    if (scope.kind !== 'workspace') return input
    const ids = workspaceBoardIds(deps, scope.ws.id)
    if (typeof primary === 'string' && !ids.includes(primary)) ids.push(primary)
    return { ...input, scope: { boardIds: ids } }
  }

  return {
    ...inner,

    async spawnBoard(input) {
      const { workspaceId: _dropped, ...rest } = input as SpawnInput
      const placed = placeSpawn(deps, rest)
      const next: SpawnInput = {
        ...rest,
        ...(placed.cwd !== undefined ? { cwd: placed.cwd } : {}),
        ...(placed.workspaceId !== undefined ? { workspaceId: placed.workspaceId } : {})
      }
      return inner.spawnBoard(next)
    },

    async spawnGroup(input) {
      const { workspaceId: _dropped, ...rest } = input as SpawnGroupInput
      const scope = callerScope(deps, rest.sourceBoardId)
      // The terminal member starts in the workspace root (no cwd): refuse a missing folder now.
      const placed = assertCwdInScope(deps, scope, undefined, 'spawn_group')
      return inner.spawnGroup({ ...rest, ...placed })
    },

    async configureBoard(boardId, config, caller?: ScopeCaller) {
      await checkCaller('configure_board', boardId, caller)
      const clean: ConfigureInput = {}
      for (const key of CONFIG_KEYS) {
        if (config?.[key] !== undefined) Object.assign(clean, { [key]: config[key] })
      }
      if (typeof clean.cwd === 'string') {
        const target = deps.boards().find((b) => b.id === boardId)
        try {
          clean.cwd = assertConfigureCwd(deps, target, clean.cwd)
        } catch (err) {
          await rejected('configure_board', boardId, err)
        }
      }
      return inner.configureBoard(boardId, clean)
    },

    async relayPrompt(sourceId, targetId, text) {
      try {
        assertTargetInScope(deps, callerScope(deps, sourceId), targetId, 'relay_prompt')
      } catch (err) {
        await rejected('relay_prompt', targetId, err)
      }
      return inner.relayPrompt(sourceId, targetId, text)
    },

    async relayPrompts(items: RelayItem[]): Promise<RelayResult[]> {
      const results: Array<RelayResult | undefined> = new Array(items.length)
      const allowed: Array<{ index: number; item: RelayItem }> = []
      for (const [index, item] of items.entries()) {
        const error = targetScopeError(
          deps,
          callerScope(deps, item?.sourceId),
          item?.targetId,
          'relay_prompts'
        )
        if (error === null) {
          allowed.push({ index, item })
          continue
        }
        results[index] = {
          sourceId: item.sourceId,
          targetId: item.targetId,
          status: 'rejected',
          detail: error
        }
        await auditRejected('relay_prompt', item.targetId, error)
      }
      if (allowed.length > 0) {
        const landed = await inner.relayPrompts(allowed.map((a) => a.item))
        allowed.forEach((a, i) => (results[a.index] = landed[i]))
      }
      return results as RelayResult[]
    },

    async closeBoard(boardId, caller?: ScopeCaller) {
      await checkCaller('close_board', boardId, caller)
      return inner.closeBoard(boardId)
    },
    async addPlanningElements(boardId, spec, caller?: ScopeCaller) {
      await checkCaller('add_planning_elements', boardId, caller)
      return inner.addPlanningElements(boardId, spec)
    },
    async updatePlanningElement(boardId, elementId, patch, caller?: ScopeCaller) {
      await checkCaller('update_planning_element', boardId, caller)
      return inner.updatePlanningElement(boardId, elementId, patch)
    },
    async removePlanningElement(boardId, elementId, caller?: ScopeCaller) {
      await checkCaller('remove_planning_element', boardId, caller)
      return inner.removePlanningElement(boardId, elementId)
    },
    async addCard(boardId, spec, caller?: ScopeCaller) {
      await checkCaller('add_card', boardId, caller)
      return inner.addCard(boardId, spec)
    },
    async moveCard(boardId, cardId, toColumnId, caller?: ScopeCaller) {
      await checkCaller('move_card', boardId, caller)
      return inner.moveCard(boardId, cardId, toColumnId)
    },
    async updateCard(boardId, cardId, patch, caller?: ScopeCaller) {
      await checkCaller('update_card', boardId, caller)
      return inner.updateCard(boardId, cardId, patch)
    },
    async removeCard(boardId, cardId, caller?: ScopeCaller) {
      await checkCaller('remove_card', boardId, caller)
      return inner.removeCard(boardId, cardId)
    },

    tidyCanvas: (input) => inner.tidyCanvas(defaultScope(input, input?.primary)),
    arrangeMainBoard: (input) => inner.arrangeMainBoard(defaultScope(input, input?.boardId))
  }
}
