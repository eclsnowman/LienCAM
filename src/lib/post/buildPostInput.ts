// ============================================================
// Build a PostInput from a Project + Setup (C-P0)
// ============================================================
// Pure: reads the project, mutates nothing. Resolves tool, feeds, spindle,
// and coolant per enabled operation, preserving operation order.
//
// Tool-not-found mechanism (fail-loud, ADR-0003): when an op's toolId does
// not resolve, we do NOT drop the op. We substitute a sentinel placeholder
// Tool with `toolNumber: undefined`, so validateToolNumbers surfaces a
// TOOL_NUMBER_MISSING error for that operation. The sentinel id is
// MISSING_TOOL_ID for callers/tests that want to detect it directly.

import { machineRapidRate } from '../../types'
import type { Operation, Project, Setup, Tool } from '../../types'
import { resolveFeedrates } from '../cam/feedrates'
import { collectToolpathSections } from '../cam/nesting/nestRuntime'
import { operationGenerationIsCurrent } from '../cam/generationFingerprint'
import { resolveCoolant, resolveSpindle } from './resolve'
import type { PostInput, PostOperation, PostOperatorStop } from './types'
import { resolveSetupWorkOffset } from './workOffsets'
import { postToolNumbersOf } from './toolNumbers'

/** Sentinel id used for the placeholder substituted when a toolId fails to
 *  resolve. Surfaces downstream as a TOOL_NUMBER_MISSING validation error. */
export const MISSING_TOOL_ID = '__post_missing_tool__'

function makeMissingTool(toolId: string): Tool {
  return {
    id: MISSING_TOOL_ID,
    name: `Unknown tool (${toolId})`,
    type: 'flat_end_mill',
    diameter: 0,
    fluteLength: 0,
    shankDiameter: 0,
    overallLength: 0,
    numberOfFlutes: 0,
    material: 'carbide',
    coating: 'none',
    notes: '',
    toolNumber: undefined,
    feedsAndSpeeds: {},
  }
}

/** WO-2019 (rule 11): a tool the operator never numbered is not a reason to
 *  refuse the post - the app can number it. Each unnumbered library tool gets
 *  the lowest number no numbered library tool holds, in the order the project
 *  first uses it (setups, then their operations, in project order, disabled
 *  ones included so enabling one never renumbers another), then any unused
 *  unnumbered library tools after them. Built from the WHOLE project, never the
 *  one setup being posted, so Control > Load, Post Process > Export, the setup
 *  sheet and the program context all give a tool the same number, and two
 *  unnumbered tools never share one. The library itself is not changed.
 *  WO-2637: a tool given its own number for the program (postToolNumbers) is
 *  not assigned one, and no tool is assigned a number the operator chose. */
export function assignedToolNumbers(
  project: Pick<Project, 'toolLibrary' | 'setups' | 'postToolNumbers'>,
): Map<string, number> {
  const chosen = postToolNumbersOf(project)
  const byId = new Map<string, Tool>()
  const taken = new Set<number>(Object.values(chosen))
  for (const tool of project.toolLibrary) {
    if (!byId.has(tool.id)) byId.set(tool.id, tool)
    if (tool.toolNumber != null) taken.add(tool.toolNumber)
  }
  const order: string[] = []
  const queue = (toolId: string) => {
    const tool = byId.get(toolId)
    if (!tool || tool.toolNumber != null || chosen[toolId] !== undefined || order.includes(toolId)) return
    order.push(toolId)
  }
  for (const s of project.setups) for (const op of s.operations) queue(op.toolId)
  for (const tool of project.toolLibrary) queue(tool.id)

  const assigned = new Map<string, number>()
  let next = 1
  for (const toolId of order) {
    while (taken.has(next)) next += 1
    assigned.set(toolId, next)
    taken.add(next)
  }
  return assigned
}

/** WO-2437: each operator stop resolved onto an operation that is emitted. A
 *  stop before an operation that does not post (suppressed, or left out of the
 *  selection) runs before the next one in order that does, else after the
 *  last; a stop naming no operation in the order runs after the last.
 *  Undefined when there are no stops, so a setup without any posts exactly as
 *  before. */
export function resolveOperatorStops(
  orderedOpIds: readonly string[],
  emitted: ReadonlySet<string>,
  stops: ReadonlyArray<{ beforeOpId: string | null; message: string }> | undefined,
): PostOperatorStop[] | undefined {
  if (!Array.isArray(stops) || stops.length === 0) return undefined
  return stops.map((stop) => {
    const message = typeof stop.message === 'string' ? stop.message : ''
    const from = stop.beforeOpId === null ? -1 : orderedOpIds.indexOf(stop.beforeOpId)
    const beforeOpId = from < 0 ? null : orderedOpIds.slice(from).find((id) => emitted.has(id)) ?? null
    return { beforeOpId, message }
  })
}

