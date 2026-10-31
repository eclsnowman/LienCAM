// WO-3188: 2D geometry ops are placed in Z from the Heights tab - stock top,
// stock bottom or any offset - and a Chamfer on a plain 2D outline starts at
// the material actually there, not at the sketch plane.
//
// owner request 2026-10-27: "2d geometry needs operations to be able to be controlled
// by the heights tab since 2d geometry is not part aware. This should allow
// defining the operation to happen at top of stock, bottoms of stock, or any
// offset in between." Gap S2D-01 (10-23): "We can likely infer the smart
// height initial value of a chamfer based on the stock height remaining at
// that point in the operation."
//
// Every case runs the store's own computeOperationToolpath with the real
// toolpathWorker (heightScenario harness): the moves read here are the moves
// the post writes.
//
// SCENE: a DXF lying where an import puts it - on the table, which is the
// stock bottom. Auto stock 12 mm above it (machine Z 0..12), work zero on the
// stock top, so the stock top is WCS 0 and the stock bottom WCS -12.

import { describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { geometryLoopPlane, sourcesAreHeightlessOutlines } from '../../store/dispatchGeo'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import {
  circleLoop, installRealToolpathWorker, rectLoop, runHeightScenario, type HeightReading, type HeightScenario,
} from '../helpers/heightScenario'
import { toWork } from '../../lib/program/coords'
import type { OperationHeightIntentV2, SmartHeightIntentOwner } from '../../lib/cam/smartHeights/types'
import type { ImportedGeometry, Operation, Tool, ToolpathMove } from '../../types'
import { obstacleFromBox, toolBands, writeSideView, type PathPoint } from '../helpers/sideViewEvidence'

installRealToolpathWorker()

const OUTLINE = rectLoop('outline', 0, 0, 60, 40)
const RING = rectLoop('ring', 15, 10, 45, 30)
const HOLE = circleLoop('hole', 52, 20, 4)
const STOCK = { kind: 'auto' as const, offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 }
const STOCK_TOP = 0
const STOCK_BOTTOM = -12
const WIDTH = 1 // the dialog's default chamfer width; its default tip offset is 0

function onTable(op: HeightScenario['operation'], extra: Partial<HeightScenario> = {}): HeightScenario {
  return {
    part: { kind: 'sketch_2d', loops: [OUTLINE, RING, HOLE], z: 0 },
    stock: STOCK, operation: op, loopIds: ['outline'], ...extra,
  }
}

/** The chamfer datum's owner, as the New Operation dialog saves it: policy
 * when the operator chose nothing, user once a reference or offset is picked
 * (twoDGeometryHeightsTab.wo3188.test.tsx pins the dialog side). */
function withDatumOwner(smartHeight: Operation['smartHeight'], owner: SmartHeightIntentOwner): Operation['smartHeight'] {
  const intent = structuredClone((smartHeight as { intent: OperationHeightIntentV2 }).intent)
  const end = intent.machining.end.value
  if (end.kind !== 'geometry_tool_formula' || end.formula.kind !== 'chamfer_edge') throw new Error('not a chamfer formula')
  end.formula.datumPlane.owner = owner
  return { kind: 'smart_v2', intent }
}

/** Regenerate the scenario's chamfer through the store and read it again. */
async function regenerateChamfer(reading: HeightReading): Promise<HeightReading> {
  const setup = useCamStore.getState().project.setups[0]
  const chamfer = setup.operations.find(o => o.type === 'chamfer')!
  await useCamStore.getState().computeOperationToolpath(setup.id, chamfer.id)
  const after = useCamStore.getState().project.setups[0].operations.find(o => o.id === chamfer.id)!
  const plan = after.resolvedHeightPlan?.version === 2 ? after.resolvedHeightPlan : undefined
  const moves = (after.toolpathMoves ?? []).map(m => ({ ...m, ...toWork(m, setup.wcs) }))
  const cuts = moves.filter(m => m.type !== 'rapid').map(m => m.z)
  return {
    ...reading,
    status: after.status, errorMessage: after.errorMessage, moves, plan,
    deepestCutZ: cuts.length ? Math.min(...cuts) : NaN,
    heightsRow: { ...reading.heightsRow, top: plan?.machining.materialStart.wcsMm, bottom: plan?.machining.cutterCenterEnd?.wcsMm },
  }
}

/** The chamfer exactly as a new dialog saves it with nothing chosen. */
async function runDialogDefault(scenario: HeightScenario): Promise<HeightReading> {
  const reading = await runHeightScenario(scenario)
  const setup = useCamStore.getState().project.setups[0]
  const chamfer = setup.operations.find(o => o.type === 'chamfer')!
  useCamStore.getState().updateOperation(setup.id, chamfer.id, {
    smartHeight: withDatumOwner(chamfer.smartHeight, { kind: 'operation_policy' }),
  })
  return regenerateChamfer(reading)
}

describe('WO-3188 Chamfer on a DXF outline: the default runs along the top edge', () => {
  it('the dialog default (no datum chosen) starts at the stock top, not the sketch plane at the stock bottom', async () => {
    const reading = await runDialogDefault(onTable('chamfer'))
    expect(reading.status, reading.errorMessage).toBe('ready')
    expect(reading.stockBottomWcs).toBeCloseTo(STOCK_BOTTOM, 6)
    expect(reading.heightsRow.top, 'chamfer Top').toBeCloseTo(STOCK_TOP, 3)
    expect(reading.heightsRow.bottom, 'chamfer Bottom').toBeCloseTo(STOCK_TOP - WIDTH, 3)
    expect(reading.deepestCutZ, 'emitted cut Z').toBeCloseTo(STOCK_TOP - WIDTH, 3)
  })
})

describe('WO-3188 Heights choices move the emitted Z by exactly the chosen amount', () => {
  const chamferCases: Array<[string, 'stock_top' | 'stock_bottom', number, number]> = [
    ['stock top', 'stock_top', 0, STOCK_TOP],
    ['stock bottom', 'stock_bottom', 0, STOCK_BOTTOM],
    ['stock top - 3', 'stock_top', -3, STOCK_TOP - 3],
    ['stock bottom + 4', 'stock_bottom', 4, STOCK_BOTTOM + 4],
  ]
  for (const [label, datumReference, datumOffsetMm, top] of chamferCases) {
    it(`Chamfer: ${label} -> Top ${top}, cut at ${top - WIDTH}`, async () => {
      const reading = await runHeightScenario(onTable('chamfer', { datumFormula: { datumReference, datumOffsetMm } }))
      expect(reading.status, reading.errorMessage).toBe('ready')
      expect(reading.heightsRow.top).toBeCloseTo(top, 3)
      expect(reading.deepestCutZ).toBeCloseTo(top - WIDTH, 3)
    })
  }

  const floorCases: Array<[string, 'stock_top' | 'stock_bottom', number, number]> = [
    ['stock top - 4', 'stock_top', -4, -4],
    ['stock bottom', 'stock_bottom', 0, STOCK_BOTTOM],
    ['stock bottom + 5', 'stock_bottom', 5, STOCK_BOTTOM + 5],
  ]
  for (const op of ['contour_2d', 'pocket_2d'] as const) {
    for (const [label, reference, offsetMm, floor] of floorCases) {
      it(`${op}: Bottom at ${label} -> deepest cut ${floor}`, async () => {
        const reading = await runHeightScenario(onTable(op, {
          loopIds: [op === 'pocket_2d' ? 'ring' : 'outline'],
          bottomRow: { reference, offsetMm },
        }))
        expect(reading.status, reading.errorMessage).toBe('ready')
        expect(reading.heightsRow.bottom).toBeCloseTo(floor, 3)
        expect(reading.deepestCutZ).toBeCloseTo(floor, 3)
      })
    }
  }

  it('contour_2d: Top at stock top - 2 starts the cut there', async () => {
    const reading = await runHeightScenario(onTable('contour_2d', {
      topRow: { reference: 'stock_top', offsetMm: -2 },
      bottomRow: { reference: 'stock_top', offsetMm: -6 },
    }))
    expect(reading.status, reading.errorMessage).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-2, 3)
    expect(reading.highestCuttingZ).toBeLessThanOrEqual(-2 + 1e-6)
    expect(reading.deepestCutZ).toBeCloseTo(-6, 3)
  })
})

