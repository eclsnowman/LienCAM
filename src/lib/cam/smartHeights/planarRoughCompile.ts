import type { SmartHeightBoundsMm } from './types'
import {
  PLANAR_ROUGH_TARGET_REPRESENTATION,
  type PlanarRoughTargetCompilationEvidence,
} from './planarRough'
import { smartHeightEvidenceFingerprint } from './adaptive3d'

export const PLANAR_ROUGH_PRISMATIC_TARGET_REPRESENTATION =
  'complete-prismatic-target-v1' as const
export const PLANAR_ROUGH_UNIFORM_MATERIAL_REPRESENTATION =
  'uniform-prismatic-material-v1' as const

export interface PlanarRoughPoint2Mm {
  x: number
  y: number
}

/**
 * One region that a scalar-Z worker must protect at every depth below its top.
 * The fingerprint names the exact analytic loop, not merely a UI selection id.
 */
export interface PlanarRoughPrismaticRegion {
  regionId: string
  loopId: string
  pointsMachineMm: PlanarRoughPoint2Mm[]
  targetTopMachineMm: number
  fingerprint: string
}

/**
 * Normalized proof produced by a geometry-specific analytic adapter. The
 * compiler does not infer completeness from a mesh or bounding box: the
 * adapter must account for every face and explicitly report unsupported
 * topology.
 */
export interface PlanarRoughPrismaticTargetBody {
  geometryId: string
  stockId: string
  artifactId: string
  boundsMachineMm: SmartHeightBoundsMm
  fingerprint: string
  representation: typeof PLANAR_ROUGH_PRISMATIC_TARGET_REPRESENTATION
  roughFloorMachineMm: number
  keepOutRegions: PlanarRoughPrismaticRegion[]
  classification: {
    source: 'analytic_kernel' | 'exact_profile_extrusion'
    allFacesClassified: boolean
    hasSlopedFaces: boolean
    hasUndercuts: boolean
    deckLevelsMachineMm: number[]
    unclassifiedFaceIds: string[]
  }
}

export interface PlanarRoughMaterialRegionTop {
  /** Exact target-region fingerprint whose local material top was sampled. */
  targetRegionFingerprint: string
  topMachineMm: number
}

export interface PlanarRoughPrismaticMaterial {
  stockId: string
  artifactId: string
  boundsMachineMm: SmartHeightBoundsMm
  fingerprint: string
  representation:
    | typeof PLANAR_ROUGH_UNIFORM_MATERIAL_REPRESENTATION
    | typeof PLANAR_ROUGH_TARGET_REPRESENTATION
  defaultTopMachineMm: number
  regionTops: PlanarRoughMaterialRegionTop[]
}

export interface PlanarRoughCompilerStock {
  stockId: string
  artifactId: string
  boundsMachineMm: SmartHeightBoundsMm
  fingerprint: string
}

export type PlanarRoughCompilationRefusalCode =
  | 'invalid_input'
  | 'stock_identity_mismatch'
  | 'material_identity_mismatch'
  | 'target_outside_stock'
  | 'incomplete_target_evidence'
  | 'unsupported_target_topology'
  | 'multiple_rough_floors'
  | 'invalid_keep_out_region'
  | 'material_above_keep_out'
  | 'target_above_material'

export interface PlanarRoughCompilationDiagnostic {
  stage: 'stock' | 'material' | 'target' | 'floor' | 'keep_out' | 'result'
  subjectId: string
  verdict: 'accepted' | 'refused'
  detail: string
}

export interface PlanarRoughCompiledKeepOutLoop {
  loopId: string
  pointsMachineMm: PlanarRoughPoint2Mm[]
  targetTopMachineMm: number
  materialTopMachineMm: number
  targetRegionFingerprint: string
}

export type PlanarRoughCompilationResult =
  | {
      ok: true
      evidence: PlanarRoughTargetCompilationEvidence
      keepOutLoops: PlanarRoughCompiledKeepOutLoop[]
      diagnostics: PlanarRoughCompilationDiagnostic[]
    }
  | {
      ok: false
      refusal: {
        code: PlanarRoughCompilationRefusalCode
        message: string
        subjectId?: string
      }
      diagnostics: PlanarRoughCompilationDiagnostic[]
    }

export interface CompilePlanarRoughTargetInput {
  stock: PlanarRoughCompilerStock
  material: PlanarRoughPrismaticMaterial
  targets: PlanarRoughPrismaticTargetBody[]
  toleranceMm?: number
}

function finite(value: number): boolean {
  return Number.isFinite(value)
}

function validBounds(bounds: SmartHeightBoundsMm): boolean {
  return Object.values(bounds).every(finite) &&
    bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY && bounds.minZ <= bounds.maxZ
}

