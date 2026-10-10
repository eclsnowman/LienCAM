import type { ImportedGeometry } from '../../../types'
import type { PrismaticRoughTargetFacts } from '../geometry/occt/model/types'
import {
  compilePlanarRoughPrismaticTarget,
  PLANAR_ROUGH_PRISMATIC_TARGET_REPRESENTATION,
  type PlanarRoughCompilationResult,
  type PlanarRoughCompilerStock,
  type PlanarRoughPrismaticMaterial,
  type PlanarRoughPrismaticTargetBody,
} from './planarRoughCompile'
import { smartHeightEvidenceFingerprint } from './adaptive3d'

export type PlanarRoughBrepAdapterResult =
  | { ok: true; target: PlanarRoughPrismaticTargetBody }
  | {
      ok: false
      refusal: {
        code: 'unsupported_geometry' | 'tilted_target' | 'incomplete_target_evidence'
        message: string
      }
    }

export type PlanarRoughBrepCompilationResult =
  | (Extract<PlanarRoughCompilationResult, { ok: true }> & {
      targets: PlanarRoughPrismaticTargetBody[]
    })
  | {
      ok: false
      refusal: {
        code:
          | 'unsupported_geometry'
          | 'tilted_target'
          | 'incomplete_target_evidence'
          | Extract<PlanarRoughCompilationResult, { ok: false }>['refusal']['code']
        message: string
        subjectId?: string
      }
      diagnostics: Extract<PlanarRoughCompilationResult, { ok: false }>['diagnostics']
    }

const POSE_TOL_DEG = 1e-8

function transformXY(
  point: { x: number; y: number },
  geometry: ImportedGeometry,
): { x: number; y: number } {
  const radians = geometry.rotation.z * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  return {
    x: geometry.position.x + point.x * cosine - point.y * sine,
    y: geometry.position.y + point.x * sine + point.y * cosine,
  }
}

function transformedBounds(
  facts: PrismaticRoughTargetFacts,
  geometry: ImportedGeometry,
) {
  const corners = [
    { x: facts.bounds.min[0], y: facts.bounds.min[1] },
    { x: facts.bounds.min[0], y: facts.bounds.max[1] },
    { x: facts.bounds.max[0], y: facts.bounds.min[1] },
    { x: facts.bounds.max[0], y: facts.bounds.max[1] },
  ].map(point => transformXY(point, geometry))
  return {
    minX: Math.min(...corners.map(point => point.x)),
    minY: Math.min(...corners.map(point => point.y)),
    minZ: facts.bounds.min[2] + geometry.position.z,
    maxX: Math.max(...corners.map(point => point.x)),
    maxY: Math.max(...corners.map(point => point.y)),
    maxZ: facts.bounds.max[2] + geometry.position.z,
  }
}

/**
 * Put worker-local analytic facts into the machine/world frame used by Smart
 * Height. Z-axis translation and rotation preserve the prismatic proof; X/Y
 * tilt invalidates it and is refused explicitly.
 */
