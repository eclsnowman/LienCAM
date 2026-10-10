import { isStockCuttingRole } from '../cam/stockCuttingRoles'
import type { OperationType, ToolpathMove } from '../../types'

export interface LayerPreviewFrame {
  fromX: number
  fromY: number
  fromZ: number
  toX: number
  toY: number
  toZ: number
  role: string
}

export interface LayerPreviewSection {
  startFrame: number
  endFrame: number
  operationType: OperationType
}

export interface ToolpathLayerPreviewPlan {
  frameToLayer: Int32Array
  layers: ToolpathMove[][]
}

const Z_EPSILON = 1e-4

const LAYERED_OPERATION_TYPES = new Set<OperationType>([
  'face',
  'contour_2d',
  'pocket_2d',
  'adaptive_clearing_2d',
  'waterline_3d',
  'adaptive_3d',
])

function frameMove(frame: LayerPreviewFrame, atStart: boolean): ToolpathMove {
  const role = frame.role as ToolpathMove['role']
  return {
    type: frame.role === 'rapid' ? 'rapid' : 'feed',
    x: atStart ? frame.fromX : frame.toX,
    y: atStart ? frame.fromY : frame.toY,
    z: atStart ? frame.fromZ : frame.toZ,
    role,
  }
}

/**
 * Build complete per-Z-layer toolpath previews for operations whose motion is
 * naturally organized into planar stepdowns. Frames before a stable cut are
 * assigned to the upcoming layer, so the old layer disappears as soon as the
 * tool begins its descent. Unsupported/non-layered operations retain the full
 * normal toolpath by mapping their frames to -1.
 */
export function buildToolpathLayerPreviewPlan(
  frames: LayerPreviewFrame[],
  sections: LayerPreviewSection[],
): ToolpathLayerPreviewPlan {
  const frameToLayer = new Int32Array(frames.length)
  frameToLayer.fill(-1)
  const layers: ToolpathMove[][] = []

  for (const section of sections) {
    if (!LAYERED_OPERATION_TYPES.has(section.operationType)) continue
    const start = Math.max(0, section.startFrame)
    const end = Math.min(frames.length, section.endFrame)
    if (end <= start) continue

    const anchorLayer = new Int32Array(end - start)
    anchorLayer.fill(-1)
    let localLayer = -1
    let anchorZ = Number.NaN

    for (let i = start; i < end; i++) {
      const frame = frames[i]
      const planar = Math.abs(frame.toZ - frame.fromZ) <= Z_EPSILON
      if (!planar || !isStockCuttingRole(frame.role)) continue
      if (localLayer < 0 || Math.abs(frame.toZ - anchorZ) > Z_EPSILON) {
        localLayer++
        anchorZ = frame.toZ
      }
      anchorLayer[i - start] = localLayer
    }
    if (localLayer < 0) continue

    const firstGlobalLayer = layers.length
    for (let i = 0; i <= localLayer; i++) layers.push([])

    let currentLocalLayer = localLayer
    for (let i = end - 1; i >= start; i--) {
      const anchor = anchorLayer[i - start]
      if (anchor >= 0) currentLocalLayer = anchor
      frameToLayer[i] = firstGlobalLayer + currentLocalLayer
    }

    for (let i = start; i < end; i++) {
      const layerIndex = frameToLayer[i]
      if (layerIndex < 0) continue
      const layerMoves = layers[layerIndex]
      if (layerMoves.length === 0) layerMoves.push(frameMove(frames[i], true))
      layerMoves.push(frameMove(frames[i], false))
    }
  }

  return { frameToLayer, layers }
}
