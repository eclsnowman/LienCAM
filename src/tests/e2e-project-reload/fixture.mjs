import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const PROJECT_ID = 'wo243-step-reload-project'
export const GEOMETRY_ID = 'wo243-step-body'
export const OPERATION_ID = 'wo243-adaptive-operation'

const SOURCE_STEP = path.resolve(import.meta.dirname, '../geom/fixtures/no-attributes.step')

const base64 = (view) => Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64')

function cubeDisplay(sourceSha256) {
  const positions = new Float32Array([
    -10, -10, 0, 10, -10, 0, 10, 10, 0, -10, 10, 0,
    -10, -10, 10, 10, -10, 10, 10, 10, 10, -10, 10, 10,
  ])
  const normals = new Float32Array([
    -0.577, -0.577, -0.577, 0.577, -0.577, -0.577,
    0.577, 0.577, -0.577, -0.577, 0.577, -0.577,
    -0.577, -0.577, 0.577, 0.577, -0.577, 0.577,
    0.577, 0.577, 0.577, -0.577, 0.577, 0.577,
  ])
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ])
  const edgePairs = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ]
  const edgePositions = new Float32Array(edgePairs.flatMap(([a, b]) => [
    positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
    positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2],
  ]))
  const edgeRanges = new Uint32Array(edgePairs.flatMap((_, index) => [index * 2, 2]))
  return {
    version: 1,
    encoding: 'base64-le',
    displayContractVersion: 1,
    sourceSha256,
    tessellation: { linearDeflection: 0.1, angularDeflection: 0.25 },
    faceCount: 1,
    edgeCount: edgePairs.length,
    solidCount: 1,
    bbox: { min: [-10, -10, 0], max: [10, 10, 10] },
    mesh: {
      positions: base64(positions),
      normals: base64(normals),
      indices: base64(indices),
      faceRanges: base64(new Uint32Array([0, indices.length])),
      ao: base64(new Float32Array(positions.length / 3).fill(1)),
    },
    edges: { positions: base64(edgePositions), edgeRanges: base64(edgeRanges) },
    faceTypes: base64(new Uint8Array([0])),
    aoVersion: 1,
  }
}

export async function makeReloadFixture(baseProject) {
  const step = await readFile(SOURCE_STEP)
  const sourceSha256 = createHash('sha256').update(step).digest('hex')
  const geometry = {
    id: GEOMETRY_ID,
    name: 'WO-243 STEP Block',
    filename: 'wo243-step-block.step',
    type: 'brep',
    format: 'step',
    boundingBox: {
      min: { x: -10, y: -10, z: 0 },
      max: { x: 10, y: 10, z: 10 },
      size: { x: 20, y: 20, z: 10 },
      center: { x: 0, y: 0, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    hidden: false,
  }
  const setup = {
    id: 'wo243-setup',
    name: 'WO-243 Setup',
    wcs: {
      id: 'wo243-g54', label: 'G54', fixtureOffset: 54,
      origin: { x: -15, y: -15, z: 15 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 5, offsetZBottom: 0, material: 'wood' },
    fixtureStack: [],
    supportPlane: { mode: 'machine_table', offset: 0 },
    operations: [{
      id: OPERATION_ID,
      name: 'WO-243 Adaptive',
      type: 'adaptive_3d',
      enabled: true,
      status: 'ready',
      toolId: null,
      geometrySelections: [GEOMETRY_ID],
      heights: { clearanceHeight: 15, retractHeight: 5, feedHeight: 2, topHeight: 0, bottomHeight: -5 },
      passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
      linking: { entryType: 'ramp_linear', rampAngle: 3, rampLength: 10, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
      feedrateOverride: { enabled: false },
      params: { maxStepdown: 2, stepover: 0.4, tolerance: 0.1, helixDiameter: 3, helixAngleDeg: 10, radialStockToLeave: 0, axialStockToLeave: 0, cellSize: 1, useStockBoundary: false, sideEntry: false },
      toolpathMoves: [
        { type: 'rapid', role: 'rapid', x: -5, y: -5, z: 15 },
        { type: 'feed', role: 'plunge', x: -5, y: -5, z: 5, feed: 300 },
        { type: 'feed', role: 'cut', x: 5, y: 5, z: 5, feed: 1000 },
      ],
    }],
    notes: '',
  }
  return {
    ...baseProject,
    id: PROJECT_ID,
    name: 'WO-243 Reload Fixture',
    geometry: [geometry],
    setups: [setup],
    activeSetupId: setup.id,
    activeOperationId: OPERATION_ID,
    binaries: {
      [GEOMETRY_ID]: {
        step: step.toString('base64'),
        stepDisplay: cubeDisplay(sourceSha256),
      },
    },
  }
}
