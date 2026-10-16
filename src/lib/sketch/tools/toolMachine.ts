// Sketch tool state machine (Stage 3, PLAN.md 3.4).
//
// PURE module: no store, no three.js, no DOM. The store owns the current
// ToolState and applies the transitions below; the viewport and toolbox
// only ever talk to the store. Keeping the machine pure makes every
// transition (and every entity/constraint a tool click produces) directly
// testable headless in vitest.
//
// ---- State machine (persistent armed-tool behavior) -------------------------
//
//   States:
//     SELECT            tool = 'select', chain = null  (the rest state)
//     ARMED(t)          tool = t,        chain = null  (tool ready, no
//                                                       entity in progress)
//     CHAINING(t)       tool = t,        chain != null (entity/chain in
//                                                       progress; `chain` is
//                                                       a per-tool payload,
//                                                       see ToolChainState)
//
//   Events and transitions:
//     ARM(t)        any state        -> ARMED(t)    in-progress chain is
//                                                   DISCARDED (arming a tool
//                                                   is an implicit cancel).
//                                                   ARM('select') = Select.
//     CLICK(p)      ARMED/CHAINING   -> per-tool behavior (toolClick):
//                                       - select: no-op here (selection is
//                                         the viewport's pick/marquee path)
//                                       - point:  commit a point entity,
//                                         stay ARMED (tools stay armed so
//                                         many entities can be placed
//                                         without re-clicking the button)
//                                       - line:   start/extend/close the
//                                         chain (see lineClick below)
//                                       - other CREATE tools: no-op until
//                                         their Stage 3 chunk lands
//     ESC           CHAINING         -> ARMED       first Esc cancels ONLY
//                                                   the in-progress chain;
//                                                   committed entities stay.
//     ESC           ARMED            -> SELECT      second Esc returns to
//                                                   Select.
//     ESC           SELECT           -> (not consumed: the caller clears
//                                        the selection instead)
//     ENTER / DBLCLICK  CHAINING     -> ARMED       ends the chain WITHOUT
//                                                   closing it; tool stays
//                                                   armed.
//
//   The machine never touches the document: toolClick RETURNS the entities
//   and constraints to commit (ToolCommit) and the store applies them as
//   one undo step.

import type {
  Vec2,
  PointRef,
  SketchEntity,
  SketchConstraint,
  SketchDimension,
} from '../types'
import { rectClick, rectPreview, type RectChainState } from './rectTools'
import { circleClick, circlePreview, type CircleChainState } from './circleTools'
import {
  ellipseClick, ellipsePreview, ellipseArcClick, ellipseArcPreview,
  type EllipseChainState, type EllipseArcChainState,
} from './ellipseTools'
import { arcClick, arcPreview, type ArcChainState } from './arcTools'
import {
  dimToolClick, cycleDimForceMode, dimForceFamily, type DimChainState,
} from './dimTool'
import { trimAtPoint, type SketchDocTransform } from './trimTool'
import { splitClick, type SplitChainState } from './splitTool'
import { extendClick, type ExtendChainState } from './extendTool'
import {
  filletClick, filletSeedFromSelection, type FilletChainState,
} from './filletTool'
import {
  chamferClick, chamferSeedFromSelection, type ChamferChainState,
} from './chamferTool'
import {
  offsetClick, offsetSeedFromSelection, type OffsetChainState,
} from './offsetTool'
import { mirrorClick, type MirrorChainState } from './mirrorTool'
import {
  linearPatternClick, circularPatternClick, pathPatternClick,
  type LinearPatternChainState, type CircularPatternChainState, type PathPatternChainState,
} from './patternTools'
import {
  newTransformChain, transformClick, transformEscape, transformSetIds,
  type TransformChainState, type TransformOp,
} from './transformTools'
import {
  polygonClick, polygonPreview, slotClick, slotPreview,
  arcSlotClick, arcSlotPreview,
  type PolygonChainState, type PolygonMode, type SlotChainState, type ArcSlotChainState,
} from './polygonSlotTools'
import {
  splineClick, splinePreview, bezierClick, bezierPreview, conicClick, conicPreview,
  type SplineChainState, type ConicChainState,
} from './splineTools'
import { textClick, type TextToolParams } from './textTools'
import { gearClick, gearPreview, DEFAULT_GEAR_PARAMS, type GearParams, type GearChainState } from './gearTool'

export type { RectChainState, CircleChainState, EllipseChainState, EllipseArcChainState, ArcChainState, DimChainState }
export type { SketchDocTransform, FilletChainState, ChamferChainState, OffsetChainState }
export type { ExtendChainState, SplitChainState }
export type {
  MirrorChainState, LinearPatternChainState, CircularPatternChainState, PathPatternChainState,
}
export type { TransformChainState }
export type { PolygonChainState, SlotChainState, ArcSlotChainState }
export type { SplineChainState, ConicChainState }

// All tools the toolbox can arm. CREATE tools without click behavior yet
// still arm (the union is the Stage 3 inventory); their clicks no-op until
// the chunk that implements them lands.
export type SketchToolId =
  | 'select'
  | 'point'
  | 'line'
  | 'rect-corner'
  | 'rect-center'
  | 'circle-center'
  | 'circle-3pt'
  | 'ellipse'
  | 'ellipse-arc'
  | 'spline'
  | 'spline-control'
  | 'bezier'
  | 'conic'
  | 'text'
  | 'arc-3pt'
  | 'arc-tangent'
  | 'arc-center'
  | 'polygon'
  | 'gear'
  | 'slot'
  | 'slot-arc'
  | 'smart-dimension'
  | 'trim'
  | 'split'
  | 'extend'
  | 'fillet'
  | 'chamfer'
  | 'offset'
  | 'mirror'
  | 'pattern-linear'
  | 'pattern-circular'
  | 'pattern-path'
  | 'move'
  | 'rotate'
  | 'scale'
  | 'project'

