// WO SKC-14B: THE sketch tool machine. Lifted verbatim out of the CAM store (src/store/index.ts:
// setSketchTool / sketchToolEscape / sketchToolEnd / sketchOverlayApply / sketchToolClick /
// sketchSnap / sketchToolOverlay / lockCursor / commitSketchDrawValue / sketchTrimSwipe*).
//
// The split this file encodes -- and the reason the migration is safe -- is that every one of
// those store actions was already two things stapled together:
//
//   TOOL HALF   : read the armed tool + chain, run a PURE function from lib/sketch/tools, write
//                 the next tool + chain, accumulate snap inferences. Pure, document-independent.
//   DOCUMENT HALF: push history, splice entities/constraints/dimensions into `activeSketch`,
//                 re-solve, open a dimension editor, flash a notice.
//
// The tool half moved here. The document half stayed with the host, behind `SketchDocumentPort`
// -- which is exactly the "document/commit/undo sink" the plan's Section 8.2 mount contract
// permits a mount to provide. Nothing was rewritten: the branch order, the notices, the
// snap-vs-raw click point, the mirror selection clear, and the one-undo-step latching are the
// same code in a new home. That is what keeps the felt surface bit-identical.
//
// STORE-FREE: this file imports nothing from src/store. Guarded by the capability scan in
// src/tests/sketch/oneSketchPointerOwner.test.ts.
import { entityLabels } from '../browserModel'
import {
  captureSketchClipboard,
  instantiateSketchClipboard,
  type SketchClipboardPayload,
} from '../clipboard'
import { optimizeLoops } from '../../geometry/loopOptimizer'
import { importDXF } from '../../import/dxfImporter'
import type { DxfImportReport } from '../../import/dxfImporter'
import { importSVG } from '../../import/svgImporter'
import { saveFile } from '../../saveFile'
import { exportSketchSvg as sketchSvg } from '../exportSvg'
import { exportSketchDxf as sketchDxf } from '../exportDxf'
import { buildSketchPrintDocument, printSketchDocument, type SketchPrintOptions } from '../printDrawing'
import { decodeRaster, traceBitmap, TRACE_DEFAULT_THRESHOLD, TRACE_DEFAULT_WIDTH_MM } from '../../import/rasterTrace'
import { inferenceConstraints } from '../inference'
import { liftLoops } from '../lift'
import { normalizeGearParams, type GearParams } from '../tools/gearTool'
import { orthoAnchor, orthoLockCursor } from '../orthoLock'
import { toolCommitFlash, toolReplaceFlash } from '../promptBar'
import {
  buildProjectCommit, resolveProjectHit, type ProjectCandidate, type ProjectResolveResult,
} from '../projectUse'
import {
  breakProjectionLinks, edgePlaneCrossing, linkProjectedEntities, makePierceConstraint, pierceMissPhrase,
  projectionLinkedIdsIn, withPierce,
} from '../projectLink'
import { piercePointForSelection } from '../constraintActions'
import { chainAlignRef, findSnap, wakeRef, type SnapResult } from '../snap'
import {
  isSampleablePath, pathLUT, pickTextAttachTarget, pointHitsTextEntity, projectPointToPathOffset,
} from '../textOnPath'
import {
  chamferApplyAll, chamferChainMaxSetback, chamferMaxUsableSetback,
  type ChamferCornerPick,
} from '../tools/chamferTool'
import { commitDrawValue } from '../tools/drawValue'
import {
  filletApplyAll, filletChainMaxRadius, filletMaxUsableRadius,
  type FilletCornerPick,
} from '../tools/filletTool'
import {
  breakOffsetLinks, offsetApply, offsetLinkIdsIn, setOffsetLinkDistance,
} from '../tools/offsetTool'
import { circularPatternApply, linearPatternApply, pathPatternApply } from '../tools/patternTools'
import { transformApply, transformNotice, transformPlaced } from '../tools/transformTools'
import { splineFinish, bezierPress as bezierPressChain } from '../tools/splineTools'
import {
  bezierJointSummary, bezierJoints, bezierSetJointSmooth, conicLogClamp, conicSelectionSummary, conicWithRho,
} from '../spline'
import {
  assertNeverChainMaxKind, classifyChainMax, seedStagedSize,
  type ChainMaxResult, type ChainMaxRefusalKind,
} from '../tools/stagedSizeDrag'
import { toolOverlay, type ToolOverlay } from '../tools/toolOverlay'
import { trimSwipe, trimSwipeHighlights } from '../tools/trimTool'
import type { SketchDoc } from '../tools/trimTool'
import {
  armToolWithSelection, clickUsesSnap, confirmToolStep, cycleDimForce as cycleDimForcePure,
  endChain, escapeTool, PICK_TOOLS, toggleRectRotated as toggleRectRotatedPure, toolClick,
  type SketchToolId, type ToolChainState,
} from '../tools/toolMachine'
import type { PointRef, Sketch, SketchEntity, Vec2 as SketchVec2 } from '../types'
import type { Loop2D } from '../../../types'
import type { SketchDocumentPort } from './ports'
import {
  clearPendingSnaps, drainPendingSnaps, recordPendingSnap, sketcherToolStore, toolState,
} from './toolStore'

// ---- Document binding -----------------------------------------------------------------------
//
// The controller is a singleton for the same reason the tool store is (see toolStore.ts): the
// toolbox, the prompt bar and the confirm overlay dispatch tool actions from all over the React
// tree. A mount binds its document sink ONCE, via `Sketcher.setDocumentPort()`.
let doc: SketchDocumentPort | null = null
let clipboard: SketchClipboardPayload | null = null
let clipboardPlacement: SketchVec2 | null = null
let fallbackPasteOrdinal = 0
/** WO-1865: the sketch point a Pierce is waiting to place, between the Pierce command and the model
 *  edge click. Cleared by any other tool arm, Esc, a document switch, or the pierce itself. */
let pendingPierce: PointRef | null = null

/** Test seam only: clipboard contents intentionally survive real document switches. */
export function __resetSketchClipboardForTest(): void {
  clipboard = null
  clipboardPlacement = null
  fallbackPasteOrdinal = 0
}

export function bindSketcherDocument(port: SketchDocumentPort | null): void {
  doc = port
}

/** The bound document sink, or null when no mount is live. Every action below no-ops without one
 *  rather than throwing: a keyboard shortcut can outlive a mount teardown by a frame. */
export function sketcherDocument(): SketchDocumentPort | null {
  return doc
}

const uuid = (): string => crypto.randomUUID()

// ---- SKC-46/R1: staged-size seed/clamp on a NEW corner ------------------------------------------
//
// Fires only for fillet/chamfer chains (the only staged-size tools). `prevChain` is the chain
// BEFORE this transition (armTool always passes null: arming discards whatever was staging).
// On the FIRST corner of a fresh session (corners grew from 0), the remembered COMMITTED size (or
// the derived grabbable default when none exists — stagedSizeDrag.ts) seeds the scalar, clamped to
// what the newly-staged corner(s) can actually take. Every LATER corner addition re-clamps the
// CURRENT scalar down if the growing batch's shared max no longer covers it; removing a corner
// never grows the scalar back (same one-way clamp direction the drag/typed paths already use).
//
// R1 (BLOCKER 1 close-out): `filletChainMaxRadius`/`chamferChainMaxSetback` now return the STRICT
// per-constructor ceiling (already safely inside the EPS_LEN accept region), so seeding AT that
// ceiling always previews (>=1 fit) and applies (non-null transform). When `seedStagedSize`
// reports `refused` -- no legal size exists above the shared 0.01mm floor for the corner just
// added -- this REFUSES the addition outright: `chain` reverts to `fallback` (the batch as it
// stood before this corner, or an emptied chain on a fresh arm) instead of staging an impossible
// preview, and `notice` carries the named reason (ADR-0003: no silent fallback).
//
// R2 (two-bounce STOP close-out): `maxUsable` is now the DISCRIMINATED `ChainMaxResult`, not a
// bare `number | null`. The old `shouldSeed` guard did a numeric comparison (`current >
// maxUsable`) BEFORE knowing whether `maxUsable` was even a number -- on a NaN chain max the
// comparison was false-by-NaN, `shouldSeed` was false, and the corner was accepted via a silent
// noop with `seedStagedSize` never even running (the preflight's "second unnamed accept path").
// `shouldSeedChainMax` below classifies FIRST: for every non-`finite-legal` kind (unresolvable,
// non-finite, sub-floor) it ALWAYS re-seeds (so `seedStagedSize` always gets a chance to refuse by
// name); only inside the `finite-legal` arm does the old current-exceeds-ceiling optimization run.
interface StagedSizeSeedResult {
  chain: ToolChainState | null
  sizePatch: Partial<{ filletRadius: number; chamferSetback: number }>
  notice: string | null
}

function shouldSeedChainMax(prevCount: number, maxUsable: ChainMaxResult, current: number): boolean {
  if (prevCount === 0) return true
  switch (maxUsable.kind) {
    case 'no-corner':
      return false
    case 'unresolvable':
    case 'non-finite':
    case 'sub-floor':
      return true
    case 'finite-legal':
      return current > maxUsable.value
    default:
      return assertNeverChainMaxKind(maxUsable)
  }
}

/** The `remembered` argument `seedStagedSize` receives on a LATER addition (`prevCount > 0`): the
 *  numeric ceiling itself when one exists (so the scalar re-clamps DOWN to the new tighter ceiling
 *  exactly), else null (nothing numeric to re-clamp to -- `unresolvable`/`non-finite` always
 *  refuse regardless of `remembered`). */
function numericChainMaxCeiling(maxUsable: ChainMaxResult): number | null {
  return maxUsable.kind === 'finite-legal' || maxUsable.kind === 'sub-floor' ? maxUsable.value : null
}

/** Exhaustive over the 3 refusal kinds ONLY (`ChainMaxRefusalKind`) -- no `default` arm exists nor
 *  is one needed, closing the WO's "no default:accept arm" gate at the type level for this site. */
