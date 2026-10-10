// Confirm-overlay view model (interaction framework, MODIFY-tool rework).
//
// Some MODIFY flows stage work and apply it only on explicit
// confirmation: fillet accumulates corners, offset locks a side, the
// patterns place a vector/center — each then shows a floating overlay
// with the editable value(s) and Apply/Cancel. This PURE module answers
// "is the overlay up right now, and what does it show?" from the SAME
// ToolState the machine owns, so the overlay can never disagree with
// what Apply will do. The component renders the model verbatim; field
// edits dispatch the per-field store setters and the live previews
// re-render through the tool overlay channel.

import type { Vec2, SketchEntity, SketchConstraint, SketchDimension } from './types'
import type { SketchToolId, ToolState } from './tools/toolMachine'
import { filletChainPreview } from './tools/filletTool'
import { chamferChainPreview } from './tools/chamferTool'
import { computeOffset } from './tools/offsetTool'
import { patternPathLength } from './tools/patternTools'
import {
  TRANSFORM_OP_LABEL, transformApply, transformPlaced,
} from './tools/transformTools'

/** Editable overlay field. `id` keys the store setter the component
 *  dispatches on change. */
export interface ConfirmOverlayField {
  id:
    | 'fillet-radius' | 'chamfer-setback' | 'chamfer-d2' | 'chamfer-angle'
    | 'offset-distance' | 'pattern-count' | 'pattern-angle' | 'pattern-path-spacing'
    | 'move-dx' | 'move-dy' | 'rotate-angle' | 'scale-factor'
  label: string
  value: number
  unit: string | null
  /** Whole numbers only (pattern counts). */
  integer: boolean
  min: number
}

/** WO-1570: one button of the chamfer's mode selector. WO-1569 reuses the
 *  same mechanism for the path pattern's spacing-mode selector. */
export interface ConfirmOverlayModeOption {
  id: 'equal' | 'two-distance' | 'distance-angle' | 'path-spacing-equal' | 'path-spacing-fixed'
  label: string
  selected: boolean
}

export interface ConfirmOverlayModel {
  tool: SketchToolId
  title: string
  /** Live summary line ("3 corners staged - 1 does not fit"). */
  info: string | null
  /** Explicit keyboard next-step so the user is never left guessing which
   *  key applies the staged work ("Enter to apply - Esc to cancel"). The
   *  fillet/chamfer radius popup near the cursor otherwise swallows the
   *  FIRST Enter to set the typed value, so the batch takes a SECOND Enter;
   *  this line (plus the popup's own hint) makes that two-key flow explicit. */
  hint: string
  fields: ConfirmOverlayField[]
  /** On/off options beside the fields (transform tools: Keep original). */
  toggles?: ConfirmOverlayToggle[]
  /** WO-1570: chamfer's Equal distance / Two distances / Distance and
   *  angle selector. Absent for every other tool. */
  modeOptions?: ConfirmOverlayModeOption[]
  /** WO-1570: chamfer's Swap control is meaningful once a mode carries two
   *  independent operands (not plain equal-distance). */
  swapAvailable?: boolean
  applyLabel: string
}

/** Checkbox option. `id` keys the setter the component dispatches. */
export interface ConfirmOverlayToggle {
  id: 'keep-original' | 'follow-tangent'
  label: string
  checked: boolean
}

/** Document + parameter context (mirrors the tool overlay ctx). */
export interface ConfirmOverlayCtx {
  entities: readonly SketchEntity[]
  constraints?: readonly SketchConstraint[]
  dimensions?: readonly SketchDimension[]
  filletRadius?: number
  chamferSetback?: number
  offsetDistance?: number
  linearPatternCount?: number
  circularPatternCount?: number
  circularPatternAngleDeg?: number
}

function docOf(ctx: ConfirmOverlayCtx): {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  dimensions: SketchDimension[]
} {
  return {
    entities: [...ctx.entities],
    constraints: [...(ctx.constraints ?? [])],
    dimensions: [...(ctx.dimensions ?? [])],
  }
}

/**
 * The overlay model for the current machine state, or null when no
 * staged flow is awaiting confirmation.
 */
