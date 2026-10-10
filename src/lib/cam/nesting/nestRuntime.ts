/* Pure nest-level cut-time aggregation (ADR 0024 Amendment 1: backplot /
 * estimate must EXPAND instances — INCLUDING inter-copy travel — to keep
 * cut-time estimates honest).
 *
 * A nest seed op stores ONE copy of its toolpath in the seed-local frame
 * (P6 Items 1-2): op.estimatedCutTimeMs is the per-COPY machine cut time.
 * The nest places N copies of each source; the honest nest-level cut time is
 * the time to run the FULL expanded multi-copy stream — every copy of every
 * seed op PLUS the rapids that link one placed copy to the next (the
 * inter-copy travel). estimateNestCutTimeMs builds that expanded stream
 * (buildNestExpansion) and times it with estimateRuntimeMs, so the result
 * counts travel and is no longer a naive per-copy multiply.
 *
 * perSourceMs is still the per-COPY cut sum (sum of each seed op's
 * estimatedCutTimeMs over one copy of every source), kept for reference;
 * totalMs is the timed expanded stream (cut + inter-copy travel) and is >=
 * perSourceMs x copies. travelExcluded is now false (travel IS counted).
 *
 * PURE: no store / DOM access; inputs are never mutated (ADR — operation
 * contract style). A missing op.estimatedCutTimeMs is treated as 0; a seed op
 * with no displayable computed toolpath contributes nothing to the stream.
 */

import type { ImportedGeometry, NestRecord, Operation, ToolpathMove } from '../../../types/index'
import { estimateRuntimeMsOrError, type CutTimeMotion } from '../runtime'
import {
  expandNest,
  renderMovesForGeo,
  type NestExpansion,
  type SeedOpExpansionInput,
} from './instanceToolpath'

export interface NestCutTimeEstimate {
  /** Sum of each seed op's per-copy estimatedCutTimeMs (ONE copy of every
   *  source's ops; placement counts NOT applied). Kept for reference. */
  perSourceMs: number
  /** Timed total of the full expanded multi-copy stream: every copy of every
   *  seed op PLUS the inter-copy travel (rapids linking placed copies),
   *  measured by estimateRuntimeMs. This is the honest nest-level machine cut
   *  time and is >= perSourceMs x copies (travel only adds time). */
  totalMs: number
  /** Total number of placed instances counted across all sources. */
  instanceCount: number
  /** Inter-copy travel IS now included in totalMs (ADR 0024 Amendment 1);
   *  always false for this helper. */
  travelExcluded: false
  /** Set (with totalMs left at 0) when the expanded stream can't be timed: a
   *  legacy/degraded seed move reached the estimate without a finite positive
   *  feed (ADR-0003 refusal, see estimateRuntimeMsOrError). The nest summary
   *  renders this as a named refusal instead of a misleading 0/"pending". */
  totalMsError?: string
}

/** Toolpaths may remain attached to outdated/degraded operations as an
 * explicit last-known visual fallback. Computing/error/pending/unsupported
 * operations are not computed output and must never reach render, simulation,
 * nest expansion, cut-time estimation, or post section collection. */
function hasDisplayableToolpath(op: Operation): op is Operation & { toolpathMoves: ToolpathMove[] } {
  return (
    (op.status === 'ready' || op.status === 'outdated' || op.status === 'degraded') &&
    Array.isArray(op.toolpathMoves) &&
    op.toolpathMoves.length > 0
  )
}

/**
 * Estimate the nest-level machine cut time by TIMING the full expanded
 * multi-copy stream (all copies + inter-copy travel), not a per-copy multiply.
 *
 *   - totalMs = estimateRuntimeMs(buildNestExpansion(nest, operations).moves,
 *               rapidRate, fastTraverseRate, finishRate). The expanded stream
 *               already contains every copy of every computed seed op and the
 *               inter-copy travel seams, so the timed result counts travel.
 *   - instanceCount = number of placed copies whose partId is a nest source.
 *   - perSourceMs = per-copy cut sum (sum of each seed op's estimatedCutTimeMs
 *     over one copy of every source), kept for reference.
 *
 * Operations bound to a geometry that is not a nest source are ignored. With
 * no computed seed op the expansion is empty -> totalMs 0; with no placed
 * copies instanceCount is 0 (the existing neutral state is preserved).
 *
 * rapidRate is the machine rapid traverse rate (mm/min); fastTraverseRate /
 * finishRate are optional resolved op speeds (default to rapidRate inside
 * estimateRuntimeMs, matching its convention for callers without them).
 */
export function estimateNestCutTimeMs(
  nest: NestRecord,
  operations: Operation[],
  rapidRate: number,
  fastTraverseRate?: number,
  finishRate?: number,
  motion?: CutTimeMotion | null,
): NestCutTimeEstimate {
  let perSourceMs = 0
  let instanceCount = 0

  for (const source of nest.sources) {
    // Per-copy cut sum: seed ops bound to THIS source (op.params.geometryId ===
    // owned seed id). Reference only; totalMs comes from the timed stream.
    for (const op of operations) {
      if (hasDisplayableToolpath(op) && op.params?.geometryId === source.geometryId) {
        perSourceMs += op.estimatedCutTimeMs ?? 0
      }
    }

    // Number of placed copies of this source on the sheet.
    for (const p of nest.placements) {
      if (p.partId === source.geometryId) instanceCount += 1
    }
  }

  // Honest total: time the full expanded multi-copy stream (cut + inter-copy
  // travel). Empty when no seed op is computed -> 0.
  const { moves } = buildNestExpansion(nest, operations)
  const cutTime = estimateRuntimeMsOrError(moves, rapidRate, fastTraverseRate, finishRate, motion)

  return {
    perSourceMs, instanceCount, travelExcluded: false,
    totalMs: cutTime.ms ?? 0,
    totalMsError: cutTime.error,
  }
}