function contains(
  outer: SmartHeightBoundsMm,
  inner: SmartHeightBoundsMm,
  toleranceMm: number,
): boolean {
  return inner.minX >= outer.minX - toleranceMm && inner.maxX <= outer.maxX + toleranceMm &&
    inner.minY >= outer.minY - toleranceMm && inner.maxY <= outer.maxY + toleranceMm &&
    inner.minZ >= outer.minZ - toleranceMm && inner.maxZ <= outer.maxZ + toleranceMm
}

function polygonArea(points: readonly PlanarRoughPoint2Mm[]): number {
  let twiceArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    twiceArea += current.x * next.y - next.x * current.y
  }
  return twiceArea / 2
}

function orientation(
  a: PlanarRoughPoint2Mm,
  b: PlanarRoughPoint2Mm,
  c: PlanarRoughPoint2Mm,
): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function properSegmentsIntersect(
  a: PlanarRoughPoint2Mm,
  b: PlanarRoughPoint2Mm,
  c: PlanarRoughPoint2Mm,
  d: PlanarRoughPoint2Mm,
  toleranceMm: number,
): boolean {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  return ((abC > toleranceMm && abD < -toleranceMm) ||
      (abC < -toleranceMm && abD > toleranceMm)) &&
    ((cdA > toleranceMm && cdB < -toleranceMm) ||
      (cdA < -toleranceMm && cdB > toleranceMm))
}

function selfIntersects(points: readonly PlanarRoughPoint2Mm[], toleranceMm: number): boolean {
  for (let left = 0; left < points.length; left += 1) {
    const leftNext = (left + 1) % points.length
    for (let right = left + 1; right < points.length; right += 1) {
      const rightNext = (right + 1) % points.length
      if (left === right || leftNext === right || rightNext === left) continue
      if (properSegmentsIntersect(
        points[left], points[leftNext], points[right], points[rightNext], toleranceMm,
      )) return true
    }
  }
  return false
}

function refusal(
  diagnostics: PlanarRoughCompilationDiagnostic[],
  stage: PlanarRoughCompilationDiagnostic['stage'],
  subjectId: string,
  code: PlanarRoughCompilationRefusalCode,
  message: string,
): PlanarRoughCompilationResult {
  diagnostics.push({ stage, subjectId, verdict: 'refused', detail: message })
  return { ok: false, refusal: { code, message, subjectId }, diagnostics }
}

function accept(
  diagnostics: PlanarRoughCompilationDiagnostic[],
  stage: PlanarRoughCompilationDiagnostic['stage'],
  subjectId: string,
  detail: string,
): void {
  diagnostics.push({ stage, subjectId, verdict: 'accepted', detail })
}

/**
 * Compile exact prismatic target facts into the one-floor-plus-static-islands
 * representation supported by the existing Pocket 2D and Adaptive Clearing
 * 2D workers. Any fact that cannot be represented is a named refusal. No
 * bounding-box or Top-minus-N fallback is permitted here.
 */
