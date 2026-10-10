// Constrainable-point enumeration for a Sketch3dDocument. This is a PURE helper
// over the document model - it never touches planegcs, so it is deliberately
// kept OUT of the solve path. Relocated here (WO SKC-6D, one-sketcher stage D)
// so the retired sketch3d/mapping.ts could be deleted while its three
// non-solver consumers (constraintGeometry, inference, picking) keep the exact
// same helper. The solve mapping now lives entirely in the 2D superset
// (src/lib/sketch/solver/gcsMapping.ts) via src/sketch3d/solveBridge.ts.
import type {
  Sketch3dEntity,
  Sketch3dDocument,
  Sketch3dPointRef,
  Sketch3dPointSite,
  Sketch3dVec2,
} from './types'

function pointFromPolar(center: Sketch3dVec2, radius: number, angle: number): Sketch3dVec2 {
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }
}

interface PointSeed {
  id: string
  at: Sketch3dVec2
}

function entityPointSeeds(entity: Sketch3dEntity): PointSeed[] {
  switch (entity.kind) {
    case 'point':
      return [{ id: entity.id, at: entity.at }]
    case 'line':
      return [
        { id: entity.id + ':start', at: entity.start },
        { id: entity.id + ':end', at: entity.end },
      ]
    case 'circle':
      return [{ id: entity.id + ':center', at: entity.center }]
    case 'arc':
      return [
        { id: entity.id + ':center', at: entity.center },
        { id: entity.id + ':start', at: pointFromPolar(entity.center, entity.radius, entity.startAngle) },
        { id: entity.id + ':end', at: pointFromPolar(entity.center, entity.radius, entity.endAngle) },
      ]
  }
}

export interface Sketch3dPointSample {
  ref: Sketch3dPointRef
  id: string
  at: Sketch3dVec2
}

// Every constrainable point in the document (bare points, line endpoints, circle/arc centers,
// arc endpoints), with its live position and the Sketch3dPointRef that addresses it - shared
// by auto-constraint inference (nearest-point search) and glyph anchoring.
export function sketch3dPointSamples(document: Sketch3dDocument): Sketch3dPointSample[] {
  const samples: Sketch3dPointSample[] = []
  for (const entity of document.entities) {
    for (const seed of entityPointSeeds(entity)) {
      const site = (seed.id === entity.id ? 'self' : seed.id.slice(entity.id.length + 1)) as Sketch3dPointSite
      samples.push({ ref: { entityId: entity.id, site }, id: seed.id, at: seed.at })
    }
  }
  return samples
}
