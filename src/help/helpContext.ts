// Help context derivation + topic ranking (HELP-1 S2, plan section 4).
//
// The app already knows what the user is doing - these are PURE functions
// over existing store state, no behavior tracking. deriveHelpContext reads
// the cam store's snapshot; pushed keys from useHelpContext are merged by
// the caller. rankTopics turns active keys into a pinned "suggested" group.

import type { ContextKey, HelpIndexEntry } from './types'

/** The slice of cam-store state the derivation reads - structural, so tests
 *  can feed plain objects and the coupling surface stays explicit. */
export interface HelpContextSource {
  workspace: 'cam' | 'part' | 'control'
  activeModal: string | null
  viewer: {
    mode: 'setup' | 'toolpath' | 'simulation' | 'sketch'
    selectedGeometryId: string | null
    selectedStockId?: string | null
    selectedNestId?: string | null
  }
  project: {
    activeOperationId: string | null
    setups: Array<{ operations: Array<{ id: string; type: string }> }>
  }
  consoleEvents: Array<{ id: number; severity: string }>
  consoleReadThroughId: number
}

export function deriveHelpContext(s: HelpContextSource): ContextKey[] {
  const keys: ContextKey[] = []
  if (s.activeModal && s.activeModal !== 'help' && s.activeModal !== 'help-errors') {
    keys.push(`modal:${s.activeModal}`)
  }
  // WO-2529: CAM selection survives tab switches. It describes the visible
  // inspector in Setup/Toolpath, but not Sketch, Simulate, Model or Control.
  const showsCamSelection = s.workspace === 'cam' &&
    (s.viewer.mode === 'setup' || s.viewer.mode === 'toolpath')
  if (showsCamSelection && s.project.activeOperationId) {
    const op = s.project.setups
      .flatMap((setup) => setup.operations)
      .find((o) => o.id === s.project.activeOperationId)
    if (op) keys.push(`selection:operation:${op.type}`)
    keys.push('panel:properties:operation')
  } else if (showsCamSelection && s.viewer.selectedGeometryId) {
    keys.push('panel:properties:geometry')
  } else if (showsCamSelection && s.viewer.selectedStockId) {
    keys.push('panel:properties:stock')
  } else if (showsCamSelection && s.viewer.selectedNestId) {
    keys.push('panel:properties:nest')
  }
  // Model/Control retain viewer.mode for the return to CAM; it is not shown.
  if (s.workspace === 'cam') keys.push(`mode:${s.viewer.mode}`)
  keys.push(`workspace:${s.workspace}`)
  const hasUnreadError = s.consoleEvents.some(
    (e) => e.severity === 'error' && e.id > s.consoleReadThroughId,
  )
  if (hasUnreadError) keys.push('error:recent')
  return keys
}

/** Specificity order for the pinned group: an exact match on a more specific
 *  key family outranks a broader one (plan section 4). */
const ROOT_SPECIFICITY: Record<string, number> = {
  modal: 0,
  tool: 1,
  selection: 2,
  panel: 3,
  interaction: 4,
  error: 5,
  mode: 6,
  workspace: 7,
}

function bestMatchSpecificity(topic: HelpIndexEntry, active: Set<string>): number | null {
  let best: number | null = null
  for (const key of topic.contextKeys) {
    if (!active.has(key)) continue
    const root = key.split(':')[0]
    // The named CAM view wins over the retained inspector selection. Setup
    // still uses its selection first because arranging/editing it is its job.
    const rank = root === 'mode' && key !== 'mode:setup' ? 1.5 : ROOT_SPECIFICITY[root] ?? 99
    if (best === null || rank < best) best = rank
  }
  return best
}

export interface RankedTopics {
  /** Topics matching the active context, most specific first - the pinned
   *  "Suggested for what you're doing" group. */
  suggested: HelpIndexEntry[]
  /** Everything else, original index order. */
  rest: HelpIndexEntry[]
}

export function rankTopics(index: HelpIndexEntry[], activeKeys: ContextKey[]): RankedTopics {
  const active = new Set(activeKeys)
  const scored: Array<{ entry: HelpIndexEntry; rank: number; breadth: number; order: number }> = []
  const rest: HelpIndexEntry[] = []
  index.forEach((entry, order) => {
    const rank = bestMatchSpecificity(entry, active)
    if (rank === null) rest.push(entry)
    else scored.push({ entry, rank, order,
      // Narrow named CAM view/workspace ties. Setup, dialog, tool and selection
      // suggestions retain index order, including the first-toolpath walkthrough.
      breadth: rank === 1.5 || rank === ROOT_SPECIFICITY.workspace
        ? entry.contextKeys.length : 0,
    })
  })
  // A topic specific to this view precedes an overview matching many views
  // (e.g. Stock simulation before Setup, Sketch, Toolpath, Simulate).
  scored.sort((a, b) => a.rank - b.rank || a.breadth - b.breadth || a.order - b.order)
  return { suggested: scored.map((s) => s.entry), rest }
}