export function compilePlanarRoughPrismaticTarget(
  input: CompilePlanarRoughTargetInput,
): PlanarRoughCompilationResult {
  const diagnostics: PlanarRoughCompilationDiagnostic[] = []
  const toleranceMm = input.toleranceMm ?? 1e-6
  if (!finite(toleranceMm) || toleranceMm < 0) {
    return refusal(diagnostics, 'result', 'compiler', 'invalid_input',
      'Planar rough compilation tolerance must be finite and non-negative.')
  }

  const stockId = input.stock.stockId.trim()
  if (!stockId || !input.stock.artifactId.trim() || !input.stock.fingerprint.trim() ||
      !validBounds(input.stock.boundsMachineMm)) {
    return refusal(diagnostics, 'stock', stockId || 'stock', 'invalid_input',
      'Planar rough compilation requires one valid, durable owning-stock artifact.')
  }
  accept(diagnostics, 'stock', stockId, 'Owning stock identity and bounds are valid.')

  const material = input.material
  if (material.stockId !== stockId) {
    return refusal(diagnostics, 'material', material.artifactId,
      'material_identity_mismatch',
      `Current material belongs to stock '${material.stockId}', not '${stockId}'.`)
  }
  if ((material.representation !== PLANAR_ROUGH_UNIFORM_MATERIAL_REPRESENTATION &&
      material.representation !== PLANAR_ROUGH_TARGET_REPRESENTATION) ||
      !material.artifactId.trim() || !material.fingerprint.trim() ||
      !validBounds(material.boundsMachineMm) ||
      !contains(input.stock.boundsMachineMm, material.boundsMachineMm, toleranceMm) ||
      !finite(material.defaultTopMachineMm) ||
      material.defaultTopMachineMm < material.boundsMachineMm.minZ - toleranceMm ||
      material.defaultTopMachineMm > material.boundsMachineMm.maxZ + toleranceMm) {
    return refusal(diagnostics, 'material', material.artifactId,
      'invalid_input', 'Current-material evidence is invalid or outside the owning stock.')
  }
  const materialTopByRegion = new Map<string, number>()
  for (const region of material.regionTops) {
    if (!region.targetRegionFingerprint.trim() || !finite(region.topMachineMm) ||
        region.topMachineMm < material.boundsMachineMm.minZ - toleranceMm ||
        region.topMachineMm > material.boundsMachineMm.maxZ + toleranceMm ||
        materialTopByRegion.has(region.targetRegionFingerprint)) {
      return refusal(diagnostics, 'material', material.artifactId, 'invalid_input',
        'Current-material region tops require unique target-region fingerprints and finite heights.')
    }
    materialTopByRegion.set(region.targetRegionFingerprint, region.topMachineMm)
  }
  accept(diagnostics, 'material', material.artifactId,
    `Current material has ${materialTopByRegion.size} exact local-height override(s).`)

  if (input.targets.length === 0) {
    return refusal(diagnostics, 'target', 'targets', 'incomplete_target_evidence',
      'Stock roughing requires at least one target body assigned to the owning stock.')
  }
  const geometryIds = new Set<string>()
  const targetArtifactIds = new Set<string>()
  const floorCandidates: Array<{ geometryId: string; value: number }> = []
  const keepOutLoops: PlanarRoughCompiledKeepOutLoop[] = []
  const loopIds = new Set<string>()
  const regionFingerprints = new Set<string>()

  for (const target of input.targets) {
    const geometryId = target.geometryId.trim()
    if (!geometryId || geometryIds.has(geometryId) || !target.artifactId.trim() ||
        targetArtifactIds.has(target.artifactId) || !target.fingerprint.trim() ||
        !validBounds(target.boundsMachineMm) || !finite(target.roughFloorMachineMm)) {
      return refusal(diagnostics, 'target', geometryId || target.artifactId || 'target',
        'invalid_input', 'Target bodies require unique durable identities, valid bounds, and a finite rough floor.')
    }
    geometryIds.add(geometryId)
    targetArtifactIds.add(target.artifactId)
    if (target.stockId !== stockId) {
      return refusal(diagnostics, 'target', geometryId, 'stock_identity_mismatch',
        `Target '${geometryId}' belongs to stock '${target.stockId}', not '${stockId}'.`)
    }
    if (!contains(input.stock.boundsMachineMm, target.boundsMachineMm, toleranceMm)) {
      return refusal(diagnostics, 'target', geometryId, 'target_outside_stock',
        `Target '${geometryId}' is outside owning stock '${stockId}'.`)
    }
    if (target.representation !== PLANAR_ROUGH_PRISMATIC_TARGET_REPRESENTATION ||
        !target.classification.allFacesClassified ||
        target.classification.unclassifiedFaceIds.length > 0) {
      return refusal(diagnostics, 'target', geometryId, 'incomplete_target_evidence',
        `Target '${geometryId}' does not account for every face with analytic prismatic evidence.`)
    }
    if (target.classification.hasSlopedFaces || target.classification.hasUndercuts) {
      return refusal(diagnostics, 'target', geometryId, 'unsupported_target_topology',
        `Target '${geometryId}' has sloped faces or undercuts that a scalar-Z worker cannot represent.`)
    }
    const levels = target.classification.deckLevelsMachineMm
    if (levels.length !== 1 || !finite(levels[0]) ||
        Math.abs(levels[0] - target.roughFloorMachineMm) > toleranceMm) {
      return refusal(diagnostics, 'floor', geometryId, 'multiple_rough_floors',
        `Target '${geometryId}' does not prove exactly one common roughing deck.`)
    }
    if (target.roughFloorMachineMm < target.boundsMachineMm.minZ - toleranceMm ||
        target.roughFloorMachineMm > target.boundsMachineMm.maxZ + toleranceMm ||
        target.roughFloorMachineMm > material.defaultTopMachineMm + toleranceMm) {
      return refusal(diagnostics, 'floor', geometryId, 'invalid_input',
        `Target '${geometryId}' rough floor is outside its target or current-material envelope.`)
    }
    floorCandidates.push({ geometryId, value: target.roughFloorMachineMm })
    accept(diagnostics, 'target', geometryId,
      `Target is a complete ${target.classification.source} prismatic body.`)

    for (const region of target.keepOutRegions) {
      const regionId = region.regionId.trim()
      const loopId = region.loopId.trim()
      const fingerprint = region.fingerprint.trim()
      const pointsInsideTarget = region.pointsMachineMm.every(point =>
        point.x >= target.boundsMachineMm.minX - toleranceMm &&
        point.x <= target.boundsMachineMm.maxX + toleranceMm &&
        point.y >= target.boundsMachineMm.minY - toleranceMm &&
        point.y <= target.boundsMachineMm.maxY + toleranceMm)
      if (!regionId || !loopId || !fingerprint || loopIds.has(loopId) ||
          regionFingerprints.has(fingerprint) || region.pointsMachineMm.length < 3 ||
          !region.pointsMachineMm.every(point => finite(point.x) && finite(point.y)) ||
          !pointsInsideTarget || selfIntersects(region.pointsMachineMm, toleranceMm) ||
          Math.abs(polygonArea(region.pointsMachineMm)) <= toleranceMm * toleranceMm ||
          !finite(region.targetTopMachineMm) ||
          region.targetTopMachineMm <= target.roughFloorMachineMm + toleranceMm ||
          region.targetTopMachineMm > target.boundsMachineMm.maxZ + toleranceMm) {
        return refusal(diagnostics, 'keep_out', regionId || loopId || geometryId,
          'invalid_keep_out_region',
          `Target '${geometryId}' has an invalid, duplicate, or degenerate keep-out region.`)
      }
      loopIds.add(loopId)
      regionFingerprints.add(fingerprint)
      const materialTop = materialTopByRegion.get(fingerprint) ?? material.defaultTopMachineMm
      if (materialTop + toleranceMm < region.targetTopMachineMm) {
        return refusal(diagnostics, 'keep_out', regionId, 'target_above_material',
          `Keep-out '${regionId}' rises above the current material and cannot be a cutting target.`)
      }
      if (materialTop > region.targetTopMachineMm + toleranceMm) {
        return refusal(diagnostics, 'keep_out', regionId, 'material_above_keep_out',
          `Keep-out '${regionId}' has removable material above its target top; a static island would leave an uncut column.`)
      }
      keepOutLoops.push({
        loopId,
        pointsMachineMm: region.pointsMachineMm.map(point => ({ ...point })),
        targetTopMachineMm: region.targetTopMachineMm,
        materialTopMachineMm: materialTop,
        targetRegionFingerprint: fingerprint,
      })
      accept(diagnostics, 'keep_out', regionId,
        'Local material already ends at the keep-out top, so a static island is exact.')
    }
  }

  const roughFloor = floorCandidates[0].value
  const conflictingFloor = floorCandidates.find(candidate =>
    Math.abs(candidate.value - roughFloor) > toleranceMm)
  if (conflictingFloor) {
    return refusal(diagnostics, 'floor', conflictingFloor.geometryId,
      'multiple_rough_floors',
      'Target bodies require different roughing floors; the scalar-Z worker cannot compile them together.')
  }
  accept(diagnostics, 'floor', 'common-floor',
    `All ${floorCandidates.length} target body/bodies share rough floor ${roughFloor} mm.`)

  const orderedTargets = [...input.targets].sort((left, right) =>
    left.geometryId.localeCompare(right.geometryId))
  const orderedLoops = [...keepOutLoops].sort((left, right) => left.loopId.localeCompare(right.loopId))
  const fingerprint = smartHeightEvidenceFingerprint({
    representation: PLANAR_ROUGH_TARGET_REPRESENTATION,
    stock: { id: stockId, artifactId: input.stock.artifactId, fingerprint: input.stock.fingerprint },
    material: { artifactId: material.artifactId, fingerprint: material.fingerprint },
    targets: orderedTargets.map(target => ({
      geometryId: target.geometryId,
      artifactId: target.artifactId,
      fingerprint: target.fingerprint,
      roughFloorMachineMm: target.roughFloorMachineMm,
    })),
    keepOutLoops: orderedLoops,
  })
  const artifactId = `planar-rough-target:${stockId}:${fingerprint}`
  const evidence: PlanarRoughTargetCompilationEvidence = {
    stockId,
    artifactId,
    materialArtifactId: material.artifactId,
    targetGeometryIds: orderedTargets.map(target => target.geometryId),
    boundsMachineMm: { ...input.stock.boundsMachineMm },
    floorMachineMm: roughFloor,
    keepOutRegions: orderedLoops.map(loop => ({
      loopId: loop.loopId,
      materialTopMachineMm: loop.materialTopMachineMm,
      targetTopMachineMm: loop.targetTopMachineMm,
    })),
    fingerprint,
    representation: PLANAR_ROUGH_TARGET_REPRESENTATION,
    schemaVersion: 1,
  }
  accept(diagnostics, 'result', artifactId,
    `Compiled one scalar floor and ${orderedLoops.length} exact static keep-out loop(s).`)
  return { ok: true, evidence, keepOutLoops: orderedLoops, diagnostics }
}