describe('WO-3188 inventory: the other 2D ops follow the Heights choice too', () => {
  // Fix round 3 (astra PROOF-MISSING): each case reads the EMITTED moves of
  // the production compute (the moves the post writes, in WCS), not only the
  // Heights row. Two choices per op - one off the stock top, one off the
  // stock bottom - and the emitted Z must land on each plane and move by
  // exactly the difference between them.
  const highestFeedZ = (reading: HeightReading) => Math.max(...reading.moves.filter(m => m.type !== 'rapid').map(m => m.z))

  // Bottom-row ops: the deepest emitted cut is exactly the chosen Bottom; the
  // Top stays the stock top, so no feed move starts above it.
  const bottomOps: Array<[HeightScenario['operation'], string]> = [
    ['adaptive_clearing_2d', 'ring'], ['drill', 'hole'], ['bore', 'hole'], ['face', 'outline'],
  ]
  const bottomChoices = [['stock_top', -3, -3], ['stock_bottom', 4, STOCK_BOTTOM + 4]] as const
  for (const [op, loop] of bottomOps) {
    it(`${op}: Bottom at stock top -3 cuts to -3, at stock bottom +4 cuts to ${STOCK_BOTTOM + 4}`, async () => {
      const deepest: number[] = []
      for (const [reference, offsetMm, floor] of bottomChoices) {
        const reading = await runHeightScenario(onTable(op, { loopIds: [loop], bottomRow: { reference, offsetMm } }))
        const label = `${op} ${reference} ${offsetMm}`
        expect(reading.status, reading.errorMessage ?? reading.authoringError).toBe('ready')
        expect(reading.heightsRow.bottom, `${label} Bottom row`).toBeCloseTo(floor, 3)
        expect(reading.moves.length, `${label} moves`).toBeGreaterThan(0)
        expect(reading.deepestCutZ, `${label} emitted deepest cut Z`).toBeCloseTo(floor, 3)
        expect(reading.heightsRow.top, `${label} Top row`).toBeCloseTo(STOCK_TOP, 3)
        expect(reading.highestCuttingZ, `${label} emitted cutting Z under the Top`).toBeLessThanOrEqual(STOCK_TOP + 1e-6)
        deepest.push(reading.deepestCutZ)
      }
      expect(deepest[1] - deepest[0], `${op} emitted Z moved by the choice`).toBeCloseTo(bottomChoices[1][2] - bottomChoices[0][2], 3)
    })
  }

  // Datum ops: the datum is the Top; the emitted cut is the datum less the
  // op's own depth (engrave depth, V-carve flat depth, thread depth).
  const datumOps: Array<[HeightScenario['operation'], string, number]> = [
    ['engrave', 'ring', 1.5], ['vcarve', 'ring', 2], ['thread_mill', 'hole', 6],
  ]
  const datumChoices = [['stock_top', -2, -2], ['stock_bottom', 6, STOCK_BOTTOM + 6]] as const
  for (const [op, loop, depthMm] of datumOps) {
    it(`${op}: datum at stock top -2 and at stock bottom +6 -> emitted Top there, cut ${depthMm} under it`, async () => {
      const deepest: number[] = []
      for (const [datumReference, datumOffsetMm, top] of datumChoices) {
        const reading = await runHeightScenario(onTable(op, {
          loopIds: [loop], datumFormula: { datumReference, datumOffsetMm, depthMm },
        }))
        const label = `${op} ${datumReference} ${datumOffsetMm}`
        expect(reading.status, reading.errorMessage ?? reading.authoringError).toBe('ready')
        expect(reading.heightsRow.top, `${label} Top row`).toBeCloseTo(top, 3)
        expect(reading.moves.length, `${label} moves`).toBeGreaterThan(0)
        expect(reading.deepestCutZ, `${label} emitted deepest cut Z`).toBeCloseTo(top - depthMm, 3)
        expect(highestFeedZ(reading), `${label} no feed move above the datum`).toBeLessThanOrEqual(top + 1e-6)
        deepest.push(reading.deepestCutZ)
      }
      expect(deepest[1] - deepest[0], `${op} emitted Z moved by the choice`).toBeCloseTo(datumChoices[1][2] - datumChoices[0][2], 3)
    })
  }
})

