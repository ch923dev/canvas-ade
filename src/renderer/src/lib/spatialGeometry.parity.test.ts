/**
 * Parity: `src/shared/spatialGeometry.ts` MIRRORS the camera constants it needs because a
 * shared module (compiled by tsconfig.node too) cannot import renderer code. This test lives
 * on the renderer side — the web tsconfig sees both trees — and pins every mirror to its
 * `canvasView` source, so MAIN's `canvas://layout` "fits" and the renderer's camera can't drift.
 */
import { describe, expect, test } from 'vitest'
import { FIT_FRAME, LOD_ZOOM, Z_MIN } from './canvasView'
import {
  FIT_MAX_ZOOM,
  FIT_MIN_ZOOM,
  FIT_PADDING_PX,
  READABLE_ZOOM
} from '../../../shared/spatialGeometry'

describe('spatialGeometry ↔ canvasView parity', () => {
  test('READABLE_ZOOM === LOD_ZOOM (below it boards render as placeholders)', () => {
    expect(READABLE_ZOOM).toBe(LOD_ZOOM)
  })

  test("FIT_PADDING_PX === FIT_FRAME.padding (a '<n>px' string)", () => {
    expect(FIT_FRAME.padding).toBe(`${FIT_PADDING_PX}px`)
    expect(FIT_PADDING_PX).toBe(parseInt(String(FIT_FRAME.padding), 10))
  })

  test('FIT_MAX_ZOOM === FIT_FRAME.maxZoom', () => {
    expect(FIT_MAX_ZOOM).toBe(FIT_FRAME.maxZoom)
  })

  test('FIT_MIN_ZOOM === Z_MIN (the camera floor)', () => {
    expect(FIT_MIN_ZOOM).toBe(Z_MIN)
  })
})