function chainMaxRefusalNotice(tool: 'fillet' | 'chamfer', maxUsable: ChainMaxRefusalKind): string {
  const Tool = tool === 'fillet' ? 'Fillet' : 'Chamfer'
  const verb = tool === 'fillet' ? 'fillet' : 'chamfer'
  const noun = tool === 'fillet' ? 'radius' : 'setback'
  switch (maxUsable.kind) {
    case 'unresolvable':
      return `${Tool}: corner cannot resolve (collinear or degenerate) - cannot ${verb}`
    case 'non-finite':
      return `${Tool}: corner geometry is degenerate (non-finite size) - cannot ${verb}`
    case 'sub-floor':
      return `${Tool}: corner too small to ${verb} (max usable ${noun} ${maxUsable.value.toFixed(4)} mm)`
    default:
      return assertNeverChainMaxKind(maxUsable)
  }
}

function stagedSizeSeedPatch(
  prevChain: ToolChainState | null, nextChain: ToolChainState | null, sk: SketchDoc,
  fallback: ToolChainState | null,
): StagedSizeSeedResult {
  const noop: StagedSizeSeedResult = { chain: nextChain, sizePatch: {}, notice: null }
  if (!doc) return noop

  if (nextChain?.kind === 'fillet' && nextChain.corners.length > 0) {
    const prevCount = prevChain?.kind === 'fillet' ? prevChain.corners.length : 0
    const maxUsable = filletChainMaxRadius(nextChain, sk)
    if (!shouldSeedChainMax(prevCount, maxUsable, toolState().filletRadius)) return noop
    const remembered = prevCount === 0 ? doc.getLastStagedSize('fillet') : numericChainMaxCeiling(maxUsable)
    const seed = seedStagedSize(remembered, maxUsable)
    if (seed.refused) {
      return {
        chain: fallback,
        sizePatch: {},
        notice: chainMaxRefusalNotice('fillet', maxUsable as ChainMaxRefusalKind),
      }
    }
    return { chain: nextChain, sizePatch: { filletRadius: seed.value }, notice: null }
  }

  if (nextChain?.kind === 'chamfer' && nextChain.corners.length > 0) {
    const prevCount = prevChain?.kind === 'chamfer' ? prevChain.corners.length : 0
    const maxUsable = chamferChainMaxSetback(nextChain, sk)
    if (!shouldSeedChainMax(prevCount, maxUsable, toolState().chamferSetback)) return noop
    const remembered = prevCount === 0 ? doc.getLastStagedSize('chamfer') : numericChainMaxCeiling(maxUsable)
    const seed = seedStagedSize(remembered, maxUsable)
    if (seed.refused) {
      return {
        chain: fallback,
        sizePatch: {},
        notice: chainMaxRefusalNotice('chamfer', maxUsable as ChainMaxRefusalKind),
      }
    }
    return { chain: nextChain, sizePatch: { chamferSetback: seed.value }, notice: null }
  }

  return noop
}

// ---- R2 requirement 2b: MIXED-CHAIN RULING ------------------------------------------------------
//
// Architect ruling (the preflight's "largest unnamed state"): resolvability is judged per
// ADDITION, not only per aggregate. `stagedSizeSeedPatch` above only ever sees the AGGREGATE
// ceiling across every staged corner -- an unresolvable/non-finite corner is invisible there
// (skipped by `classifyChainMax`'s `continue`, or poisons the whole aggregate to NaN). Neither
// case names the ONE corner responsible. The two entry points below classify the newly-added
// corner(s) in isolation, BEFORE the aggregate ever runs:
//   - a CLICK addition (exactly one corner) that is itself unresolvable/non-finite is refused
//     OUTRIGHT: the whole click reverts to the batch as it stood (`checkMixedChainAddition`).
//   - a PRESELECTION seeding (armTool, N corners at once) drops just the unresolvable/non-finite
//     corners and keeps the resolvable rest, flashing ONE notice naming the drop count
//     (`filterMixedChainCorners`).
// Both route every per-corner ceiling through the SAME single classifier (`classifyChainMax`) --
// there is no second, ad-hoc resolvability test anywhere in this file.
function perCornerChainMax(
  kind: 'fillet' | 'chamfer', sk: SketchDoc, c: FilletCornerPick | ChamferCornerPick,
): ChainMaxResult {
  const raw = kind === 'fillet'
    ? filletMaxUsableRadius(sk, c.aId, c.bId, c.hintA, c.hintB)
    : chamferMaxUsableSetback(sk, c.aId, c.bId, c.hintA, c.hintB)
  return classifyChainMax([raw])
}

function isDeadCorner(result: ChainMaxResult): boolean {
  return result.kind === 'unresolvable' || result.kind === 'non-finite'
}

/** CLICK-addition check: `nextChain` grew by exactly one corner over `prevChain` (the click path
 *  only ever adds/removes one via `toggleCorner`). When the newly-added corner is itself dead
 *  (unresolvable/non-finite) -- even while the chain AGGREGATE stays finite thanks to the older
 *  resolvable corners -- refuse the addition by name: revert to `prevChain`, memory untouched. */
function checkMixedChainAddition(
  prevChain: ToolChainState | null, nextChain: ToolChainState | null, sk: SketchDoc,
): { refused: boolean; notice: string | null } {
  const none = { refused: false, notice: null }
  if (nextChain?.kind === 'fillet') {
    const prevCorners = prevChain?.kind === 'fillet' ? prevChain.corners : []
    if (nextChain.corners.length <= prevCorners.length) return none
    const added = nextChain.corners.find((c) => !prevCorners.includes(c))
    if (!added || !isDeadCorner(perCornerChainMax('fillet', sk, added))) return none
    return {
      refused: true,
      notice: 'Fillet: that corner cannot resolve (collinear or degenerate) - selection unchanged',
    }
  }
  if (nextChain?.kind === 'chamfer') {
    const prevCorners = prevChain?.kind === 'chamfer' ? prevChain.corners : []
    if (nextChain.corners.length <= prevCorners.length) return none
    const added = nextChain.corners.find((c) => !prevCorners.includes(c))
    if (!added || !isDeadCorner(perCornerChainMax('chamfer', sk, added))) return none
    return {
      refused: true,
      notice: 'Chamfer: that corner cannot resolve (collinear or degenerate) - selection unchanged',
    }
  }
  return none
}

/** PRESELECTION filter: `chain` was just seeded from a multi-line selection (armTool ->
 *  filletSeedFromSelection/chamferSeedFromSelection stage EVERY shared corner, resolvable or not).
 *  Drops the dead corners, keeps the resolvable rest, and names the drop count in ONE notice. When
 *  every corner is dead, this returns an EMPTY chain -- the existing full-refusal shape (zero
 *  staged preview) -- with a notice naming that too. Returns `chain` unchanged (and `notice: null`)
 *  when nothing was dropped. */
function filterMixedChainCorners(
  chain: ToolChainState | null, sk: SketchDoc,
): { chain: ToolChainState | null; notice: string | null } {
  if (!chain || (chain.kind !== 'fillet' && chain.kind !== 'chamfer')) return { chain, notice: null }
  const kind = chain.kind
  const resolvable = chain.corners.filter((c) => !isDeadCorner(perCornerChainMax(kind, sk, c)))
  const dropped = chain.corners.length - resolvable.length
  if (dropped === 0) return { chain, notice: null }
  const Tool = kind === 'fillet' ? 'Fillet' : 'Chamfer'
  const verb = kind === 'fillet' ? 'fillet' : 'chamfer'
  const next = { ...chain, corners: resolvable } as ToolChainState
  const notice = resolvable.length === 0
    ? `${Tool}: no selected corner can ${verb} (collinear or degenerate) - nothing staged`
    : `${Tool}: ${dropped} corner${dropped === 1 ? '' : 's'} cannot ${verb} (collinear or degenerate) - dropped from selection`
  return { chain: next, notice }
}

// ---- The controller -------------------------------------------------------------------------

/** Arm a tool. Discards the in-progress chain, its snapped clicks and its woken alignment refs.
 *
 *  Multi-operand MODIFY tools (mirror/patterns) CONSUME a non-empty selection as their first
 *  step's operands (pre-selection doctrine): the chain arrives seeded as an OPEN set the user can
 *  still extend by clicking, then CLOSES with Confirm (Enter) before the axis / placement step.
 *  Seeding mirror straight into axis-pick was the tool-first bug: a single lingering selection
 *  hijacked the next click as the axis.
 *
 *  SELECT-CURVE-FIRST for text (spec T1c): a sampleable curve in the selection when the Text tool
 *  is armed means the text is created ON that curve IMMEDIATELY after the arm -- caret ready, no
 *  location click. Captured BEFORE the arm (so we read the selection as it stood). Multi-selection
 *  rule: the FIRST sampleable entity in selection order (deterministic). */