/** Tools the toolbox enables for arming. Grows chunk by chunk through
 *  Stages 3-4 as each tool's click behavior lands. */
export const ARMABLE_TOOLS: ReadonlySet<SketchToolId> = new Set<SketchToolId>([
  'point',
  'line',
  'rect-corner',
  'rect-center',
  'circle-center',
  'circle-3pt',
  'ellipse',
  'ellipse-arc',
  'spline',
  'spline-control',
  'bezier',
  'conic',
  'text',
  'arc-3pt',
  'arc-center',
  'arc-tangent',
  'polygon',
  'gear',
  'slot',
  'slot-arc',
  'smart-dimension',
  'trim',
  'split',
  'extend',
  'fillet',
  'chamfer',
  'offset',
  'mirror',
  'pattern-linear',
  'pattern-circular',
  'pattern-path',
  'move',
  'rotate',
  'scale',
  'project',
])

/** Tools whose clicks PICK existing geometry (or place a label) instead
 *  of placing new geometry. Their clicks land on the RAW cursor (a snap
 *  pulling the point away would falsify the pick), they record no snap
 *  inferences, and they never wake hover alignment references. */
export const PICK_TOOLS: ReadonlySet<SketchToolId> = new Set<SketchToolId>([
  'smart-dimension',
  'trim',
  'split',
  'extend',
  'fillet',
  'chamfer',
  'offset',
  'mirror',
  'pattern-linear',
  'pattern-circular',
  'pattern-path',
  'move',
  'rotate',
  'scale',
  'project',
])

/** The transform each transform tool performs. */
export const TRANSFORM_TOOL_OPS: Readonly<Partial<Record<SketchToolId, TransformOp>>> = {
  move: 'move', rotate: 'rotate', scale: 'scale',
}

// In-progress line chain (CHAINING state payload). The chain stores world
// coordinates plus the ids of the lines it has committed so far — enough
// to place the next segment, auto-connect it, and detect closure. The
// document itself is never referenced: committed segments already live in
// the sketch.
export interface LineChainState {
  kind: 'line'
  /** Chain start (first click). Clicking back here closes the chain. */
  start: Vec2
  /** First committed segment (closure constraint target); null until the
   *  second click commits it. */
  firstLineId: string | null
  /** Last committed point = next segment's start (rubber-band anchor). */
  prev: Vec2
  /** Line whose 'end' sits at prev; null before the first segment. */
  prevLineId: string | null
}

// Per-tool CHAINING payload. Discriminated on `kind` so each tool's click
// handler narrows to exactly the state it owns; arming any tool resets
// chain to null, so a stale payload can never leak across tools.
export type ToolChainState =
  | LineChainState
  | RectChainState
  | CircleChainState
  | EllipseChainState
  | EllipseArcChainState
  | ArcChainState
  | DimChainState
  | ExtendChainState
  | SplitChainState
  | FilletChainState
  | ChamferChainState
  | OffsetChainState
  | MirrorChainState
  | LinearPatternChainState
  | CircularPatternChainState
  | PathPatternChainState
  | TransformChainState
  | PolygonChainState
  | GearChainState
  | SlotChainState
  | ArcSlotChainState
  | SplineChainState
  | ConicChainState

export interface ToolState {
  tool: SketchToolId
  chain: ToolChainState | null
}

export const IDLE_TOOL_STATE: ToolState = { tool: 'select', chain: null }

// ---- Transitions ----------------------------------------------------------

/** ARM(t): arm a tool (or 'select'). Discards any in-progress chain. */
export function armTool(_state: ToolState, tool: SketchToolId): ToolState {
  return { tool, chain: null }
}

/** Multi-operand MODIFY tools that consume a non-empty selection as
 *  their first step's operands when armed (pre-selection doctrine —
 *  pick first, then the tool). Fillet seeds every shared corner among
 *  the selected lines; offset joins via its own chain seeding. */
export const PRESELECTION_TOOLS: ReadonlySet<SketchToolId> = new Set<SketchToolId>([
  'mirror',
  'pattern-linear',
  'pattern-circular',
  'pattern-path',
  'fillet',
  'chamfer',
  'offset',
  'move',
  'rotate',
  'scale',
])

/**
 * ARM(t) with pre-selection consumption: arming a PRESELECTION_TOOLS
 * tool while entities are selected seeds its chain with them (marked
 * `seeded`), skipping the set-accumulation step — the next click is the
 * axis / anchor / center. Filters match the tools' own click-time
 * seeding: mirror takes any selected entity, the patterns exclude
 * construction geometry. Everything else behaves exactly like armTool.
 */
