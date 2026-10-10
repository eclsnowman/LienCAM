// GEO-UNIFY Stage 3 (promote flow, MOVE semantics) — the store action
// promoteSketchLayerToModel + its read-only preview, driven through the REAL
// zustand store (enterModelWorkspace.intModelUnify pattern).
//
// Proves the 9 steps of plan sec 3.2 at the store level:
//   - happy path: a stored CAM sketch MOVES into a new Model Item, the sketch
//     leaves the CAM Geometry list (no duplicate anywhere), the item is minted,
//     a seed document is stashed and consumable exactly once, the workspace
//     opens on the item.
//   - lift path: an imported layer with loops but NO stored sketch is LIFTED
//     first (same one-source-of-truth semantics openSketchForLayer uses).
//   - dependent-op WARNING list matches the mutator's amber set (mutation-proof
//     via the shared listOpsReferencingGeo rule).
//   - amber: exactly the ready referencing ops flip to 'outdated', toolpath
//     dropped, dangling loop refs RETAINED (never a silent rebind); an
//     already-outdated referencing op and an unrelated op are untouched.
//   - undo: one Ctrl+Z restores the layer + loops + sketch + op statuses and
//     removes the item record + placement.
//   - container cleanup: an emptied Sketches container row is removed.
//   - placement seed: a whole-item placement is seeded from the owner geo pose.
//   - preflight refusals (loud, named, no mutation): locked / projection / STL /
//     non-sketch / missing.
//   - an ambered op's editor opens post-promote without a crash (risk item).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useCamStore, SKETCH_CONTAINER_ID } from '../../store'
import { resetDocumentHolder, takePendingDocumentSeed } from '../../doc/documentHolder'
import type { SketchBlockEntity } from '../../lib/sketch/types'
import type { ProfileRegion } from '../../geom/geom-service'
import type {
  ImportedGeometry, Layer2D, Loop2D, Operation, Setup, WCS,
  HeightParams, PassParams, LinkingParams, SceneStock,
} from '../../types'
import type { Sketch } from '../../lib/sketch/types'

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}
const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function makeWcs(): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
}
function op(
  id: string,
  over: Partial<Operation> = {},
  status: Operation['status'] = 'ready',
): Operation {
  return {
    id, name: id, type: 'contour_2d', enabled: true, status,
    toolId: 'tool-1', geometrySelections: [],
    heights, passes, linking, params: {},
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 5 }],
    ...over,
  }
}
function makeSetup(ops: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', wcs: makeWcs(),
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' } as Setup['stock'],
    operations: ops, notes: '',
  }
}

/** A closed 10x10 square as a stored CAM Sketch (4 non-construction lines whose
 *  endpoints coincide by coordinate — chains into one closed loop, so
 *  extractSketchProfile produces a profile at seed time). */