export function confirmOverlayModel(
  state: ToolState, ctx: ConfirmOverlayCtx,
): ConfirmOverlayModel | null {
  const chain = state.chain
  if (!chain) return null

  if (chain.kind === 'fillet' && chain.corners.length > 0) {
    const radius = ctx.filletRadius ?? 2
    const pv = filletChainPreview(chain, docOf(ctx), radius)
    const n = chain.corners.length
    let info = `${n} ${n === 1 ? 'corner' : 'corners'} staged`
    if (pv.misfits > 0) {
      info += ` - ${pv.misfits} ${pv.misfits === 1 ? 'does' : 'do'} not fit (skipped on Apply)`
    }
    return {
      tool: 'fillet',
      title: 'Fillet',
      info,
      hint: 'Enter to apply the fillet - Esc to cancel',
      fields: [{
        id: 'fillet-radius', label: 'Radius', value: radius,
        unit: 'mm', integer: false, min: 0.01,
      }],
      applyLabel: 'Apply',
    }
  }

  if (chain.kind === 'chamfer' && chain.corners.length > 0) {
    const setback = ctx.chamferSetback ?? 2
    // WO-1570: mode/d2/angle/swap ride on each staged corner (not a new
    // toolStore scalar); every corner in a batch is kept in sync by the
    // mode/swap edits (chamferSetMode etc.), so the first corner is
    // representative of the whole batch.
    const mode = chain.corners[0]?.mode ?? 'equal'
    const d2 = chain.corners[0]?.d2 ?? setback
    const angleDeg = chain.corners[0]?.angleDeg ?? 45
    const pv = chamferChainPreview(chain, docOf(ctx), setback)
    const n = chain.corners.length
    let info = `${n} ${n === 1 ? 'corner' : 'corners'} staged`
    if (pv.misfits > 0) {
      info += ` - ${pv.misfits} ${pv.misfits === 1 ? 'does' : 'do'} not fit (skipped on Apply)`
    }
    const fields: ConfirmOverlayField[] = mode === 'two-distance'
      ? [
          { id: 'chamfer-setback', label: 'd1', value: setback, unit: 'mm', integer: false, min: 0.01 },
          { id: 'chamfer-d2', label: 'd2', value: d2, unit: 'mm', integer: false, min: 0.01 },
        ]
      : mode === 'distance-angle'
        ? [
            { id: 'chamfer-setback', label: 'Distance', value: setback, unit: 'mm', integer: false, min: 0.01 },
            { id: 'chamfer-angle', label: 'Angle', value: angleDeg, unit: 'deg', integer: false, min: 0.01 },
          ]
        : [{ id: 'chamfer-setback', label: 'Setback', value: setback, unit: 'mm', integer: false, min: 0.01 }]
    return {
      tool: 'chamfer',
      title: 'Chamfer',
      info,
      hint: 'Enter to apply the chamfer - Esc to cancel',
      fields,
      modeOptions: [
        { id: 'equal', label: 'Equal distance', selected: mode === 'equal' },
        { id: 'two-distance', label: 'Two distances', selected: mode === 'two-distance' },
        { id: 'distance-angle', label: 'Distance and angle', selected: mode === 'distance-angle' },
      ],
      swapAvailable: mode !== 'equal',
      applyLabel: 'Apply',
    }
  }

  if (chain.kind === 'linpat' && chain.vector) {
    const count = ctx.linearPatternCount ?? 3
    const n = chain.ids.length
    return {
      tool: 'pattern-linear',
      title: 'Linear Pattern',
      info: `${n} ${n === 1 ? 'entity' : 'entities'} x ${count} instances`,
      hint: 'Enter to place the pattern - Esc to cancel',
      fields: [{
        id: 'pattern-count', label: 'Count', value: count,
        unit: null, integer: true, min: 2,
      }],
      applyLabel: 'OK',
    }
  }

  if (chain.kind === 'circpat' && chain.center) {
    const count = ctx.circularPatternCount ?? 4
    const angle = ctx.circularPatternAngleDeg ?? 360 / count
    const n = chain.ids.length
    return {
      tool: 'pattern-circular',
      title: 'Circular Pattern',
      info: `${n} ${n === 1 ? 'entity' : 'entities'} x ${count} instances`,
      hint: 'Enter to place the pattern - Esc to cancel',
      fields: [
        {
          id: 'pattern-count', label: 'Count', value: count,
          unit: null, integer: true, min: 2,
        },
        {
          id: 'pattern-angle', label: 'Step', value: angle,
          unit: 'deg', integer: false, min: -360,
        },
      ],
      applyLabel: 'OK',
    }
  }

  if (chain.kind === 'pathpat' && chain.path) {
    const n = chain.ids.length
    const len = patternPathLength(chain.path)
    const fields: ConfirmOverlayField[] = [
      {
        id: 'pattern-count', label: 'Count', value: chain.count,
        unit: null, integer: true, min: 2,
      },
    ]
    if (chain.spacingMode === 'fixed') {
      fields.push({
        id: 'pattern-path-spacing', label: 'Spacing', value: chain.fixedSpacing,
        unit: 'mm', integer: false, min: 0.01,
      })
    }
    return {
      tool: 'pattern-path',
      title: 'Path Pattern',
      info: `${n} ${n === 1 ? 'entity' : 'entities'} x ${chain.count} instances ` +
        `- path ${len.toFixed(2)} mm`,
      hint: 'Enter to place the pattern - Esc to cancel',
      fields,
      modeOptions: [
        { id: 'path-spacing-equal', label: 'Equal spacing', selected: chain.spacingMode === 'equal' },
        { id: 'path-spacing-fixed', label: 'Fixed distance', selected: chain.spacingMode === 'fixed' },
      ],
      toggles: [{ id: 'follow-tangent', label: 'Follow tangent', checked: chain.followTangent }],
      applyLabel: 'OK',
    }
  }

  if (chain.kind === 'transform' && transformPlaced(chain)) {
    const title = TRANSFORM_OP_LABEL[chain.op]
    const n = chain.ids.length
    // Live consequence line: what OK would do right now, including the
    // outside ties it releases (the same transformApply OK runs).
    const r = transformApply(chain, docOf(ctx), () => 'overlay-probe')
    let info = typeof r === 'string'
      ? r
      : `${n} ${n === 1 ? 'entity' : 'entities'}${chain.keepOriginal ? ' - copy' : ''}`
    if (typeof r !== 'string' && r.released > 0) {
      info += ` - releases ${r.released} ${r.released === 1 ? 'tie' : 'ties'} to outside geometry`
    }
    const fields: ConfirmOverlayField[] =
      chain.op === 'move'
        ? [
            { id: 'move-dx', label: 'dX', value: chain.dx, unit: 'mm', integer: false, min: -1e6 },
            { id: 'move-dy', label: 'dY', value: chain.dy, unit: 'mm', integer: false, min: -1e6 },
          ]
        : chain.op === 'rotate'
          ? [{ id: 'rotate-angle', label: 'Angle', value: chain.angleDeg, unit: 'deg', integer: false, min: -360 }]
          : [{ id: 'scale-factor', label: 'Factor', value: chain.factor, unit: null, integer: false, min: 0.0001 }]
    return {
      tool: chain.op,
      title,
      info,
      hint: `Enter to ${chain.op} - Esc to go back a step`,
      fields,
      toggles: [{ id: 'keep-original', label: 'Keep original', checked: chain.keepOriginal }],
      applyLabel: 'OK',
    }
  }

  if (chain.kind === 'offset' && chain.lockedSide !== null) {
    const d = ctx.offsetDistance ?? 2
    const geo = computeOffset(chain.source, chain.lockedSide, d)
    return {
      tool: 'offset',
      title: 'Offset',
      // A distance the shape cannot take explains itself live (OK would
      // refuse with the same reason).
      info: typeof geo === 'string'
        ? geo
        : `side locked - click the sketch to flip`,
      hint: 'Enter to apply the offset - Esc to cancel',
      fields: [{
        id: 'offset-distance', label: 'Distance', value: d,
        unit: 'mm', integer: false, min: 0.01,
      }],
      applyLabel: 'OK',
    }
  }

  return null
}

/** True when Enter should APPLY the staged flow instead of ending the
 *  chain (the store's sketchToolEnd consults this). */
export function confirmOverlayActive(
  state: ToolState, ctx: ConfirmOverlayCtx,
): boolean {
  return confirmOverlayModel(state, ctx) !== null
}

/** Where the staged geometry sits (overlay positioning hint): centroid
 *  of the staged corner points / source geometry, or null. */
export function confirmOverlayAnchor(state: ToolState): Vec2 | null {
  const chain = state.chain
  if (!chain) return null
  if (
    (chain.kind === 'fillet' || chain.kind === 'chamfer') &&
    chain.corners.length > 0
  ) {
    let x = 0, y = 0
    for (const c of chain.corners) { x += c.at.x; y += c.at.y }
    return { x: x / chain.corners.length, y: y / chain.corners.length }
  }
  return null
}
