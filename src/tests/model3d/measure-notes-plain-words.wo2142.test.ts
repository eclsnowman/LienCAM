// @vitest-environment jsdom
//
// WO-2142: the Measure readout never shows developer wording. A radius,
// diameter or distance taken from the displayed mesh (rather than an exact
// kernel answer) says so in the operator's words, and says nothing about
// reports, WOs or kernel queries. Driven through the production route: the
// real measureSingle / measureDistance produce the outcomes and the real
// MeasurePanel renders them, exactly as SolidsWorkbenchPage does.

import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { GeometryCache } from '../../viewport3d'
import { makeBoxTessBuffers } from '../../viewport3d/fixtures'
import type { EdgePickHit, FacePickHit } from '../../viewport3d'
import { edgeId as mintEdgeId } from '../../doc/stable-id'
import type { MeasureResult, TessBuffers } from '../../geom/geom-service'
import {
  measureDistance,
  measureSingle,
  type MeasureExactFn,
  type MeasureOutcome,
  type PickWithBody,
  type SnapshotLookup,
} from '../../components/model3d/measure/measureLogic'
import { MeasurePanel } from '../../components/model3d/measure/MeasurePanel'
import type { MeasureSessionState } from '../../components/model3d/measure/useMeasureSession'

afterEach(cleanup)

const DEVELOPER_WORDS = /report|interfaceConcerns|kernel|query|distanceBetween|\bWO\b|mesh-derived/i

function renderPanel(outcomes: MeasureOutcome[]): string {
  const state: MeasureSessionState = {
    mode: 'single',
    busy: false,
    outcomes,
    armedCount: 0,
    hoveredBodyId: null,
    selectedBodyIds: new Set(),
    hoveredVertex: null,
    selectedVertex: null,
  }
  render(createElement(MeasurePanel, { state, onModeChange: () => {}, onClear: () => {} }))
  return screen.getByTestId('measure-panel').textContent ?? ''
}

const measureExact: MeasureExactFn = async (_bodyId, kind) => ({ kind, value: 12 } as MeasureResult)

// One triangle whose three corners sit on a radius-6 circle about +Z, tagged
// as a single cylinder face with one rim edge (also on the circle).
const CYL_FACE = 'F1:REV:cyl:surf'
const RIM_EDGE = mintEdgeId(CYL_FACE, 'F1:BOX:face#5')
function cylinderBody() {
  const buffers: TessBuffers = {
    position: new Float32Array([6, 0, 0, 0, 6, 0, -6, 0, 0]),
    normal: new Float32Array([1, 0, 0, 0, 1, 0, -1, 0, 0]),
    index: new Uint32Array([0, 1, 2]),
    triFace: new Uint32Array([0]),
    faceIds: [CYL_FACE],
    edgePositions: new Float32Array([6, 0, 0, 0, 6, 0]),
    edgeOffsets: new Uint32Array([0, 2]),
    edgeIds: [RIM_EDGE],
  }
  return new GeometryCache().ingest('cyl', buffers)
}
const CYL_SNAPSHOTS: SnapshotLookup = {
  [CYL_FACE]: { type: 'cylinder', centroid: [0, 0, 0], normal: [0, 0, 1], axis: [0, 0, 1], area: 1 },
}

describe('WO-2142 Measure readout notes are in plain words', () => {
  it('a cylinder face shows radius and diameter as approximate, measured on the displayed surface', async () => {
    const body = cylinderBody()
    const hit: FacePickHit = { kind: 'face', id: CYL_FACE, bodyId: 'cyl', distance: 1, point: { x: 6, y: 0, z: 0 } }
    const outcomes = await measureSingle(measureExact, body, 'cyl', hit, CYL_SNAPSHOTS)
    const text = renderPanel(outcomes)
    expect(text).toContain('Radius: 6.000 mm (approx)')
    expect(text).toContain('Diameter: 12.000 mm (approx)')
    expect(text).toContain('approximate - measured on the displayed surface')
    expect(text).not.toMatch(DEVELOPER_WORDS)
  })

  it('a rim edge shows radius and diameter in the same plain words', async () => {
    const body = cylinderBody()
    const hit: EdgePickHit = { kind: 'edge', id: RIM_EDGE, bodyId: 'cyl', distance: 1, point: { x: 6, y: 0, z: 0 } }
    const outcomes = await measureSingle(measureExact, body, 'cyl', hit, CYL_SNAPSHOTS)
    const text = renderPanel(outcomes)
    expect(text).toContain('Radius: 6.000 mm (approx)')
    expect(text).toContain('approximate - measured on the displayed surface')
    expect(text).not.toMatch(DEVELOPER_WORDS)
  })

  it('a face-to-face distance says it is approximate, from the displayed surface', () => {
    const body = new GeometryCache().ingest('box', makeBoxTessBuffers({ size: { x: 40, y: 20, z: 10 }, featureId: 'F1' }))
    const pick = (id: string): PickWithBody => ({
      bodyId: 'box',
      body,
      hit: { kind: 'face', id, bodyId: 'box', distance: 1, point: { x: 0, y: 0, z: 0 } },
      snapshots: {},
    })
    // -X face and +X face of the 40 mm box: 40 mm apart.
    const outcome = measureDistance(pick('F1:BOX:face#0'), pick('F1:BOX:face#1'))
    const text = renderPanel([outcome])
    expect(text).toContain('Distance: 40.000 mm (approx)')
    expect(text).toContain('approximate - closest points on the displayed surface')
    expect(text).not.toMatch(DEVELOPER_WORDS)
  })
})