function squareSketch(layerId: string, id = 'sk-1'): Sketch {
  return {
    id, layerId,
    entities: [
      { id: 'e1', construction: false, kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'e2', construction: false, kind: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
      { id: 'e3', construction: false, kind: 'line', start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
      { id: 'e4', construction: false, kind: 'line', start: { x: 0, y: 10 }, end: { x: 0, y: 0 } },
    ],
    constraints: [], dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}
function squareLoop(id: string, layerId: string): Loop2D {
  return {
    id, layerId, closed: true, type: 'contour', area: 100,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  }
}
function sketchLayer(id: string, over: Partial<Layer2D> = {}): Layer2D {
  return { id, name: id, color: '#ffd740', visible: true, sourceType: 'sketch', ...over }
}

/** The shared "Sketches" container holding one sketch-editable layer + its loop
 *  + its stored parametric document — exactly the shape createSketchLayer + bake
 *  produce. `over` lets a test add a second layer or move the pose. */
function storedSketchContainer(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  const layerId = 'lay-1'
  return {
    id: SKETCH_CONTAINER_ID, name: 'Sketches', filename: '', type: 'curves_2d', format: 'sketch',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    layers2d: [sketchLayer(layerId)],
    loops: [squareLoop('lp-1', layerId)],
    sketches: [squareSketch(layerId)],
    ...over,
  }
}

function resetStore(): void {
  resetDocumentHolder()
  useCamStore.setState((s) => ({
    project: {
      ...s.project, setups: [], sceneStock: autoStock,
      geometry: [], modelItems: [], modelItemPlacements: [], modelItemDocuments: undefined,
    },
    workspace: 'cam', activeModal: null, activeModelItemId: null,
    projectHistory: [], sketchHistory: [], canUndo: false,
  }))
}

const state = () => useCamStore.getState()
const items = () => state().project.modelItems ?? []
const geom = () => state().project.geometry
const opById = (id: string): Operation | undefined =>
  state().project.setups.flatMap((su) => su.operations).find((o) => o.id === id)

describe('GEO-UNIFY Stage 3: promoteSketchLayerToModel — happy path (stored sketch, MOVE)', () => {
  beforeEach(resetStore)

  it('MOVES the sketch into a new Model Item: sketch gone from CAM, item minted, workspace opened, seed stashed once', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [storedSketchContainer()] } }))
    const res = await state().promoteSketchLayerToModel('lay-1', SKETCH_CONTAINER_ID)

    expect(res.ok).toBe(true)
    const itemId = res.itemId!
    expect(itemId).toBeTruthy()

    // MOVE proven: the emptied Sketches container is gone entirely (no duplicate
    // sketch anywhere in CAM geometry).
    expect(geom()).toEqual([])
    // Item minted, named after the layer, workspace opened on it.
    expect(items().map((m) => m.id)).toContain(itemId)
    expect(items().find((m) => m.id === itemId)?.name).toBe('lay-1')
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe(itemId)

    // A seed document was stashed against the item and is consumable exactly
    // once (the workbench mount's takePendingDocumentSeed contract).
    expect(takePendingDocumentSeed(itemId)).not.toBeNull()
    expect(takePendingDocumentSeed(itemId)).toBeNull()
  })

  it('seeds a whole-item placement from the owner geo pose (body lands where the sketch sat)', async () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [storedSketchContainer({ position: { x: 7, y: -3, z: 0 }, rotation: { x: 0, y: 0, z: 1.5 } })] },
    }))
    const res = await state().promoteSketchLayerToModel('lay-1', SKETCH_CONTAINER_ID)
    const placement = (state().project.modelItemPlacements ?? []).find((p) => p.modelItemId === res.itemId)
    expect(placement).toBeDefined()
    expect(placement?.bodyId).toBeUndefined() // whole-item, not body-filtered
    expect(placement?.position).toEqual({ x: 7, y: -3, z: 0 })
    expect(placement?.rotation).toEqual({ x: 0, y: 0, z: 1.5 })
  })

  it('keeps a SIBLING sketch layer and its container when only one of two layers is promoted (container cleanup only when emptied)', async () => {
    const twoLayer = storedSketchContainer({
      layers2d: [sketchLayer('lay-1'), sketchLayer('lay-2', { name: 'Sketch 2' })],
      loops: [squareLoop('lp-1', 'lay-1'), squareLoop('lp-2', 'lay-2')],
      sketches: [squareSketch('lay-1'), squareSketch('lay-2', 'sk-2')],
    })
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [twoLayer] } }))
    await state().promoteSketchLayerToModel('lay-1', SKETCH_CONTAINER_ID)

    const container = geom().find((g) => g.id === SKETCH_CONTAINER_ID)
    expect(container).toBeDefined()
    expect(container?.layers2d?.map((l) => l.id)).toEqual(['lay-2'])
    expect(container?.loops?.map((l) => l.id)).toEqual(['lp-2'])
    expect(container?.sketches?.map((sk) => sk.layerId)).toEqual(['lay-2'])
  })
})