describe('WO-3188 Chamfer default follows the material earlier operations left', () => {
  it('a ring inside a 4 mm pocket is chamfered on the pocket floor edge, the outline on the stock top', async () => {
    // The chamfer of the inner ring, alone, after a pocket that cleared the
    // whole outline 4 mm deep: the material at the ring is the pocket floor.
    const reading = await runDialogDefault(onTable('chamfer', { loopIds: ['ring'] }))
    expect(reading.status, reading.errorMessage).toBe('ready')
    expect(reading.heightsRow.top, 'no earlier op: the stock top').toBeCloseTo(STOCK_TOP, 3)

    const state = useCamStore.getState()
    const setup = state.project.setups[0]
    const chamfer = setup.operations[0]
    const pocketParams = {
      geometryId: 'part-1', loopIds: ['outline'], stepover: 3, heightReference: 'absolute', planeOffset: 0,
      direction: 'climb',
    }
    const heights = {
      clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 3,
      topHeight: 0, topHeightMode: 'absolute', bottomHeight: -4, bottomHeightMode: 'absolute',
    }
    useCamStore.getState().addTool({
      id: 'tool-em', name: 'EM6 flat', type: 'flat_end_mill', diameter: 6, fluteLength: 30, shankDiameter: 6,
      overallLength: 60, numberOfFlutes: 2, material: 'carbide', coating: 'none', toolNumber: 2,
    } as unknown as Tool)
    const pocket = {
      id: 'op-pocket', name: 'Pocket', type: 'pocket_2d', enabled: true, status: 'pending', toolId: 'tool-em',
      geometrySelections: [], heights, params: pocketParams,
      passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
      linking: chamfer.linking,
      smartHeight: smartHeightAuthorityFixture('pocket_2d', {
        setupId: setup.id, heights: heights as never, params: pocketParams, geometryIds: ['part-1'],
        explicitDepthMm: 4,
      }),
    } as unknown as Operation
    useCamStore.setState(s => ({
      project: {
        ...s.project,
        setups: s.project.setups.map(candidate => candidate.id === setup.id
          ? { ...candidate, operations: [pocket, ...candidate.operations] }
          : candidate),
      },
    }))
    await useCamStore.getState().computeOperationToolpath(setup.id, 'op-pocket')
    const pocketDone = useCamStore.getState().project.setups[0].operations.find(o => o.id === 'op-pocket')!
    expect(pocketDone.status, pocketDone.errorMessage).toBe('ready')

    await useCamStore.getState().computeOperationToolpath(setup.id, chamfer.id)
    const after = useCamStore.getState().project.setups[0].operations.find(o => o.id === chamfer.id)!
    expect(after.status, after.errorMessage).toBe('ready')
    const plan = after.resolvedHeightPlan?.version === 2 ? after.resolvedHeightPlan : undefined
    expect(plan?.machining.materialStart.wcsMm, 'the ring sits on the pocket floor').toBeCloseTo(-4, 3)
    const wz = setup.wcs.origin.z
    const cuts = (after.toolpathMoves ?? []).filter((m: ToolpathMove) => m.type !== 'rapid')
    expect(Math.min(...cuts.map(m => m.z)) - wz, 'cut one width under the floor').toBeCloseTo(-4 - WIDTH, 3)
  })
})

