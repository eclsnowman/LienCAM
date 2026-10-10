// Sketch prompt bar model (interaction framework, PLAN.md 3.4).
//
// PURE view-model layer between the tool step sequences (toolSteps.ts)
// and the prompt bar component: given the machine state + document
// context it answers "what should the bar say RIGHT NOW?" — armed tool
// name, current step instruction, live operand count, and which buttons
// (Confirm / Cancel) are meaningful. Headless-testable; the component
// renders the model verbatim.
//
// Also home to the commit FLASH messages ("Mirrored 4 entities about
// Line 7") the store pushes through the existing notice channel when a
// multi-step MODIFY tool completes — completion must be as visible as
// the steps that led to it.

import type { SketchEntity, SketchConstraint } from './types'
import type { SketchToolId, ToolState, ToolCommit } from './tools/toolMachine'
import { toolStepStatus, type ToolStepCtx } from './tools/toolSteps'
import { entityLabels } from './browserModel'

/** Display name per tool (prompt bar header; matches toolbox labels). */
export const SKETCH_TOOL_LABELS: Record<SketchToolId, string> = {
  select: 'Select',
  point: 'Point',
  line: 'Line',
  'rect-corner': 'Rectangle',
  'rect-center': 'Center Rect',
  'circle-center': 'Circle',
  'circle-3pt': '3-Pt Circle',
  ellipse: 'Ellipse',
  'ellipse-arc': 'Elliptical Arc',
  spline: 'Spline',
  'spline-control': 'Control Spline',
  bezier: 'Bezier',
  conic: 'Conic Arc',
  text: 'Text',
  'arc-3pt': '3-Pt Arc',
  'arc-tangent': 'Tangent Arc',
  'arc-center': 'Center Arc',
  polygon: 'Polygon',
  gear: 'Gear',
  slot: 'Slot',
  'slot-arc': 'Arc Slot',
  'smart-dimension': 'Smart Dimension',
  trim: 'Trim',
  split: 'Split',
  extend: 'Extend',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  offset: 'Offset',
  mirror: 'Mirror',
  'pattern-linear': 'Linear Pattern',
  'pattern-circular': 'Circular Pattern',
  'pattern-path': 'Path Pattern',
  move: 'Move',
  rotate: 'Rotate',
  scale: 'Scale',
  project: 'Project / Use',
}

/** Tools whose collected operands are ENTITIES ("3 entities selected");
 *  the multi-point CREATE tools count placed points instead. */
const ENTITY_OPERAND_TOOLS: ReadonlySet<SketchToolId> = new Set<SketchToolId>([
  'smart-dimension', 'mirror', 'pattern-linear', 'pattern-circular', 'pattern-path',
  'move', 'rotate', 'scale',
])

const POINT_OPERAND_TOOLS: ReadonlySet<SketchToolId> = new Set<SketchToolId>([
  'line', 'rect-corner', 'rect-center', 'circle-center', 'circle-3pt',
  'ellipse', 'ellipse-arc', 'spline', 'spline-control', 'bezier', 'conic', 'text', 'arc-3pt', 'arc-center', 'polygon', 'gear', 'slot', 'slot-arc',
])

export type PromptBarModel =
  | {
      /** No tool armed: quiet hint, no buttons. */
      kind: 'idle'
      hint: string
    }
  | {
      kind: 'armed'
      tool: SketchToolId
      toolLabel: string
      /** 1-based step position for the "Step 2 of 3" chip. */
      stepNumber: number
      stepCount: number
      /** Imperative instruction for the current step. */
      prompt: string
      /** Live operand summary ("3 entities selected"), or null. */
      operandText: string | null
      /** Confirm button (Enter) enabled — the step is confirmable. */
      canConfirm: boolean
    }

export const PROMPT_BAR_IDLE_HINT =
  'Select a tool - or right-click for options'

/**
 * Build the prompt bar model for the current machine state. Pure; the
 * store exposes the inputs and the bar re-renders on every transition.
 */
export function promptBarModel(
  state: ToolState, ctx: ToolStepCtx = {},
): PromptBarModel {
  const status = toolStepStatus(state, ctx)
  if (!status) return { kind: 'idle', hint: PROMPT_BAR_IDLE_HINT }

  let operandText: string | null = null
  if (status.operandCount > 0) {
    if (status.tool === 'fillet' || status.tool === 'chamfer') {
      operandText =
        `${status.operandCount} ` +
        `${status.operandCount === 1 ? 'corner' : 'corners'} staged`
    } else if (ENTITY_OPERAND_TOOLS.has(status.tool)) {
      operandText =
        `${status.operandCount} ` +
        `${status.operandCount === 1 ? 'entity' : 'entities'} selected`
    } else if (POINT_OPERAND_TOOLS.has(status.tool)) {
      operandText =
        `${status.operandCount} ` +
        `${status.operandCount === 1 ? 'point' : 'points'} placed`
    }
  }

  return {
    kind: 'armed',
    tool: status.tool,
    toolLabel: SKETCH_TOOL_LABELS[status.tool],
    stepNumber: status.stepIndex + 1,
    stepCount: status.steps.length,
    prompt: status.prompt,
    operandText,
    canConfirm: status.confirmable,
  }
}

// ---- Commit flash messages ------------------------------------------------------

/**
 * Status flash after a MODIFY tool's COMMIT lands ("Mirrored 4 entities
 * about Line 7"), or null when the tool's commits are self-evident
 * (CREATE tools draw what they made). `docEntities` is the PRE-commit
 * document — the mirror axis label is looked up there.
 */
export function toolCommitFlash(
  tool: SketchToolId,
  commit: ToolCommit,
  docEntities: readonly SketchEntity[],
): string | null {
  const n = commit.entities.length
  const ents = `${n} ${n === 1 ? 'entity' : 'entities'}`
  switch (tool) {
    case 'mirror': {
      // The commit's symmetric constraints all carry the axis id; name it
      // with the same document-order labels the constraint browser uses.
      const axisId = commit.constraints.find(
        (c): c is Extract<SketchConstraint, { kind: 'symmetric' }> =>
          c.kind === 'symmetric',
      )?.axis
      const axisLabel = axisId
        ? entityLabels(docEntities).get(axisId) ?? null
        : null
      return axisLabel
        ? `Mirrored ${ents} about ${axisLabel}`
        : `Mirrored ${ents}`
    }
    case 'pattern-linear':
      return `Linear pattern: created ${ents}`
    case 'pattern-circular':
      return `Circular pattern: created ${ents}`
    case 'pattern-path':
      return `Path pattern: created ${ents}`
    case 'offset':
      return `Offset: created ${ents}`
    default:
      return null
  }
}

/**
 * Status flash after a MODIFY tool's REPLACE transform lands (trim /
 * extend rewrite the document arrays instead of committing new
 * entities), or null for tools without one. The fillet batch flashes
 * from its overlay Apply (sketchOverlayApply), not here.
 */
export function toolReplaceFlash(tool: SketchToolId): string | null {
  switch (tool) {
    case 'trim':
      return 'Trimmed the curve at the click'
    case 'split':
      return 'Split the curve at the click'
    case 'extend':
      return 'Extended the curve to the boundary'
    default:
      return null
  }
}
