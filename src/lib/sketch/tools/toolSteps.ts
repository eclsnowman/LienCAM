// Tool step sequences (interaction framework; PLAN.md 3.4 doctrine).
//
// Every armed tool declares its STEP SEQUENCE: the ordered user gestures
// that take the tool from freshly armed to a committed result. Each step
// carries an imperative prompt ("Click the mirror line"), what gesture it
// expects, and (when bounded) how many operands it needs. toolStepStatus
// derives the CURRENT step + collected operand count from the SAME
// ToolState the machine owns — the prompt can never disagree with what
// the next click actually does, because both read the same chain payload.
//
// Consumers: the sketch prompt bar (persistent "what do I do now?" UI)
// and the right-click context menu (confirm/cancel affordances). PURE
// module following the toolMachine doctrine: no store, no DOM.
//
// HONESTY RULE: prompts describe the tool's behavior TODAY. When a tool's
// flow changes (per-tool preview/confirm rework), its sequence here must
// change in the same commit.

import type { SketchEntity } from '../types'
import type { SketchToolId, ToolState } from './toolMachine'
import { opEntityId, planDimension } from './dimTool'
import { bezierChainAnchorCount } from './splineTools'

/** Gesture a step expects from the user.
 *    entity-pick  click ON existing geometry (pick tools, set building)
 *    point-click  click a location on the sketch plane
 *    confirm      Enter / Confirm button (no pointer gesture)
 *    value        numeric input (toolbox parameter rows / dim editor)   */
export type StepExpects = 'entity-pick' | 'point-click' | 'confirm' | 'value'

export interface ToolStep {
  id: string
  /** Imperative user instruction, shown verbatim in the prompt bar. */
  prompt: string
  expects: StepExpects
  /** Fixed operand count for the step, when bounded. Open-ended
   *  accumulation steps (mirror/pattern sets, line chaining) omit it. */
  count?: number
}

// ---- Step declarations ------------------------------------------------------
//
// One sequence per armable tool, honest to the CURRENT click behavior in
// toolMachine.ts and the per-tool modules. 'select' has no sequence (it
// is the rest state, not an armed tool).