// WO-3188 audit F1 (astra 2026-10-28): an explicitly selected or saved
// Reference plane = Geometry keeps its sketch-plane datum, at + 0 as at any
// offset. Only a datum nobody chose moves to the material top.
describe('WO-3188 a chosen Geometry datum stays on the sketch plane', () => {
  // A sketch raised to mid-stock: stock machine Z 0..12, sketch at 6, WCS zero
  // on the stock top, so the sketch plane is WCS -6.
  const raised = (extra: Partial<HeightScenario> = {}): HeightScenario => ({
    part: { kind: 'sketch_2d', loops: [OUTLINE, RING, HOLE], z: 6 },
    stock: { kind: 'auto', offsetXY: 5, offsetZTop: 6, offsetZBottom: 6 },
    operation: 'chamfer', loopIds: ['outline'], ...extra,
  })

  it('Geometry + 0 chosen: Top on the sketch plane, cut one width under it', async () => {
    const reading = await runHeightScenario(raised())
    expect(reading.status, reading.errorMessage).toBe('ready')
    expect(reading.stockTopWcs).toBeCloseTo(0, 6)
    expect(reading.heightsRow.top, 'chamfer Top').toBeCloseTo(-6, 3)
    expect(reading.deepestCutZ, 'emitted cut Z').toBeCloseTo(-6 - WIDTH, 3)
  })

  it('Geometry + 0 chosen survives save, reload and regenerate', async () => {
    const first = await runHeightScenario(raised())
    expect(first.heightsRow.top).toBeCloseTo(-6, 3)
    const tools = useCamStore.getState().toolLibrary
    vi.stubGlobal('alert', vi.fn())
    await useCamStore.getState().loadProjectFromFile(JSON.stringify(useCamStore.getState().project))
    for (const tool of tools) {
      if (!useCamStore.getState().toolLibrary.some(t => t.id === tool.id)) useCamStore.getState().addTool(tool)
    }
    const loaded = useCamStore.getState().project.setups[0].operations.find(o => o.type === 'chamfer')!
    const end = (loaded.smartHeight as { intent: OperationHeightIntentV2 }).intent.machining.end.value
    expect(end.kind === 'geometry_tool_formula' && end.formula.kind === 'chamfer_edge' && end.formula.datumPlane)
      .toMatchObject({ reference: 'geometry_plane', offsetMm: 0, owner: { kind: 'user_override' } })
    const reading = await regenerateChamfer(first)
    expect(reading.status, reading.errorMessage).toBe('ready')
    expect(reading.heightsRow.top, 'chamfer Top after reload').toBeCloseTo(-6, 3)
    expect(reading.deepestCutZ, 'emitted cut Z after reload').toBeCloseTo(-6 - WIDTH, 3)
  })

  it('Geometry + 0.1 chosen sits 0.1 above + 0 (no jump between the two)', async () => {
    const reading = await runHeightScenario(raised({ datumFormula: { datumReference: 'geometry_plane', datumOffsetMm: 0.1 } }))
    expect(reading.status, reading.errorMessage).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-5.9, 3)
  })

  it('the same raised outline with no datum chosen starts at the stock top', async () => {
    const reading = await runDialogDefault(raised())
    expect(reading.status, reading.errorMessage).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(0, 3)
    expect(reading.deepestCutZ).toBeCloseTo(-WIDTH, 3)
  })
})

