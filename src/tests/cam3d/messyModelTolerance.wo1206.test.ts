import * as fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { resolveAdaptive3dPartSource } from '../../cam3d/integration/adaptive3dPartSource'
import {
  computeAdaptive3dMoves,
  DEFAULT_ADAPTIVE3D_PARAMS,
} from '../../cam3d/integration/adaptive3dOperation'
import { sanitizeTriangleMesh } from '../../cam3d/input/sanitize'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import type { PartMesh } from '../../cam3d/kernel/types'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import { decodeBrepModelPayload } from '../../lib/projectBinaries'
import type { ImportedGeometry, ModelItemPlacementRecord, Tool } from '../../types'

const CUBE_POSITIONS = new Float32Array([
  0, 0, 0,
  10, 0, 0,
  10, 10, 0,
  0, 10, 0,
  0, 0, 10,
  10, 0, 10,
  10, 10, 10,
  0, 10, 10,
])

const CUBE_INDICES = new Uint32Array([
  0, 2, 1, 0, 3, 2,
  4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4,
  1, 2, 6, 1, 6, 5,
  2, 3, 7, 2, 7, 6,
  3, 0, 4, 3, 4, 7,
])

const PLACEMENT: ModelItemPlacementRecord = {
  modelItemId: 'item-1',
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
}

function modeledGeometry(mesh: PartMesh, name = 'Messy Widget'): ImportedGeometry {
  return {
    id: 'modelbody:body-1',
    name,
    filename: '',
    type: 'model',
    format: 'model',
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: mesh.bounds.min[0], y: mesh.bounds.min[1], z: mesh.bounds.min[2] },
      max: { x: mesh.bounds.max[0], y: mesh.bounds.max[1], z: mesh.bounds.max[2] },
      size: {
        x: mesh.bounds.max[0] - mesh.bounds.min[0],
        y: mesh.bounds.max[1] - mesh.bounds.min[1],
        z: mesh.bounds.max[2] - mesh.bounds.min[2],
      },
      center: {
        x: (mesh.bounds.min[0] + mesh.bounds.max[0]) / 2,
        y: (mesh.bounds.min[1] + mesh.bounds.max[1]) / 2,
        z: (mesh.bounds.min[2] + mesh.bounds.max[2]) / 2,
      },
    },
    modelItemId: 'item-1',
    modelBody: {
      ref: { bodyId: 'body-1', stableIds: [], version: 1 },
      display: {
        positions: Array.from(mesh.positions),
        normals: [],
        indices: Array.from(mesh.indices),
        edgePositions: [],
        edgeOffsets: [],
        bbox: { min: [...mesh.bounds.min], max: [...mesh.bounds.max] },
        ...(mesh.faceIds ? { triFace: Array.from(mesh.faceIds) } : {}),
      },
    },
  }
}

function repairableCube(): PartMesh {
  return {
    positions: new Float32Array([...CUBE_POSITIONS, 5, 0, 0]),
    // Split front triangle (0,1,5) at the T-vertex while the bottom face keeps
    // edge (0,1) whole. The final collinear cap closes all three seam edges.
    indices: new Uint32Array([
      ...CUBE_INDICES.slice(0, 12),
      0, 8, 5,
      8, 1, 5,
      ...CUBE_INDICES.slice(15),
      0, 8, 1,
    ]),
    faceIds: new Uint32Array([...Array.from({ length: 13 }, (_, i) => i), 99]),
    bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    source: 'step',
  }
}

function cleanCube(): PartMesh {
  return {
    positions: CUBE_POSITIONS,
    indices: CUBE_INDICES,
    bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    source: 'step',
  }
}

function openRepairableCube(): PartMesh {
  const mesh = repairableCube()
  return {
    ...mesh,
    // Punch out the separate final cube-face triangle while retaining the cap.
    indices: new Uint32Array([...mesh.indices.slice(0, -6), ...mesh.indices.slice(-3)]),
    faceIds: undefined,
  }
}

function bytes(view: ArrayBufferView): number[] {
  return Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
}

function makeClient(): Cam3dClient {
  const kernel = new BvhKernel()
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest)
    },
    terminate(): void {},
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    worker.onmessage?.({ data: message } as MessageEvent)
  })
  return new Cam3dClient(worker)
}

const TOOL = {
  id: 'tool-1',
  name: 'Flat 6mm',
  type: 'flat_end_mill',
  diameter: 6,
  fluteLength: 20,
  shankDiameter: 6,
  overallLength: 50,
  numberOfFlutes: 2,
} as Tool

async function computeCleanFixture(mesh: PartMesh) {
  const client = makeClient()
  try {
    const stockBounds = {
      minX: mesh.bounds.min[0] - 2,
      minY: mesh.bounds.min[1] - 2,
      minZ: mesh.bounds.min[2],
      maxX: mesh.bounds.max[0] + 2,
      maxY: mesh.bounds.max[1] + 2,
      maxZ: mesh.bounds.max[2] + 2,
    }
    return await computeAdaptive3dMoves({
      partMesh: mesh,
      tool: TOOL,
      params: {
        ...DEFAULT_ADAPTIVE3D_PARAMS,
        maxStepdown: 4,
        tolerance: 0.2,
        cellSize: 1,
        useStockBoundary: true,
      },
      stockBounds,
      stockBoundsAreRealStock: true,
      resolvedHeights: {
        clearanceZ: stockBounds.maxZ + 10,
        retractZ: stockBounds.maxZ + 2,
        feedZ: stockBounds.maxZ + 2,
        topZ: stockBounds.maxZ,
        bottomZ: mesh.bounds.min[2],
      },
      client,
    })
  } finally {
    await client.dispose()
  }
}