export function armToolWithSelection(
  state: ToolState,
  tool: SketchToolId,
  selectedIds: readonly string[],
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[] = [],
): ToolState {
  const base = armTool(state, tool)
  if (!PRESELECTION_TOOLS.has(tool)) return base
  if (tool === 'offset') {
    // The first selected curve seeds the source (its whole chain); the
    // next click locks the side, the overlay confirms the distance.
    const source = offsetSeedFromSelection(entities, constraints, selectedIds)
    return source
      ? { tool, chain: { kind: 'offset', source, lockedSide: null } }
      : base
  }
  if (tool === 'fillet') {
    // Every shared corner among the selected lines arrives staged with
    // a live preview arc; the confirm overlay applies the batch.
    const corners = filletSeedFromSelection(entities, selectedIds)
    return corners.length > 0
      ? {
          tool,
          chain: { kind: 'fillet', corners, pendingLineId: null, pendingClick: null },
        }
      : base
  }
  if (tool === 'chamfer') {
    // Same pre-selection doctrine as fillet: every shared corner among the
    // selected lines arrives staged with a live preview line.
    const corners = chamferSeedFromSelection(entities, selectedIds)
    return corners.length > 0
      ? {
          tool,
          chain: { kind: 'chamfer', corners, pendingLineId: null, pendingClick: null },
        }
      : base
  }
  if (tool === 'mirror') {
    // Pre-selection seeds the mirror SET (not the axis): the user still
    // closes it with Enter / Confirm before the axis pick, EXACTLY like
    // the pattern tools. Seeding straight to axis-pick was the reported
    // tool-first bug — a single lingering selection hijacked the very
    // next click (meant to ADD an entity) as the axis. The set now stays
    // open so click-accumulate works whether the user pre-selected or
    // not; Enter is the one consistent "I'm done picking" gesture.
    const ids = selectedIds.filter((id) => entities.some((e) => e.id === id))
    return ids.length > 0
      ? { tool, chain: { kind: 'mirror', ids, seeded: true, confirmed: false } }
      : base
  }
  const op = TRANSFORM_TOOL_OPS[tool]
  if (op) {
    // Transforms take construction geometry too (it moves with the part);
    // the injected origin/axes never join the set. Same open-set gesture as
    // the patterns: the seed still closes with Confirm before placement.
    const set = transformSetIds(entities, selectedIds)
    const ids = selectedIds.filter((id) => set.has(id))
    return ids.length > 0 ? { tool, chain: newTransformChain(op, ids, true) } : base
  }
  const ids = selectedIds.filter((id) =>
    entities.some((e) => e.id === id && !e.construction))
  if (ids.length === 0) return base
  // Patterns: the seed fills the SET step; the user still confirms it
  // (Enter / prompt-bar Confirm) before the placement clicks — the
  // prompt names the seed so the next gesture is never a surprise.
  if (tool === 'pattern-linear') {
    return {
      tool,
      chain: {
        kind: 'linpat', ids, confirmed: false, anchor: null, vector: null,
        seeded: true,
      },
    }
  }
  if (tool === 'pattern-circular') {
    return {
      tool,
      chain: { kind: 'circpat', ids, confirmed: false, center: null, seeded: true },
    }
  }
  return {
    tool,
    chain: {
      kind: 'pathpat', ids, confirmed: false, path: null,
      count: 5, spacingMode: 'equal', fixedSpacing: 10, followTangent: false,
      seeded: true,
    },
  }
}

/**
 * CONFIRM (Enter / prompt-bar button) as a STEP ADVANCE: a pattern set
 * with members closes and moves to the placement phase. Returns null
 * when the current state has no confirmable step transition (the caller
 * falls through to endChain / overlay apply).
 */
export function confirmToolStep(state: ToolState): ToolState | null {
  const chain = state.chain
  if (chain?.kind === 'linpat' && !chain.confirmed && chain.ids.length > 0) {
    return { tool: state.tool, chain: { ...chain, confirmed: true } }
  }
  if (chain?.kind === 'circpat' && !chain.confirmed && chain.ids.length > 0) {
    return { tool: state.tool, chain: { ...chain, confirmed: true } }
  }
  if (chain?.kind === 'pathpat' && !chain.confirmed && chain.ids.length > 0) {
    return { tool: state.tool, chain: { ...chain, confirmed: true } }
  }
  if (chain?.kind === 'transform' && !chain.confirmed && chain.ids.length > 0) {
    return { tool: state.tool, chain: { ...chain, confirmed: true } }
  }
  // Mirror set closes on Enter: the next click is the axis pick and ANY
  // line works. Both click-accumulated AND pre-selected (seeded) sets
  // reach the axis phase this way — seeded is no longer a shortcut past
  // the close-the-set step (that shortcut was the tool-first bug).
  if (
    chain?.kind === 'mirror' && !chain.confirmed && chain.ids.length > 0
  ) {
    return { tool: state.tool, chain: { ...chain, confirmed: true } }
  }
  return null
}

/** True when a click for this state should land on the SNAPPED point.
 *  PICK-tool clicks land raw (a snap would falsify the pick) — EXCEPT
 *  pattern placement clicks (anchor / vector end / rotation center),
 *  which place POINTS and want endpoint/center/grid snapping. */
export function clickUsesSnap(state: ToolState): boolean {
  if (!PICK_TOOLS.has(state.tool)) return true
  const chain = state.chain
  if (chain?.kind === 'linpat' && chain.confirmed) return true
  if (chain?.kind === 'circpat' && chain.confirmed) return true
  if (chain?.kind === 'transform' && chain.confirmed) return true
  return false
}

/**
 * ESC. Returns the next state plus whether the event was consumed:
 * CHAINING -> ARMED (cancel chain), ARMED -> SELECT, SELECT -> not
 * consumed (caller falls through to clearing the selection).
 *
 * Confirm-overlay phases step BACK one step instead of dropping the
 * whole chain: a side-locked offset unlocks (back to the side pick);
 * the source/operands survive for the retry.
 */
export function escapeTool(state: ToolState): { state: ToolState; consumed: boolean } {
  const back = (chain: ToolChainState): { state: ToolState; consumed: boolean } => ({
    state: { tool: state.tool, chain }, consumed: true,
  })
  const c = state.chain
  if (c?.kind === 'offset' && c.lockedSide !== null) {
    return back({ ...c, lockedSide: null })
  }
  if (c?.kind === 'linpat') {
    if (c.vector) return back({ ...c, vector: null })
    if (c.anchor) return back({ ...c, anchor: null })
    if (c.confirmed) return back({ ...c, confirmed: false })
  }
  if (c?.kind === 'circpat') {
    if (c.center) return back({ ...c, center: null })
    if (c.confirmed) return back({ ...c, confirmed: false })
  }
  if (c?.kind === 'pathpat') {
    if (c.path) return back({ ...c, path: null })
    if (c.confirmed) return back({ ...c, confirmed: false })
  }
  if (c?.kind === 'mirror' && c.confirmed) {
    return back({ ...c, confirmed: false }) // reopen the set, keep it
  }
  if (c?.kind === 'transform') {
    const prev = transformEscape(c)
    if (prev) return back(prev)
  }
  if (state.chain) {
    return { state: { tool: state.tool, chain: null }, consumed: true }
  }
  if (state.tool !== 'select') {
    return { state: IDLE_TOOL_STATE, consumed: true }
  }
  return { state, consumed: false }
}