describe('WO-3188 only a heightless outline is assumed', () => {
  const base = {
    id: 'g', name: 'g', filename: 'g.dxf', type: 'curves_2d', format: 'dxf',
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{ id: 'l', closed: true, type: 'contour', layerId: 'L', points: [], area: 1 }],
    layers2d: [{ id: 'L', name: 'L', color: '#fff', visible: true }],
  } as unknown as ImportedGeometry

  it('a plain DXF, SVG or sketch outline is assumed; a projected layer, a projection plane or an STL is not', () => {
    expect(geometryLoopPlane(base, ['l']).assumed).toBe(true)
    expect(geometryLoopPlane({ ...base, format: 'svg' }, ['l']).assumed).toBe(true)
    expect(geometryLoopPlane({ ...base, format: 'sketch' }, ['l']).assumed).toBe(true)
    expect(geometryLoopPlane({ ...base, format: 'stl' }, ['l']).assumed).toBe(false)
    const projectedLayer = {
      ...base,
      layers2d: [{ id: 'L', name: 'L', color: '#fff', visible: true,
        projectionPlane: { origin: { x: 0, y: 0, z: 7 }, normal: { x: 0, y: 0, z: 1 } } }],
    } as unknown as ImportedGeometry
    expect(geometryLoopPlane(projectedLayer, ['l'])).toEqual({ worldZ: 7, assumed: false })
    const projectedRow = {
      ...base, projectionPlane: { origin: { x: 0, y: 0, z: 9 }, normal: { x: 0, y: 0, z: 1 } },
    } as unknown as ImportedGeometry
    expect(geometryLoopPlane(projectedRow, ['l'])).toEqual({ worldZ: 9, assumed: false })
    expect(sourcesAreHeightlessOutlines([base, projectedRow], ['l'])).toBe(false)
    expect(sourcesAreHeightlessOutlines([], [])).toBe(false)
  })
})