export function armTool(tool: SketchToolId): void {
  if (!doc) return
  const sketch = doc.getSketch()
  const selection = doc.getSelection()

  let pathForText: SketchEntity | null = null
  if (tool === 'text') {
    const ents = sketch?.entities ?? []
    for (const id of selection) {
      const e = ents.find((x) => x.id === id)
      if (e && isSampleablePath(e)) {
        pathForText = e
        break
      }
    }
  }

  pendingPierce = null
  clearPendingSnaps()
  const armState = toolState()
  const next = armToolWithSelection(
    { tool: armState.tool, chain: armState.chain }, tool,
    selection, sketch?.entities ?? [], sketch?.constraints ?? [],
  )
  // Pre-selection seeding (filletSeedFromSelection / chamferSeedFromSelection) can stage corners
  // immediately on arm; a fresh arm always discards whatever was staging before, so this is
  // always a NEW session (prevChain null) for the seed/clamp rule above. A refusal here (R1) has
  // no "batch before this corner" to fall back to -- it drops ALL pre-seeded corners (the tool
  // stays armed, empty, for the user to click a workable corner) rather than staging any of them
  // with an unseedable shared scalar.
  //
  // R2 mixed-chain ruling (requirement 2b): filletSeedFromSelection/chamferSeedFromSelection stage
  // EVERY shared corner among the selected lines, resolvable or not -- a selection spanning an
  // L-corner plus a collinear extension seeds one dead corner alongside a live one. That dead
  // corner can NEVER fit at any size (unlike a resolvable-but-misfit corner the user can heal by
  // dragging the size down), so it is dropped here, before the aggregate seed/clamp below ever
  // runs, keeping only the resolvable corners and naming the drop count in one notice.
  const preselectionFilter = sketch ? filterMixedChainCorners(next.chain, sketch) : { chain: next.chain, notice: null }
  const filteredChain = preselectionFilter.chain
  const armFallback: ToolChainState | null =
    filteredChain && (filteredChain.kind === 'fillet' || filteredChain.kind === 'chamfer')
      ? { ...filteredChain, corners: [] }
      : filteredChain
  const seedResult = sketch
    ? stagedSizeSeedPatch(null, filteredChain, sketch, armFallback)
    : { chain: filteredChain, sizePatch: {}, notice: null }
  sketcherToolStore.setState({
    tool: next.tool, chain: seedResult.chain, wakeRefs: [], ...seedResult.sizePatch,
  })
  // Only one notice flashes: the preselection drop (if any corners were dead) takes priority over
  // the aggregate seed/clamp notice (sub-floor on the SURVIVING corners) since it names the more
  // fundamental reason a batch changed shape.
  const armNotice = preselectionFilter.notice ?? seedResult.notice
  if (armNotice) doc.notice(armNotice, 'warning')

  // SELECT-CURVE-FIRST: create the on-path text NOW (no location click ever -- spec T1c) and open
  // the caret.
  if (tool === 'text' && pathForText) {
    // A live text edit left open (arming from the toolbox button does not blur-commit) finishes
    // first so its edit flags are not clobbered by the new placement.
    if (doc.getTextEditId()) doc.commitTextEdit()
    const lut = pathLUT(pathForText)
    if (!lut) {
      // Unreachable after isSampleablePath above, but never a silent no-op (ADR-0003).
      doc.notice('Text on curve: the selected curve cannot be sampled')
      return
    }
    // Select-curve-first attaches CENTERED (spec T1c "default anchor: center"): pathAlign
    // 'center' -- render/bake resolve the actual start offset from arc length + string advance as
    // the user types (effectiveStartOffsetMm, ONE shared source). pathOffsetMm keeps the mid-curve
    // value ONLY as the numeric fallback a later switch to 'free' starts from; `at` lands the
    // caret mid-curve.
    const startOffsetMm = lut.totalLength / 2
    doc.placeText(lut.pointAt(startOffsetMm), pathForText, startOffsetMm, 'center', toolState().constructionMode)
    // CONSUME the seed selection (selection-driven semantics, same convention as mirror consuming its
    // operands): leaving the curve selected made EVERY later arming of the Text tool instantly
    // re-create another empty caret on it.
    const seedId = pathForText.id
    doc.setSelection(doc.getSelection().filter((x) => x !== seedId))
    doc.notice('Text attached to the selected curve — start typing')
  }
}

/** Tab while smart-dimension has an operand set: cycle that operand family's mode. */
export function cycleDimForce(): void {
  sketcherToolStore.setState((s) => {
    const entities = doc?.getSketch()?.entities ?? []
    const next = cycleDimForcePure({ tool: s.tool, chain: s.chain }, entities)
    return { tool: next.tool, chain: next.chain }
  })
}

/** Tab while a rectangle tool is armed: toggle ROTATED (angled) mode. */
export function toggleRectRotated(): void {
  sketcherToolStore.setState((s) => {
    const next = toggleRectRotatedPure({ tool: s.tool, chain: s.chain })
    return { tool: next.tool, chain: next.chain }
  })
}

/** 'q': flip construction on the selection, else toggle the draw-as-construction mode.
 *
 *  Selected entities win: the host flips THEIR flags as one undo step. NEVER silent (stage6-ux
 *  gate, scenario 09 trap): a selection flip on a possibly off-screen/stale selection flashes what
 *  happened (the host says so) and leaves the MODE untouched -- the toolbox button's lit state
 *  reflects the MODE only. */
export function toggleConstruction(): void {
  if (!doc) return
  if (doc.toggleSelectionConstruction()) return
  const on = !toolState().constructionMode
  sketcherToolStore.setState({ constructionMode: on })
  doc.notice(on
    ? 'Construction mode ON - new geometry will be construction'
    : 'Construction mode OFF - new geometry will be normal')
}

/** Esc. Returns true when the key was consumed (the caller must not fall through to exit). */
export function escape(): boolean {
  if (!doc) return false
  pendingPierce = null
  // A pending attach-to-path pick swallows Esc first: cancel the pick and stay in whatever
  // edit/tool state we were in.
  if (doc.getPickPathForTextId()) {
    doc.cancelPickTextPath()
    return true
  }
  // A live placed-text edit swallows Esc first: revert and finish (this path runs before the
  // viewport's typing-guard, so Esc cancels even while a toolbox text input holds focus).
  if (doc.getTextEditId()) {
    doc.cancelTextEdit()
    return true
  }
  const s = toolState()
  const r = escapeTool({ tool: s.tool, chain: s.chain })
  if (r.consumed) {
    clearPendingSnaps()
    sketcherToolStore.setState({
      tool: r.state.tool,
      chain: r.state.chain,
      wakeRefs: [],
    })
  }
  return r.consumed
}

/** Enter / double-click / the prompt-bar Confirm button. */
export function end(): void {
  if (!doc) return
  const s = toolState()
  const chain = s.chain

  // Confirm-overlay phase: Enter (and the prompt-bar Confirm button, and the context menu's
  // Confirm step) APPLIES the staged flow -- same path as the overlay's Apply button.
  if (
    (chain?.kind === 'fillet' && chain.corners.length > 0) ||
    (chain?.kind === 'chamfer' && chain.corners.length > 0) ||
    (chain?.kind === 'offset' && chain.lockedSide !== null) ||
    (chain?.kind === 'linpat' && chain.vector !== null) ||
    (chain?.kind === 'circpat' && chain.center !== null) ||
    (chain?.kind === 'pathpat' && chain.path !== null) ||
    (chain?.kind === 'transform' && transformPlaced(chain))
  ) {
    overlayApply()
    return
  }

  // SPLINE finish: Enter / double-click commits the accumulated through-points as ONE
  // solver-inert spline (>= 2 points; otherwise the chain is just discarded by the generic
  // end-chain below). Snap inferences recorded on the anchor click ride the same undo step.
  if (chain?.kind === 'spline' && doc.getSketch()) {
    const commit = splineFinish(chain, s.constructionMode, uuid, s.splineClosed)
    if (commit) {
      const inferred = inferenceConstraints(commit, drainPendingSnaps(), uuid)
      doc.beginStep()
      sketcherToolStore.setState({ chain: null, wakeRefs: [] })
      doc.append(commit, inferred)
      return
    }
  }

  // Confirm as a STEP ADVANCE (pattern set closes -> placement).
  const advanced = confirmToolStep({ tool: s.tool, chain })
  if (advanced) {
    sketcherToolStore.setState({ tool: advanced.tool, chain: advanced.chain })
    return
  }

  clearPendingSnaps()
  sketcherToolStore.setState((st) => {
    const next = endChain({ tool: st.tool, chain: st.chain })
    return { tool: next.tool, chain: next.chain, wakeRefs: [] }
  })
}

/** The confirm overlay's Apply button (and Enter, via `end()`). Every branch is ONE undo step. */
export function overlayApply(): void {
  if (!doc) return
  const sk = doc.getSketch()
  if (!sk) return
  const s = toolState()
  const chain = s.chain

  // FILLET: apply every staged corner at the current radius as ONE undo step; corners that do not
  // resolve are skipped and NAMED.
  if (chain?.kind === 'fillet' && chain.corners.length > 0) {
    const r = filletApplyAll(sk, chain.corners, s.filletRadius)
    if (!r.transform) {
      // BK-78: nothing at all was applied -- the requested transform fully failed.
      doc.notice(r.skipped[0]?.reason ?? 'Fillet: nothing could be applied', 'error')
      return
    }
    doc.beginStep()
    sketcherToolStore.setState({ chain: null })
    doc.replace(r.transform, { clearSelection: true })
    // SKC-46: memory updates ONLY here -- a real, applied commit. A canceled drag, a typed-but-
    // unapplied edit, or a drag tick never reaches overlayApply, so none of them can overwrite it.
    doc.setLastStagedSize('fillet', s.filletRadius)
    const labels = entityLabels(sk.entities)
    const name = (id: string): string => labels.get(id) ?? id
    const skippedNames = r.skipped.map(({ pick }) => `${name(pick.aId)} / ${name(pick.bId)}`)
    doc.notice(
      `Filleted ${r.applied} ${r.applied === 1 ? 'corner' : 'corners'} (R${s.filletRadius})` +
      (skippedNames.length > 0 ? ` - skipped (does not fit): ${skippedNames.join(', ')}` : ''))
    return
  }

  // CHAMFER: apply every staged corner at the current setback as ONE undo step.
  if (chain?.kind === 'chamfer' && chain.corners.length > 0) {
    const r = chamferApplyAll(sk, chain.corners, s.chamferSetback)
    if (!r.transform) {
      doc.notice(r.skipped[0]?.reason ?? 'Chamfer: nothing could be applied', 'error')
      return
    }
    doc.beginStep()
    sketcherToolStore.setState({ chain: null })
    doc.replace(r.transform, { clearSelection: true })
    // SKC-46: memory updates ONLY here -- see the matching fillet comment above.
    doc.setLastStagedSize('chamfer', s.chamferSetback)
    const labels = entityLabels(sk.entities)
    const name = (id: string): string => labels.get(id) ?? id
    const skippedNames = r.skipped.map(({ pick }) => `${name(pick.aId)} / ${name(pick.bId)}`)
    doc.notice(
      `Chamfered ${r.applied} ${r.applied === 1 ? 'corner' : 'corners'} (${s.chamferSetback} mm)` +
      (skippedNames.length > 0 ? ` - skipped (does not fit): ${skippedNames.join(', ')}` : ''))
    return
  }

  // PATTERNS: commit the placed pattern at the live count/angle as ONE undo step; rejections keep
  // the flow alive.
  if (
    (chain?.kind === 'linpat' && chain.vector !== null) ||
    (chain?.kind === 'circpat' && chain.center !== null)
  ) {
    const r = chain.kind === 'linpat'
      ? linearPatternApply(chain, sk.entities, sk.constraints, s.linearPatternCount)
      : circularPatternApply(
          chain, sk.entities, sk.constraints, s.circularPatternCount,
          (s.circularPatternAngleDeg * Math.PI) / 180)
    if (typeof r === 'string') {
      // BK-78: a rejected pattern configuration -- correctable, warning.
      doc.notice(r, 'warning')
      return
    }
    doc.beginStep()
    sketcherToolStore.setState({ chain: null })
    doc.append({ entities: r.entities, constraints: r.constraints }, [])
    const label = chain.kind === 'linpat' ? 'Linear' : 'Circular'
    doc.notice(
      `${label} pattern: created ${r.entities.length} ` +
      `${r.entities.length === 1 ? 'entity' : 'entities'}`)
    return
  }

  // PATH PATTERN: commit `count` fresh instances walked along the locked
  // path at the live count/spacing/orientation, as ONE undo step; a
  // rejected configuration (e.g. count < 2) keeps the flow alive.
  if (chain?.kind === 'pathpat' && chain.path !== null) {
    const r = pathPatternApply(chain, sk.entities, sk.constraints)
    if (typeof r === 'string') {
      doc.notice(r, 'warning')
      return
    }
    doc.beginStep()
    sketcherToolStore.setState({ chain: null })
    doc.append({ entities: r.entities, constraints: r.constraints }, [])
    doc.notice(
      `Path pattern: created ${r.entities.length} ` +
      `${r.entities.length === 1 ? 'entity' : 'entities'}`)
    return
  }

  // MOVE / ROTATE / SCALE: commit at the overlay values as ONE undo step (in place, or a copy with
  // Keep original); a value the transform cannot take explains itself and keeps the overlay up.
  if (chain?.kind === 'transform' && transformPlaced(chain)) {
    const r = transformApply(chain, sk)
    if (typeof r === 'string') {
      doc.notice(r, 'warning')
      return
    }
    doc.beginStep()
    sketcherToolStore.setState({ chain: null })
    doc.replace(r.transform, { clearSelection: true })
    doc.notice(transformNotice(chain.op, r))
    return
  }

  // OFFSET: commit the side-locked offset at the current distance as ONE undo step; a distance the
  // shape cannot take explains itself and keeps the flow alive (adjust and OK again).
  if (chain?.kind === 'offset' && chain.lockedSide !== null) {
    const r = offsetApply(chain, s.offsetDistance)
    if (typeof r === 'string') {
      doc.notice(r, 'warning')
      return
    }
    doc.beginStep()
    sketcherToolStore.setState({ chain: null })
    doc.append({ entities: r.entities, constraints: r.constraints }, [])
    doc.notice(
      `Offset: created ${r.entities.length} ` +
      `${r.entities.length === 1 ? 'entity' : 'entities'} (${s.offsetDistance} mm)`)
  }
}

