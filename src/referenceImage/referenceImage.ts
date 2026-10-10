import type { Command, DagNodeInput } from '../doc'
import type { PlaneFrame } from '../sketch3d/planeMath'

/** Display-only datum. Its plane dependency follows face edits without producing geometry. */
export interface ReferenceImagePayload extends Record<string, unknown> {
  datumType: 'reference-image'
  name: string
  planeNodeId: string
  image: { dataUrl: string; fileName: string; widthPx: number; heightPx: number }
  widthMm: number
  heightMm: number
  opacity: number
  /** Plane-local center; absent in older documents means the plane origin. */
  center?: { x: number; y: number }
  angleDeg?: number
  flipHorizontal?: boolean
  flipVertical?: boolean
  scaleLocked?: boolean
}

export function isReferenceImagePayload(payload: Record<string, unknown>): payload is ReferenceImagePayload {
  return payload.datumType === 'reference-image'
}

export function referenceImageInput(id: string, payload: ReferenceImagePayload): DagNodeInput {
  return { id, kind: 'datum', consumes: [payload.planeNodeId], refs: [], payload }
}

export function referenceImageFrame(dag: { getNode(id: string): { payload: Record<string, unknown> } | undefined }, payload: ReferenceImagePayload): PlaneFrame | undefined {
  return dag.getNode(payload.planeNodeId)?.payload.lastGoodFrame as PlaneFrame | undefined
}

/** A sketch cancellation restores sketch history, but independent picture edits remain undoable. */
export function isReferenceImageCommand(command: Command): boolean {
  const containsImage = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false
    const data = value as { id?: string; featureId?: string; input?: { id?: string }; commands?: unknown[] }
    const id = data.id ?? data.featureId ?? data.input?.id
    return id?.startsWith('reference-image:') === true || data.commands?.some(containsImage) === true
  }
  return containsImage(command.serialize())
}

/** Project-owned 2D underlay: it survives empty-sketch cleanup and has no CAM geometry. */
export interface ReferenceImage2d {
  id: string
  payload: ReferenceImagePayload
  hidden?: boolean
}
export const REFERENCE_IMAGE_2D_FRAME: PlaneFrame = {
  origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 },
}