describe('WO-1206 modeled-solid mesh tolerance', () => {
  it('uses the import sanitizer contract and repairs a closed solid in one console line', () => {
    const input = repairableCube()
    const imported = sanitizeTriangleMesh(input.positions, input.indices, input.faceIds)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let modeled: PartMesh | undefined
    expect(() => {
      modeled = resolveAdaptive3dPartSource(modeledGeometry(input), [PLACEMENT]).partMesh
    }).not.toThrow()

    expect(imported.watertightBeforeRepair).toBe(true)
    expect(imported.droppedDegenerateTriangles).toBe(1)
    expect(imported.watertight).toBe(false)
    expect(imported.boundaryEdges).toBe(3)
    expect(imported.oversharedEdges).toBe(0)
    expect(bytes(modeled!.positions)).toEqual(bytes(imported.positions))
    expect(bytes(modeled!.indices)).toEqual(bytes(imported.indices))
    expect(bytes(modeled!.faceIds!)).toEqual(bytes(imported.faceIds!))
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    expect(consoleWarn).toHaveBeenCalledWith(
      '[Adaptive 3D] Modeled solid "Messy Widget": dropped 1 degenerate triangle before machining.',
    )
    consoleWarn.mockRestore()
  })

  it('still refuses a punched-open solid with the repaired edge and drop counts', () => {
    const input = openRepairableCube()
    const repaired = sanitizeTriangleMesh(input.positions, input.indices)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(repaired.watertightBeforeRepair).toBe(false)
    expect(repaired.watertight).toBe(false)
    expect(repaired.boundaryEdges).toBe(6)
    expect(() => resolveAdaptive3dPartSource(modeledGeometry(input, 'Open Widget'), [PLACEMENT]))
      .toThrow(
        /Open Widget.*after dropping 1 degenerate triangle: 6 open edges and 0 edges shared by more than two triangles were found after repair/,
      )
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    consoleWarn.mockRestore()
  })

  it('drops a sub-micron welded sliver without counting its self-edge', () => {
    const input: PartMesh = {
      ...cleanCube(),
      positions: new Float32Array([...CUBE_POSITIONS, 0.0000004, 0, 0]),
      indices: new Uint32Array([...CUBE_INDICES, 0, 8, 1]),
    }

    const repaired = sanitizeTriangleMesh(input.positions, input.indices)

    expect(repaired.droppedDegenerateTriangles).toBe(1)
    expect(repaired.watertight).toBe(true)
    expect(repaired.boundaryEdges).toBe(0)
    expect(repaired.oversharedEdges).toBe(0)
  })

  it('keeps a clean mesh byte-identical and produces the same real toolpath', { timeout: 300_000 }, async () => {
    const input = cleanCube()
    const modeled = resolveAdaptive3dPartSource(modeledGeometry(input, 'Clean Widget'), [PLACEMENT]).partMesh

    expect(modeled.indices.length / 3).toBe(input.indices.length / 3)
    expect(bytes(modeled.positions)).toEqual(bytes(input.positions))
    expect(bytes(modeled.indices)).toEqual(bytes(input.indices))

    const before = await computeCleanFixture(input)
    const after = await computeCleanFixture(modeled)
    expect(before.moves.length).toBeGreaterThan(0)
    expect(after.moves).toEqual(before.moves)
  })

  const realProjectFile = process.env.EXAMPLE_PROBE_FILE
  it.skipIf(!realProjectFile)(
    "reports Operator's saved solid through both sanitizer entry paths",
    () => {
      const project = JSON.parse(fs.readFileSync(realProjectFile!, 'utf8')) as {
        geometry: Array<{ id: string; name: string }>
        binaries: Record<string, { stepDisplay?: unknown }>
      }
      const geometry = project.geometry[0]
      const decoded = decodeBrepModelPayload(project.binaries[geometry.id]?.stepDisplay)
      expect(decoded).not.toBeNull()
      const payload = decoded!.payload
      const imported = sanitizeTriangleMesh(payload.mesh.positions, payload.mesh.indices)
      const input: PartMesh = {
        positions: payload.mesh.positions,
        indices: payload.mesh.indices,
        bounds: payload.bbox,
        source: 'step',
      }
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const modeled = resolveAdaptive3dPartSource(
        modeledGeometry(input, geometry.name),
        [PLACEMENT],
      ).partMesh
      const operatorLine = consoleWarn.mock.calls.map((args) => String(args[0])).join('\n')
      consoleWarn.mockRestore()

      expect(payload.mesh.indices.length / 3).toBe(1431)
      expect(imported.droppedDegenerateTriangles).toBe(1)
      expect(imported.watertightBeforeRepair).toBe(false)
      expect(imported.watertight).toBe(true)
      expect(modeled.indices.length).toBe(imported.indices.length)
      expect(bytes(modeled.indices)).toEqual(bytes(imported.indices))
      expect(operatorLine).toBe(
        `[Adaptive 3D] Modeled solid "${geometry.name}": dropped 1 degenerate triangle before machining.`,
      )
      console.warn(
        `[WO-1206 evidence] triangles in=1431 dropped=1 ` +
          `watertight before=false after=true; ${operatorLine}`,
      )
    },
  )
})