// Side-view evidence (WRITE_EVIDENCE=1 only). WO3188_PHASE=before is run with
// the store source of the branch base checked out, =after with this branch.
describe('WO-3188 evidence: side view of the DXF chamfer', () => {
  it('draws the default chamfer on the DXF outline, section at Y 20', async () => {
    const reading = await runDialogDefault(onTable('chamfer'))
    expect(reading.status, reading.errorMessage).toBe('ready')
    const phase = process.env.WO3188_PHASE === 'before' ? 'before' : 'after'
    const SECTION_Y = 20
    const path: PathPoint[] = []
    const moves = reading.moves
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1]
      const b = moves[i]
      if (b.type === 'rapid') continue
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.25))
      for (let k = 0; k <= n; k++) {
        const t = k / n
        const y = a.y + (b.y - a.y) * t
        if (Math.abs(y - SECTION_Y - (reading.stockXY.minY + 5)) > 1.5) continue
        path.push({ x: a.x + (b.x - a.x) * t, y: SECTION_Y, z: a.z + (b.z - a.z) * t, kind: 'cut' })
      }
    }
    const tool = useCamStore.getState().toolLibrary.find(t => t.id === 'tool-1')!
    const holder = { id: 'h', name: 'collet', segments: [{ height: 20, lowerDiameter: 16, upperDiameter: 16 }] }
    const edgeX = reading.stockXY.minX + 5
    writeSideView({
      dir: 'src/tests/evidence/WO-3188',
      name: `${phase}-dxf-chamfer-side-view`,
      title: phase === 'before'
        ? 'BEFORE (branch base) - the DXF chamfer runs on the sketch plane at the stock bottom'
        : 'AFTER (WO-3188) - the DXF chamfer runs along the top edge',
      subtitle: `60 x 40 mm DXF outline on the table, auto stock 12 mm, 90 deg chamfer mill, default Heights. Section at the part's mid Y, looking from -Y. WCS Z.`,
      obstacles: [obstacleFromBox(
        [reading.stockXY.minX, reading.stockXY.minY, reading.stockBottomWcs, reading.stockXY.maxX, reading.stockXY.maxY, reading.stockTopWcs],
        'stock', '#c0392b',
      )],
      path,
      bands: toolBands({ ...tool, lengthBelowHolder: 30 } as Tool, holder),
      placements: [{ x: edgeX, tipZ: reading.deepestCutZ }],
      referenceLines: [
        { z: reading.stockTopWcs, label: 'stock top (WCS Z 0)' },
        { z: reading.stockBottomWcs, label: 'stock bottom = DXF sketch plane (WCS Z -12)' },
      ],
      captions: [
        'red = stock - blue = chamfer cutting moves at the section - tool drawn at the cut depth on the left edge',
        `Heights tab: Top ${reading.heightsRow.top?.toFixed(3)}, Bottom ${reading.heightsRow.bottom?.toFixed(3)} (WCS)`,
        `Deepest emitted cut Z ${reading.deepestCutZ.toFixed(3)}`,
      ],
    })
  })
})