const STEPS: Record<Exclude<SketchToolId, 'select'>, readonly ToolStep[]> = {
  point: [
    { id: 'place', prompt: 'Click to place a point', expects: 'point-click', count: 1 },
  ],
  line: [
    { id: 'start', prompt: 'Click the start point', expects: 'point-click', count: 1 },
    {
      id: 'next',
      prompt: 'Click the next point - click the start to close, Enter to finish',
      expects: 'point-click',
    },
  ],
  'rect-corner': [
    { id: 'corner-a', prompt: 'Click the first corner (Tab: angled rectangle)', expects: 'point-click', count: 1 },
    { id: 'corner-b', prompt: 'Click the opposite corner', expects: 'point-click', count: 1 },
  ],
  'rect-center': [
    { id: 'center', prompt: 'Click the rectangle center (Tab: angled rectangle)', expects: 'point-click', count: 1 },
    { id: 'corner', prompt: 'Click a corner', expects: 'point-click', count: 1 },
  ],
  'circle-center': [
    { id: 'center', prompt: 'Click the circle center', expects: 'point-click', count: 1 },
    { id: 'radius', prompt: 'Click to set the radius', expects: 'point-click', count: 1 },
  ],
  'circle-3pt': [
    { id: 'p1', prompt: 'Click the first rim point', expects: 'point-click', count: 1 },
    { id: 'p2', prompt: 'Click the second rim point', expects: 'point-click', count: 1 },
    { id: 'p3', prompt: 'Click the third rim point', expects: 'point-click', count: 1 },
  ],
  ellipse: [
    { id: 'center', prompt: 'Click the ellipse center', expects: 'point-click', count: 1 },
    {
      id: 'major',
      prompt: 'Click the major-axis end - sets size and rotation',
      expects: 'point-click',
      count: 1,
    },
    {
      id: 'minor',
      prompt: 'Click to set the minor radius',
      expects: 'point-click',
      count: 1,
    },
  ],
  'ellipse-arc': [
    { id: 'center', prompt: 'Click the ellipse center', expects: 'point-click', count: 1 },
    {
      id: 'major',
      prompt: 'Click the major-axis end - sets size and rotation',
      expects: 'point-click',
      count: 1,
    },
    {
      id: 'minor',
      prompt: 'Click to set the minor radius',
      expects: 'point-click',
      count: 1,
    },
    { id: 'start', prompt: 'Click the arc start point', expects: 'point-click', count: 1 },
    { id: 'end', prompt: 'Click the arc end point - sweeps CCW from the start', expects: 'point-click', count: 1 },
  ],
  spline: [
    { id: 'start', prompt: 'Click the first spline point', expects: 'point-click', count: 1 },
    {
      id: 'through',
      prompt: 'Click to add a through-point - Enter or double-click to finish',
      expects: 'point-click',
    },
  ],
  'spline-control': [
    { id: 'start', prompt: 'Click the first control point', expects: 'point-click', count: 1 },
    {
      id: 'control',
      prompt: 'Click to add a control point - Enter or double-click to finish',
      expects: 'point-click',
    },
  ],
  conic: [
    { id: 'start', prompt: 'Click the conic start point', expects: 'point-click', count: 1 },
    { id: 'end', prompt: 'Click the conic end point', expects: 'point-click', count: 1 },
    {
      id: 'apex',
      prompt: 'Click the apex where the two end tangents meet - rho sets the fullness',
      expects: 'point-click',
      count: 1,
    },
  ],
  bezier: [
    {
      id: 'start',
      prompt: 'Press for the first anchor - drag out its handle, or release for a corner',
      expects: 'point-click',
      count: 1,
    },
    {
      id: 'anchor',
      prompt: 'Press for the next anchor and drag its handle - Enter or double-click to finish',
      expects: 'point-click',
    },
  ],
  text: [
    {
      id: 'place',
      prompt: 'Click a point or a curve to place text - type right in the canvas',
      expects: 'point-click',
      count: 1,
    },
  ],
  'arc-3pt': [
    { id: 'start', prompt: 'Click the arc start point', expects: 'point-click', count: 1 },
    { id: 'end', prompt: 'Click the arc end point', expects: 'point-click', count: 1 },
    {
      id: 'bulge',
      prompt: 'Click to shape the arc through the cursor',
      expects: 'point-click',
      count: 1,
    },
  ],
  'arc-center': [
    { id: 'center', prompt: 'Click the arc center', expects: 'point-click', count: 1 },
    {
      id: 'start',
      prompt: 'Click the arc start - sets the radius',
      expects: 'point-click',
      count: 1,
    },
    { id: 'end', prompt: 'Click the arc end', expects: 'point-click', count: 1 },
  ],
  'arc-tangent': [
    {
      id: 'from',
      prompt: 'Click a line or arc endpoint to start from',
      expects: 'entity-pick',
      count: 1,
    },
    { id: 'end', prompt: 'Click the arc end point', expects: 'point-click', count: 1 },
  ],
  gear: [
    { id: 'center', prompt: 'Click the gear center', expects: 'point-click', count: 1 },
    { id: 'rotation', prompt: 'Click to set rotation - size is teeth x module', expects: 'point-click', count: 1 },
  ],
  polygon: [
    { id: 'center', prompt: 'Click the polygon center', expects: 'point-click', count: 1 },
    {
      id: 'vertex',
      prompt: 'Click to place a vertex - sets size and rotation',
      expects: 'point-click',
      count: 1,
    },
  ],
  slot: [
    { id: 'cap-a', prompt: 'Click the first cap center', expects: 'point-click', count: 1 },
    { id: 'cap-b', prompt: 'Click the second cap center', expects: 'point-click', count: 1 },
    { id: 'width', prompt: 'Click to set the slot width', expects: 'point-click', count: 1 },
  ],
  'slot-arc': [
    { id: 'start', prompt: 'Click the centerline arc start', expects: 'point-click', count: 1 },
    { id: 'end', prompt: 'Click the centerline arc end', expects: 'point-click', count: 1 },
    {
      id: 'thru',
      prompt: 'Click a point on the arc to shape the centerline',
      expects: 'point-click',
      count: 1,
    },
    { id: 'width', prompt: 'Click to set the slot width', expects: 'point-click', count: 1 },
  ],
  'smart-dimension': [
    {
      id: 'operands',
      prompt: 'Click a line, circle, arc, or point to dimension ' +
        '(two lines = angle)',
      expects: 'entity-pick',
    },
    {
      id: 'place',
      prompt: 'Click empty space to place the dimension - or click another entity to add it',
      expects: 'point-click',
      count: 1,
    },
  ],
  trim: [
    {
      id: 'cut',
      prompt:
        'Hover a curve to highlight what a click removes - click or ' +
        'drag-swipe to trim; constraints repair automatically',
      expects: 'entity-pick',
      count: 1,
    },
  ],
  split: [
    {
      id: 'pick',
      prompt:
        'Click a line, arc or circle to split at that point (a circle ' +
        'needs a second point)',
      expects: 'entity-pick',
      count: 1,
    },
    {
      id: 'second',
      prompt: 'Click a second point on the circle to complete the split',
      expects: 'point-click',
      count: 1,
    },
  ],
  extend: [
    {
      id: 'pick',
      prompt: 'Click the line or arc to extend',
      expects: 'entity-pick',
      count: 1,
    },
    {
      id: 'target',
      prompt:
        'Move toward the boundary to extend to - the ghost previews it, ' +
        'click to apply; joints stay anchored at the virtual corner',
      expects: 'point-click',
      count: 1,
    },
  ],
  fillet: [
    {
      id: 'corners',
      prompt:
        'Click corner points - or pairs of lines - to stage fillets ' +
        '(click again to remove)',
      expects: 'entity-pick',
    },
    {
      id: 'confirm',
      prompt:
        'Set the radius in the overlay - Apply (Enter) adds each fillet ' +
        'with a driving radius dimension you can edit later',
      expects: 'confirm',
    },
  ],
  chamfer: [
    {
      id: 'corners',
      prompt:
        'Click corner points - or pairs of lines - to stage chamfers ' +
        '(click again to remove)',
      expects: 'entity-pick',
    },
    {
      id: 'confirm',
      prompt:
        'Adjust the setback in the overlay - Apply (Enter) chamfers the ' +
        'staged corners',
      expects: 'confirm',
    },
  ],
  offset: [
    { id: 'source', prompt: 'Click the curve or chain to offset', expects: 'entity-pick', count: 1 },
    {
      id: 'side',
      prompt:
        'Move the cursor to the side to offset toward - the ghost ' +
        'previews it, click to lock the side',
      expects: 'point-click',
      count: 1,
    },
    {
      id: 'confirm',
      prompt:
        'Adjust the distance in the overlay - OK (Enter) creates the offset',
      expects: 'confirm',
    },
  ],
  mirror: [
    {
      id: 'set',
      prompt: 'Click entities to mirror - click one again to remove it',
      expects: 'entity-pick',
    },
    {
      id: 'axis',
      prompt:
        'Hover a construction line to preview the mirror - click it to ' +
        'apply, or Confirm (Enter) to close the set and mirror about ' +
        'ANY line (or click more entities to add)',
      expects: 'entity-pick',
      count: 1,
    },
  ],
  'pattern-linear': [
    {
      id: 'set',
      prompt:
        'Click entities to pattern - Confirm (Enter) closes the set',
      expects: 'entity-pick',
    },
    {
      id: 'anchor',
      prompt: 'Click the step-vector start point',
      expects: 'point-click',
      count: 1,
    },
    {
      id: 'step',
      prompt:
        'Click the step-vector end point - ghosts preview the copies',
      expects: 'point-click',
      count: 1,
    },
    {
      id: 'confirm',
      prompt:
        'Adjust the count in the overlay - OK (Enter) creates the copies',
      expects: 'confirm',
    },
  ],
  'pattern-circular': [
    {
      id: 'set',
      prompt:
        'Click entities to pattern - Confirm (Enter) closes the set',
      expects: 'entity-pick',
    },
    {
      id: 'center',
      prompt:
        'Click the rotation center - the ghost ring follows the cursor',
      expects: 'point-click',
      count: 1,
    },
    {
      id: 'confirm',
      prompt:
        'Adjust count and angle in the overlay - OK (Enter) creates the copies',
      expects: 'confirm',
    },
  ],
  'pattern-path': [
    {
      id: 'set',
      prompt:
        'Click entities to pattern - Confirm (Enter) closes the set',
      expects: 'entity-pick',
    },
    {
      id: 'path',
      prompt:
        'Click the line, arc, spline, elliptical arc, or chain to use as the path',
      expects: 'entity-pick',
      count: 1,
    },
    {
      id: 'confirm',
      prompt:
        'Adjust count, spacing and orientation in the overlay - OK (Enter) creates the copies',
      expects: 'confirm',
    },
  ],
  move: [
    {
      id: 'set',
      prompt: 'Click entities to move - Confirm (Enter) closes the set',
      expects: 'entity-pick',
    },
    { id: 'base', prompt: 'Click the base point', expects: 'point-click', count: 1 },
    {
      id: 'destination',
      prompt: 'Click the destination point - the ghost follows the cursor',
      expects: 'point-click',
      count: 1,
    },
    {
      id: 'confirm',
      prompt: 'Adjust dX / dY in the overlay - OK (Enter) moves the geometry',
      expects: 'confirm',
    },
  ],
  rotate: [
    {
      id: 'set',
      prompt: 'Click entities to rotate - Confirm (Enter) closes the set',
      expects: 'entity-pick',
    },
    { id: 'center', prompt: 'Click the centre of rotation', expects: 'point-click', count: 1 },
    {
      id: 'reference',
      prompt: 'Click a point on the reference direction',
      expects: 'point-click',
      count: 1,
    },
    {
      id: 'target',
      prompt: 'Click a point on the target direction - the ghost follows the cursor',
      expects: 'point-click',
      count: 1,
    },
    {
      id: 'confirm',
      prompt: 'Adjust the angle in the overlay - OK (Enter) rotates the geometry',
      expects: 'confirm',
    },
  ],
  scale: [
    {
      id: 'set',
      prompt: 'Click entities to scale - Confirm (Enter) closes the set',
      expects: 'entity-pick',
    },
    { id: 'base', prompt: 'Click the base point', expects: 'point-click', count: 1 },
    {
      id: 'confirm',
      prompt:
        'Type the factor in the overlay, or click a reference point then a ' +
        'target point - OK (Enter) scales the geometry',
      expects: 'confirm',
    },
  ],
  project: [
    {
      id: 'loop',
      prompt: 'Click a point, edge, face, or loop to project it',
      expects: 'entity-pick',
      count: 1,
    },
  ],
}

