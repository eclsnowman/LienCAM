import * as THREE from 'three'
import { CNCViewport as BaseCNCViewport } from '../../lib/viewport/CNCViewport'
import type { BrepPickMode } from '../../lib/viewport/CNCViewport'
import type { ModelBodyDisplay } from '../../types'
import { buildEdgeLineGeometry } from '../../viewport3d/tessGeometry'

export interface ViewportBrepSelection {
  geoId: string
  kind: 'face' | 'edge'
  index: number
  surfaceType?: number
  isModelFace?: boolean
  isModelEdge?: boolean
}

interface ViewportInternals {
  partGroups: Map<string, THREE.Group>
}

function validEdgeTable(display: ModelBodyDisplay): display is ModelBodyDisplay & { edgeIds: string[] } {
  const { edgeIds, edgeOffsets, edgePositions } = display
  if (!edgeIds || edgeIds.length === 0 || edgeOffsets.length !== edgeIds.length + 1) return false
  if (edgeOffsets[0] !== 0 || edgeOffsets[edgeOffsets.length - 1] > edgePositions.length / 3) return false
  return edgeOffsets.every((offset, index) => index === 0 || offset >= edgeOffsets[index - 1])
}

/**
 * Translate a modeled body's durable CSR edge table into the exact metadata
 * contract consumed by CNCViewport's existing B-rep edge raycaster. The
 * invisible native-line twin is pick-only; the engine's normal modeled-body
 * edge overlay remains the sole visual presentation.
 */
export function createModelEdgePickObject(display: ModelBodyDisplay, geoId: string): THREE.LineSegments | null {
  if (!validEdgeTable(display)) return null

  const edgeGeometry = buildEdgeLineGeometry({
    edgePositions: new Float32Array(display.edgePositions),
    edgeOffsets: new Uint32Array(display.edgeOffsets),
    edgeIds: display.edgeIds,
  })
  const edgeSegStarts = new Uint32Array(display.edgeIds.length + 1)
  const edgeRanges = new Uint32Array(display.edgeIds.length * 2)
  let segment = 0
  for (let edgeIndex = 0; edgeIndex < display.edgeIds.length; edgeIndex++) {
    const start = display.edgeOffsets[edgeIndex]
    const end = display.edgeOffsets[edgeIndex + 1]
    edgeSegStarts[edgeIndex] = segment
    edgeRanges[edgeIndex * 2] = start
    edgeRanges[edgeIndex * 2 + 1] = end - start
    segment += Math.max(0, end - start - 1)
  }
  edgeSegStarts[display.edgeIds.length] = segment

  edgeGeometry.userData.edgeIds = [...display.edgeIds]
  edgeGeometry.userData.edgeSegStarts = edgeSegStarts
  edgeGeometry.userData.edgeRanges = edgeRanges
  edgeGeometry.userData.edgePositions = new Float32Array(display.edgePositions)

  const pickLines = new THREE.LineSegments(
    edgeGeometry,
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0 }),
  )
  pickLines.visible = false
  pickLines.userData.isBrepEdges = true
  pickLines.userData.isModelEdges = true
  pickLines.userData.brepGeoId = geoId
  return pickLines
}

/**
 * The production CAM viewport adapter. It feeds modeled-body edges through the
 * engine's one existing edge-pick pool and annotates the public callback so CAM
 * callers can resolve the returned array index through ModelBodyDisplay.edgeIds.
 */
export class CNCViewport extends BaseCNCViewport {
  supportsModelEdgePick(): boolean {
    return true
  }

  override addModelBody(
    id: string,
    display: ModelBodyDisplay,
    name: string,
    position = { x: 0, y: 0, z: 0 },
    rotation = { x: 0, y: 0, z: 0 },
    color?: string,
  ): void {
    super.addModelBody(id, display, name, position, rotation, color)
    const pickObject = createModelEdgePickObject(display, id)
    if (pickObject === null) return

    const group = (this as unknown as ViewportInternals).partGroups.get(id)
    const mesh = group?.children.find(
      (child) => child instanceof THREE.Mesh && child.userData.isModelBodyMesh === true,
    )
    mesh?.add(pickObject)
  }

  override setBrepPickMode(
    kind: BrepPickMode | null,
    callback?: ((selection: ViewportBrepSelection, nowSelected: boolean) => void) | null,
    allowedGeoId: string | null = null,
  ): void {
    const wrappedCallback = callback == null
      ? callback
      : (selection: ViewportBrepSelection, nowSelected: boolean) => {
          const modelEdge = selection.kind === 'edge' && this.hasModelEdgePickObject(selection.geoId)
          callback(modelEdge ? { ...selection, isModelEdge: true } : selection, nowSelected)
        }
    super.setBrepPickMode(kind, wrappedCallback, allowedGeoId)
  }

  private hasModelEdgePickObject(geoId: string): boolean {
    const group = (this as unknown as ViewportInternals).partGroups.get(geoId)
    let found = false
    group?.traverse((child) => {
      if (child instanceof THREE.LineSegments && child.userData.isModelEdges === true) found = true
    })
    return found
  }
}
