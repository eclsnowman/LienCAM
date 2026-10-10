// MODEL-ROW-CITIZEN batch 1 (defect c): a WHOLE-BODY-bound contour/pocket op
// (NO ModelReference - no face was picked) must go amber ('outdated') when the
// modeled body it cuts changes (regen or Placement move), just like a drill op.
// Before the markModelBodyBoundOpsOutdated fix such an op stayed GREEN while the
// compute path silently re-derived a different profile from the edited body.
//
// MUTATION proof: delete either markModelBodyBoundOpsOutdated call site (in
// syncModelBodies / updateModelItemPlacement) -> these tests go RED (status stays
// ready). The op carries NO modelReferences, so the drill and CAM-1 reresolve
// paths cannot be what turns it amber - only the new shared helper can.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ModelBodyDisplay, Operation } from '../../types'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'

const { useCamStore } = await import('../../store')
const { resetDocumentHolder } = await import('../../doc/documentHolder')

function display(min: [number, number, number], max: [number, number, number]): ModelBodyDisplay {
  return {
    positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
    bbox: { min, max },
  }
}

let idb: FakeIndexedDBHandle
beforeEach(() => {
  resetDocumentHolder()
  idb = installFakeIndexedDB()
  vi.clearAllMocks()
  useCamStore.getState().newProject()
})
afterEach(() => { idb.restore() })

/** Seed a model body via the REAL syncModelBodies, then bind a WHOLE-BODY contour
 *  op to it (params.geometryId = the model row, NO modelReferences). */
function seedWholeBodyOpOnBody(
  bodyId: string,
  type: 'contour_2d' | 'adaptive_clearing_2d' = 'contour_2d',
): string {
  useCamStore.getState().syncModelBodies({
    live: [{ bodyId, name: 'Plate' }],
    derived: [{
      bodyId, version: 1, stableIds: [`${bodyId}:F0`],
      display: display([-20, -15, 0], [20, 15, 10]),
    }],
  })
  const state = useCamStore.getState()
  const geo = state.project.geometry.find((g) => g.format === 'model')
  expect(geo).toBeDefined()
  const op = {
    id: 'op-contour-1', name: type === 'contour_2d' ? 'Contour' : 'Adaptive',
    type, enabled: true, status: 'ready',
    toolId: state.toolLibrary[0]?.id ?? 'tool-1', geometrySelections: [],
    // NO modelReferences: a whole-body contour without a picked face.
    heights: {
      clearanceHeight: 15, clearanceHeightMode: 'absolute',
      retractHeight: 5, feedHeight: 2, topHeight: 0, topHeightMode: 'absolute',
      bottomHeight: -5, bottomHeightMode: 'absolute',
    },
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: type === 'contour_2d'
      ? { geometryId: geo!.id, loopIds: [] }
      : {
          geometryId: geo!.id, loopIds: [], boundarySource: 'geometry',
          targetEngagement: 0.4, maxEngagement: 0.7, stepDistance: 0.4,
          thetaMax: Math.PI / 3, climb: true, rampAngle: 3,
          completionTolerance: 1,
        },
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' }],
  } as unknown as Operation
  const existing = useCamStore.getState().project.setups
  if (existing.length === 0) {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        setups: [{
          id: 'setup-1', name: 'Setup 1', operations: [op],
          wcs: {
            id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
            xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
          },
          stock: null, notes: '',
        } as never],
        activeSetupId: 'setup-1',
      },
    }))
  } else {
    useCamStore.getState().addOperation(existing[0].id, op)
  }
  return geo!.id
}

function findContourOp(): Operation | undefined {
  for (const s of useCamStore.getState().project.setups) {
    const op = s.operations.find((o) => o.id === 'op-contour-1')
    if (op) return op
  }
  return undefined
}

describe('MODEL-ROW-CITIZEN: whole-body contour ambers on model edit (defect c)', () => {
  it('syncModelBodies with a changed body version ambers the whole-body contour op', () => {
    seedWholeBodyOpOnBody('BODY-A')
    expect(findContourOp()?.status).toBe('ready')

    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'BODY-A', name: 'Plate' }],
      derived: [{
        bodyId: 'BODY-A', version: 2, stableIds: ['BODY-A:F0'],
        display: display([-20, -15, 0], [20, 15, 14]), // taller -> body changed
      }],
    })
    const op = findContourOp()
    expect(op?.status).toBe('outdated')
    expect(op?.modelReferenceNote).toMatch(/modeled part this operation cuts changed/i)
    // Last-known toolpath retained (S5c ruling; markModelBodyBoundOpsOutdated does
    // NOT clear it, unlike outdateOpsReferencingGeo).
    expect(op?.toolpathMoves?.length).toBe(1)
  })

  it('updateModelItemPlacement ambers the whole-body contour op on that item', () => {
    seedWholeBodyOpOnBody('BODY-B')
    expect(findContourOp()?.status).toBe('ready')

    useCamStore.getState().updateModelItemPlacement(
      'legacy', undefined,
      { x: 5, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    )
    expect(findContourOp()?.status).toBe('outdated')
  })

  it('a DIFFERENT, untouched body syncing does NOT amber this op (scoped to touched bodies)', () => {
    seedWholeBodyOpOnBody('BODY-C') // op bound to BODY-C
    expect(findContourOp()?.status).toBe('ready')
    // Sync an UNRELATED body the op does not cut -> touchedBodyIds excludes BODY-C.
    useCamStore.getState().syncModelBodies({
      live: [
        { bodyId: 'BODY-C', name: 'Plate' },
        { bodyId: 'BODY-OTHER', name: 'Widget' },
      ],
      derived: [{
        bodyId: 'BODY-OTHER', version: 1, stableIds: ['BODY-OTHER:F0'],
        display: display([50, 50, 0], [70, 70, 8]),
      }],
    })
    expect(findContourOp()?.status).toBe('ready') // BODY-C untouched -> op stays ready
  })

  it('adaptive clearing also goes amber and retains its last-known toolpath', () => {
    seedWholeBodyOpOnBody('BODY-AC', 'adaptive_clearing_2d')
    expect(findContourOp()?.status).toBe('ready')

    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'BODY-AC', name: 'Plate' }],
      derived: [{
        bodyId: 'BODY-AC', version: 2, stableIds: ['BODY-AC:F0'],
        display: display([-20, -15, 0], [20, 15, 14]),
      }],
    })

    expect(findContourOp()?.status).toBe('outdated')
    expect(findContourOp()?.toolpathMoves).toHaveLength(1)
  })

  it('a direct-edit leaf change keeps the bound row id and ambers Adaptive', () => {
    const rowId = seedWholeBodyOpOnBody('ROOT-BODY', 'adaptive_clearing_2d')

    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'PUSH-PULL-LEAF', lineageId: 'ROOT-BODY', name: 'Plate' }],
      derived: [{
        bodyId: 'PUSH-PULL-LEAF', lineageId: 'ROOT-BODY', version: 2,
        stableIds: ['PUSH-PULL-LEAF:F0'],
        display: display([-20, -15, 0], [20, 15, 18]),
      }],
    })

    const row = useCamStore.getState().project.geometry.find((g) => g.format === 'model')
    expect(row?.id).toBe(rowId)
    expect(row?.modelBody?.ref).toMatchObject({
      bodyId: 'PUSH-PULL-LEAF',
      lineageId: 'ROOT-BODY',
    })
    expect(findContourOp()?.params.geometryId).toBe(rowId)
    expect(findContourOp()?.status).toBe('outdated')
  })
})