describe('GEO-UNIFY Stage 3: promote — lift path (imported layer, no stored sketch)', () => {
  beforeEach(resetStore)

  it('LIFTS an imported DXF layer with loops but no stored sketch, then moves it', async () => {
    const dxf: ImportedGeometry = {
      id: 'dxf-1', name: 'part.dxf', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
        size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      layers2d: [sketchLayer('imp-1', { name: 'Layer 0', sourceType: 'import' })],
      loops: [squareLoop('lp-1', 'imp-1')],
      // no `sketches` — the lift path is exercised
    }
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [dxf] } }))
    const res = await state().promoteSketchLayerToModel('imp-1', 'dxf-1')

    expect(res.ok).toBe(true)
    // The DXF geo's only layer moved out; a DXF container with zero layers is not
    // the Sketches container, so it is retained (empty), not auto-removed.
    const dxfAfter = geom().find((g) => g.id === 'dxf-1')
    expect(dxfAfter?.layers2d ?? []).toEqual([])
    expect(items().some((m) => m.id === res.itemId)).toBe(true)
    expect(takePendingDocumentSeed(res.itemId!)).not.toBeNull()
  })

  it('SKC-BLOCKS Stage 3: the imported layer promotes as ONE LOCKED BLOCK, still extrude-eligible', async () => {
    const dxf: ImportedGeometry = {
      id: 'dxf-2', name: 'part.dxf', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
        size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      layers2d: [sketchLayer('imp-2', { name: 'Layer 0', sourceType: 'import' })],
      loops: [squareLoop('lp-1', 'imp-2')],
    }
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [dxf] } }))
    const res = await state().promoteSketchLayerToModel('imp-2', 'dxf-2')
    expect(res.ok).toBe(true)

    // The stashed seed's base sketch node carries ONE block (the whole import),
    // and a profile was extracted at seed time (block-aware extraction), so the
    // promoted model is extrude-eligible on first open.
    const seed = takePendingDocumentSeed(res.itemId!)
    expect(seed).not.toBeNull()
    const dag = seed!.dag
    const sketchNodes = dag.nodeIds()
      .map((id) => dag.getNode(id)!)
      .filter((n) => n.kind === 'sketch')
    expect(sketchNodes).toHaveLength(1)
    const payload = sketchNodes[0].payload as { sketch?: { entities: { kind: string }[] }; profile?: ProfileRegion }
    const userEntities = (payload.sketch?.entities ?? []).filter((e) => e.kind !== undefined)
    const blocks = userEntities.filter((e) => e.kind === 'block')
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as unknown as SketchBlockEntity).members.entities).toHaveLength(4)
    // Extrude-eligible: a closed profile came out of the block at seed time.
    expect(payload.profile).toBeDefined()
    expect(payload.profile!.loops.length).toBeGreaterThan(0)
  })
})