/** Step sequence a tool declares, or null for 'select' (rest state). */
export function toolStepSequence(tool: SketchToolId): readonly ToolStep[] | null {
  return tool === 'select' ? null : STEPS[tool]
}

// Angled (Tab) rect flow is a THREE-click sequence (rectTools.ts:
// anchor -> edgeEnd -> width -> commit), shared verbatim by rect-corner and
// rect-center once rotated (rectClick's rotated branch does not distinguish
// the two modes). STEPS above only declares each tool's axis-aligned
// two-step sequence, so toolStepStatus substitutes this one when
// chain.rotated is true, keeping steps.length honest for the prompt bar's
// "Step X of Y" chip (BUG-540).
const ROTATED_RECT_STEPS: readonly ToolStep[] = [
  {
    id: 'corner-a',
    prompt: 'Click the first corner (Tab: back to axis-aligned)',
    expects: 'point-click',
    count: 1,
  },
  {
    id: 'edge-end',
    prompt: 'Click the opposite end of the first edge - sets the angle',
    expects: 'point-click',
    count: 1,
  },
  { id: 'width', prompt: 'Click to set the width', expects: 'point-click', count: 1 },
]

// ---- Current-step derivation --------------------------------------------------

export interface ToolStepStatus {
  tool: SketchToolId
  steps: readonly ToolStep[]
  /** Index of the current step in `steps`. */
  stepIndex: number
  /** The current step (== steps[stepIndex]). */
  step: ToolStep
  /** Operands collected so far across the whole flow (points anchored,
   *  entities in the set) — what the user has already given the tool. */
  operandCount: number
  /** Live instruction for the prompt bar. Defaults to step.prompt;
   *  selection-seeded flows substitute a prompt reflecting the seed. */
  prompt: string
  /** True when Enter / Confirm meaningfully completes the current step
   *  TODAY (line chaining: Enter ends the polyline without closing). */
  confirmable: boolean
}