/** The seed-local op's clearance plane = the highest Z it reaches (its
 *  approach / final-retract height), and feedZ = the lowest. Read from the
 *  already-resolved stored moves (not re-resolved) so the inter-copy travel Z
 *  is guaranteed to live in the SAME absolute frame as the copy moves. Loop
 *  rather than Math.max(...moves) so a large move stream never overflows the
 *  argument stack. */
function zSpan(moves: ToolpathMove[]): { maxZ: number; minZ: number } {
  let maxZ = -Infinity
  let minZ = Infinity
  for (const m of moves) {
    if (m.z > maxZ) maxZ = m.z
    if (m.z < minZ) minZ = m.z
  }
  return { maxZ, minZ }
}

/** Bridge from store data to the pure nest expander (ADR 0024 Amendment 1).
 *
 *  Collects each computed seed op of the nest (op.params.geometryId is one of
 *  the nest's sources AND it has toolpathMoves), derives its clearance / feed
 *  planes from its own resolved moves, and runs expandNest with the nest's
 *  origin + machiningOrder. The result is the full multi-copy ToolpathMove[]
 *  stream (with inter-copy travel) consumed identically by the Toolpath view,
 *  the Simulation, the cut-time estimate, and the post.
 *
 *  Ops are kept in the given array order so by-operation sections preserve the
 *  user's operation order (internal features before cutoffs). Pure: reads the
 *  inputs, mutates nothing. Returns an empty expansion when no seed op is
 *  computed yet. */
export function buildNestExpansion(
  nest: NestRecord,
  operations: Operation[],
): NestExpansion {
  const sourceIds = new Set(nest.sources.map((s) => s.geometryId))
  const inputs: SeedOpExpansionInput[] = []
  for (const op of operations) {
    const geometryId = op.params?.geometryId as string | undefined
    if (geometryId === undefined || !sourceIds.has(geometryId)) continue
    if (!hasDisplayableToolpath(op)) continue
    const moves = op.toolpathMoves
    const { maxZ, minZ } = zSpan(moves)
    inputs.push({
      opId: op.id,
      toolId: op.toolId,
      sourceGeometryId: geometryId,
      localMoves: moves,
      // Inter-copy travel rides the clearance plane (the safest height, see
      // travelSeam); retract defaults to the same. feedZ is recorded for
      // completeness (the seam itself does not descend - the copy stream does).
      clearanceZ: maxZ,
      retractZ: maxZ,
      feedZ: minZ,
      retractMode: op.params?.retractMode as 'clearance' | 'retract' | undefined,
    })
  }
  return expandNest(inputs, nest.placements, nest.origin ?? { x: 0, y: 0 }, nest.machiningOrder ?? 'by-operation')
}

/** A ready-to-render toolpath section: one op's move stream (nest-world),
 *  tagged with the op + tool so the Simulation can resolve the tool and the
 *  post can tool-change. The shared unit consumed by the Toolpath view AND the
 *  Simulation so they agree by construction (ADR 0024 Amendment 1). */
export interface ToolpathSection {
  opId: string
  toolId: string
  moves: ToolpathMove[]
}

/** Turn a list of operations into the ordered render sections, collapsing each
 *  nest into its expansion ONCE (ADR 0024 Amendment 1):
 *  - A normal op -> one section with renderMovesForGeo (pass-through for a
 *    non-seed geo; seed-slot offset for an owned seed). Empty ops are dropped.
 *  - A nest seed op (its geometry has ownerNestId) -> the nest's full
 *    multi-copy expansion sections (all copies + inter-copy travel, ordered by
 *    machiningOrder), emitted at the position of the nest's FIRST op in the
 *    list; the nest's other ops are skipped (so a nest renders exactly once).
 *
 *  Pure: reads the inputs, mutates nothing. With no nests this returns one
 *  section per non-empty op, byte-identical to the prior per-op behavior. */
export function collectToolpathSections(
  operations: Operation[],
  geometry: ImportedGeometry[],
  nests: NestRecord[] | undefined,
): ToolpathSection[] {
  const geoById = new Map(geometry.map((g) => [g.id, g]))
  const nestById = new Map((nests ?? []).map((n) => [n.id, n]))
  const sections: ToolpathSection[] = []
  const renderedNests = new Set<string>()

  for (const op of operations) {
    if (!hasDisplayableToolpath(op)) continue
    const geoId = (op.params as { geometryId?: string } | undefined)?.geometryId
    const geo = geoId ? geoById.get(geoId) : undefined
    const nestId = geo?.ownerNestId
    if (nestId !== undefined) {
      if (renderedNests.has(nestId)) continue // render each nest exactly once
      renderedNests.add(nestId)
      const nest = nestById.get(nestId)
      if (!nest) continue
      // buildNestExpansion filters `operations` to this nest's computed seed ops.
      for (const sec of buildNestExpansion(nest, operations).sections) {
        sections.push({ opId: sec.opId, toolId: sec.toolId, moves: sec.moves })
      }
    } else {
      const local = op.toolpathMoves ?? []
      if (local.length === 0) continue
      sections.push({ opId: op.id, toolId: op.toolId, moves: renderMovesForGeo(local, geo) })
    }
  }
  return sections
}