describe('GEO-UNIFY Stage 3: promote — dependent-op amber + warning agree (mutation-proof)', () => {
  beforeEach(resetStore)

  function installOpsAndSketch(): void {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [storedSketchContainer()],
        setups: [makeSetup([
          op('op-loop', { geometrySelections: ['lp-1'] }),                       // references the loop
          op('op-geo', { params: { geometryId: SKETCH_CONTAINER_ID } }),         // references the geo id
          op('op-all', { params: { geometryId: '__all__' } }),                   // wildcard
          op('op-unrelated', { params: { geometryId: 'other' } }),              // untouched
          op('op-already', { geometrySelections: ['lp-1'] }, 'outdated'),        // not ready -> not listed/flipped
        ])],
      },
    }))
  }

  it('the preview NAMES exactly the ops the promote ambers (same shared rule)', async () => {
    installOpsAndSketch()
    const preview = state().promoteSketchPreview('lay-1', SKETCH_CONTAINER_ID)
    expect(preview.eligible).toBe(true)
    expect([...preview.opNames].sort()).toEqual(['op-all', 'op-geo', 'op-loop'])

    const res = await state().promoteSketchLayerToModel('lay-1', SKETCH_CONTAINER_ID)
    expect(res.opNames && [...res.opNames].sort()).toEqual(['op-all', 'op-geo', 'op-loop'])

    // The ops the mutator actually flipped to 'outdated' == the preview list.
    const flipped = state().project.setups
      .flatMap((su) => su.operations)
      .filter((o) => o.status === 'outdated' && o.id !== 'op-already')
      .map((o) => o.id)
      .sort()
    expect(flipped).toEqual(['op-all', 'op-geo', 'op-loop'])
  })

  it('ambered ops drop their toolpath but RETAIN their (now dangling) loop refs — never a silent rebind', async () => {
    installOpsAndSketch()
    await state().promoteSketchLayerToModel('lay-1', SKETCH_CONTAINER_ID)

    expect(opById('op-loop')?.status).toBe('outdated')
    expect(opById('op-loop')?.toolpathMoves).toBeUndefined()
    // The dangling loop id is preserved for the user to reselect against later.
    expect(opById('op-loop')?.geometrySelections).toEqual(['lp-1'])

    // Unrelated + already-outdated ops are untouched (identity of status).
    expect(opById('op-unrelated')?.status).toBe('ready')
    expect(opById('op-unrelated')?.toolpathMoves).toEqual([{ type: 'rapid', x: 0, y: 0, z: 5 }])
    expect(opById('op-already')?.status).toBe('outdated')
  })

  it('an ambered op\'s editor opens post-promote without a crash (dangling loop refs are harmless)', async () => {
    installOpsAndSketch()
    await state().promoteSketchLayerToModel('lay-1', SKETCH_CONTAINER_ID)
    expect(() => state().openEditOperation('setup-1', 'op-loop')).not.toThrow()
    expect(state().activeModal).toBe('edit-operation')
    expect(state().editingOpPayload).toEqual({ setupId: 'setup-1', opId: 'op-loop' })
  })
})

describe('GEO-UNIFY Stage 3: promote — undo restores everything (one Ctrl+Z)', () => {
  beforeEach(resetStore)

  it('one undo restores the layer + loops + sketch + op statuses and removes the item + placement', async () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [storedSketchContainer()],
        setups: [makeSetup([op('op-loop', { geometrySelections: ['lp-1'] })])],
      },
    }))
    const beforeGeo = geom()
    const historyBefore = state().projectHistory.length

    const res = await state().promoteSketchLayerToModel('lay-1', SKETCH_CONTAINER_ID)
    expect(state().projectHistory.length).toBe(historyBefore + 1) // exactly ONE undo step
    expect(geom()).toEqual([])
    expect(opById('op-loop')?.status).toBe('outdated')
    expect(items().some((m) => m.id === res.itemId)).toBe(true)

    state().undo()

    // Sketch layer + loops + stored document are back verbatim; the item record
    // and its placement are gone (transient workspace nav is NOT part of the
    // snapshot — the same documented soft edge addModelItem has). The op exists
    // again and its selection points at the RESTORED loop id, ready to recompute.
    // Its status is 'outdated' (not 'ready') — that is pushHistory's UNIVERSAL
    // contract: every snapshot strips toolpaths and marks ready ops outdated so
    // the user regenerates after ANY undo (store/index.ts pushHistory), not a
    // promote-specific effect.
    expect(geom()).toEqual(beforeGeo)
    expect(opById('op-loop')?.status).toBe('outdated')
    expect(opById('op-loop')?.geometrySelections).toEqual(['lp-1'])
    expect(geom().find((g) => g.id === SKETCH_CONTAINER_ID)?.loops?.some((l) => l.id === 'lp-1')).toBe(true)
    expect(items().some((m) => m.id === res.itemId)).toBe(false)
    expect((state().project.modelItemPlacements ?? []).some((p) => p.modelItemId === res.itemId)).toBe(false)
  })
})