/** ENTER / double-click: end the chain without closing; tool stays armed. */
export function endChain(state: ToolState): ToolState {
  if (!state.chain) return state
  return { tool: state.tool, chain: null }
}

// ---- Click behavior ---------------------------------------------------------

/** Entities + constraints (+ dimensions, smart-dim tool) a click
 *  produced, applied by the store as ONE undo step (history is pushed
 *  once per commit, not per object). */
export interface ToolCommit {
  patterns?: import('../patterns').SketchPatternDefinition[]
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  dimensions?: SketchDimension[]
}

export interface ToolClickResult {
  state: ToolState
  /** null = the click changed only tool state (or was a no-op). */
  commit: ToolCommit | null
  /** MODIFY tools (trim): full replacement document arrays the store
   *  swaps in as one undo step. Mutually exclusive with `commit`. */
  replace?: SketchDocTransform
  /** Rejection reason the store surfaces as a notice (smart-dim invalid
   *  operand set). Never silent (ADR 0003 spirit). */
  notice?: string
}

/** Document context a click may need beyond the machine state: the
 *  entity list (endpoint picking for the tangent arc) and the toolbox's
 *  construction mode (newly drawn entities get the flag). MODIFY tools
 *  additionally read the constraint/dimension arrays (the trim cascade
 *  rewrites them). Read-only — clicks never mutate the document. */
export interface ToolClickCtx {
  entities: readonly SketchEntity[]
  /** When true, every entity this click commits is construction geometry
   *  (participates in constraints, excluded from bake). Default false. */
  construction?: boolean
  /** Document constraints (MODIFY tools only; defaults to none). */
  constraints?: readonly SketchConstraint[]
  /** Document dimensions (MODIFY tools only; defaults to none). */
  dimensions?: readonly SketchDimension[]
  /** Fillet tool radius in mm (toolbox input; defaults to 2). */
  filletRadius?: number
  /** Chamfer tool setback in mm (toolbox input; defaults to 2). */
  chamferSetback?: number
  /** Offset tool distance in mm (toolbox input; defaults to 2). */
  offsetDistance?: number
  /** Current selection (MODIFY tools that consume a pre-selection:
   *  mirror's and the patterns' selection-seeded modes). Defaults to
   *  empty. */
  selectedIds?: readonly string[]
  /** Linear pattern instance count (toolbox input; defaults to 3). */
  linearPatternCount?: number
  /** Circular pattern instance count (toolbox input; defaults to 4). */
  circularPatternCount?: number
  /** Circular pattern PER-STEP angle in radians (toolbox input;
   *  defaults to 2*pi / count = full circle). */
  circularPatternStepRad?: number
  /** Polygon side count (toolbox input; defaults to 6, min 3). */
  polygonSides?: number
  /** Polygon radius semantics (defaults to inscribed). */
  polygonMode?: PolygonMode
  gearParams?: GearParams
  /** Conic arc rho a NEW conic chain starts at (toolbox input; defaults to
   *  0.5, the parabola). A started chain carries its own rho. */
  conicRho?: number
  /** Single-line text tool string (toolbox input; defaults to 'TEXT'). */
  textValue?: string
  /** Single-line text tool cap height in mm (toolbox input; defaults to 5). */
  textHeight?: number
  /** Text face: 'single-line' (Hershey) or 'outline' (TTF). Default single. */
  textStyle?: 'single-line' | 'outline'
  /** Single-line text baseline rotation in RADIANS (the toolbox angle is in
   *  degrees; the store converts deg -> rad at this boundary). Default 0 =
   *  horizontal. Threaded so the committed entity carries the toolbox angle. */
  textRotation?: number
  /** OUTLINE font family (toolbox picker). Unset -> default M+ face. Threaded
   *  onto the committed entity (single-line ignores it). */
  textFontFamily?: string
  /** SMART-DIMENSION only: the point the store's snap engine resolved to a real
   *  point SITE (endpoint / vertex / center / spline-start) under the cursor.
   *  Threaded so an explicitly-snapped corner/vertex becomes a POINT operand
   *  (point-to-line distance) rather than its owning line body (an angle).
   *  Null / absent for a body/midpoint/quadrant snap or when drawing snap is
   *  off — the whole-entity pick path then runs, exactly as before. */
  dimExplicitPoint?: { point: Vec2; ref: PointRef } | null
  /** SMART-DIMENSION only: whether visible line-center markers are directly
   *  addressable as dim operands. The interactive path supplies the SKC-62
   *  repair-3 semantic (true exactly when entity snapping is DISABLED and
   *  the markers are the only point-site affordance). When absent,
   *  dimToolClick falls back to its explicit===null heuristic. */
  dimLineCentersAddressable?: boolean
  /** RECTANGLE only (V6): Shift held on the committing click, so the ortho-lock
   *  snapped the drag to a visual square. Threaded so the axis-aligned rect
   *  commit adds an `equal` leg constraint that KEEPS it square under solving.
   *  Ignored by every other tool / by the rotated rect path. */
  forceSquare?: boolean
}

const EMPTY_CTX: ToolClickCtx = { entities: [] }

/**
 * CLICK(p) dispatch. `closeTol` is the click tolerance in world mm
 * (derived from screen pixels by the viewport); `newId` is injectable for
 * deterministic tests. Tools without behavior yet return the state
 * unchanged with no commit.
 */
