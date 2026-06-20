/**
 * Classify WHY addConnector would reject a connector (GROUP-04) so the caller can surface a
 * specific toast instead of the link silently vanishing. Pure + DOM-free → unit-tested; mirrors
 * connectorSlice.addConnector's reject rules exactly (self-link · missing endpoint · exact
 * duplicate). `null` ⇒ the connector is valid (addConnector will succeed). `'missing'` stays
 * SILENT in the UI (an endpoint vanished mid-gesture — nothing useful to tell the user).
 */
import type { Connector, ConnectorKind } from './boardSchema'

export type ConnectorReject = 'self' | 'duplicate' | 'missing' | null

export function classifyConnectorReject(
  connectors: Connector[],
  boardIds: Set<string>,
  sourceId: string,
  targetId: string,
  kind: ConnectorKind
): ConnectorReject {
  if (sourceId === targetId) return 'self'
  if (!boardIds.has(sourceId) || !boardIds.has(targetId)) return 'missing'
  if (
    connectors.some((c) => c.sourceId === sourceId && c.targetId === targetId && c.kind === kind)
  ) {
    return 'duplicate'
  }
  return null
}

/** User-facing toast copy for the speakable rejects (GROUP-04). `'missing'` has none by design. */
export const CONNECTOR_REJECT_MESSAGE: Record<'self' | 'duplicate', string> = {
  self: "Can't connect a board to itself",
  duplicate: 'Already connected'
}
