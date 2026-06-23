import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { DataFlowView } from './DataFlowView'
import { useOsrNetworkStore, type BoardNet } from '../../../store/osrNetworkStore'
import type { NetRecord } from '../../../../../preload'

afterEach(cleanup)

const BID = 'b1'
let seq = 0
const rec = (url: string, p: Partial<NetRecord> = {}): NetRecord => ({
  requestId: `r${seq++}`,
  url,
  method: 'GET',
  type: 'fetch',
  status: 200,
  startTs: 0,
  endTs: 30,
  ...p
})

function seedBoard(over: Partial<BoardNet>): void {
  const base: BoardNet = {
    records: [],
    ws: [],
    dropped: 0,
    open: true,
    dock: 'bottom',
    tab: 'dataflow',
    preserve: false,
    inferShapes: false,
    expanded: [],
    schemas: {}
  }
  useOsrNetworkStore.setState({ byBoard: { [BID]: { ...base, ...over } } })
}

const sampleOsrNetSchema = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { api: { sampleOsrNetSchema: typeof sampleOsrNetSchema } }).api = {
    sampleOsrNetSchema
  }
  useOsrNetworkStore.setState({ byBoard: {} })
})

describe('DataFlowView', () => {
  it('collapses repeated calls into one body-free inventory row, opt-in OFF', () => {
    seedBoard({
      records: [rec('http://h/api/v2/users/1'), rec('http://h/api/v2/users/2')]
    })
    const { container } = render(
      <DataFlowView boardId={BID} records={useOsrNetworkStore.getState().byBoard[BID].records} />
    )
    const rows = container.querySelectorAll('.bb-net-df-row')
    expect(rows).toHaveLength(1)
    expect(container.querySelector('.bb-net-df-route')?.textContent).toContain('/api/v2/users/{id}')
    // a locked schema cell, never a sample call while bodies are off
    expect(screen.getByText('🔒')).toBeTruthy()
    expect(sampleOsrNetSchema).not.toHaveBeenCalled()
  })

  it('shows the opt-in gate on expand and does NOT sample while bodies are off', () => {
    seedBoard({ records: [rec('http://h/api/users/1')] })
    const { container } = render(
      <DataFlowView boardId={BID} records={useOsrNetworkStore.getState().byBoard[BID].records} />
    )
    fireEvent.click(container.querySelector('.bb-net-df-row') as Element)
    expect(screen.getByText('Shapes are off')).toBeTruthy()
    expect(sampleOsrNetSchema).not.toHaveBeenCalled()
  })

  it('samples lazily on expand when bodies are ON, and renders the inferred schema', async () => {
    sampleOsrNetSchema.mockResolvedValue({
      samples: [
        {
          root: { types: ['object'], children: { id: { types: ['string'], format: 'uuid' } } },
          complete: true
        }
      ],
      requested: 1,
      sampled: 1
    })
    seedBoard({ records: [rec('http://h/api/users/1')], inferShapes: true })
    const { container } = render(
      <DataFlowView boardId={BID} records={useOsrNetworkStore.getState().byBoard[BID].records} />
    )
    fireEvent.click(container.querySelector('.bb-net-df-row') as Element)
    await waitFor(() =>
      expect(sampleOsrNetSchema).toHaveBeenCalledWith(
        BID,
        expect.arrayContaining([expect.any(String)])
      )
    )
    // 'id' + its type render in BOTH the inventory schema reveal and the inspector → getAllByText
    await waitFor(() => expect(screen.getAllByText('id').length).toBeGreaterThan(0))
    expect(screen.getAllByText(/string · uuid/).length).toBeGreaterThan(0)
  })

  it('renders a PII chip and never injects HTML for a hostile field name', async () => {
    const hostile = '<img src=x onerror=alert(1)>'
    sampleOsrNetSchema.mockResolvedValue({
      samples: [
        {
          root: {
            types: ['object'],
            children: {
              email: { types: ['string'], format: 'email' },
              [hostile]: { types: ['string'] }
            }
          },
          complete: true
        }
      ],
      requested: 1,
      sampled: 1
    })
    seedBoard({ records: [rec('http://h/api/users/1')], inferShapes: true })
    const { container } = render(
      <DataFlowView boardId={BID} records={useOsrNetworkStore.getState().byBoard[BID].records} />
    )
    fireEvent.click(container.querySelector('.bb-net-df-row') as Element)
    await waitFor(() => expect(screen.getAllByText('email').length).toBeGreaterThan(0))
    // PII name flagged (value never present to leak)
    expect(screen.getByText(/PII/)).toBeTruthy()
    // the hostile key is rendered as escaped TEXT — no <img> element materializes
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getAllByText(hostile).length).toBeGreaterThan(0)
  })

  it('filters the inventory by route / origin substring', () => {
    seedBoard({
      records: [
        rec('http://localhost:3000/api/users/1'),
        rec('https://prod-api.example.com/v2/orders')
      ]
    })
    const { container } = render(
      <DataFlowView boardId={BID} records={useOsrNetworkStore.getState().byBoard[BID].records} />
    )
    expect(container.querySelectorAll('.bb-net-df-row')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('Filter routes'), { target: { value: 'prod-api' } })
    const rows = container.querySelectorAll('.bb-net-df-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('orders')
  })

  it('drag-resizing the inspector persists a clamped width to the store', () => {
    seedBoard({ records: [rec('http://h/api/users/1')] })
    const { container } = render(
      <DataFlowView boardId={BID} records={useOsrNetworkStore.getState().byBoard[BID].records} />
    )
    const handle = container.querySelector('.bb-net-df-resize') as Element
    fireEvent.pointerDown(handle, { pointerId: 1 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    // jsdom rects are zero → the width clamps to the 220px minimum, proving the resize wired through.
    expect(useOsrNetworkStore.getState().byBoard[BID].dfInspW).toBe(220)
  })

  it('unwraps an enveloped response: nested fields shown in the tree, entity unwrapped in the inspector', async () => {
    sampleOsrNetSchema.mockResolvedValue({
      samples: [
        {
          root: {
            types: ['object'],
            children: {
              status: { types: ['string'] },
              data: {
                types: ['object'],
                children: {
                  id: { types: ['string'], format: 'uuid' },
                  email: { types: ['string'], format: 'email' }
                }
              }
            }
          },
          complete: true
        }
      ],
      requested: 1,
      sampled: 1
    })
    seedBoard({ records: [rec('http://h/api/users/1')], inferShapes: true })
    const { container } = render(
      <DataFlowView boardId={BID} records={useOsrNetworkStore.getState().byBoard[BID].records} />
    )
    fireEvent.click(container.querySelector('.bb-net-df-row') as Element)
    // the schema reveal is fully deconstructed — envelope keys AND the nested entity fields are visible
    await waitFor(() => expect(screen.getAllByText('status').length).toBeGreaterThan(0))
    expect(screen.getAllByText('data').length).toBeGreaterThan(0)
    expect(screen.getAllByText('id').length).toBeGreaterThan(0)
    // the inspector shows the UNWRAPPED entity (named for the route), not the envelope
    const insp = container.querySelector('.bb-net-df-insp') as HTMLElement
    expect(insp.textContent).toContain('User')
    const inspFields = [...insp.querySelectorAll('.bb-net-df-inspline')].map((n) => n.textContent)
    expect(inspFields.some((t) => t?.includes('email'))).toBe(true) // unwrapped field
    expect(inspFields.some((t) => t?.includes('status'))).toBe(false) // envelope meta, not an entity field
  })
})