/**
 * THE tool click. Branch order is load-bearing and unchanged from the store original:
 *   text-edit click-away -> attach-to-path pick -> PROJECT -> TEXT -> the pure tool machine.
 */
export function click(
  world: SketchVec2, tolWorld: number, snap: SnapResult | null, forceSquare: boolean,
  beforeMutate?: () => void,
  projectResolution?: ProjectResolveResult,
): void {
  if (!doc) return

  // Tool clicks must NEVER silently no-op (ADR-0003). Entering sketch mode auto-creates a blank
  // document; if a click still finds none (store-API entry paths), the host makes one HERE, without
  // resetting the armed tool, so the click that triggered this lands in the new document. Runs
  // first, before anything below reads the document.
  doc.ensureSketch()

  // A live text edit commits on click-away. The attach-pick exemption below stays FIRST.
  // M1c EXCEPTION (drag-while-typing): a click that lands ON the text being EDITED belongs to that
  // edit -- the viewport may grow the press into the normal drag-slide, and a stationary press
  // must neither commit the edit nor place another text. Same metric as pick
  // (pointHitsTextEntity), so "on the text" agrees with hover/select everywhere.
  {
    const openEditId = doc.getTextEditId()
    if (openEditId && !doc.getPickPathForTextId()) {
      const sk = doc.getSketch()
      const edited = sk?.entities.find((x) => x.id === openEditId)
      if (sk && edited && pointHitsTextEntity(edited, sk.entities, world, tolWorld)) {
        return // caret stays open; nothing commits, nothing places
      }
      doc.commitTextEdit()
    }
  }

  const sketch = doc.getSketch()
  if (!sketch) return
  const s = toolState()

  // TEXT-ON-PATH attach: while awaiting a curve pick, THIS click binds the text to the nearest
  // curve (never falls through to the armed tool). A miss explains itself and stays in pick mode.
  const pickPathForTextId = doc.getPickPathForTextId()
  if (pickPathForTextId) {
    const hit = pickTextAttachTarget(sketch.entities, world, tolWorld, pickPathForTextId)
    if (!hit) {
      // BK-78: a miss the user can just retry -- warning.
      doc.notice(
        'Attach to path: no curve here — click a line, arc, circle, ellipse or spline', 'warning')
      return
    }
    doc.bindTextPath(pickPathForTextId, hit.id)
    doc.notice('Text attached to path')
    return
  }

  // PROJECT tool (Stage 6): the click consumes a baked loop from ANOTHER VISIBLE layer (locked
  // layers allowed -- read-only). Misses explain themselves (no silent no-op).
  if (s.tool === 'project') {
    // Pointer-driven external sources arrive already resolved by SketchInteraction. Direct callers
    // (including CAM store tests) retain the exact baked-layer fallback.
    const resolved = projectResolution ?? resolveProjectHit(doc.getProjectCandidates(), world, tolWorld)
    if (!resolved.ok) {
      doc.notice(resolved.message, 'warning')
      return
    }
    const candidate = resolved.candidate
    if (pendingPierce !== null) {
      commitPierce(sketch, pendingPierce, candidate, beforeMutate)
      return
    }
    const built = buildProjectCommit(candidate, s.constructionMode)
    if (!built.ok) {
      doc.notice(built.message, 'warning')
      return
    }
    const commit = built.commit
    // WO-1864: a model source commits LINKED pieces that follow the model; a CAM layer loop has no
    // model to follow and stays a static copy.
    const entities = linkProjectedEntities(commit.entities, candidate)
    beforeMutate?.()
    doc.append({ entities, constraints: commit.constraints }, [])
    const linked = entities.some((entity) => entity.projectionLink !== undefined)
    doc.notice(
      `Projected ${commit.entities.length} ` +
      `${s.constructionMode ? 'construction ' : ''}` +
      `entit${commit.entities.length === 1 ? 'y' : 'ies'} from ` +
      `"${candidate.sourceLabel}" ` +
      (linked ? '(fixed; linked - follows the model)' : '(fixed; static copy - no live link)'))
    return
  }

  // TEXT tool (WYSIWYG in-canvas entry): a click PLACES an empty text entity and immediately opens
  // the live in-canvas editor at it, focused.
  // CLICK-ON-CURVE attach (spec T1b): the click is FIRST tested against nearby curves; a hit births
  // the text ON-PATH, starting where the click projects along the curve -- the click means a
  // position ALONG the curve, NEVER a floating location near it (Operator's clarification). A miss
  // places FREE text at the (snapped) anchor, byte-identical to before.
  if (s.tool === 'text') {
    const at = snap?.point ?? world
    // Same pick + tolerance as the attach-to-path flow above AND the viewport's text-tool hover
    // (pickTextAttachTarget owns the doubled tolerance), so "near a curve" means the same thing
    // everywhere.
    const onPath = pickTextAttachTarget(sketch.entities, world, tolWorld)
    const pathOffsetMm = onPath ? (projectPointToPathOffset(onPath, at) ?? 0) : 0
    // A CLICKED position along the curve is a FREE position (spec T1b).
    doc.placeText(at, onPath, pathOffsetMm, 'free', s.constructionMode)
    return
  }

  // Clicks land on the snapped point the viewport previewed -- except PICK tools (smart-dim,
  // trim): their clicks PICK entities / place a label, so a grid/entity snap pulling the point
  // away would falsify the pick. Pattern PLACEMENT clicks (anchor / vector end / rotation center)
  // are point placements and DO snap (clickUsesSnap) -- a machinist's centerpoint wants the origin.
  const isPickTool = PICK_TOOLS.has(s.tool)
  const usesSnap = clickUsesSnap({ tool: s.tool, chain: s.chain })
  const at = usesSnap && snap?.point ? snap.point : world
  const selection = doc.getSelection()
  const r = toolClick(
    { tool: s.tool, chain: s.chain },
    at,
    tolWorld,
    undefined, // default id factory
    {
      entities: sketch.entities,
      construction: s.constructionMode,
      // Shift-at-commit -> square rect gets an equal-leg constraint.
      forceSquare,
      constraints: sketch.constraints,
      dimensions: sketch.dimensions,
      filletRadius: s.filletRadius,
      chamferSetback: s.chamferSetback,
      offsetDistance: s.offsetDistance,
      selectedIds: selection,
      linearPatternCount: s.linearPatternCount,
      circularPatternCount: s.circularPatternCount,
      circularPatternStepRad: (s.circularPatternAngleDeg * Math.PI) / 180,
      gearParams: s.gearParams,
      polygonSides: s.polygonSides,
      polygonMode: s.polygonMode,
      // WO-1863: the rho a new conic chain starts at (a started chain carries its own).
      conicRho: conicDrawRho,
      // NOTE: the text* ctx fields the store used to pass are deliberately absent. The `text` tool
      // returns above, so `toolClick` is never reached with it armed and those fields were dead on
      // this path. (They remain part of ToolClickCtx for toolMachine's own tests.)
      //
      // SMART-DIMENSION: pass the snapped POINT identity (endpoint / vertex / center / spline-
      // start) so an explicitly-picked corner is dimensioned as a POINT (point-to-line distance),
      // not as its owning line body (an angle). snap.wake.ref carries the addressable site; it is
      // null for a body / midpoint / quadrant snap, leaving the whole-entity pick path unchanged.
      // (Pick-tool clicks land raw -- usesSnap is false -- so this rides ALONGSIDE the raw pick.)
      // A MIDPOINT snap's wake ref carries the line's center site for
      // point-site picking, but for SMART-DIMENSION a midpoint click keeps
      // whole-line semantics (length / chamfer d1xd2) - excluding it here is
      // what that comment above promises (RED-A/B repair, 2026-07-21).
      dimExplicitPoint:
        s.tool === 'smart-dimension' && snap?.wake?.ref && snap.kind !== 'midpoint'
          ? { point: snap.point, ref: snap.wake.ref }
          : null,
      // SKC-62 repair 3, stated exactly: line-center markers are addressable
      // dim operands precisely when entity snapping is DISABLED.
      dimLineCentersAddressable: !s.snapEntity,
    },
  )

  // Record the snapped click so its inference becomes a real constraint when the chain commits
  // (multi-click tools: anchor clicks resolve later against the entities they helped build).
  // Pick-tool clicks never commit entities, so they record nothing. A bezier release after a
  // press is a HANDLE, not a point of the curve: its anchor's snap was recorded at the press.
  const bezierHandleRelease = s.tool === 'bezier' && s.chain?.kind === 'spline' && !!s.chain.press
  if (!isPickTool && snap && snap.inferences.length > 0 && !bezierHandleRelease) {
    recordPendingSnap({
      point: { x: at.x, y: at.y },
      inferences: snap.inferences,
      alignFrom: snap.alignFrom,
    })
  }

  // Rejected clicks (smart-dim invalid operand combination) explain themselves.
  if (r.notice) doc.notice(r.notice)

  // MODIFY tools (trim): full replacement document arrays as ONE undo step.
  if (r.replace) {
    beforeMutate?.()
    sketcherToolStore.setState({ tool: r.state.tool, chain: r.state.chain })
    doc.replace(r.replace, { clearSelection: true })
    // Step-completion flash (prompt-bar framework): say what the transform DID -- a rejection
    // already spoke via r.notice.
    if (!r.notice) {
      const flash = toolReplaceFlash(s.tool)
      if (flash) doc.notice(flash)
    }
    return
  }

  if (r.commit) {
    // Inference constraints ride the SAME undo step as the commit: entities + auto constraints +
    // snap inferences land together.
    const inferred = inferenceConstraints(r.commit, drainPendingSnaps(), uuid)
    beforeMutate?.()
    sketcherToolStore.setState({
      tool: r.state.tool,
      chain: r.state.chain,
      // Commit clears the woken alignment references (they served the entity that just landed).
      wakeRefs: [],
    })
    // MIRROR consumed the selection as its operands -- clear it (same convention as the fillet
    // overlay apply). Leaving it live made the NEXT line click re-enter selection-seeded mode and
    // silently re-mirror the stale selection: duplicate copies stacked on the first mirror (the
    // user-reported "mirror does not work correctly" pile-up).
    doc.append(r.commit, inferred, {
      openDimensionEditor: true,
      clearSelection: s.tool === 'mirror',
    })
    // A placed driving dimension opened its editor inside `append` (verdict solve, chunk-1 path);
    // it takes no flash. Multi-step MODIFY commits flash what they did ("Mirrored 4 entities about
    // Line 7"); CREATE commits are self-evident on canvas and stay quiet. The axis label is
    // resolved against the PRE-commit document (`sketch` captured above).
    if (!r.commit.dimensions?.[0]) {
      const flash = toolCommitFlash(s.tool, r.commit, sketch.entities)
      if (flash) doc.notice(flash)
    }
  } else {
    // SKC-46/R1: fillet/chamfer corner toggling lands here (r.commit is always null for those
    // tools; the batch commits through overlayApply). Seed/clamp the shared size scalar on the
    // new corner, or REFUSE it (BLOCKER 1) when no legal size exists for the resulting batch: the
    // chain reverts to `s.chain` (the batch as it stood before this click) instead of staging an
    // impossible preview, and a named notice explains why.
    //
    // R2 mixed-chain ruling (requirement 2b): BEFORE the aggregate seed/clamp above ever runs,
    // check whether THIS click ADDED a corner that is itself dead (unresolvable/non-finite) --
    // the aggregate alone cannot see this (a dead corner is invisible to `Math.min`'s `continue`,
    // or would poison it to NaN, but never names the ONE corner responsible). A dead addition is
    // refused outright: revert to `s.chain` exactly, memory untouched, named notice.
    const additionCheck = checkMixedChainAddition(s.chain, r.state.chain, sketch)
    if (additionCheck.refused) {
      sketcherToolStore.setState({ tool: r.state.tool, chain: s.chain })
      if (additionCheck.notice) doc.notice(additionCheck.notice, 'warning')
      return
    }
    const seedResult = stagedSizeSeedPatch(s.chain, r.state.chain, sketch, s.chain)
    sketcherToolStore.setState({
      tool: r.state.tool, chain: seedResult.chain, ...seedResult.sizePatch,
    })
    if (seedResult.notice) doc.notice(seedResult.notice, 'warning')
  }
}