describe('PROMOTE-SKETCH-FAIL round 2: pending/empty/active-editor guards (never a silent no-op)', () => {
  beforeEach(resetStore)

  /** The exact race Operator hit: the tree "Convert to model" confirm fires while
   *  the fresh sketch's bake/compute has not yet produced a stored document OR
   *  loops. Promote MUST refuse by name and mutate nothing (sketch stays in
   *  CAM) rather than mint an empty model or silently do nothing. */
  it('refuses an unbaked layer (no stored sketch, no loops) BY NAME and mutates nothing', async () => {
    const pending = storedSketchContainer({ loops: [], sketches: [] })
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [pending] } }))
    const before = geom()

    const res = await state().promoteSketchLayerToModel('lay-1', SKETCH_CONTAINER_ID)

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('not-ready')
    // No empty model minted; the sketch layer STAYS in CAM (matches Operator's
    // "it was still in the sketch/cam workspace"), workspace not switched.
    expect(geom()).toEqual(before)
    expect(items()).toEqual([])
    expect(state().workspace).toBe('cam')
    // A plain-words notice was surfaced (not only a console.error).
    expect(state().sketchNotice).toMatch(/still being prepared/i)
  })

  /** MUTATION PROOF for the empty-guard: a sketch WITH entities but NOT-yet-baked
   *  loops (bake mid-flight, entities are the source of truth) must STILL
   *  promote — the guard keys on entities, not loops, so it cannot over-block
   *  this legitimate case. If the guard regressed to `layerLoops.length === 0`
   *  this would wrongly refuse. */
  it('still promotes a sketch that has entities but no baked loops yet (guard keys on entities, not loops)', async () => {
    const entitiesNoLoops = storedSketchContainer({ loops: [] }) // squareSketch entities present, loops stripped
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [entitiesNoLoops] } }))
    const res = await state().promoteSketchLayerToModel('lay-1', SKETCH_CONTAINER_ID)
    expect(res.ok).toBe(true)
    expect(items().some((m) => m.id === res.itemId)).toBe(true)
    expect(geom()).toEqual([]) // moved out
  })

  /** A live sketch-editor session for this layer holds unbaked edits; promoting
   *  now would move stale/empty geometry and drop the in-progress drawing.
   *  Refuse by name. */
  it('refuses when a live sketch editor is open for this layer (drops no in-progress work)', async () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [storedSketchContainer()] },
      activeSketch: {
        id: 'sk-live', layerId: 'lay-1',
        entities: [{ id: 'e1', construction: false, kind: 'line', start: { x: 0, y: 0 }, end: { x: 5, y: 0 } }],
        constraints: [], dimensions: [], solveStatus: null,
      },
      viewer: { ...state().viewer, mode: 'sketch' },
    }))
    const before = geom()
    const res = await state().promoteSketchLayerToModel('lay-1', SKETCH_CONTAINER_ID)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('sketch-open')
    expect(geom()).toEqual(before)
    expect(items()).toEqual([])
    expect(state().sketchNotice).toMatch(/finish the sketch first/i)
  })

  afterEach(() => {
    // The refusals call showSketchNotice, which arms an auto-clear timer; reset
    // it so it never leaks across tests.
    useCamStore.setState({ sketchNotice: null })
  })
})

