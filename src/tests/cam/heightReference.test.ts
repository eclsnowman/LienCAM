// Unit tests for the single-source ref-plane -> heights/params mapping
// (src/lib/cam/heightReference.ts). This is the helper BOTH the NewOperationModal
// and the PropertiesPanel Heights quick-edit route a reference-plane change
// through (UI-STANDARD 11.6). The matrix below asserts the SAME behavior the
// modal's inline setOpHeightReference / setOpHeightReferenceAny produced before
// the extraction (parity), so a future edit that changes the bottomManual rule
// on one surface but not the other fails here.

import { describe, it, expect } from 'vitest'
import {
  deriveHeightRefUpdate, heightRefGovernsTop, heightRefMarksBottomManual,
  type HeightRefOpType, type HeightRefParams,
} from '../../lib/cam/heightReference'
import type { HeightParams } from '../../types'
import type { ChamferHeightReference } from '../../lib/cam/types'

const baseHeights = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5,
  feedHeight: 2, topHeight: 0, topHeightMode: 'stock_top',
  bottomHeight: -5, bottomHeightMode: 'absolute',
} as unknown as HeightParams

const REFS: ChamferHeightReference[] = [
  'geometry_face', 'stock_top', 'stock_bottom', 'machine_floor', 'wcs_plane', 'picked_plane',
]

// Expected refGovernsTop / bottomManual per op type, mirroring the modal:
//   refGovernsTop = face || engrave || (thread_mill top-referenced)
//   bottomManual  = chamfer ? never : !refGovernsTop
const CASES: Array<{ opType: HeightRefOpType; params: HeightRefParams; governsTop: boolean; bottomManual: boolean }> = [
  { opType: 'contour_2d', params: {}, governsTop: false, bottomManual: true },
  { opType: 'pocket_2d', params: {}, governsTop: false, bottomManual: true },
  { opType: 'drill', params: {}, governsTop: false, bottomManual: true },
  { opType: 'adaptive_clearing_2d', params: {}, governsTop: false, bottomManual: true },
  { opType: 'face', params: {}, governsTop: true, bottomManual: false },
  { opType: 'engrave', params: {}, governsTop: true, bottomManual: false },
  { opType: 'chamfer', params: {}, governsTop: false, bottomManual: false }, // chamfer NEVER marks manual
  { opType: 'thread_mill', params: { threadKind: 'internal' }, governsTop: true, bottomManual: false },
  { opType: 'thread_mill', params: { threadKind: 'external' }, governsTop: true, bottomManual: false }, // default 'top'
  { opType: 'thread_mill', params: { threadKind: 'external', externalReference: 'top' }, governsTop: true, bottomManual: false },
  { opType: 'thread_mill', params: { threadKind: 'external', externalReference: 'base' }, governsTop: false, bottomManual: true },
]

describe('heightRefGovernsTop / heightRefMarksBottomManual', () => {
  for (const c of CASES) {
    const tag = `${c.opType}${c.params.threadKind ? `/${c.params.threadKind}` : ''}${c.params.externalReference ? `/${c.params.externalReference}` : ''}`
    it(`${tag}: governsTop=${c.governsTop}, bottomManual=${c.bottomManual}`, () => {
      expect(heightRefGovernsTop(c.opType, c.params)).toBe(c.governsTop)
      expect(heightRefMarksBottomManual(c.opType, c.params)).toBe(c.bottomManual)
    })
  }
})

describe('deriveHeightRefUpdate matrix', () => {
  for (const c of CASES) {
    for (const ref of REFS) {
      const tag = `${c.opType}${c.params.externalReference ? `/${c.params.externalReference}` : ''} x ${ref}`
      it(`${tag}: heightReference passthrough + bottomManual`, () => {
        const upd = deriveHeightRefUpdate(c.opType, baseHeights, c.params, ref)
        expect(upd.params.heightReference).toBe(ref)
        expect(upd.params.referencePlaneGeo).toBeUndefined()
        if (c.bottomManual) {
          expect(upd.heights.bottomManual).toBe(true)
        } else {
          expect(upd.heights.bottomManual).toBeUndefined()
        }
      })
    }
  }

  it('carries the picked datum onto params.referencePlaneGeo when provided', () => {
    const datum = { geoId: 'g1', faceIndex: 3, localZ: -7 }
    const upd = deriveHeightRefUpdate('contour_2d', baseHeights, {}, 'picked_plane', datum)
    expect(upd.params.heightReference).toBe('picked_plane')
    expect(upd.params.referencePlaneGeo).toEqual(datum)
  })

  it('does not mutate the input heights/params', () => {
    const params: HeightRefParams = { heightReference: 'stock_top', planeOffset: 3 }
    const heightsCopy = { ...baseHeights }
    deriveHeightRefUpdate('pocket_2d', baseHeights, params, 'wcs_plane')
    expect(baseHeights).toEqual(heightsCopy)
    expect(params).toEqual({ heightReference: 'stock_top', planeOffset: 3 })
  })
})