/** Best snap candidate at the cursor. The component feeds the SAME result to preview, markers and
 *  the click, so what is previewed is exactly what commits. */
export function snap(
  cursor: SketchVec2, worldPerPixel: number, shiftKey = false,
): SnapResult | null {
  if (!doc) return null
  const sketch = doc.getSketch()
  if (!sketch) return null
  const s = toolState()
  const r = findSnap({
    cursor,
    entities: sketch.entities,
    gridSpacing: doc.getGridSpacing(),
    worldPerPixel,
    // Ortho-lock (Shift) suppresses soft H/V alignment + hover-wake so the locked direction wins;
    // entity/grid snaps still apply along the ray (the cursor is already locked upstream via
    // lockCursor).
    alignRef: shiftKey ? null : chainAlignRef(s.chain),
    wokenRefs: shiftKey ? [] : s.wakeRefs,
    flags: { entity: s.snapEntity, grid: s.snapGrid, inference: s.snapInference },
  })
  // Hover-wake: hovering a snappable point while a DRAWING tool is armed wakes it as an alignment
  // reference (smart-dim clicks pick entities, never place geometry -- nothing to align). wakeRef
  // returns the same array when already most recent, so the common pointermove path skips the
  // state write.
  if (r?.wake && !shiftKey && s.snapInference && s.tool !== 'select' && !PICK_TOOLS.has(s.tool)) {
    const next = wakeRef(s.wakeRefs, r.wake)
    if (next !== s.wakeRefs) sketcherToolStore.setState({ wakeRefs: next })
  }
  return r
}

/** Ortho-lock the cursor to the chain's 0/45/90deg rays while Shift is held (no-op otherwise).
 *  Applied BEFORE snap so the lock wins over soft H/V inference; the same locked point feeds
 *  preview and the click. */
export function lockCursor(world: SketchVec2, shiftKey: boolean): SketchVec2 {
  return shiftKey ? orthoLockCursor(toolState().chain, world) : world
}

/** Live tool overlay (removal highlights / ghost previews / warning markers) for the armed tool at
 *  the cursor. The component renders the channels verbatim. */
export function overlay(
  cursor: SketchVec2, tolWorld: number, shiftKey = false,
): ToolOverlay | null {
  if (!doc) return null
  const sketch = doc.getSketch()
  if (!sketch) return null
  const s = toolState()
  return toolOverlay(
    { tool: s.tool, chain: s.chain }, cursor, tolWorld,
    {
      entities: sketch.entities,
      constraints: sketch.constraints,
      dimensions: sketch.dimensions,
      selectedIds: doc.getSelection(),
      filletRadius: s.filletRadius,
      chamferSetback: s.chamferSetback,
      offsetDistance: s.offsetDistance,
      linearPatternCount: s.linearPatternCount,
      circularPatternCount: s.circularPatternCount,
      circularPatternStepRad: (s.circularPatternAngleDeg * Math.PI) / 180,
      // Ortho-lock cue: feed the chain anchor only while Shift is held so toolOverlay draws the
      // locked-direction guide.
      orthoLockAnchor: shiftKey ? orthoAnchor(s.chain) : null,
    },
  )
}

/** Removal highlights for an in-progress trim swipe path. */
export function swipeOverlay(path: SketchVec2[]): ToolOverlay | null {
  if (!doc) return null
  const sketch = doc.getSketch()
  if (!sketch || toolState().tool !== 'trim' || path.length < 2) return null
  const removal = trimSwipeHighlights(sketch, path)
  return removal.length > 0 ? { removal } : null
}

/** Drag-swipe trim (trim tool armed + drag): every curve the swipe crosses is trimmed. */
export function swipeTrim(path: SketchVec2[], beforeMutate?: () => void): void {
  if (!doc) return
  const sketch = doc.getSketch()
  if (!sketch || path.length < 2) return
  const r = trimSwipe(sketch, path)
  if (r.notice) doc.notice(r.notice)
  if (!r.transform) return
  beforeMutate?.()
  doc.replace(r.transform, { clearSelection: true })
}

/** WO-1862: a press with the BEZIER tool armed places the next anchor at the (snapped) press
 *  point; the release arrives as an ordinary click() whose point is that anchor's handle. The
 *  press snap is recorded here because the release point is not on the curve. No-op for any other
 *  tool. */
export function bezierPress(world: SketchVec2, snap: SnapResult | null): void {
  if (!doc || !doc.getSketch()) return
  const s = toolState()
  if (s.tool !== 'bezier') return
  const at = snap?.point ?? world
  const chain = s.chain?.kind === 'spline' && s.chain.form === 'bezier' ? s.chain : null
  if (snap && snap.inferences.length > 0) {
    recordPendingSnap({ point: { x: at.x, y: at.y }, inferences: snap.inferences, alignFrom: snap.alignFrom })
  }
  sketcherToolStore.setState({ chain: bezierPressChain(chain, at) })
}

/** WO-1862: a bezier press that ended without a release click (pointer cancel / lost capture)
 *  forgets its pending anchor, so the next click is an ordinary one. */
export function clearBezierPress(): void {
  const s = toolState()
  if (s.chain?.kind !== 'spline' || !s.chain.press) return
  const { press: _press, ...rest } = s.chain
  void _press
  sketcherToolStore.setState({ chain: rest.points.length > 0 ? rest : null })
}

/** WO-1862: the bezier JOINTS in the selection (anchors with a handle on both sides), and whether
 *  every one of them is already smooth. Null when the selection holds no bezier with a joint. */
export function bezierJointsInSelection(): { entityIds: string[]; joints: number; allSmooth: boolean } | null {
  const sketch = doc?.getSketch()
  if (!doc || !sketch) return null
  return bezierJointSummary(sketch.entities, doc.getSelection())
}