/** Document context the derivation may need beyond the machine state.
 *  Pre-selection is now seeded into the CHAIN at arm time
 *  (armToolWithSelection) for every set-based MODIFY tool including
 *  mirror, so the status reads the chain alone — the live selection is
 *  no longer consulted here. Kept as an optional param for call-site
 *  compatibility (and future per-tool needs). */
export interface ToolStepCtx {
  entities?: readonly SketchEntity[]
  selectedIds?: readonly string[]
}

/**
 * Current step + collected operands for the armed tool, or null in
 * Select mode. Pure function of the machine state — the store exposes it
 * as a selector and the prompt bar re-renders on every transition.
 */
export function toolStepStatus(
  state: ToolState, ctx: ToolStepCtx = {},
): ToolStepStatus | null {
  if (state.tool === 'select') return null
  let steps: readonly ToolStep[] = STEPS[state.tool]
  const chain = state.chain

  let stepIndex = 0
  let operandCount = 0
  let prompt: string | null = null
  let confirmable = false

  switch (state.tool) {
    case 'point':
    case 'text':
    case 'trim':
    case 'project':
      break // stateless single-step tools: always at step 0

    case 'extend':
      if (chain?.kind === 'extend') { stepIndex = 1; operandCount = 1 }
      break

    case 'split':
      if (chain?.kind === 'split') { stepIndex = 1; operandCount = 1 }
      break

    case 'line':
      if (chain?.kind === 'line') {
        stepIndex = 1
        operandCount = chain.prevLineId ? 2 : 1
        confirmable = true // Enter ends the polyline without closing
      }
      break

    case 'rect-corner':
    case 'rect-center':
      if (chain?.kind === 'rect') {
        if (chain.rotated) {
          // 3-click angled flow: corner -> edge end -> width. Swap in the
          // 3-entry sequence so stepIndex/steps.length agree with the real
          // click count (BUG-540).
          steps = ROTATED_RECT_STEPS
          if (!chain.anchor) {
            stepIndex = 0
          } else if (!chain.edgeEnd) {
            stepIndex = 1; operandCount = 1
          } else {
            stepIndex = 2; operandCount = 2
          }
        } else if (chain.anchor) {
          stepIndex = 1; operandCount = 1
        }
      }
      break

    case 'circle-center':
      if (chain?.kind === 'circle') { stepIndex = 1; operandCount = 1 }
      break

    case 'circle-3pt':
      if (chain?.kind === 'circle') {
        stepIndex = chain.p2 ? 2 : 1
        operandCount = chain.p2 ? 2 : 1
      }
      break

    case 'ellipse':
      if (chain?.kind === 'ellipse') {
        stepIndex = chain.major ? 2 : 1
        operandCount = chain.major ? 2 : 1
      }
      break

    case 'ellipse-arc':
      if (chain?.kind === 'ellipse-arc') {
        // center placed -> step >= 1; advance one step per fixed point.
        stepIndex = chain.start ? 4 : chain.minor ? 3 : chain.major ? 2 : 1
        operandCount = stepIndex
      }
      break

    case 'bezier':
      // WO-1862: steps count ANCHORS (a bezier chain also carries handles).
      if (chain?.kind === 'spline') {
        const anchors = bezierChainAnchorCount(chain)
        stepIndex = anchors > 0 ? 1 : 0
        operandCount = anchors
        confirmable = anchors >= 2
      }
      break

    case 'conic':
      // WO-1863: start placed -> step 1, end placed -> step 2 (the apex).
      if (chain?.kind === 'conic') {
        stepIndex = chain.end ? 2 : 1
        operandCount = stepIndex
      }
      break

    case 'spline':
    case 'spline-control':
      if (chain?.kind === 'spline') {
        stepIndex = 1
        operandCount = chain.points.length
        // Enter / double-click finishes once at least 2 points exist.
        confirmable = chain.points.length >= 2
      }
      break

    case 'arc-3pt':
      if (chain?.kind === 'arc' && chain.mode === '3pt') {
        stepIndex = chain.end ? 2 : 1
        operandCount = chain.end ? 2 : 1
      }
      break

    case 'arc-center':
      if (chain?.kind === 'arc' && chain.mode === 'center') {
        stepIndex = chain.start ? 2 : 1
        operandCount = chain.start ? 2 : 1
      }
      break

    case 'arc-tangent':
      if (chain?.kind === 'arc' && chain.mode === 'tangent') {
        stepIndex = 1
        operandCount = 1
      }
      break

    case 'gear':
      if (chain?.kind === 'gear') { stepIndex = 1; operandCount = 1 }
      break

    case 'polygon':
      if (chain?.kind === 'polygon') { stepIndex = 1; operandCount = 1 }
      break

    case 'slot':
      if (chain?.kind === 'slot') {
        stepIndex = chain.b ? 2 : 1
        operandCount = chain.b ? 2 : 1
      }
      break

    case 'slot-arc':
      if (chain?.kind === 'slotArc') {
        stepIndex = chain.thru ? 3 : chain.end ? 2 : 1
        operandCount = stepIndex
      }
      break

    case 'smart-dimension': {
      const opIds = chain?.kind === 'dim' ? chain.operandIds : []
      const ops = opIds.length
      operandCount = ops
      if (ops > 0) stepIndex = 1
      // Kind-aware guidance so the angle flow names each step (the
      // angle-dim repro: the generic "click an entity" gave no sense of
      // what to do next). One picked LINE -> invite a second line for an
      // angle; two operands -> invite placement.
      const ents = ctx.entities ?? []
      // An operand is a whole-entity id OR an explicit-point { entityId, site }.
      // The angle guidance is about whole LINE BODIES only, so an explicitly
      // picked point (site set) is NOT treated as a line here.
      const bodyLineAt = (i: number) =>
        typeof opIds[i] === 'string' &&
        ents.find((e) => e.id === opEntityId(opIds[i]))?.kind === 'line'
      if (ops === 1 && bodyLineAt(0)) {
        prompt =
          'Line selected - click a SECOND line for the angle, or click ' +
          'empty space to dimension this line\'s length'
      } else if (ops === 2 && bodyLineAt(0) && bodyLineAt(1)) {
        // Consult the SAME classification planDimension resolves for the
        // preview/commit (BUG-539): parallel lines place a perpendicular
        // distance, not an angle.
        const plan = planDimension(ents, opIds)
        prompt = plan.ok && plan.plan.kind === 'distancePL'
          ? 'Two parallel lines selected - click to place the perpendicular distance dimension'
          : 'Two lines selected - click to place the angle dimension'
      } else if (ops >= 1) {
        prompt = 'Click empty space to place the dimension'
      }
      break
    }

    case 'fillet':
      if (chain?.kind === 'fillet') {
        operandCount = chain.corners.length
        if (chain.corners.length > 0) {
          stepIndex = 1
          confirmable = true // Enter = the overlay's Apply
        }
        if (chain.pendingLineId) {
          stepIndex = 0
          prompt = 'Click the second line of the corner - or the same line to unpick'
        }
      }
      break

    case 'chamfer':
      if (chain?.kind === 'chamfer') {
        operandCount = chain.corners.length
        if (chain.corners.length > 0) {
          stepIndex = 1
          confirmable = true // Enter = the overlay's Apply
        }
        if (chain.pendingLineId) {
          stepIndex = 0
          prompt = 'Click the second line of the corner - or the same line to unpick'
        }
      }
      break

    case 'offset':
      if (chain?.kind === 'offset') {
        operandCount = 1
        if (chain.lockedSide !== null) {
          stepIndex = 2
          confirmable = true // Enter = the overlay's OK
        } else {
          stepIndex = 1
        }
      }
      break

    case 'mirror': {
      const ids = chain?.kind === 'mirror' ? chain.ids : []
      if (ids.length > 0) {
        operandCount = ids.length
        if (chain?.kind === 'mirror' && chain.confirmed) {
          // Set closed via Enter: any line works as the axis.
          stepIndex = 1
          prompt =
            `${ids.length} ${plural(ids.length, 'entity', 'entities')} ` +
            'in the set - click the mirror line (any line)'
        } else if (chain?.kind === 'mirror' && chain.seeded) {
          // Pre-selected set, still OPEN: click to add/remove more, then
          // Confirm (Enter) closes it before the axis pick — exactly the
          // pattern-tool gesture (no more instant axis-pick hijack).
          stepIndex = 0
          confirmable = true
          prompt =
            `${ids.length} ${plural(ids.length, 'entity', 'entities')} ` +
            'from selection - click to add or remove, Confirm (Enter) ' +
            'closes the set'
        } else {
          // Open click-accumulate set: Enter closes it (regular-line axis).
          stepIndex = 0
          confirmable = true
        }
      }
      break
    }

    case 'pattern-linear': {
      if (chain?.kind !== 'linpat') break
      operandCount = chain.ids.length
      if (!chain.confirmed) {
        stepIndex = 0
        confirmable = chain.ids.length > 0 // Enter closes the set
        if (chain.seeded) {
          prompt =
            `${chain.ids.length} ${plural(chain.ids.length, 'entity', 'entities')} ` +
            'from selection - Confirm (Enter) closes the set, or click to adjust it'
        }
      } else if (!chain.anchor) {
        stepIndex = 1
      } else if (!chain.vector) {
        stepIndex = 2
      } else {
        stepIndex = 3
        confirmable = true // Enter = the overlay's OK
      }
      break
    }

    case 'pattern-circular': {
      if (chain?.kind !== 'circpat') break
      operandCount = chain.ids.length
      if (!chain.confirmed) {
        stepIndex = 0
        confirmable = chain.ids.length > 0
        if (chain.seeded) {
          prompt =
            `${chain.ids.length} ${plural(chain.ids.length, 'entity', 'entities')} ` +
            'from selection - Confirm (Enter) closes the set, or click to adjust it'
        }
      } else if (!chain.center) {
        stepIndex = 1
      } else {
        stepIndex = 2
        confirmable = true
      }
      break
    }

    case 'pattern-path': {
      if (chain?.kind !== 'pathpat') break
      operandCount = chain.ids.length
      if (!chain.confirmed) {
        stepIndex = 0
        confirmable = chain.ids.length > 0
        if (chain.seeded) {
          prompt =
            `${chain.ids.length} ${plural(chain.ids.length, 'entity', 'entities')} ` +
            'from selection - Confirm (Enter) closes the set, or click to adjust it'
        }
      } else if (!chain.path) {
        stepIndex = 1
      } else {
        stepIndex = 2
        confirmable = true
      }
      break
    }

    case 'move':
    case 'rotate':
    case 'scale': {
      if (chain?.kind !== 'transform') break
      operandCount = chain.ids.length
      if (!chain.confirmed) {
        stepIndex = 0
        confirmable = chain.ids.length > 0 // Enter closes the set
        if (chain.seeded) {
          prompt =
            `${chain.ids.length} ${plural(chain.ids.length, 'entity', 'entities')} ` +
            'from selection - Confirm (Enter) closes the set, or click to adjust it'
        }
        break
      }
      // Placement steps run base -> ref -> target; the last step is the
      // overlay (move: after the destination, rotate: after the target
      // direction, scale: straight after the base point).
      const placed = [chain.base, chain.ref, chain.target].filter((p) => p !== null).length
      stepIndex = Math.min(1 + placed, steps.length - 1)
      confirmable = stepIndex === steps.length - 1 // Enter = the overlay's OK
      break
    }
  }

  const step = steps[stepIndex]
  return {
    tool: state.tool,
    steps,
    stepIndex,
    step,
    operandCount,
    prompt: prompt ?? step.prompt,
    confirmable,
  }
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}
