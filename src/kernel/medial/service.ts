// WO-3038 (alpha.3 A3-07): the kernel medial-axis service. Construction (construct.ts), the
// declared filters (filters.ts) and chain extraction (extract.ts), with every number from
// parameters.ts. At parity `axis` equals today's V-carve medialAxis on every input.

import { MEDIAL_PARAMETERS as P } from './parameters'
import { PARITY_MEDIAL_POLICY, type MedialPolicy } from './policy'
import { construct, normalizeRegion } from './construct'
import { connect, pruneSpurs, removeSecondaryEdges, trimByRadius } from './filters'
import { extractPaths } from './extract'
import type { AxisPath, MedialAxisOptions, MedialGraph, MedialResult, PointSite, Region } from './contracts'

interface Settings { spacing: number; pruneLength: number; simplifyTol: number; cornerAngleRad: number }

/** Today's defaults for every option the caller leaves out. */
export function resolveMedialOptions(opts: MedialAxisOptions): Settings {
  const spacing = Math.max(P.minSpacing.value, opts.spacing)
  return {
    spacing,
    pruneLength: opts.pruneLength ?? P.pruneLengthPerSpacing.value * spacing,
    simplifyTol: opts.simplifyTolerance ?? spacing * P.simplifyPerSpacing.value,
    cornerAngleRad: ((opts.cornerAngleDeg ?? P.cornerAngleDeg.value) * Math.PI) / 180,
  }
}

/** Construction and filters of one region; null when the region bounds no area. */
function filteredGraph(input: Region, opts: MedialAxisOptions): { graph: MedialGraph; settings: Settings } | null {
  const region = normalizeRegion(input)
  if (region.outer.length < P.minContourVertices.value) return null
  const settings = resolveMedialOptions(opts)
  const built = construct(region, settings.spacing, settings.cornerAngleRad)
  connect(built.nodes, removeSecondaryEdges(built.edges))
  pruneSpurs(built.nodes, settings.pruneLength, settings.cornerAngleRad)
  return { graph: built, settings }
}

/** V-carve's boundary sample spacing for a region at an arc tolerance (index.ts:695). */
export function carveSpacing(region: Region, tolerance: number): number {
  const byTol = Math.max(P.carveSpacingMin.value, Math.min(P.carveSpacingMax.value, tolerance * P.carveSpacingPerTolerance.value))
  return Math.max(byTol, regionPerimeter(region) / P.sampleBudget.value)
}

/** The floor-ring core's sample spacing for a stepover (index.ts:745). */
export function floorCoreSpacing(core: Region, stepover: number): number {
  const byStep = Math.max(P.carveSpacingMin.value, Math.min(stepover * P.floorCoreSpacingPerStepover.value, P.carveSpacingMax.value))
  return Math.max(byStep, regionPerimeter(core) / P.sampleBudget.value)
}

export function regionPerimeter(region: Region): number {
  let len = 0
  for (const c of [region.outer, ...region.holes]) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i], b = c[(i + 1) % c.length]
      len += Math.hypot(b.x - a.x, b.y - a.y)
    }
  }
  return len
}

export function createMedialService(policy: MedialPolicy = PARITY_MEDIAL_POLICY) {
  /** The medial axis of one region as chains: today's medialAxis. Contours must be simple and
   *  non-overlapping (weld overlapping outlines first). */
  function axis(region: Region, opts: MedialAxisOptions): AxisPath[] {
    const built = filteredGraph(region, opts)
    if (!built || built.graph.nodes.length === 0) return []
    return extractPaths(built.graph.nodes, built.settings.simplifyTol)
  }
  /** The axis plus its point sites (single-point chains: a disc, a dot). */
  function analyse(region: Region, opts: MedialAxisOptions): MedialResult {
    const paths = axis(region, opts)
    const pointSites: PointSite[] = paths.filter(p => p.points.length === 1).map(p => ({ ...p.points[0] }))
    return { paths, pointSites }
  }
  /** The constructed graph after the filters, for inspection (null: no area). */
  function graph(region: Region, opts: MedialAxisOptions): MedialGraph | null {
    return filteredGraph(region, opts)?.graph ?? null
  }
  return { policy, parameters: P, axis, analyse, graph, trimByRadius, carveSpacing, floorCoreSpacing }
}

export type MedialService = ReturnType<typeof createMedialService>
