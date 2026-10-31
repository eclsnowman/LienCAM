// WO-3221 (WO-3176 Brief B): Create tab removal contour.
//
// A pure authoring adapter, not an emitter. From a computed tabbed Contour it
// authors a SEPARATE finishing-only Contour - same tool, outline, side,
// direction and setup, allowance zero, tabs off, the source's own bottom - and
// the additive `tabRemovalSource` binding that ties it to that source. The
// existing Contour planner cuts it; nothing here plans motion.
//
// The source operation, its settings and its tab locations are never written.
// Removal is all tabs on the targeted outlines: a selection of only some tabs
// is refused (selective removal is not implemented), as is removal from a
// flipped second side.

import type { ContourTabPreview, Operation, Setup, Tool } from '../../types'
import {
  DEFAULT_CONTOUR_TABS,
  type ContourParams,
  type ContourTabRemovalSource,
  type ContourTabRemovalTarget,
} from './types'
import { buildContourTabPlan, sampleTabPath } from './contour2d'
import { normalizeToolCutHand } from '../tool/cutHand'

/** Why Create tab removal contour cannot make the requested cleanup. */
export type ContourTabRemovalRefusal =
  | 'missing'
  | 'not-contour'
  | 'is-cleanup'
  | 'open'
  | 'tabs-off'
  | 'generate-first'
  | 'stale'
  | 'no-tabs'
  | 'selective'
  | 'flipped'

/** Why a saved tab removal contour cannot be generated as it stands. */
export type ContourTabRemovalComputeRefusal =
  | 'binding-malformed'
  | 'source-missing'
  | 'source-other-setup'
  | 'source-after'
  | 'source-disabled'
  | 'source-changed'
  | 'cleanup-changed'

export type TabRemovalBindingRead =
  | { kind: 'none' }
  | { kind: 'malformed' }
  | { kind: 'bound'; binding: ContourTabRemovalSource }

function canonical(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : String(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonical)
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => [key, canonical(entry)]))
}