/** WO-1862: make every joint of the selected bezier chains SMOOTH (the in-handle turns to lie
 *  opposite the out-handle, and handle drags keep them collinear) or return them to CORNERS
 *  (geometry unchanged; the handles move independently from then on). One undo step. */
export function setBezierJointsSmooth(smooth: boolean): void {
  const sketch = doc?.getSketch()
  const found = bezierJointsInSelection()
  if (!doc || !sketch) return
  if (!found) {
    doc.notice('Bezier joints: select a bezier with at least two segments first.', 'info')
    return
  }
  const wanted = new Set(found.entityIds)
  const entities = sketch.entities.map((e) => {
    if (e.kind !== 'spline' || !wanted.has(e.id)) return e
    let next = e
    for (const j of bezierJoints(e.points.length, e.closed)) next = bezierSetJointSmooth(next, j, smooth)
    return next
  })
  doc.beginStep()
  doc.replace({ entities, constraints: sketch.constraints, dimensions: sketch.dimensions })
  doc.notice(
    `Bezier: ${found.joints} joint${found.joints === 1 ? '' : 's'} ${smooth ? 'made smooth' : 'set to corners'}`)
}

// ---- Conic arc rho (WO-1863) ---------------------------------------------------------------------

/** The rho a new conic arc is drawn at. A tool preference like the polygon side count; it lives
 *  here rather than in the tool store because a started conic chain carries its own copy (so the
 *  preview and the commit read the chain, never this). */
let conicDrawRho = 0.5

/** WO-1863: the conic tool's rho -- the live chain's while one is being placed, else the value the
 *  next conic starts at. */
export function conicDrawRhoValue(): number {
  const c = toolState().chain
  return c?.kind === 'conic' ? c.rho : conicDrawRho
}

/** WO-1863: set the conic tool's rho. Out-of-range values are clamped to the drawable range with
 *  one console line (rule 11: draw it, say what was drawn). A conic being placed takes it at once,
 *  so its rubber band reshapes. */
export function setConicDrawRho(rho: number): void {
  conicDrawRho = conicLogClamp(rho)
  const c = toolState().chain
  if (c?.kind === 'conic') sketcherToolStore.setState({ chain: { ...c, rho: conicDrawRho } })
}

/** WO-1863: the conic arcs in the selection and their rho (null when there are none). */
export function conicsInSelection(): { entityIds: string[]; rho: number; mixed: boolean } | null {
  const sketch = doc?.getSketch()
  if (!doc || !sketch) return null
  return conicSelectionSummary(sketch.entities, doc.getSelection())
}

/** WO-1863: set the rho of every selected conic arc. Start, apex and end stay exactly where they
 *  are; only the shoulder moves and the arc reshapes in place. One undo step. Out-of-range values
 *  are clamped with one console line. */
export function setSelectedConicsRho(rho: number): void {
  const sketch = doc?.getSketch()
  const found = conicsInSelection()
  if (!doc || !sketch || !found) return
  const drawn = conicLogClamp(rho)
  const wanted = new Set(found.entityIds)
  const entities = sketch.entities.map((e) =>
    e.kind === 'spline' && wanted.has(e.id) ? conicWithRho(e, drawn) : e)
  doc.beginStep()
  doc.replace({ entities, constraints: sketch.constraints, dimensions: sketch.dimensions })
}

/** The "type a value mid-draw" box. */
export function commitDrawValueAt(value: number, cursor: SketchVec2): void {
  if (!doc) return
  const sketch = doc.getSketch()
  if (!sketch) {
    console.warn('commitDrawValue: no active sketch')
    return
  }
  const s = toolState()
  // FILLET / CHAMFER: the near-cursor box sets the persistent size scalar
  // LIVE (the ghost restyles immediately, the overlay Apply bakes it). It
  // does NOT commit geometry like the line/circle draw path; the bottom
  // toolbox field and confirm overlay write these same setters.
  if (s.tool === 'fillet' || s.tool === 'chamfer') {
    if (value > 0 && Number.isFinite(value)) {
      if (s.tool === 'fillet') setFilletRadius(value)
      else setChamferSetback(value)
    } else {
      doc.notice(
        s.tool === 'fillet'
          ? 'Fillet: radius must be a positive number'
          : 'Chamfer: setback must be a positive number',
        'warning',
      )
    }
    return
  }
  const res = commitDrawValue(
    { tool: s.tool, chain: s.chain }, cursor, value, uuid, s.constructionMode,
  )
  if (!res) {
    doc.notice('Type a value: not available for this draw step', 'warning')
    return
  }
  // Entities + auto constraints + the driving dimension land as ONE undo step; the chain advances
  // exactly as a normal click would (line continues, circle ends). Unlike a placed smart-dimension,
  // the value is already chosen, so NO editor opens -- just solve.
  doc.beginStep()
  sketcherToolStore.setState({ chain: res.nextChain, wakeRefs: [] })
  doc.append(res.commit, [])
}

// ---- Plain scalar setters (the toolbox / confirm overlay write these) -------------------------

export function setGearParams(patch: Partial<GearParams>): void {
  sketcherToolStore.setState({ gearParams: normalizeGearParams({ ...sketcherToolStore.getState().gearParams, ...patch }) })
}

export function setPolygonSides(n: number): void {
  if (Number.isInteger(n) && n >= 3) sketcherToolStore.setState({ polygonSides: n })
}
export function setPolygonMode(mode: 'inscribed' | 'circumscribed'): void {
  sketcherToolStore.setState({ polygonMode: mode })
}
export function setSplineClosed(v: boolean): void {
  sketcherToolStore.setState({ splineClosed: v })
}
export function setFilletRadius(r: number): void {
  if (r > 0 && Number.isFinite(r)) sketcherToolStore.setState({ filletRadius: r })
}
export function setChamferSetback(v: number): void {
  if (v > 0 && Number.isFinite(v)) sketcherToolStore.setState({ chamferSetback: v })
}
export function setOffsetDistance(v: number): void {
  if (v > 0 && Number.isFinite(v)) sketcherToolStore.setState({ offsetDistance: v })
}
export function setLinearPatternCount(n: number): void {
  if (Number.isInteger(n) && n >= 2) sketcherToolStore.setState({ linearPatternCount: n })
}
export function setCircularPatternCount(n: number): void {
  if (Number.isInteger(n) && n >= 2) sketcherToolStore.setState({ circularPatternCount: n })
}
export function setCircularPatternAngle(deg: number): void {
  if (Number.isFinite(deg) && deg > 0) sketcherToolStore.setState({ circularPatternAngleDeg: deg })
}
/** Confirm-overlay edit of a placed transform's value (dX/dY in mm, angle in degrees, factor).
 *  The value lives on the chain, so the ghost and OK read exactly what was typed. */
export function setTransformValue(field: 'dx' | 'dy' | 'angleDeg' | 'factor', v: number): void {
  if (!Number.isFinite(v)) return
  if (field === 'factor' && !(v > 0)) return
  sketcherToolStore.setState((s) =>
    s.chain?.kind === 'transform' ? { chain: { ...s.chain, [field]: v } } : {})
}
/** Confirm-overlay Keep original checkbox: commit a copy and leave the set where it is. */
export function setTransformKeepOriginal(keep: boolean): void {
  sketcherToolStore.setState((s) =>
    s.chain?.kind === 'transform' ? { chain: { ...s.chain, keepOriginal: keep } } : {})
}
export function toggleSnapFlag(flag: 'entity' | 'grid' | 'inference'): void {
  sketcherToolStore.setState((s) => ({
    snapEntity: flag === 'entity' ? !s.snapEntity : s.snapEntity,
    snapGrid: flag === 'grid' ? !s.snapGrid : s.snapGrid,
    snapInference: flag === 'inference' ? !s.snapInference : s.snapInference,
  }))
}

/** Measure utility toggle (the `I` shortcut and the toolbox Measure button
 *  share this one action). Measure is a readout, not a drawing tool: it never
 *  enters `SketchToolId` or the tool click machine, so this only flips the
 *  shared `measureOpen` flag the toolbox reads for the active button state and
 *  the readout panel. */
export function toggleMeasure(): void {
  sketcherToolStore.setState((s) => ({ measureOpen: !s.measureOpen }))
}

export function setMeasureOpen(open: boolean): void {
  sketcherToolStore.setState({ measureOpen: open })
}

/** Delete / Backspace: the host owns the cascade + its undo step. */
export function deleteSelection(): void {
  doc?.deleteSelection()
}

// ---- Associative offset (WO-1859) ------------------------------------------------------
//
// Both hosts reach the link through these three: the workbench rail renders them as a row,
// CAM's browser renders them as a section. Neither host has its own copy of the rule.

/** The ONE associative offset the selection names, or null. `distance` is the link's own
 *  current distance, so an editor opens showing the offset's real number. */
export function linkedOffsetInSelection(): { linkIds: string[]; distance: number; pieces: number } | null {
  const sketch = doc?.getSketch()
  if (!doc || !sketch) return null
  const linkIds = offsetLinkIdsIn(sketch.entities, doc.getSelection())
  if (linkIds.length === 0) return null
  const wanted = new Set(linkIds)
  const pieces = sketch.entities.filter((e) => e.offsetLink && wanted.has(e.offsetLink.id))
  return { linkIds, distance: pieces[0].offsetLink!.distance, pieces: pieces.length }
}

/** BREAK the selection's offset link(s): the geometry stays at the exact coordinates it has
 *  and stops following its source. One undo step. */
export function breakOffsetLink(): void {
  const sketch = doc?.getSketch()
  if (!doc || !sketch) return
  const linkIds = offsetLinkIdsIn(sketch.entities, doc.getSelection())
  if (linkIds.length === 0) {
    doc.notice('Break offset link: select an offset that follows its source first.', 'info')
    return
  }
  const entities = breakOffsetLinks(sketch.entities, linkIds)
  if (entities === null) return
  doc.beginStep()
  doc.replace({ entities, constraints: sketch.constraints, dimensions: sketch.dimensions })
  doc.notice(
    `Offset: link broken - the offset stays where it is and no longer follows its source`)
}

// ---- Pierce (WO-1865) ---------------------------------------------------------------------------

/** Current coordinates of a point site on the plain kinds a pierce accepts (piercePointForSelection:
 *  a point, a line/arc endpoint, a circle/arc centre). */