/** WO-2437: the setup's switched-on Operator stop actions as stops placed
 *  before an operation: an action after operation A runs before the operation
 *  that follows A (null = after the last); an action before the first
 *  operation runs before it. Undefined when there are none. */
export function operatorStopsFromActions(
  orderedOpIds: readonly string[],
  actions: Setup['machineActions'],
): Array<{ beforeOpId: string | null; message: string }> | undefined {
  if (!Array.isArray(actions)) return undefined
  const stops = actions
    .filter((action) => action.kind === 'operator_stop' && action.enabled !== false)
    .map((action) => {
      const at = action.afterOpId === null ? -1 : orderedOpIds.indexOf(action.afterOpId)
      const beforeOpId = action.afterOpId !== null && at < 0 ? null : orderedOpIds[at + 1] ?? null
      return { beforeOpId, message: action.message }
    })
  return stops.length > 0 ? stops : undefined
}

export function buildPostInput(project: Project, setup: Setup): PostInput {
  const resolvedSetup = resolveSetupWorkOffset(project, setup).setup
  const operations: PostOperation[] = []
  const assigned = assignedToolNumbers(project)
  const chosen = postToolNumbersOf(project)
  // The library tool as it posts: one the operator gave its own number for
  // this program (WO-2637) carries that number; an unnumbered one carries its
  // assigned number and says so; a numbered one is the library object,
  // untouched. The library itself is never changed.
  const resolveTool = (toolId: string): Pick<PostOperation, 'tool' | 'toolNumberAssigned'> => {
    const tool = project.toolLibrary.find((t) => t.id === toolId)
    if (!tool) return { tool: makeMissingTool(toolId) }
    const own = chosen[tool.id]
    if (own !== undefined) return { tool: { ...tool, toolNumber: own } }
    const n = tool.toolNumber == null ? assigned.get(tool.id) : undefined
    return n === undefined ? { tool } : { tool: { ...tool, toolNumber: n }, toolNumberAssigned: true }
  }
  // WO-1700 (ADR-0049; Operator 2026-09-19): the feed ceiling is the machine's
  // effective everyday rapid - the typed rapidRate capped at the slowest stated
  // X/Y/Z max velocity (the ceiling alone when nothing is typed; the typed
  // alone with no definition speeds). Null (neither stated) falls back as before.
  const rapidCeiling = machineRapidRate(project.machine)?.mmMin ?? project.machine.rapidRate

  // ADR 0024 Amendment 1 (P7 redirect): inter-copy travel + machining order are
  // generated UPSTREAM as real ToolpathMove[], not synthesized in the post.
  // collectToolpathSections returns the ordered render/emit sections:
  //  - a normal op -> ONE section (renderMovesForGeo pass-through for a non-seed
  //    geo; seed-slot offset for an owned seed); empty ops are dropped,
  //  - a nest seed op -> the nest's full multi-copy expansion sections (all
  //    copies + inter-copy travel, ordered by machiningOrder), emitted ONCE per
  //    nest, each section carrying its own opId/toolId (by-part interleaves).
  // With no nests this yields one section per non-empty enabled op in op order,
  // so the resulting PostOperation list is byte-identical to the prior behavior.
  const enabled = resolvedSetup.operations.filter((o) => o.enabled)
  const sections = collectToolpathSections(enabled, project.geometry, project.nests)

  // Whether the section originated from a nest expansion (multiple sections may
  // share one seed opId; an op contributes >1 section only via expansion).
  const opSectionCount = new Map<string, number>()
  for (const sec of sections) {
    opSectionCount.set(sec.opId, (opSectionCount.get(sec.opId) ?? 0) + 1)
  }
  // A nest seed op's geometry has ownerNestId set; flag those opIds so the drill
  // canned-cycle branch falls through to the verbatim move walk (the inter-copy
  // travel must survive — it cannot be collapsed into G81 across copies).
  // WO-1388: a nest edit (gap/solver/style/seed) sets NestRecord.needsRecompute
  // but leaves the seed geometry's loops untouched, so the seed op's OWN
  // generation fingerprint still matches — operationGenerationIsCurrent alone
  // cannot catch it. A nest that needs recompute is the same situation as any
  // other outdated input: flag its seed ops here too so the SAME status
  // downgrade (and validateOpsCurrent's existing OP_OUTDATED diagnostic) covers
  // it. No new nest-specific gate.
  const geoById = new Map(project.geometry.map((g) => [g.id, g]))
  const nestById = new Map((project.nests ?? []).map((n) => [n.id, n]))
  const nestExpandedOpIds = new Set<string>()
  const staleNestOpIds = new Set<string>()
  for (const op of enabled) {
    const geoId = (op.params as { geometryId?: string } | undefined)?.geometryId
    const geo = geoId ? geoById.get(geoId) : undefined
    if (geo?.ownerNestId === undefined) continue
    nestExpandedOpIds.add(op.id)
    if (nestById.get(geo.ownerNestId)?.needsRecompute === true) staleNestOpIds.add(op.id)
  }

  const downgradeIfOutdated = (op: Operation): Operation => {
    if (op.status !== 'ready') return op
    if (staleNestOpIds.has(op.id)) {
      return {
        ...op,
        status: 'outdated' as const,
        errorMessage:
          'This operation\'s nest needs recompute; its packed placements no longer match ' +
          'the nest\'s current settings. Recompute the nest before posting.',
      }
    }
    if (!operationGenerationIsCurrent(project, setup, op)) {
      return {
        ...op,
        status: 'outdated' as const,
        errorMessage: 'Generated toolpath inputs no longer match the current operation.',
      }
    }
    return op
  }

  for (const sec of sections) {
    const op = enabled.find((o) => o.id === sec.opId)
    if (!op) continue // section's owning op was not enabled (defensive)

    const { tool, toolNumberAssigned } = resolveTool(sec.toolId)

    const feeds = resolveFeedrates(tool, op.feedrateOverride, rapidCeiling)
    const spindle = resolveSpindle(op, tool, project.machine)
    const coolant = resolveCoolant(tool, project.machine)

    const nestExpanded =
      nestExpandedOpIds.has(op.id) || (opSectionCount.get(op.id) ?? 0) > 1
    const postOp = downgradeIfOutdated(op)
    operations.push({
      op: postOp,
      tool,
      feeds,
      spindle,
      coolant,
      moves: sec.moves,
      ...(nestExpanded ? { nestExpanded: true } : {}),
      ...(toolNumberAssigned ? { toolNumberAssigned: true } : {}),
    })
  }

  // CAM-12: collectToolpathSections SILENTLY DROPS a moveless op
  // (nestRuntime.ts), so an ENABLED op that produced no section never became a
  // PostOperation above and the pre-emission validators never saw it - posting
  // could emit a header/footer program with missing (or zero) cutting moves
  // behind a green/edited scope, silently. The worst case is the stale-green op
  // a browser refresh produces: 'ready' with no toolpath, dropped here, so
  // validateOpsReady's OP_NO_TOOLPATH guard (validate.ts) was UNREACHABLE for
  // exactly the defect it was written for. Re-add every such op with empty moves
  // so the pre-emission validators refuse the run loud (ADR-0003):
  //   - 'ready' + no moves  -> OP_NO_TOOLPATH
  //   - 'outdated'/'pending'/'computing'/'error'/'degraded'/'unsupported' + no
  //     moves -> the matching validateOpsCurrent diagnostic.
  // Nest ops are exempt by construction: a computed seed ALWAYS carries base
  // moves (its copies fold into ONE section under the nest's first op), so an op
  // WITH moves is skipped here - only genuinely moveless enabled ops surface.
  const emittedOpIds = new Set(operations.map((o) => o.op.id))
  for (const op of enabled) {
    if (emittedOpIds.has(op.id)) continue         // already a PostOperation (has a section)
    // A non-displayable status may still carry persisted legacy moves. It was
    // intentionally rejected by collectToolpathSections and must be re-added
    // with NO moves so post validation refuses it loudly by status. Only a
    // computed nest seed can be absent here because it folded into a section.
    if (
      (op.status === 'ready' || op.status === 'outdated' || op.status === 'degraded') &&
      op.toolpathMoves && op.toolpathMoves.length > 0
    ) continue
    const { tool, toolNumberAssigned } = resolveTool(op.toolId)
    const feeds = resolveFeedrates(tool, op.feedrateOverride, rapidCeiling)
    const spindle = resolveSpindle(op, tool, project.machine)
    const coolant = resolveCoolant(tool, project.machine)
    const postOp = downgradeIfOutdated(op)
    operations.push({
      op: postOp, tool, feeds, spindle, coolant, moves: [],
      ...(toolNumberAssigned ? { toolNumberAssigned: true } : {}),
    })
  }

  const orderedOpIds = resolvedSetup.operations.map((op) => op.id)
  const operatorStops = resolveOperatorStops(
    orderedOpIds,
    new Set(operations.map((o) => o.op.id)),
    operatorStopsFromActions(orderedOpIds, resolvedSetup.machineActions),
  )

  return {
    machine: project.machine,
    setup: { wcs: resolvedSetup.wcs, operations, ...(operatorStops ? { operatorStops } : {}) },
    stocks: project.stocks,
    setupId: setup.id,
  }
}