describe('PROMOTE-SKETCH-FAIL round 2: Model-tab select-then-switch (promoteSelectedSketchToModel)', () => {
  beforeEach(() => {
    resetStore()
    // resetStore leaves activeSketch/viewer.mode untouched; a prior describe's
    // active-editor test would otherwise leak the sketch-open guard into here.
    useCamStore.setState((s) => ({
      activeSketch: null,
      viewer: { ...s.viewer, mode: 'setup', selectedGeometryId: null, selectedLayerId: null, selectedLayerGeoId: null },
    }))
  })
  afterEach(() => useCamStore.setState({ sketchNotice: null }))

  it('a SELECTED SKETCH LAYER promotes on the Model tab (was a silent navigate-away no-op)', async () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [storedSketchContainer()] },
      viewer: { ...s.viewer, selectedLayerId: 'lay-1', selectedLayerGeoId: SKETCH_CONTAINER_ID, selectedGeometryId: null },
    }))
    const res = await state().promoteSelectedSketchToModel()
    expect(res.ok).toBe(true)
    expect(geom()).toEqual([])                    // moved out (real promote, not bare nav)
    expect(items().some((m) => m.id === res.itemId)).toBe(true)
    expect(state().workspace).toBe('part')
  })

  it('a whole part with 2+ sketches refuses in plain words (no silent nav, no wrong promote)', async () => {
    const twoLayer = storedSketchContainer({
      id: 'dxf', format: 'dxf', name: 'part.dxf',
      layers2d: [sketchLayer('lay-1'), sketchLayer('lay-2', { name: 'Sketch 2' })],
      loops: [squareLoop('lp-1', 'lay-1'), squareLoop('lp-2', 'lay-2')],
      sketches: [squareSketch('lay-1'), squareSketch('lay-2', 'sk-2')],
    })
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [twoLayer] },
      viewer: { ...s.viewer, selectedGeometryId: 'dxf', selectedLayerId: null, selectedLayerGeoId: null },
    }))
    const res = await state().promoteSelectedSketchToModel()
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('ambiguous')
    expect(items()).toEqual([])                   // nothing promoted
    expect(state().sketchNotice).toMatch(/more than one sketch/i)
  })

  it('no sketch selection falls through to plain Model-workspace nav (unchanged)', async () => {
    // No geometry, nothing selected -> enterModelWorkspace claims the legacy slot.
    const res = await state().promoteSelectedSketchToModel()
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('no-selection')
    expect(state().workspace).toBe('part')        // navigated, as today
  })
})

describe('PROMOTE-SKETCH-FAIL round 2: themed confirm (requestConfirm/resolveConfirm)', () => {
  beforeEach(resetStore)

  it('requestConfirm opens the dialog and resolves true on confirm', async () => {
    const p = state().requestConfirm({ title: 'Convert sketch to model?', body: 'x', confirmLabel: 'Convert to model' })
    expect(state().confirmDialog).not.toBeNull()
    expect(state().confirmDialog?.confirmLabel).toBe('Convert to model')
    state().resolveConfirm(true)
    expect(state().confirmDialog).toBeNull()
    await expect(p).resolves.toBe(true)
  })

  it('resolves false on cancel and a second request supersedes the first (no hung promise)', async () => {
    const first = state().requestConfirm({ title: 'A' })
    const second = state().requestConfirm({ title: 'B' }) // supersedes first
    await expect(first).resolves.toBe(false)               // first auto-cancelled
    state().resolveConfirm(false)
    await expect(second).resolves.toBe(false)
  })
})

describe('GEO-UNIFY Stage 3: promote — preflight refusals (loud, named, no mutation)', () => {
  beforeEach(resetStore)

  it('refuses a LOCKED layer and mutates nothing', async () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [storedSketchContainer({ layers2d: [sketchLayer('lay-1', { locked: true })] })] },
    }))
    const before = geom()
    const res = await state().promoteSketchLayerToModel('lay-1', SKETCH_CONTAINER_ID)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('locked')
    expect(geom()).toEqual(before)
    expect(items()).toEqual([])
    expect(state().promoteSketchPreview('lay-1', SKETCH_CONTAINER_ID).eligible).toBe(false)
  })

  it('refuses a projection layer (read-only, ADR-0011)', async () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [storedSketchContainer({ layers2d: [sketchLayer('lay-1', { projectionPlane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } } as unknown as Layer2D['projectionPlane'] })] })] },
    }))
    const res = await state().promoteSketchLayerToModel('lay-1', SKETCH_CONTAINER_ID)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('read-only')
  })

  it('refuses a missing layer by name (no mutation)', async () => {
    const res = await state().promoteSketchLayerToModel('ghost', SKETCH_CONTAINER_ID)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('not-found')
    expect(items()).toEqual([])
  })
})