function pointSiteAt(sketch: Sketch, ref: PointRef): SketchVec2 | null {
  const e = sketch.entities.find((x) => x.id === ref.entityId)
  if (!e) return null
  if (e.kind === 'point') return ref.site === 'self' ? e.at : null
  if (e.kind === 'line') return ref.site === 'start' ? e.start : ref.site === 'end' ? e.end : null
  if (e.kind === 'circle') return ref.site === 'center' ? e.center : null
  if (e.kind === 'arc') {
    if (ref.site === 'center') return e.center
    const angle = ref.site === 'start' ? e.startAngle : ref.site === 'end' ? e.endAngle : null
    return angle === null ? null : { x: e.center.x + e.radius * Math.cos(angle), y: e.center.y + e.radius * Math.sin(angle) }
  }
  if ((e.kind === 'ellipse' || e.kind === 'elliptical-arc') && ref.site === 'center') return e.center
  return null
}

/** The point a Pierce is waiting to place (the rail lights its button while one is). */
export function piercePending(): PointRef | null {
  return pendingPierce
}

/**
 * The Pierce command: take the ONE selected sketch point and arm the model pick for its edge. The
 * next Project/Use click on a model edge places the pierce instead of projecting. Nothing selected
 * that names one point is the only refusal (nothing to pierce).
 */
export function beginPierce(): void {
  const sketch = doc?.getSketch()
  if (!doc || !sketch) return
  const plan = piercePointForSelection(sketch, doc.getSelection())
  if (!plan.ok) {
    doc.notice(plan.reason, 'warning')
    return
  }
  armTool('project')
  pendingPierce = plan.point
  doc.notice('Pierce: now click the model edge that crosses the sketch plane (Esc cancels).')
}

function commitPierce(
  sketch: Sketch,
  target: PointRef,
  candidate: ProjectCandidate,
  beforeMutate: (() => void) | undefined,
): void {
  if (!doc) return
  const identity = candidate.sourceIdentity
  if (candidate.sourceKind !== 'model-edge' || identity === undefined || candidate.pierceEdge === undefined) {
    doc.notice('Pierce: click a model edge - a pierce follows an edge where it crosses the sketch plane.', 'warning')
    return
  }
  const here = pointSiteAt(sketch, target)
  if (here === null) {
    pendingPierce = null
    doc.notice('Pierce: the point to pierce is no longer in the sketch - select it again.', 'warning')
    return
  }
  const crossing = edgePlaneCrossing(candidate.pierceEdge, here)
  const source = { bodyId: identity.bodyId, stableId: identity.stableId, sourceLabel: candidate.sourceLabel }
  // Rule 11: an edge that does not cross the plane right now is still pierced. The point stays
  // where it is (the constraint holds it there, marked unresolved) and follows the edge the moment
  // a model change gives it a crossing.
  const pierce = crossing.ok
    ? makePierceConstraint(uuid(), target, source, crossing.at)
    : { ...makePierceConstraint(uuid(), target, source, here), unresolved: crossing.reason }
  beforeMutate?.()
  doc.replace({ entities: sketch.entities, constraints: withPierce(sketch.constraints, pierce), dimensions: sketch.dimensions })
  pendingPierce = null
  sketcherToolStore.setState({ tool: 'select', chain: null, wakeRefs: [] })
  const label = entityLabels(sketch.entities).get(target.entityId) ?? 'The point'
  doc.notice(crossing.ok
    ? `Pierce: ${label} now sits where "${candidate.sourceLabel}" crosses the sketch plane (follows the model).`
    : `Pierce: "${candidate.sourceLabel}" ${pierceMissPhrase(crossing.reason)}; ${label} stays where it is ` +
      'and will follow the edge once it crosses.')
}

/** WO-1864: break the model link on the selected projected pieces. Each stays exactly where it is
 *  (still grounded, still reference-coloured) and stops following the model. Pieces that were not
 *  selected keep following it. */
export function breakProjectionLink(): void {
  const sketch = doc?.getSketch()
  if (!doc || !sketch) return
  const ids = projectionLinkedIdsIn(sketch.entities, doc.getSelection())
  const entities = ids.length === 0 ? null : breakProjectionLinks(sketch.entities, ids)
  if (entities === null) {
    doc.notice('Break model link: select projected geometry that follows the model first.', 'info')
    return
  }
  doc.beginStep()
  doc.replace({ entities, constraints: sketch.constraints, dimensions: sketch.dimensions })
  doc.notice(
    `Model link broken on ${ids.length} entit${ids.length === 1 ? 'y' : 'ies'} - ` +
    'it stays where it is and no longer follows the model')
}

/** Re-offset the selection's link at a new distance, IN PLACE: the same entities move to the
 *  new distance, so there is no second chain and no duplicate constraint. A distance the shape
 *  cannot take explains itself and leaves the offset where it is. */
export function setLinkedOffsetDistance(distance: number): void {
  const sketch = doc?.getSketch()
  if (!doc || !sketch) return
  const linkIds = offsetLinkIdsIn(sketch.entities, doc.getSelection())
  if (linkIds.length === 0) {
    doc.notice('Offset distance: select an offset that follows its source first.', 'info')
    return
  }
  const entities = setOffsetLinkDistance(sketch.entities, linkIds, distance)
  if (typeof entities === 'string') {
    doc.notice(entities, 'warning')
    return
  }
  doc.beginStep()
  doc.replace({ entities, constraints: sketch.constraints, dimensions: sketch.dimensions })
  doc.notice(`Offset: re-offset at ${distance} mm`)
}

/** Ctrl/Cmd+C and the non-modal context menu share this package-owned action. */
export function copySelection(): boolean {
  if (doc === null) return false
  const sketch = doc.getSketch()
  if (sketch === null) {
    doc.notice('Copy: there is no active sketch.', 'warning')
    return false
  }
  try {
    const captured = captureSketchClipboard(sketch, doc.getSelection())
    if (captured === null) {
      doc.notice('Copy: select one or more sketch entities first.', 'info')
      return false
    }
    clipboard = captured
    fallbackPasteOrdinal = 0
    doc.notice(
      `Copied ${captured.entities.length} sketch ${captured.entities.length === 1 ? 'entity' : 'entities'}.`,
      'success',
    )
    return true
  } catch (error) {
    doc.notice(
      `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    )
    return false
  }
}

/** The right-click point becomes the context menu's Paste target. */
export function setClipboardPlacement(point: SketchVec2): void {
  if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
    clipboardPlacement = { ...point }
  }
}

/** Ctrl/Cmd+V and the non-modal context menu share one host-neutral commit. */
export function pasteSelection(point?: SketchVec2): boolean {
  if (doc === null) return false
  const sketch = doc.getSketch()
  if (sketch === null) {
    doc.notice('Paste: there is no active sketch.', 'warning')
    return false
  }
  if (clipboard === null) {
    doc.notice('Paste: the sketch clipboard is empty.', 'info')
    return false
  }

  const explicitPlacement = point ?? clipboardPlacement
  const placement = explicitPlacement ?? {
    x: clipboard.anchor.x + 10 * (fallbackPasteOrdinal + 1),
    y: clipboard.anchor.y + 10 * (fallbackPasteOrdinal + 1),
  }
  const reservedIds = [
    ...sketch.entities.map((entity) => entity.id),
    ...sketch.constraints.map((constraint) => constraint.id),
    ...sketch.dimensions.map((dimension) => dimension.id),
  ]
  try {
    const pasted = instantiateSketchClipboard(clipboard, placement, uuid, reservedIds)
    doc.beginStep()
    doc.append({ entities: pasted.entities, constraints: pasted.constraints }, [])
    doc.setSelection(pasted.selectedIds)
    if (explicitPlacement === null) fallbackPasteOrdinal += 1
    doc.notice(
      `Pasted ${pasted.entities.length} sketch ${pasted.entities.length === 1 ? 'entity' : 'entities'}.`,
      'success',
    )
    return true
  } catch (error) {
    doc.notice(
      `Paste failed: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    )
    return false
  }
}

// ---- WO-1860: DXF/SVG import straight into the open sketch --------------------------------------

/** Default curve-fit tolerance for a fresh sketch import -- mirrors the fallback DesignTree's
 *  "Optimize layer" wizard uses when a geometry object carries no stored override
 *  (appSettings.projectionToleranceDefault ?? 0.02). A sketch import has no CAM geometry object to
 *  read an override from, and this package cannot reach the store (STORE-FREE, see the file
 *  header) -- the shared default is the correct fixed point. */
const IMPORT_CURVE_FIT_TOL_MM = 0.02

/** Loop2D[] -> arc/line-segmented Loop2D[], the SAME curve fit DesignTree's "Optimize layer"
 *  wizard runs (src/lib/geometry/loopOptimizer.ts) -- called directly, no preview/confirm UI, so a
 *  fresh sketch import lands real arc/circle entities instead of a many-sided polygon: raw DXF/SVG
 *  import loops never carry the `.segments` liftLoops needs to tell a filleted corner or a circle
 *  from a dense polyline (joinSegments only ever emits bare points -- the wizard is the one
 *  existing place that fits arcs; this reuses its fitter, not its UI). */
function fitImportedCurves(loops: Loop2D[]): Loop2D[] {
  return optimizeLoops(loops, {
    tolerance: IMPORT_CURVE_FIT_TOL_MM * 0.5,
    resampleStep: Math.max(0.2, IMPORT_CURVE_FIT_TOL_MM * 0.3),
    projectionTolerance: IMPORT_CURVE_FIT_TOL_MM,
  })
}

/** Both raw importers flatten curves at a ~0.5mm chord/sample spacing (dxfImporter.ts's
 *  `CHORD_LEN_MM`, svgImporter.ts's `SAMPLE_SPACING_MM`) and push their curves' EXACT analytical
 *  endpoint as the last sample -- but joinSegments then drops that final point on a closed loop
 *  (it doesn't repeat the first point), so the raw point actually kept is one sampling step short
 *  of the true corner. `closeFittedLoops` below only needs to tell that one-sample-short gap (an
 *  artifact of the raw sampling, not missing geometry) apart from a genuinely missing edge (a
 *  whole side of a straight-edged loop, orders of magnitude larger) -- twice the shared 0.5mm
 *  sample spacing leaves ample margin between the two without needing to import either
 *  importer's private constant. */
