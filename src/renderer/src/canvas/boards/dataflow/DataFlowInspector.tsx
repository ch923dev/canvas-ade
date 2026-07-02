/**
 * DataFlowInspector — the Data-Flow board's per-type content for the Board Inspector (P2). Presentation-
 * only: DataFlowBoard owns all state/handlers and portals this into the shell's slot, so every control
 * reuses the EXACT same handler its in-body `.df-bar` counterpart uses (no duplication, no lifted state).
 *
 * The Data-Flow board keeps ALL its controls in an in-body toolbar (unlike the other boards, it has no
 * title-bar actions); this raises the buried Graph/Sequence · infer/API/first-party filters ·
 * Regenerate / → Planning · source binding into the always-reachable popover — the visibility win.
 * Sections mirror docs/research/mocks/board-inspector-popover-mock (Data-Flow hero). The content adapts
 * to the board's state: unbound → only a Source binder; bound-but-empty → a Regenerate prompt; ready →
 * the full View / Filters / Actions. The shell owns the head + Duplicate foot, so this renders sections.
 */
import type { ReactElement } from 'react'
import { Icon } from '../../Icon'
import {
  InspectorAction,
  InspectorMeta,
  InspectorRow,
  InspectorSection,
  InspectorSegmented,
  InspectorStatus,
  InspectorToggle
} from '../../inspector/primitives'

export type DataFlowTab = 'graph' | 'sequence'

export interface DataFlowInspectorProps {
  // Source binding
  browsers: ReadonlyArray<{ id: string; title: string }>
  sourceId?: string
  sourceTitle?: string
  onBindSource: (id: string) => void
  hasRecords: boolean
  routeCount: number
  lineageCount: number
  // View
  tab: DataFlowTab
  onTab: (t: DataFlowTab) => void
  // Filters
  inferShapes: boolean
  onToggleInfer: () => void
  apiOnly: boolean
  onSetApiOnly: (next: boolean) => void
  firstParty: boolean
  onSetFirstParty: (next: boolean) => void
  firstPartyAvailable: boolean
  hiddenCount: number
  // Actions
  diffAdded: number
  diffChanged: number
  onRegenerate: () => void
  onExportPlanning: () => void
}

const TAB_OPTS: ReadonlyArray<{ value: DataFlowTab; label: string }> = [
  { value: 'graph', label: 'Graph' },
  { value: 'sequence', label: 'Sequence' }
]

export function DataFlowInspector({
  browsers,
  sourceId,
  sourceTitle,
  onBindSource,
  hasRecords,
  routeCount,
  lineageCount,
  tab,
  onTab,
  inferShapes,
  onToggleInfer,
  apiOnly,
  onSetApiOnly,
  firstParty,
  onSetFirstParty,
  firstPartyAvailable,
  hiddenCount,
  diffAdded,
  diffChanged,
  onRegenerate,
  onExportPlanning
}: DataFlowInspectorProps): ReactElement {
  // Unbound: the only meaningful control is picking a Browser board to map.
  if (!sourceId) {
    return (
      <InspectorSection label="Source" persistKey="dataflow.source">
        {browsers.length === 0 ? (
          <InspectorMeta label="Source" value="No Browser boards yet" />
        ) : (
          browsers.map((b) => (
            <InspectorAction
              key={b.id}
              icon={<Icon name="globe" size={14} />}
              onClick={() => onBindSource(b.id)}
            >
              Bind to {b.title}
            </InspectorAction>
          ))
        )}
      </InspectorSection>
    )
  }

  const diffParts: string[] = []
  if (diffAdded > 0) diffParts.push(`+${diffAdded} new`)
  if (diffChanged > 0) diffParts.push(`${diffChanged} changed`)

  return (
    <>
      {hasRecords ? (
        <>
          <InspectorSection label="View" persistKey="dataflow.view">
            <InspectorRow>
              <InspectorSegmented
                fill
                ariaLabel="Layout"
                value={tab}
                options={TAB_OPTS}
                onChange={onTab}
              />
            </InspectorRow>
          </InspectorSection>

          <InspectorSection label="Filters" persistKey="dataflow.filters">
            <InspectorRow label="Infer shapes">
              <InspectorToggle
                checked={inferShapes}
                onChange={() => onToggleInfer()}
                ariaLabel="Infer data shapes"
              />
            </InspectorRow>
            <InspectorRow label="API only">
              <InspectorToggle
                checked={apiOnly}
                onChange={onSetApiOnly}
                ariaLabel="Show data calls only"
              />
            </InspectorRow>
            {firstPartyAvailable && (
              <InspectorRow label="First-party">
                <InspectorToggle
                  checked={firstParty}
                  onChange={onSetFirstParty}
                  ariaLabel="First-party origins only"
                />
              </InspectorRow>
            )}
            {hiddenCount > 0 && <InspectorMeta label="Hidden" value={String(hiddenCount)} />}
          </InspectorSection>

          <InspectorSection label="Actions" persistKey="dataflow.actions">
            <InspectorAction
              icon={<Icon name="refresh" size={14} />}
              onClick={onRegenerate}
              dataTest="inspector-dataflow-regen"
            >
              Regenerate
            </InspectorAction>
            <InspectorAction
              icon={<Icon name="arrow" size={14} />}
              primary
              onClick={onExportPlanning}
              dataTest="inspector-dataflow-planning"
            >
              Sketch to Planning
            </InspectorAction>
            {diffParts.length > 0 && (
              <InspectorRow>
                <InspectorStatus tone="ok" title="Since last run">
                  {diffParts.join(' · ')}
                </InspectorStatus>
              </InspectorRow>
            )}
          </InspectorSection>
        </>
      ) : (
        <InspectorSection label="Captures" persistKey="dataflow.captures">
          <InspectorMeta label="Captures" value="None yet" />
          <InspectorAction icon={<Icon name="refresh" size={14} />} onClick={onRegenerate}>
            Regenerate
          </InspectorAction>
        </InspectorSection>
      )}

      <InspectorSection label="Source" defaultOpen={false} persistKey="dataflow.source">
        <InspectorMeta label="Source" value={sourceTitle ?? '—'} />
        <InspectorMeta label="Surface" value={`${routeCount} routes · ${lineageCount} lineage`} />
        {browsers
          .filter((b) => b.id !== sourceId)
          .map((b) => (
            <InspectorAction
              key={b.id}
              icon={<Icon name="globe" size={14} />}
              onClick={() => onBindSource(b.id)}
            >
              Switch to {b.title}
            </InspectorAction>
          ))}
      </InspectorSection>
    </>
  )
}