export function adaptBrepPrismaticRoughTarget(input: {
  geometry: ImportedGeometry
  stockId: string
  facts: PrismaticRoughTargetFacts
}): PlanarRoughBrepAdapterResult {
  const { geometry, stockId, facts } = input
  if (geometry.type !== 'brep' || geometry.format !== 'step') {
    return {
      ok: false,
      refusal: {
        code: 'unsupported_geometry',
        message: `Target '${geometry.name}' is not an imported STEP/B-rep body.`,
      },
    }
  }
  if (Math.abs(geometry.rotation.x) > POSE_TOL_DEG ||
      Math.abs(geometry.rotation.y) > POSE_TOL_DEG) {
    return {
      ok: false,
      refusal: {
        code: 'tilted_target',
        message: `Target '${geometry.name}' is tilted away from machine Z and is not scalar-planar roughing evidence.`,
      },
    }
  }
  if (facts.roughFloorZ === undefined) {
    return {
      ok: false,
      refusal: {
        code: 'incomplete_target_evidence',
        message: `Target '${geometry.name}' has no proven common prismatic roughing deck.`,
      },
    }
  }

  const pose = {
    position: geometry.position,
    rotation: geometry.rotation,
    projectionStale: geometry.projectionStale,
  }
  const targetFingerprint = smartHeightEvidenceFingerprint({
    geometryId: geometry.id,
    filename: geometry.filename,
    pose,
    facts,
  })
  return {
    ok: true,
    target: {
      geometryId: geometry.id,
      stockId,
      artifactId: `brep-prismatic-target:${geometry.id}:${targetFingerprint}`,
      boundsMachineMm: transformedBounds(facts, geometry),
      fingerprint: targetFingerprint,
      representation: PLANAR_ROUGH_PRISMATIC_TARGET_REPRESENTATION,
      roughFloorMachineMm: facts.roughFloorZ + geometry.position.z,
      keepOutRegions: facts.keepOutRegions.map(region => {
        const regionFingerprint = smartHeightEvidenceFingerprint({
          geometryId: geometry.id,
          faceIndex: region.faceIndex,
          pose,
          loop: region.loop,
          targetTopZ: region.targetTopZ,
        })
        return {
          regionId: `${geometry.id}:face:${region.faceIndex}`,
          loopId: `smart-height-keep-out:${geometry.id}:face:${region.faceIndex}`,
          pointsMachineMm: region.loop.points.map(point => transformXY(point, geometry)),
          targetTopMachineMm: region.targetTopZ + geometry.position.z,
          fingerprint: regionFingerprint,
        }
      }),
      classification: {
        source: 'analytic_kernel',
        allFacesClassified: facts.classification.allFacesClassified,
        hasSlopedFaces: facts.classification.hasSlopedFaces,
        hasUndercuts: facts.classification.hasUndercuts,
        deckLevelsMachineMm: facts.classification.deckLevelsZ.map(
          value => value + geometry.position.z,
        ),
        unclassifiedFaceIds: facts.classification.unclassifiedFaceIds.map(
          faceId => `${geometry.id}:${faceId}`,
        ),
      },
    },
  }
}

/**
 * One pure bridge from analytic B-rep facts to the scalar-planar compilation.
 * The store may derive facts asynchronously, but it cannot reinterpret them or
 * silently skip a target: every supplied body is adapted, then the common
 * compiler proves the complete stock/material/target relationship.
 */
export function compileBrepPlanarRoughTarget(input: {
  stock: PlanarRoughCompilerStock
  material: PlanarRoughPrismaticMaterial
  targets: Array<{
    geometry: ImportedGeometry
    facts: PrismaticRoughTargetFacts
  }>
  toleranceMm?: number
}): PlanarRoughBrepCompilationResult {
  const targets: PlanarRoughPrismaticTargetBody[] = []
  const ordered = [...input.targets].sort((left, right) =>
    left.geometry.id.localeCompare(right.geometry.id))
  for (const candidate of ordered) {
    const adapted = adaptBrepPrismaticRoughTarget({
      geometry: candidate.geometry,
      stockId: input.stock.stockId,
      facts: candidate.facts,
    })
    if (!adapted.ok) {
      return {
        ok: false,
        refusal: {
          ...adapted.refusal,
          subjectId: candidate.geometry.id,
        },
        diagnostics: [{
          stage: 'target',
          subjectId: candidate.geometry.id,
          verdict: 'refused',
          detail: adapted.refusal.message,
        }],
      }
    }
    targets.push(adapted.target)
  }
  const compiled = compilePlanarRoughPrismaticTarget({
    stock: input.stock,
    material: input.material,
    targets,
    toleranceMm: input.toleranceMm,
  })
  return compiled.ok ? { ...compiled, targets } : compiled
}