function hash(text: string): string {
  let a = 0x811c9dc5, b = 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

/**
 * The source's authored cut inputs that decide where its tabs are and what
 * outline the cleanup traces: outline, side, direction, tabs and their saved
 * locations, height authority (the intended bottom), and the cutter's size and
 * hand. Name, on/off, feeds and computed output are not part of it, so a
 * progress write or a rename never changes it.
 */
export function contourTabRemovalSourceIdentity(source: Operation, tool: Tool | undefined): string {
  const { tabRemovalSource: _binding, ...params } = source.params as unknown as ContourParams
  return `tabsrc-v1-${hash(JSON.stringify(canonical({
    type: source.type,
    toolId: source.toolId,
    geometrySelections: source.geometrySelections,
    modelReferences: source.modelReferences,
    smartHeight: source.smartHeight,
    params,
    tool: tool ? { diameter: tool.diameter, cutHand: normalizeToolCutHand(tool.cutHand) } : null,
  })))}`
}

/** Read a contour's saved binding. Anything present but not well formed is
 *  'malformed' - never an unbound contour. */
export function readTabRemovalBinding(operation: Pick<Operation, 'type' | 'params'>): TabRemovalBindingRead {
  const raw = (operation.params as { tabRemovalSource?: unknown } | undefined)?.tabRemovalSource
  // Only a contour reads the key (the predecessor predicate's own rule).
  if (raw === undefined || operation.type !== 'contour_2d') return { kind: 'none' }
  const b = raw as Partial<ContourTabRemovalSource> | null
  const text = (v: unknown) => typeof v === 'string' && v.length > 0
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  const ok = b !== null && typeof b === 'object' && b.version === 1
    && text(b.sourceSetupId) && text(b.sourceOperationId) && text(b.sourceIdentity)
    && Array.isArray(b.loopIds) && b.loopIds.length > 0 && b.loopIds.every(text)
    && Array.isArray(b.targets) && b.targets.length > 0
    && b.targets.every((t) => t !== null && typeof t === 'object' && text(t.loopId) && text(t.label)
      && b.loopIds!.includes(t.loopId) && t.center !== null && typeof t.center === 'object'
      && finite(t.center.x) && finite(t.center.y) && finite(t.width) && t.width > 0
      && finite(t.height) && t.height > 0 && (t.shape === 'box' || t.shape === 'triangular'))
  return ok ? { kind: 'bound', binding: b as ContourTabRemovalSource } : { kind: 'malformed' }
}

/** True for any contour carrying a binding, well formed or not. */
export function hasTabRemovalBinding(operation: Pick<Operation, 'type' | 'params'>): boolean {
  return readTabRemovalBinding(operation).kind !== 'none'
}

/**
 * Every tab the source cuts, resolved through the SAME buildContourTabPlan
 * input the planner uses (its preview finish path, the saved fractions or even
 * spacing, re-seaming included). A loop set to 'none' carries no tabs.
 */
export function contourTabRemovalTargets(
  source: Operation,
  preview: ContourTabPreview,
): { loopIds: string[]; targets: ContourTabRemovalTarget[] } {
  const params = source.params as unknown as ContourParams
  const width = params.tabWidth ?? DEFAULT_CONTOUR_TABS.width
  const height = params.tabHeight ?? DEFAULT_CONTOUR_TABS.height
  const count = params.tabCount ?? DEFAULT_CONTOUR_TABS.count
  const shape = params.tabShape ?? 'box'
  const loopIds: string[] = []
  const targets: ContourTabRemovalTarget[] = []
  for (const loop of preview.loops) {
    const custom = params.tabLocations?.[loop.loopId]
    if (custom === 'none') continue
    const plan = buildContourTabPlan(
      loop.path,
      { width, count, shape, tabTopZ: preview.tabTopZ, stockBottomZ: preview.tabTopZ - height },
      custom && custom.length > 0 ? custom : undefined,
    )
    if (plan.intervals.length === 0) continue
    loopIds.push(loop.loopId)
    plan.intervals.forEach((interval, k) => {
      const c = sampleTabPath(plan, (interval.start + interval.end) / 2)
      targets.push({ loopId: loop.loopId, label: `${loop.loopId}#${k}`, center: { x: c.x, y: c.y }, width, height, shape })
    })
  }
  return { loopIds, targets }
}

export interface ContourTabRemovalRequest {
  setup: Setup
  source: Operation | undefined
  tool: Tool | undefined
  /** The source's tab preview still matches its live inputs (the store's contourTabSourceKey). */
  previewCurrent: boolean
  /** Labels of the tabs the operator kept selected; absent = all. */
  selectedLabels?: readonly string[]
  /** Where the cleanup is to go. Only the source's own setup is offered. */
  targetSetupId?: string
}

export type ContourTabRemovalReview =
  | { ok: true; loopIds: string[]; targets: ContourTabRemovalTarget[]; sourceIdentity: string }
  | { ok: false; reason: ContourTabRemovalRefusal }

/** What Create tab removal contour would remove, or the one reason it cannot. */
export function reviewContourTabRemoval(request: ContourTabRemovalRequest): ContourTabRemovalReview {
  const { setup, source } = request
  if (!source || !setup.operations.some((candidate) => candidate.id === source.id)) return { ok: false, reason: 'missing' }
  if (source.type !== 'contour_2d') return { ok: false, reason: 'not-contour' }
  if (hasTabRemovalBinding(source)) return { ok: false, reason: 'is-cleanup' }
  const params = source.params as unknown as ContourParams
  if ((params.pathType ?? 'closed') === 'open') return { ok: false, reason: 'open' }
  if (params.tabs !== true) return { ok: false, reason: 'tabs-off' }
  if (request.targetSetupId !== undefined && request.targetSetupId !== setup.id) return { ok: false, reason: 'flipped' }
  const preview = source.contourTabPreview
  if (source.status !== 'ready' || !preview || !Array.isArray(preview.loops) || preview.loops.length === 0) {
    return { ok: false, reason: 'generate-first' }
  }
  if (!request.previewCurrent) return { ok: false, reason: 'stale' }
  const { loopIds, targets } = contourTabRemovalTargets(source, preview)
  if (targets.length === 0) return { ok: false, reason: 'no-tabs' }
  if (request.selectedLabels !== undefined) {
    const selected = new Set(request.selectedLabels)
    if (!targets.every((target) => selected.has(target.label))) return { ok: false, reason: 'selective' }
  }
  return { ok: true, loopIds, targets, sourceIdentity: contourTabRemovalSourceIdentity(source, request.tool) }
}

export type ContourTabRemovalPlan =
  | { ok: true; operation: Operation; binding: ContourTabRemovalSource; targets: ContourTabRemovalTarget[] }
  | { ok: false; reason: ContourTabRemovalRefusal }

/**
 * Author the cleanup: a NEW operation id, finishing only (no roughing, wall
 * and floor allowance zero), tabs off, cutting exactly the targeted outlines
 * with the source's tool, side, direction, height authority (its intended
 * bottom), stepdown and entry. The source object is not modified.
 */
export function planContourTabRemoval(
  request: ContourTabRemovalRequest & { operationId: string; name: string },
): ContourTabRemovalPlan {
  const review = reviewContourTabRemoval(request)
  if (!review.ok) return review
  const source = request.source!
  const {
    tabs: _tabs, tabWidth: _width, tabHeight: _height, tabCount: _count, tabShape: _shape,
    tabLocations: _locations, contourFinishMode: _finishMode, roughingStyle: _roughing,
    trochoidalWidth: _trochoidalWidth, trochoidalAdvance: _trochoidalAdvance, ...kept
  } = source.params as unknown as ContourParams
  const binding: ContourTabRemovalSource = {
    version: 1,
    sourceSetupId: request.setup.id,
    sourceOperationId: source.id,
    sourceIdentity: review.sourceIdentity,
    loopIds: [...review.loopIds],
    targets: review.targets.map((target) => ({ ...target, center: { ...target.center } })),
  }
  const params: ContourParams = { ...structuredClone(kept), loopIds: [...review.loopIds], tabs: false, tabRemovalSource: binding }
  const operation: Operation = {
    id: request.operationId,
    name: request.name,
    type: 'contour_2d',
    enabled: true,
    ...(source.folderId !== undefined ? { folderId: source.folderId } : {}),
    status: 'pending',
    toolId: source.toolId,
    geometrySelections: [...source.geometrySelections],
    ...(source.modelReferences ? { modelReferences: structuredClone(source.modelReferences) } : {}),
    heights: structuredClone(source.heights),
    ...(source.smartHeight ? { smartHeight: structuredClone(source.smartHeight) } : {}),
    passes: { ...structuredClone(source.passes), stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1 },
    linking: structuredClone(source.linking),
    ...(source.feedrateOverride ? { feedrateOverride: structuredClone(source.feedrateOverride) } : {}),
    params: params as unknown as Record<string, unknown>,
  }
  return { ok: true, operation, binding, targets: binding.targets }
}

/**
 * Whether a saved tab removal contour can be generated as it stands. It is
 * bound to its source in the same setup, earlier in the list and on (or left
 * out of only the program being posted), with the
 * same authored cut inputs it was made from; and it still cuts that source's
 * outlines with its tool and side, tabs off. Otherwise one reason, and the
 * caller moves nothing.
 */
export function tabRemovalComputeRefusal(
  setup: Setup,
  cleanup: Operation,
  resolveTool: (toolId: string) => Tool | undefined,
  /** Operations left out of only the program being posted right now. Such a
   *  source is off for that file, not suppressed: the cleanup still generates. */
  excludedFromEmission: ReadonlySet<string> = new Set(),
): ContourTabRemovalComputeRefusal | null {
  const read = readTabRemovalBinding(cleanup)
  if (read.kind === 'none') return null
  if (read.kind === 'malformed') return 'binding-malformed'
  const { binding } = read
  if (binding.sourceSetupId !== setup.id) return 'source-other-setup'
  const sourceIndex = setup.operations.findIndex((candidate) => candidate.id === binding.sourceOperationId)
  if (sourceIndex < 0) return 'source-missing'
  const source = setup.operations[sourceIndex]
  if (sourceIndex > setup.operations.findIndex((candidate) => candidate.id === cleanup.id)) return 'source-after'
  if (source.enabled === false && !excludedFromEmission.has(source.id)) return 'source-disabled'
  if (source.type !== 'contour_2d' || contourTabRemovalSourceIdentity(source, resolveTool(source.toolId)) !== binding.sourceIdentity) {
    return 'source-changed'
  }
  const sourceParams = source.params as unknown as ContourParams
  const params = cleanup.params as unknown as ContourParams
  const sameLoops = Array.isArray(params.loopIds) && params.loopIds.length === binding.loopIds.length
    && binding.loopIds.every((id) => params.loopIds.includes(id))
  if (cleanup.toolId !== source.toolId || params.tabs === true || !sameLoops
    || params.geometryId !== sourceParams.geometryId || params.side !== sourceParams.side
    || (params.pathType ?? 'closed') !== 'closed') {
    return 'cleanup-changed'
  }
  return null
}
