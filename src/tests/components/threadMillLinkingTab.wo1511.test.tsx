// @vitest-environment jsdom
//
// WO-1511 / BUG-413 (family K12a): Thread Mill showed a Linking tab whose
// Entry-type controls it never reads. threadmill2d.ts derives its entry motion
// entirely from handedness / cut-direction and params.leadInOut; op.linking is
// never consulted. The modal's Linking-tab exclusions are maintained by hand in
// two places, and thread_mill was missed from both.
//
// Two proofs:
//   1. Modal render: opening a Thread Mill op (new AND edit) shows no Linking
//      tab; a Contour op still does (positive control, so the absence assertion
//      cannot pass trivially).
//   2. Builder: two payloads identical except linking.entryType produce a
//      byte-identical move stream, so an old saved op carrying a stray
//      entryType still posts identically.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags; the
// store's persist() needs a working backend. Install an in-memory shim BEFORE
// the store import. (Same pattern as ThreadMillModal.smoke.test.tsx.)
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { buildThreadMillToolpath } = await import('../../lib/cam/threadmill2d')
const { HELIX_FI_STEP } = await import('../../lib/cam/threadHelix')
import type { LinkingParams, Tool, ToolpathMove } from '../../types'
import type { LoopData, ThreadMillParams, ThreadMillWorkerPayload } from '../../lib/cam/types'

const GEO_ID = 'geo-test'
const SETUP_ID = 'setup-test'

const LOOP = { id: 'loop-b', points: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }], closed: true, type: 'hole', layerId: 'L', area: 4 }

function seedProject(operations: unknown[] = []) {
  const geometry = [{
    id: GEO_ID, name: 'part.svg', type: 'curves_2d', format: 'svg', loaded: true, loops: [LOOP],
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
  }]
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations, notes: '' }
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      project: { ...s.project, geometry, setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

function seedThreadOp() {
  const op = {
    id: 'op-tm', name: 'Thread 1', type: 'thread_mill', enabled: true, status: 'pending', toolId: '',
    geometrySelections: ['loop-b'],
    heights: { topHeight: 5, bottomHeight: -9, clearanceHeight: 15, retractHeight: 10, feedHeight: 1, topHeightMode: 'stock_top', bottomHeightMode: 'geometry_face', planeOffset: 0 },
    passes: { stockToLeave: 0, finishPasses: 0, depthPerPass: 1, stepover: 0.4 },
    // The stray entryType a pre-existing saved op may carry - the tab must not
    // let the operator edit what the builder ignores.
    linking: { entryType: 'ramp_linear', rampAngle: 5, rampLength: 0, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
    params: {
      geometryId: GEO_ID, loopIds: ['loop-b'],
      threadKind: 'internal', externalReference: 'top',
      majorDiameter: 10, pitch: 1.5, handedness: 'right', cutDirection: 'climb',
      roughingPasses: 1, springPasses: 0, leadInOut: 'arc', compensation: 'computer',
      heightReference: 'geometry_face', planeOffset: 0, threadDepth: 9,
      geometrySource: 'loop',
    },
  }
  seedProject([op])
}

afterEach(cleanup)

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-1511 NewOperationModal: Thread Mill hides the Linking tab', () => {
  it('a NEW Thread Mill op shows no Linking tab (and Contour still does)', () => {
    seedProject()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })

    // Positive control first: the generic Contour op DOES offer Linking, so the
    // exclusion we assert below is a real filter and not a missing tab bar.
    expect(screen.queryByText('Linking')).not.toBeNull()

    fireEvent.click(screen.getByText('Thread Mill'))
    expect(screen.queryByText('Linking')).toBeNull()
  })

  it('an EDIT Thread Mill op shows no Linking tab', () => {
    seedThreadOp()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-tm') })

    expect(screen.queryByText('Linking')).toBeNull()
    // The thread op still opens its own tabs.
    expect(screen.queryByText('Passes')).not.toBeNull()
  })
})

describe('WO-1511 threadmill2d ignores linking.entryType', () => {
  function makeTool(diameter = 6): Tool {
    return {
      id: 't1', name: `O${diameter} thread mill`, type: 'thread_mill',
      diameter, fluteLength: 30, shankDiameter: diameter, overallLength: 60,
      numberOfFlutes: 3, material: 'carbide', coating: 'none', notes: '',
      feedsAndSpeeds: { default: { rpm: 6000, feedRate: 400, plungeRate: 120, depthOfCut: 5, stepover: 1 } },
    } as Tool
  }

  function holeLoop(id = 'h1', dia = 8.5): LoopData {
    const r = dia / 2
    const points = []
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * 2 * Math.PI
      points.push({ x: r * Math.cos(a), y: r * Math.sin(a) })
    }
    return { id, closed: true, type: 'contour', points }
  }

  function payload(entryType: LinkingParams['entryType']): ThreadMillWorkerPayload {
    const params: ThreadMillParams = {
      geometryId: 'g1', loopIds: [],
      threadKind: 'internal', majorDiameter: 10, pitch: 1.5,
      handedness: 'right', cutDirection: 'climb',
      roughingPasses: 1, springPasses: 0,
      leadInOut: 'arc', compensation: 'computer',
    }
    return {
      opId: 'op', setupId: 'su', params,
      heights: {
        clearanceHeight: 10, clearanceHeightMode: 'absolute',
        retractHeight: 5, feedHeight: 1,
        topHeight: 0, topHeightMode: 'absolute',
        bottomHeight: -9, bottomHeightMode: 'absolute',
      },
      passes: { stepdown: 5, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
      linking: { entryType, rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
      tool: makeTool(), loops: [holeLoop()], wcsOrigin: { x: 0, y: 0, z: 0 },
    }
  }

  it('plunge vs ramp_linear vs helix entryType produce byte-identical moves', () => {
    const a: ToolpathMove[] = buildThreadMillToolpath(payload('plunge'))
    const b: ToolpathMove[] = buildThreadMillToolpath(payload('ramp_linear'))
    const c: ToolpathMove[] = buildThreadMillToolpath(payload('ramp_helical'))
    expect(a.length).toBeGreaterThan(0)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    expect(a.some(m => m.role === 'helix')).toBe(true)
    expect(a[0].role).toBe('rapid')
    expect(HELIX_FI_STEP).toBeGreaterThan(0)
  })
})