const IMPORT_RAW_SAMPLE_GAP_MM = 1.0

/** optimizeLoops (src/lib/geometry/loopOptimizer.ts) fits segments across a closed loop's raw
 *  points pts[0]..pts[n-1] but never wraps back to pts[0] -- joinSegments' closed loops don't
 *  repeat their first point (src/lib/geometry/path2d.ts), so the last fitted segment simply stops
 *  at pts[n-1]. liftLoops walks `loop.segments` verbatim and only ADDS THE CONSTRAINT closing the
 *  chain, never the missing geometry (its header: "loop WITHOUT segments[] -- closed loops close
 *  back onto points[0]", which only covers the no-segments fallback) -- so a closed loop whose last
 *  fitted segment doesn't already land back on points[0] silently loses its final edge and the
 *  closing coincident constraint drags the two loose ends together, deforming the shape (a plain
 *  rectangle collapses toward a triangle). Fixed here, not in loopOptimizer.ts: that module is
 *  shared with DesignTree's "Optimize layer" wizard and is outside this order's owned paths -- this
 *  is the one place a sketch import routes through it. Skips only the true full-circle case
 *  (loopOptimizer's synthesized single arc segment whose `to` IS `points[0]` by construction, see
 *  lift.ts's FULL_CIRCLE_EPS) and the raw-sampling artifact above; every other gap -- including a
 *  fillet arc's sampled endpoint, which is real geometry, not sampling noise -- gets a real closing
 *  edge, same as the segments-less fallback below always adds its own wrap-around line. */
function closeFittedLoops(loops: Loop2D[]): Loop2D[] {
  return loops.map((loop) => {
    if (!loop.closed || !loop.segments || loop.segments.length === 0) return loop
    const first = loop.points[0]
    const lastSeg = loop.segments[loop.segments.length - 1]
    if (Math.hypot(lastSeg.to.x - first.x, lastSeg.to.y - first.y) <= IMPORT_RAW_SAMPLE_GAP_MM) return loop
    return { ...loop, segments: [...loop.segments, { type: 'line' as const, to: { x: first.x, y: first.y } }] }
  })
}

/** WO-1840's console-report line, duplicated (not imported) from importGeometryFile.ts: that
 *  module imports the CAM store, and toolController.ts is itself imported BY the store
 *  (camSketchDocumentPort's wiring) -- importing it back here would close a real module cycle, not
 *  just an architecture smell. Same fields, same wording. */
function formatDxfImportNote(report: DxfImportReport): string {
  const parts: string[] = []
  if (report.gapsClosed > 0) {
    const largest = Number(report.largestGapMM.toFixed(3))
    parts.push(`${report.gapsClosed} gap${report.gapsClosed === 1 ? '' : 's'} closed (largest ${largest}mm)`)
  }
  if (report.openChains > 0) {
    parts.push(`${report.openChains} chain${report.openChains === 1 ? '' : 's'} left open`)
  }
  if (report.skipped.length > 0) {
    parts.push(`${report.skipped.map((s) => `${s.type} x${s.count}`).join(', ')} not imported`)
  }
  // WO-1904: mirror importGeometryFile.ts's formatDxfImportReport - the drawing
  // origin is only news on the non-default path, so a re-centred import's note
  // stays byte-identical. (WO-1900 audit's named follow-up.)
  if (report.origin === 'drawing') {
    parts.push('drawing origin kept')
  }
  return parts.length > 0 ? parts.join(', ') : 'no gaps closed, nothing skipped'
}

export function printSketch(name = 'Sketch', options?: SketchPrintOptions): void {
  const sketch = doc?.getSketch()
  if (sketch) printSketchDocument(buildSketchPrintDocument(sketch, name, options).html)
}

export async function exportSketchSvg(name = 'Sketch'): Promise<void> {
  const port = doc
  const sketch = port?.getSketch()
  if (!port || !sketch) return
  const safeName = name.split('')
    .map((char) => char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char)
    .join('').trim()
  const filename = `${safeName || 'Sketch'}.svg`
  const saved = await saveFile(filename, sketchSvg(sketch, name), 'image/svg+xml')
  if (saved) port.notice(`Exported "${filename}"`)
}

export async function exportSketchDxf(name = 'Sketch'): Promise<void> {
  const port = doc
  const sketch = port?.getSketch()
  if (!port || !sketch) return
  const safeName = name.split('')
    .map((char) => char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char)
    .join('').trim()
  const filename = `${safeName || 'Sketch'}.dxf`
  const saved = await saveFile(filename, sketchDxf(sketch), 'application/dxf')
  if (saved) port.notice(`Exported "${filename}"`)
}

/**
 * WO-1860: a DXF or SVG file lands as editable entities in the OPEN sketch -- no CAM layer, no
 * separate lift step. Reuses the CAM-layer path's own parsers (importDXF/importSVG), curve fit
 * (optimizeLoops) and lift (liftLoops) directly -- NOT importGeometryFile() itself, which adds a
 * CAM part and runs the stock prompt, neither of which belongs to a sketch import (WO body, "what
 * it costs, up front"). One undo step for the whole import (beginStep + one append); liftLoops
 * mints fresh entity/constraint ids on every call, so a second import of the same file into the
 * same sketch never collides. Never silent (rule 11): every exit path notices.
 */
export async function importFileIntoSketch(
  file: File,
  options: { keepOrigin?: boolean; traceWidthMm?: number; traceThreshold?: number } = {},
): Promise<void> {
  if (!doc) return
  const ext = file.name.split('.').pop()?.toLowerCase()
  const isPicture = ext === 'png' || ext === 'jpg' || ext === 'jpeg'
  if (ext !== 'dxf' && ext !== 'svg' && !isPicture) {
    doc.notice(`Import into sketch: "${file.name}" is not a DXF, SVG, PNG or JPG file`, 'warning')
    return
  }

  let loops: Loop2D[]
  let parseNote: string
  try {
    if (isPicture) {
      const widthMm = options.traceWidthMm && options.traceWidthMm > 0 ? options.traceWidthMm : TRACE_DEFAULT_WIDTH_MM
      const threshold = options.traceThreshold ?? TRACE_DEFAULT_THRESHOLD
      const bitmap = await decodeRaster(file)
      loops = traceBitmap(bitmap, { widthMm, threshold })
      if (loops.length === 0) {
        doc.notice(`Import into sketch: "${file.name}" has no dark shapes at threshold ${threshold}`, 'warning')
        return
      }
      const heightMm = (bitmap.height / bitmap.width) * widthMm
      parseNote = `traced at ${Number(widthMm.toFixed(2))} x ${Number(heightMm.toFixed(2))} mm, threshold ${threshold}; curves fit to line/arc segments`
    } else if (ext === 'dxf') {
      const text = await file.text()
      // WO-1904: the remembered drawing-origin choice, passed through by the host
      // row (this package is store-free; see the file header).
      const result = importDXF(text, { keepOrigin: options.keepOrigin })
      loops = result.loops
      const noteParts: string[] = []
      if (result.unitScale !== 1) {
        noteParts.push(`${result.unitLabel} converted to mm (x${result.unitScale})`)
      }
      noteParts.push(formatDxfImportNote(result.report))
      parseNote = noteParts.join('; ')
    } else {
      const text = await file.text()
      loops = importSVG(text).loops
      parseNote = 'curves fit to line/arc segments'
    }
  } catch (err) {
    doc.notice(
      `Import into sketch failed for "${file.name}": ${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
    return
  }

  if (loops.length === 0) {
    doc.notice(`Import into sketch: "${file.name}" contains no importable geometry`, 'warning')
    return
  }

  const lifted = liftLoops(closeFittedLoops(fitImportedCurves(loops)))
  if (lifted.entities.length === 0) {
    doc.notice(`Import into sketch: "${file.name}" produced no usable geometry`, 'warning')
    return
  }

  doc.ensureSketch()
  doc.beginStep()
  doc.append({ entities: lifted.entities, constraints: lifted.constraints }, [])
  const skippedNote = lifted.skippedLoops > 0
    ? `, ${lifted.skippedLoops} loop${lifted.skippedLoops === 1 ? '' : 's'} skipped (no usable geometry)`
    : ''
  doc.notice(
    `Imported "${file.name}" into sketch: ${lifted.liftedLoops} loop${lifted.liftedLoops === 1 ? '' : 's'} ` +
    `(${parseNote})${skippedNote}`,
  )
}

/**
 * The whole tool surface as one object, for consumers that would otherwise import a dozen
 * functions (the interaction layer, the toolbox, the overlays, tests).
 */
export const sketcherTools = {
  armTool, beginPierce, piercePending, bezierJointsInSelection, bezierPress, breakOffsetLink, breakProjectionLink, clearBezierPress, click, copySelection, cycleDimForce, commitDrawValueAt,
  conicDrawRhoValue, conicsInSelection, deleteSelection, end, escape,
  importFileIntoSketch, exportSketchSvg, exportSketchDxf, printSketch, linkedOffsetInSelection, lockCursor,
  overlay, overlayApply, setChamferSetback, setCircularPatternAngle, setCircularPatternCount,
  pasteSelection, setClipboardPlacement, setLinkedOffsetDistance,
  setFilletRadius, setLinearPatternCount, setMeasureOpen, setOffsetDistance, setPolygonMode,
  setBezierJointsSmooth, setConicDrawRho, setSelectedConicsRho, setPolygonSides, setGearParams, setSplineClosed, setTransformKeepOriginal, setTransformValue,
  snap, swipeOverlay, swipeTrim, toggleConstruction, toggleMeasure, toggleRectRotated, toggleSnapFlag,
  resetForDocumentSwitch,
} as const

/**
 * The host switched documents (CAM `setActiveSketch`): "selection and armed tool never survive a
 * document switch". The mount signals the event; the package decides what tool state means for it.
 * Scalars (fillet radius, polygon sides, snap flags) are user PREFERENCES and deliberately survive,
 * exactly as they did when they lived in the store's sketch slice.
 */
export function resetForDocumentSwitch(): void {
  pendingPierce = null
  clearPendingSnaps()
  clipboardPlacement = null
  fallbackPasteOrdinal = 0
  sketcherToolStore.setState({
    tool: 'select',
    chain: null,
    wakeRefs: [],
    constructionMode: false,
    measureOpen: false,
  })
}