export function toolClick(
  state: ToolState,
  world: Vec2,
  closeTol: number,
  newId: () => string = () => crypto.randomUUID(),
  ctx: ToolClickCtx = EMPTY_CTX,
): ToolClickResult {
  const construction = ctx.construction ?? false
  switch (state.tool) {
    case 'point':
      return pointClick(state, world, construction, newId)
    case 'line':
      return lineClick(state, world, closeTol, construction, newId)
    case 'rect-corner':
    case 'rect-center': {
      const mode = state.tool === 'rect-corner' ? 'corner' : 'center'
      const chain = state.chain?.kind === 'rect' ? state.chain : null
      const r = rectClick(
        chain, mode, world, closeTol, construction, newId, ctx.forceSquare ?? false,
      )
      return { state: { tool: state.tool, chain: r.chain }, commit: r.commit }
    }
    case 'circle-center':
    case 'circle-3pt': {
      const mode = state.tool === 'circle-center' ? 'center' : '3pt'
      const chain = state.chain?.kind === 'circle' ? state.chain : null
      const r = circleClick(chain, mode, world, closeTol, construction, newId)
      return {
        state: { tool: state.tool, chain: r.chain }, commit: r.commit,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'ellipse': {
      const chain = state.chain?.kind === 'ellipse' ? state.chain : null
      const r = ellipseClick(chain, world, closeTol, construction, newId)
      return { state: { tool: state.tool, chain: r.chain }, commit: r.commit }
    }
    case 'ellipse-arc': {
      const chain = state.chain?.kind === 'ellipse-arc' ? state.chain : null
      const r = ellipseArcClick(chain, world, closeTol, construction, newId)
      return {
        state: { tool: state.tool, chain: r.chain }, commit: r.commit,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'spline': {
      // Multi-click accumulation; the commit normally happens on finish (Enter
      // / double-click -> store sketchToolEnd -> splineFinish). The ONE click
      // that commits is close-on-start: >= 3 points + a click on points[0]
      // finishes the spline CLOSED (splineClick builds the commit, so it needs
      // the construction flag + id factory).
      const chain = state.chain?.kind === 'spline' ? state.chain : null
      const r = splineClick(chain, world, closeTol, construction, newId)
      return { state: { tool: state.tool, chain: r.chain }, commit: r.commit }
    }
    case 'spline-control': {
      // WO-1861: the spline tool's gestures, placing CONTROL points -- the
      // chain carries form 'control' so preview and commit read the points
      // as a B-spline control polygon.
      const chain = state.chain?.kind === 'spline' ? state.chain : null
      const r = splineClick(chain, world, closeTol, construction, newId, 'control')
      return { state: { tool: state.tool, chain: r.chain }, commit: r.commit }
    }
    case 'bezier': {
      // WO-1862: the release of a press-drag (or a stationary click). With a
      // press recorded on the chain the release point is that anchor's
      // handle; close-on-start commits here, Enter / double-click via finish.
      const chain = state.chain?.kind === 'spline' ? state.chain : null
      const r = bezierClick(chain, world, closeTol, construction, newId)
      return { state: { tool: state.tool, chain: r.chain }, commit: r.commit }
    }
    case 'conic': {
      // WO-1863: start, end, then the apex click commits one conic arc at
      // the chain's rho (the toolbox value when the chain started).
      const chain = state.chain?.kind === 'conic' ? state.chain : null
      const r = conicClick(chain, world, closeTol, construction, newId, ctx.conicRho ?? 0.5)
      return { state: { tool: state.tool, chain: r.chain }, commit: r.commit }
    }
    case 'text': {
      // SINGLE-CLICK commit: the click places the anchor and commits one
      // solver-inert text entity from the live toolbox string + height
      // (threaded via ctx). Degenerate (empty/whitespace text or height<=0)
      // returns null -> a clean no-op (no chain; nothing accumulates).
      const params: TextToolParams = {
        text: ctx.textValue ?? 'TEXT',
        height: ctx.textHeight ?? 5,
        rotation: ctx.textRotation,
        fontStyle: ctx.textStyle ?? 'single-line',
        fontFamily: ctx.textFontFamily,
      }
      const commit = textClick(world, params, construction, newId)
      return { state, commit }
    }
    case 'arc-3pt':
    case 'arc-center':
    case 'arc-tangent': {
      const mode =
        state.tool === 'arc-3pt' ? '3pt' :
        state.tool === 'arc-center' ? 'center' : 'tangent'
      const chain = state.chain?.kind === 'arc' ? state.chain : null
      const r = arcClick(chain, mode, world, closeTol, construction, newId, ctx.entities)
      return {
        state: { tool: state.tool, chain: r.chain }, commit: r.commit,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'gear': {
      const chain = state.chain?.kind === 'gear' ? state.chain : null
      const r = gearClick(chain, world, ctx.gearParams ?? DEFAULT_GEAR_PARAMS, construction, newId)
      return { state: { tool: state.tool, chain: r.chain }, commit: r.commit }
    }
    case 'polygon': {
      const chain = state.chain?.kind === 'polygon' ? state.chain : null
      const sides = Math.max(3, Math.round(ctx.polygonSides ?? 6))
      const r = polygonClick(
        chain,
        world,
        closeTol,
        sides,
        construction,
        newId,
        ctx.polygonMode ?? 'inscribed',
      )
      return { state: { tool: state.tool, chain: r.chain }, commit: r.commit }
    }
    case 'slot': {
      const chain = state.chain?.kind === 'slot' ? state.chain : null
      const r = slotClick(chain, world, closeTol, construction, newId)
      return { state: { tool: state.tool, chain: r.chain }, commit: r.commit }
    }
    case 'slot-arc': {
      const chain = state.chain?.kind === 'slotArc' ? state.chain : null
      const r = arcSlotClick(chain, world, closeTol, construction, newId)
      return {
        state: { tool: state.tool, chain: r.chain }, commit: r.commit,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'smart-dimension': {
      const chain = state.chain?.kind === 'dim' ? state.chain : null
      // UI-50C-R1 major 1: ctx.constraints was silently dropped here, so the
      // REAL click-to-commit path never saw the document's coincident /
      // point_on_object graph -- resolveChamferCorner (and therefore d1xd2,
      // accept OR named-refuse) could never fire from an actual click, only
      // from a caller that threaded constraints in by hand (dimPreview's
      // live cursor preview already did, dimToolClick's own default did
      // not). Thread the same ctx.constraints every other MODIFY-adjacent
      // branch in this switch already reads.
      // Pass dimExplicitPoint through UNCHANGED: dimToolClick distinguishes
      // null (interactive no-point-snap; line-center markers addressable)
      // from undefined (legacy programmatic whole-line midpoint behavior).
      // Coercing undefined -> null here silently flipped every direct
      // toolMachine caller onto the marker path (RED-A/B, 2026-07-21).
      const r = dimToolClick(chain, world, closeTol, ctx.entities, newId,
        ctx.dimExplicitPoint, ctx.constraints ?? [],
        ctx.dimLineCentersAddressable)
      return {
        state: { tool: state.tool, chain: r.chain },
        commit: r.dimension
          ? { entities: [], constraints: [], dimensions: [r.dimension] }
          : null,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'trim': {
      // Stateless armed MODIFY tool: every click acts independently
      // (the drag-swipe variant routes through the store's swipe
      // action, not this click path).
      const doc = {
        entities: [...ctx.entities],
        constraints: [...(ctx.constraints ?? [])],
        dimensions: [...(ctx.dimensions ?? [])],
      }
      const r = trimAtPoint(doc, world, closeTol, newId)
      return {
        state,
        commit: null,
        ...(r.transform ? { replace: r.transform } : {}),
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'split': {
      // Line/arc split immediately (one click = the cut point). A circle
      // needs a second point: the first click stages it (chain), the
      // second commits two arcs covering the full circle.
      const chain = state.chain?.kind === 'split' ? state.chain : null
      const doc = {
        entities: [...ctx.entities],
        constraints: [...(ctx.constraints ?? [])],
        dimensions: [...(ctx.dimensions ?? [])],
      }
      const r = splitClick(chain, doc, world, closeTol, newId)
      return {
        state: { tool: state.tool, chain: r.chain },
        commit: null,
        ...(r.transform ? { replace: r.transform } : {}),
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'extend': {
      // Two-step flow: pick the entity, then the cursor-directed click
      // commits the SAME extension the ghost previewed.
      const chain = state.chain?.kind === 'extend' ? state.chain : null
      const doc = {
        entities: [...ctx.entities],
        constraints: [...(ctx.constraints ?? [])],
        dimensions: [...(ctx.dimensions ?? [])],
      }
      const r = extendClick(chain, doc, world, closeTol, newId)
      return {
        state: { tool: state.tool, chain: r.chain },
        commit: null,
        ...(r.transform ? { replace: r.transform } : {}),
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'offset': {
      // Select - side - confirm: the click picks the source, then locks
      // the side; the commit happens through the confirm overlay's OK
      // (store sketchOverlayApply), never the click.
      const chain = state.chain?.kind === 'offset' ? state.chain : null
      const r = offsetClick(chain, ctx.entities, ctx.constraints ?? [], world, closeTol)
      return {
        state: { tool: state.tool, chain: r.chain },
        commit: null,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'mirror': {
      const chain = state.chain?.kind === 'mirror' ? state.chain : null
      const r = mirrorClick(
        chain, ctx.entities, ctx.selectedIds ?? [], world, closeTol, newId,
      )
      return {
        state: { tool: state.tool, chain: r.chain },
        commit: r.commit,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'pattern-linear': {
      // Set - Confirm - place - overlay OK: clicks toggle the set or
      // place the vector; the commit happens through the confirm
      // overlay's OK (store sketchOverlayApply), never the click.
      const chain = state.chain?.kind === 'linpat' ? state.chain : null
      const r = linearPatternClick(chain, ctx.entities, world, closeTol)
      return {
        state: { tool: state.tool, chain: r.chain },
        commit: null,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'pattern-circular': {
      const chain = state.chain?.kind === 'circpat' ? state.chain : null
      const r = circularPatternClick(chain, ctx.entities, world, closeTol)
      return {
        state: { tool: state.tool, chain: r.chain },
        commit: null,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'pattern-path': {
      // Set - Confirm - PATH PICK - overlay OK: clicks toggle the set or
      // pick the path; the commit happens through the confirm overlay's
      // OK (store sketchOverlayApply), never the click.
      const chain = state.chain?.kind === 'pathpat' ? state.chain : null
      const r = pathPatternClick(chain, ctx.entities, ctx.constraints ?? [], world, closeTol)
      return {
        state: { tool: state.tool, chain: r.chain },
        commit: null,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'move':
    case 'rotate':
    case 'scale': {
      // Set -> Confirm -> placement clicks; the confirm overlay's OK commits.
      const chain = state.chain?.kind === 'transform' && state.chain.op === state.tool
        ? state.chain
        : null
      const r = transformClick(state.tool, chain, ctx.entities, world, closeTol)
      return {
        state: { tool: state.tool, chain: r.chain },
        commit: null,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'fillet': {
      // Accumulate-then-confirm: clicks toggle corners (corner points /
      // line pairs) in and out of the staged set; the confirm overlay's
      // Apply commits the batch (store action), never the click.
      const chain = state.chain?.kind === 'fillet' ? state.chain : null
      const doc = {
        entities: [...ctx.entities],
        constraints: [...(ctx.constraints ?? [])],
        dimensions: [...(ctx.dimensions ?? [])],
      }
      const r = filletClick(chain, doc, world, closeTol)
      return {
        state: { tool: state.tool, chain: r.chain },
        commit: null,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'chamfer': {
      // Accumulate-then-confirm, identical flow to fillet: clicks toggle
      // corners in/out of the staged set; the confirm overlay's Apply
      // commits the batch (store action), never the click.
      const chain = state.chain?.kind === 'chamfer' ? state.chain : null
      const doc = {
        entities: [...ctx.entities],
        constraints: [...(ctx.constraints ?? [])],
        dimensions: [...(ctx.dimensions ?? [])],
      }
      const r = chamferClick(chain, doc, world, closeTol)
      return {
        state: { tool: state.tool, chain: r.chain },
        commit: null,
        ...(r.notice ? { notice: r.notice } : {}),
      }
    }
    case 'project':
      // Owned by the store (sketchToolClick): the project tool reads
      // OTHER LAYERS' baked loops, which the pure machine cannot see.
      return { state, commit: null }
    default:
      // Remaining CREATE tools arm but ignore clicks until their Stage 3
      // chunk lands.
      return { state, commit: null }
  }
}

// ---- Rubber-band preview ----------------------------------------------------

/** Live document context the preview may need beyond the chain payload. */
export interface ToolPreviewCtx {
  /** Polygon side count (live toolbox value, same as the click's). */
  polygonSides?: number
  /** Polygon radius semantics (live toolbox value, same as the click's). */
  polygonMode?: PolygonMode
  gearParams?: GearParams
  /** Spline "Close loop" toggle (live toolbox value) — the preview wraps
   *  back to points[0] exactly as the commit will. */
  splineClosed?: boolean
  /** Close tolerance (world mm, = pick tol). When the spline cursor is within
   *  this of the start point (>= 3 points) the preview snaps CLOSED as
   *  close-on-start feedback. 0 disables the hint. */
  closeTol?: number
}

/**
 * Preview polyline (world mm) for the in-progress chain at the current
 * cursor position, or null when there is nothing to preview. Pure: built
 * from the SAME geometry helpers the click commit uses, so the preview
 * always matches what the next click commits. Curves are returned
 * tessellated — the viewport renders the points verbatim.
 */
export function toolPreview(
  state: ToolState, cursor: Vec2, ctx: ToolPreviewCtx = {},
): Vec2[] | null {
  const chain = state.chain
  if (!chain) return null
  switch (chain.kind) {
    case 'line':
      return [chain.prev, { x: cursor.x, y: cursor.y }]
    case 'rect':
      return rectPreview(chain, cursor)
    case 'circle':
      return circlePreview(chain, cursor)
    case 'ellipse':
      return ellipsePreview(chain, cursor)
    case 'ellipse-arc':
      return ellipseArcPreview(chain, cursor, ctx.closeTol)
    case 'spline':
      if (chain.form === 'bezier') return bezierPreview(chain, cursor, ctx.splineClosed, ctx.closeTol)
      return splinePreview(chain, cursor, ctx.splineClosed, ctx.closeTol)
    case 'conic':
      return conicPreview(chain, cursor)
    case 'arc':
      return arcPreview(chain, cursor)
    case 'dim':
      // The smart-dim preview is a TEXT label (dimPreview in dimTool.ts,
      // rendered by the dimension overlay), not a rubber-band polyline.
      return null
    case 'extend':
      // The extension ghost renders through the tool overlay channel
      // (toolOverlay.ts), not the rubber band.
      return null
    case 'split':
      // Circle split staged its first point; rubber-band to the cursor as
      // the pending second cut (line/arc splits never reach a chain).
      return [chain.first, { x: cursor.x, y: cursor.y }]
    case 'fillet':
      // The staged corners preview through the tool overlay channel
      // (ghost arcs + warning markers), not the rubber band.
      return null
    case 'chamfer':
      // The staged corners preview through the tool overlay channel
      // (ghost chamfer lines + warning markers), not the rubber band.
      return null
    case 'offset':
      // The offset ghost renders through the tool overlay channel
      // (toolOverlay.ts), not the rubber band.
      return null
    case 'mirror':
      // The accumulated mirror set is shown via selection highlight; the
      // result appears on the axis click.
      return null
    case 'linpat':
      // Anchored step vector rubber-bands to the cursor until the end
      // click locks it; the ghost instances render through the tool
      // overlay channel.
      return chain.anchor && !chain.vector
        ? [chain.anchor, { x: cursor.x, y: cursor.y }]
        : null
    case 'circpat':
      // The ghost ring renders through the tool overlay channel.
      return null
    case 'pathpat':
      // The path-pattern ghosts render through the tool overlay channel.
      return null
    case 'transform': {
      // Rubber band from the base (rotate: through the reference direction)
      // to the cursor while a placement click is pending; the ghost geometry
      // renders through the tool overlay channel.
      if (!chain.base) return null
      const c = { x: cursor.x, y: cursor.y }
      if (chain.op === 'move') return chain.ref ? null : [chain.base, c]
      if (chain.op === 'rotate') {
        if (chain.target) return null
        return chain.ref ? [chain.ref, chain.base, c] : [chain.base, c]
      }
      return chain.ref && !chain.target ? [chain.base, c] : null
    }
    case 'gear':
      return gearPreview(chain, cursor, ctx.gearParams ?? DEFAULT_GEAR_PARAMS)
    case 'polygon':
      return polygonPreview(
        chain,
        cursor,
        Math.max(3, Math.round(ctx.polygonSides ?? 6)),
        ctx.polygonMode ?? 'inscribed',
      )
    case 'slot':
      return slotPreview(chain, cursor)
    case 'slotArc':
      return arcSlotPreview(chain, cursor)
  }
}

/** Point tool: every click places a free point; the tool stays armed. */
function pointClick(
  state: ToolState,
  world: Vec2,
  construction: boolean,
  newId: () => string,
): ToolClickResult {
  const entity: SketchEntity = {
    id: newId(),
    kind: 'point',
    construction,
    at: { x: world.x, y: world.y },
  }
  return { state, commit: { entities: [entity], constraints: [] } }
}

/**
 * Line tool (chained polyline):
 *   - first click anchors the chain (no entity yet)
 *   - each further click commits a segment from the previous point and
 *     auto-adds a coincident constraint joining it to the previous
 *     segment's endpoint
 *   - clicking within closeTol of the CHAIN START closes the chain: the
 *     closing segment's end snaps to the start, gets a coincident
 *     constraint to the first segment's start, and the chain ends (the
 *     tool stays armed for the next chain)
 *   - clicks within closeTol of the previous point are ignored
 *     (zero-length guard; also makes the dblclick-to-end gesture clean,
 *     since its second click lands on the same spot)
 */
function lineClick(
  state: ToolState,
  world: Vec2,
  closeTol: number,
  construction: boolean,
  newId: () => string,
): ToolClickResult {
  const chain = state.chain?.kind === 'line' ? state.chain : null

  // First click: anchor only.
  if (!chain) {
    return {
      state: {
        tool: state.tool,
        chain: {
          kind: 'line',
          start: { x: world.x, y: world.y },
          firstLineId: null,
          prev: { x: world.x, y: world.y },
          prevLineId: null,
        },
      },
      commit: null,
    }
  }

  // Zero-length guard (also absorbs the dblclick's second click).
  if (dist(world, chain.prev) <= closeTol) {
    return { state, commit: null }
  }

  const closing = chain.firstLineId !== null && dist(world, chain.start) <= closeTol
  const end = closing
    ? { x: chain.start.x, y: chain.start.y }
    : { x: world.x, y: world.y }

  const lineId = newId()
  const entity: SketchEntity = {
    id: lineId,
    kind: 'line',
    construction,
    start: { x: chain.prev.x, y: chain.prev.y },
    end,
  }

  const constraints: SketchConstraint[] = []
  if (chain.prevLineId) {
    constraints.push({
      id: newId(),
      kind: 'coincident',
      a: { entityId: chain.prevLineId, site: 'end' },
      b: { entityId: lineId, site: 'start' },
    })
  }
  if (closing) {
    constraints.push({
      id: newId(),
      kind: 'coincident',
      a: { entityId: lineId, site: 'end' },
      b: { entityId: chain.firstLineId!, site: 'start' },
    })
  }

  const nextChain: LineChainState | null = closing
    ? null
    : {
        kind: 'line',
        start: chain.start,
        firstLineId: chain.firstLineId ?? lineId,
        prev: end,
        prevLineId: lineId,
      }

  return {
    state: { tool: state.tool, chain: nextChain },
    commit: { entities: [entity], constraints },
  }
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// ---- Smart-dimension orientation force (Tab) --------------------------------

/**
 * Tab while the smart-dimension tool has an operand set: cycle the linear
 * orientation override (auto -> aligned -> H -> V -> auto). No-op for any
 * other tool / state. Pure; the store applies the new chain and re-resolves
 * the preview. */
export function cycleDimForce(
  state: ToolState, entities?: readonly SketchEntity[],
): ToolState {
  if (state.tool !== 'smart-dimension' || state.chain?.kind !== 'dim') return state
  // The real controller always supplies the live entities. The undefined
  // fallback preserves the public pure helper's original linear-cycle API for
  // callers that only exercise an already-known linear chain.
  const family = entities === undefined
    ? 'linear'
    : dimForceFamily(entities, state.chain.operandIds)
  if (family === null) return state
  return {
    tool: state.tool,
    chain: {
      ...state.chain,
      forceMode: cycleDimForceMode(state.chain.forceMode, family),
    },
  }
}

// ---- Rectangle rotated (angled) force (Tab) ---------------------------------

/**
 * Tab on a rectangle tool: toggle the ROTATED (free-angle) mode (item G).
 * Mirrors the smart-dimension Tab force-mode. Works whether the rect chain is
 * fresh/just-armed (Tab BEFORE click1 stages a rotated chain that carries the
 * flag but no anchor yet) or mid-draw (flips the flag in place). Toggling
 * rotated OFF before any click drops back to the plain armed state. No-op for
 * any non-rect tool. Pure; the store applies the new chain and re-resolves
 * the preview. */
export function toggleRectRotated(state: ToolState): ToolState {
  if (state.tool !== 'rect-corner' && state.tool !== 'rect-center') return state
  const mode = state.tool === 'rect-corner' ? 'corner' : 'center'
  const chain = state.chain?.kind === 'rect' ? state.chain : null
  if (!chain) {
    // Pre-click toggle: stage a rotated chain (no anchor) so click1 keeps it.
    return { tool: state.tool, chain: { kind: 'rect', mode, rotated: true } }
  }
  const nextRotated = !chain.rotated
  if (!nextRotated && !chain.anchor) {
    // Toggling rotated off before any click -> plain armed (discard staging).
    return { tool: state.tool, chain: null }
  }
  return { tool: state.tool, chain: { ...chain, rotated: nextRotated } }
}

// ---- Construction toggle ----------------------------------------------------

/**
 * Flip the construction flag on every entity whose id is in `ids`
 * (non-entity ids — selected constraints/dimensions — are ignored).
 * Returns the new entity array, or null when the selection contains no
 * entities at all, so the caller can fall back to toggling the
 * draw-as-construction MODE instead. Pure; the store applies the result
 * as one undo step.
 */
export function toggleConstructionFlags(
  entities: readonly SketchEntity[],
  ids: readonly string[],
): SketchEntity[] | null {
  const idSet = new Set(ids)
  let touched = false
  const next = entities.map((e) => {
    if (!idSet.has(e.id)) return e
    touched = true
    return { ...e, construction: !e.construction }
  })
  return touched ? next : null
}
