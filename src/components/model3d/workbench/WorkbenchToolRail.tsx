import { useText, textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { ReferenceImageInsertRow } from '../referenceImage/ReferenceImageInsertRow'
// WO UI-17 (criterion 2, Operator verbatim: "Don't clutter up the tool bar with a
// dumb string of buttons. Use our sketch toolbar along the right hand side"):
// the workbench's ONE tool surface -- a right-hand vertical rail using the CAM
// sketch environment's own presentation classes (.sketch-tool-grid /
// .sketch-tool-btn, app.css:1412-1453) and iconographic language (lucide
// icon-over-label, SketchToolbox.tsx's SECTIONS pattern).
//
// MODE-SWITCHING (Operator's Q1 answer, verbatim in the directive doc): outside a
// sketch session the rail shows the MODELING tools (every command the old top
// strip carried, grouped in labeled sections); inside a session it swaps to
// the SKETCH tool sections -- the SECTIONS config ported from
// src/components/panels/sketch/SketchToolbox.tsx (read-only reference), driving
// the ALREADY-SHARED sketcherTools/useSketcherTool engine the workbench mount
// wired in SKC-15B.
//
// WO SKC-16 (Operator hands-on findings B1/B2/B3): UI-17 deliberately left the
// CAM-store-coupled rows (constraints, construction, delete) off this rail,
// noting "they dispatch into CAM store actions the workbench document port does
// not speak". That premise is now stale: SKC-15B/15C built the workbench's OWN
// document/overlays ports, and those ports ALREADY speak all three actions over
// the shared engine, NOT useCamStore:
//   * DELETE      -> workbenchOverlaysPort.deleteSelection()      (one delete-
//                    cascade via deleteFromSketch, one undo step). Del/Backspace
//                    already route here through the package's SketchInteraction;
//                    this adds the RAIL Delete action CAM's MODIFY section has.
//   * CONSTRUCTION-> sketcherTools.toggleConstruction() (engine): with a
//                    selection it flips construction flags through the document
//                    port; with none it toggles draw-as-construction MODE. The
//                    same one entry the CAM CREATE button and the 'q' key use.
//   * CONSTRAINTS -> workbenchOverlaysPort.applyConstraint(kind): the shared
//                    planConstraintForSelection planner + a synchronous verdict
//                    solve (the workbench twin of the CAM store's
//                    applySketchConstraint). Buttons enable/disable by the SAME
//                    planConstraintForSelection eligibility the CAM section uses.
// No new port surface and no useCamStore reach: the rail consumes the ports
// SKC-15B already published.
//
// POINTER-OWNERSHIP NOTE (oneWorkbenchSketchPointerOwner.test.ts net (d)): this
// file lives in the severing target, so the ONLY pointer/mouse event binding
// it may carry is onClick -- every affordance here is a plain button click.

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useFormStore } from '../../../form/formStore'
import { useSketcherTool, sketcherTools } from '../../../lib/sketch/sketcher'
import type { SketchToolId } from '../../../lib/sketch/tools/toolMachine'
import { SHORTCUT_KEY_BY_TOOL, SHORTCUT_KEY_BY_UTILITY } from '../../../lib/sketch/tools/shortcuts'
import { piercePointForSelection, planConstraintForSelection } from '../../../lib/sketch/constraintActions'
import { offsetLinkIdsIn } from '../../../lib/sketch/tools/offsetTool'
import type { Sketch, SketchBlockEntity, SketchConstraintKind, SolveStatus } from '../../../lib/sketch/types'
import { sketchHasUserContent } from '../../../lib/sketch/sketchAnchors'
import type { LucideIcon } from 'lucide-react'
import {
  MousePointer2, Slash, Square, SquareDot, CircleDashed,
  Radius, Tangent, Pentagon, Settings2,
  Ruler, Scissors, Split, ArrowRightFromLine,
  FlipHorizontal2, Grid3x3, Move, RotateCw, Scaling, Trash2, Waypoints,
  Crosshair, Target,
  MoveHorizontal, MoveVertical, Equal,
  Lock, LocateFixed, Unlink,
  CheckCircle2, AlertTriangle, Import,
  ChevronDown, ChevronRight, LayoutGrid, Rows3,
} from 'lucide-react'
// WO-045: shipped CAD-semantic glyphs (the workshop set Operator approved) for
// the tools the WO-043 audit flagged; audited-FINE tools keep lucide picks.
import { cadIcon } from '../../icons/cadIcons'
import { sketchSessionStore, type SketchSessionState } from './sketchSessionStore'
import { workbenchOverlaysPort } from './workbenchOverlaysPort'
import { workbenchSketchDocumentPort } from './workbenchSketchDocumentPort'
import { SketchCancelButton, SketchFinishButton, SketchGlyphToggle } from '../../panels/sketch/SketchChrome'
import { BlockPropertiesRow } from '../../panels/sketch/BlockPropertiesRow'
import { BlockEditBanner } from '../../panels/sketch/BlockEditBanner'
import { SketchMeasureReadout } from '../../panels/sketch/SketchMeasureReadout'
import {
  BezierJointRow, ConicDrawRhoRow, ConicRhoRow, ImportIntoSketchRow, PolygonSidesRow, GearRow,
} from '../../panels/sketch/SketchToolbox'
import { PierceSection } from '../../panels/sketch/ConstraintBrowser'
import '../../common/toolPaletteLayout.css'
import { useToolPaletteLayout } from '../../common/useToolPaletteLayout'
import { PanelEdgeResizer, useEdgePanelSize } from '../../panels/PanelResizer'
import { useUiPrefs } from '../../../store/uiPrefs'

/** One modeling-rail button, built by the page (it owns the handlers/enabled
 *  state) and rendered here with the sketch-tool look. `testId` keeps every
 *  pre-UI-17 toolbar testid alive so existing harnesses keep driving the SAME
 *  commands from their new home. */
export interface RailTool {
  testId: string
  label: string
  icon: LucideIcon
  onClick(): void
  disabled?: boolean
  /** Highlight like an armed sketch tool (.sketch-tool-btn-active). */
  active?: boolean
  title?: string
}

export interface RailSection {
  id: string
  title: string
  tools: RailTool[]
}

/** The workbench sketch-session tool sections -- SketchToolbox.tsx's SECTIONS
 *  config (id/label/lucide icon), filtered to the tools the shared engine can
 *  arm from this mount (ARMABLE_TOOLS + 'select'; see the header). */
export const SKETCH_SECTIONS: Array<{ id: string; title: string; tools: Array<{ id: SketchToolId; label: string; icon: LucideIcon }> }> = [
  {
    id: 'create',
    get title() { return workbenchText('WorkbenchToolRail.create') },
    tools: [
      { id: 'select',        get label() { return workbenchText('WorkbenchToolRail.select') },       icon: MousePointer2 },
      { id: 'line',          get label() { return workbenchText('WorkbenchToolRail.line') },         icon: Slash },
      { id: 'rect-corner',   get label() { return workbenchText('WorkbenchToolRail.rectangle') },    icon: Square },
      { id: 'rect-center',   get label() { return workbenchText('WorkbenchToolRail.centerRect') },  icon: SquareDot },
      { id: 'circle-center', get label() { return workbenchText('WorkbenchToolRail.circle') },       icon: cadIcon('circle-center') },
      { id: 'circle-3pt',    get label() { return workbenchText('WorkbenchToolRail.3PtCircle') },  icon: cadIcon('circle-3pt') },
      { id: 'ellipse',       get label() { return workbenchText('WorkbenchToolRail.ellipse') },      icon: cadIcon('ellipse') },
      { id: 'arc-3pt',       get label() { return workbenchText('WorkbenchToolRail.3PtArc') },     icon: cadIcon('arc-3pt') },
      { id: 'arc-center',    get label() { return workbenchText('WorkbenchToolRail.centerArc') },   icon: Radius },
      { id: 'arc-tangent',   get label() { return workbenchText('WorkbenchToolRail.tangentArc') },  icon: Tangent },
      { id: 'spline',        get label() { return workbenchText('WorkbenchToolRail.spline') },       icon: cadIcon('spline') },
      { id: 'spline-control', get label() { return workbenchText('WorkbenchToolRail.controlSpline') }, icon: cadIcon('spline-control') },
      { id: 'bezier',        get label() { return workbenchText('WorkbenchToolRail.bezier') },       icon: cadIcon('bezier') },
      { id: 'conic',         get label() { return workbenchText('WorkbenchToolRail.conicArc') },    icon: cadIcon('conic') },
      { id: 'gear',          get label() { return workbenchText('WorkbenchToolRail.gear') },         icon: Settings2 },
      { id: 'polygon',       get label() { return workbenchText('WorkbenchToolRail.polygon') },      icon: Pentagon },
      { id: 'slot',          get label() { return workbenchText('WorkbenchToolRail.slot') },         icon: cadIcon('slot') },
      { id: 'point',         get label() { return workbenchText('WorkbenchToolRail.point') },        icon: cadIcon('point') },
    ],
  },
  {
    id: 'modify',
    get title() { return workbenchText('WorkbenchToolRail.modify') },
    tools: [
      { id: 'smart-dimension',  get label() { return workbenchText('WorkbenchToolRail.smartDim') },    icon: Ruler },
      { id: 'trim',             get label() { return workbenchText('WorkbenchToolRail.trim') },          icon: Scissors },
      { id: 'split',            get label() { return workbenchText('WorkbenchToolRail.split') },         icon: Split },
      { id: 'extend',           get label() { return workbenchText('WorkbenchToolRail.extend') },        icon: ArrowRightFromLine },
      { id: 'fillet',           get label() { return workbenchText('WorkbenchToolRail.fillet') },        icon: cadIcon('fillet') },
      { id: 'chamfer',          get label() { return workbenchText('WorkbenchToolRail.chamfer') },       icon: cadIcon('chamfer') },
      { id: 'offset',           get label() { return workbenchText('WorkbenchToolRail.offset') },        icon: cadIcon('offset') },
      { id: 'mirror',           get label() { return workbenchText('WorkbenchToolRail.mirror') },        icon: FlipHorizontal2 },
      { id: 'pattern-linear',   get label() { return workbenchText('WorkbenchToolRail.linearPat') },   icon: Grid3x3 },
      { id: 'pattern-circular', get label() { return workbenchText('WorkbenchToolRail.circularPat') }, icon: cadIcon('pattern-circular') },
      { id: 'pattern-path',     get label() { return workbenchText('WorkbenchToolRail.pathPat') },     icon: Waypoints },
      { id: 'move',             get label() { return workbenchText('WorkbenchToolRail.move') },          icon: Move },
      { id: 'rotate',           get label() { return workbenchText('WorkbenchToolRail.rotate') },        icon: RotateCw },
      { id: 'scale',            get label() { return workbenchText('WorkbenchToolRail.scale') },         icon: Scaling },
    ],
  },
  {
    id: 'utility',
    get title() { return workbenchText('WorkbenchToolRail.utility') },
    tools: [
      { id: 'project', get label() { return workbenchText('WorkbenchToolRail.projectUse') }, icon: Import },
    ],
  },
]

/** WO SKC-16 (B1): the CONSTRAINTS section -- the CAM toolbox's own 13 buttons
 *  (SketchToolbox.tsx CONSTRAINT_KIND_BY_BUTTON + the `constraints` SECTION),
 *  same kinds, same friendly labels, same lucide icons, same order. Each drives
 *  workbenchOverlaysPort.applyConstraint(kind) and is enabled iff
 *  planConstraintForSelection(sketch, selection, kind).ok -- one rule set, no
 *  UI/engine divergence, exactly as CAM. Dimensional constraints (distance,
 *  radius, angle) are DIMENSIONS placed by the Smart Dim. tool, not this
 *  section -- they are not part of the CAM constraints set and are not here. */
const CONSTRAINT_BUTTONS: Array<{ kind: SketchConstraintKind; label: string; icon: LucideIcon }> = [
  { kind: 'coincident',      get label() { return workbenchText('WorkbenchToolRail.coincident') },    icon: Crosshair },
  { kind: 'concentric',      get label() { return workbenchText('WorkbenchToolRail.concentric') },    icon: Target },
  { kind: 'parallel',        get label() { return workbenchText('WorkbenchToolRail.parallel') },      icon: cadIcon('parallel') },
  { kind: 'perpendicular',   get label() { return workbenchText('WorkbenchToolRail.perpendicular') }, icon: cadIcon('perpendicular') },
  { kind: 'collinear',       get label() { return workbenchText('WorkbenchToolRail.collinear') },     icon: cadIcon('collinear') },
  { kind: 'horizontal',      get label() { return workbenchText('WorkbenchToolRail.horizontal') },    icon: MoveHorizontal },
  { kind: 'vertical',        get label() { return workbenchText('WorkbenchToolRail.vertical') },      icon: MoveVertical },
  { kind: 'tangent',         get label() { return workbenchText('WorkbenchToolRail.tangent') },       icon: Tangent },
  { kind: 'equal',           get label() { return workbenchText('WorkbenchToolRail.equal') },         icon: Equal },
  { kind: 'midpoint',        get label() { return workbenchText('WorkbenchToolRail.midpoint') },      icon: cadIcon('midpoint') },
  { kind: 'symmetric',       get label() { return workbenchText('WorkbenchToolRail.symmetric') },     icon: cadIcon('symmetric') },
  { kind: 'fix',             get label() { return workbenchText('WorkbenchToolRail.fix') },           icon: Lock },
  { kind: 'point_on_object', get label() { return workbenchText('WorkbenchToolRail.onObject') },     icon: LocateFixed },
]

export interface WorkbenchToolRailProps {
  /** True while a package sketch session is live -- flips the rail to the
   *  sketch sections. */
  onInsertReferenceImage?(file: File): Promise<void>
  sketchActive: boolean
  /** The modeling sections, built by the page (handlers + enabled state). */
  modelingSections: RailSection[]
  /** Undo/Redo, ALSO reachable during a sketch session (a package gesture is
   *  one workbench CommandHistory step, so mid-sketch undo is a first-class
   *  action -- and the pre-UI-17 toolbar always offered it). Same testids as
   *  the modeling Document section's copies; only one mode renders at a time. */
  sketchHistoryTools: RailTool[]
  /** Finish the live sketch session (rendered as the rail's primary action
   *  while sketchActive). */
  onFinishSketch(): void
  /** Cancel the live session and restore its entry snapshot. */
  onCancelSketch?(): void
}

/** The live sketch-session state, for the sketch-mode rail's eligibility gates
 *  (selection-driven Delete + Constraints). The SAME useSyncExternalStore shape
 *  workbenchOverlaysPort uses -- a host with no framework subscribing to its own
 *  session store, per-selector Object.is bail-out. Only reads; never a binding. */
function useSketchSession<T>(f: (s: SketchSessionState) => T): T {
  useText('sketch-and-model-workbench')
  return useSyncExternalStore(
    sketchSessionStore.subscribe,
    () => f(sketchSessionStore.getState()),
    () => f(sketchSessionStore.getState()),
  )
}

function RailSectionHeader({ title, right, collapsed, onToggle, sectionId }: { title: string; right?: ReactNode; collapsed?: boolean; onToggle?: () => void; sectionId?: string }) {
  const workbenchText = useText('sketch-and-model-workbench')
  return (
    <div className="tree-section-header" style={{ position: 'static' }}>
      {title}
      {right}
      {onToggle !== undefined && (
        <button
          type="button"
          className="rail-collapse-btn"
          data-testid={`workbench-rail-collapse-${sectionId}`}
          aria-expanded={collapsed !== true}
          aria-label={collapsed === true ? workbenchText('WorkbenchToolRail.show', { title: String(title) }) : workbenchText('WorkbenchToolRail.hide', { title: String(title) })}
          data-tooltip={collapsed === true ? workbenchText('WorkbenchToolRail.showTheTools', { title: String(title) }) : workbenchText('WorkbenchToolRail.hideTheTools', { title: String(title) })}
          onClick={onToggle}
        >
          {collapsed === true ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
      )}
    </div>
  )
}

/** WO SKC-17 (BK-123(2)): CAM's `ConstraintGlyphToggle` twin -- same classes
 *  (`.sketch-header-toggle` / `-on`), same Eye/EyeOff language, same "hides only
 *  the glyph badges, dimensions stay visible" scope. Reads/writes the workbench
 *  session store's `glyphsVisible` (sketchSessionStore.ts) rather than
 *  useCamStore -- the CAM field is untouched by this WO. */
function GlyphToggle() {
  useText('sketch-and-model-workbench')
  const glyphsVisible = useSketchSession((s) => s.glyphsVisible)
  return (
    <SketchGlyphToggle
      visible={glyphsVisible}
      onToggle={sketchSessionStore.toggleGlyphsVisible}
      testId="workbench-package-glyph-toggle"
    />
  )
}

/** WO SKC-17 (BK-123(2)): CAM's `SketchDefinitionChip` twin, at the rail's PANEL
 *  header (CAM parity note P3: the two chips live at different levels -- the
 *  glyph toggle sits on the CONSTRAINTS section header, this sits on the panel
 *  header next to "Sketch"). The workbench solves SYNCHRONOUSLY
 *  (workbenchSketchDocumentPort's `solved()`), so `sketch.solveStatus` IS the
 *  live status -- no separate liveStatus field to fall back from, unlike CAM's
 *  worker-solver split. */
function SketchDofBadge() {
  const workbenchText = useText('sketch-and-model-workbench')
  const status: SolveStatus | null = useSketchSession((s) => s.sketch?.solveStatus ?? null)
  const solverAvailability = useSketchSession((s) => s.solverAvailability)

  // A persisted status is not a current verdict while the solver is absent.
  // Availability wins over dof so stale dof 0 can never paint green.
  if (solverAvailability !== 'ready') {
    const unavailable = solverAvailability === 'unavailable'
    return (
      <span
        className="sketch-def-chip sketch-def-chip-idle"
        data-testid="workbench-sketch-dof-chip"
        data-tooltip={unavailable
          ? workbenchText('WorkbenchToolRail.theSketchSolverIsUnavailableNoDefinitionVerdictIs')
          : workbenchText('WorkbenchToolRail.theSketchSolverIsNotReadyNoDefinitionVerdict')}
      >
        {unavailable ? <AlertTriangle size={11} /> : <CircleDashed size={11} />}
        <span>{unavailable ? workbenchText('WorkbenchToolRail.solverUnavailable') : workbenchText('WorkbenchToolRail.solverNotReady')}</span>
      </span>
    )
  }
  if (status === null) {
    return (
      <span
        className="sketch-def-chip sketch-def-chip-idle"
        data-testid="workbench-sketch-dof-chip"
        data-tooltip={workbenchText('WorkbenchToolRail.theSolverIsReadyButHasNotProducedA')}
      >
        <CircleDashed size={11} />
        <span>{workbenchText('WorkbenchToolRail.notSolved')}</span>
      </span>
    )
  }
  if (status.solveFailed) {
    return (
      <span
        className="sketch-def-chip sketch-def-chip-failed"
        data-testid="workbench-sketch-dof-chip"
        data-tooltip={workbenchText('WorkbenchToolRail.solveFailed', { value1: String(status.failureMessage ?? workbenchText('WorkbenchToolRail.seeConsoleForDetails')) })}
      >
        <AlertTriangle size={11} />
        <span>{workbenchText('WorkbenchToolRail.solveFailed2')}</span>
      </span>
    )
  }
  if (status.dof === 0) {
    return (
      <span className="sketch-def-chip sketch-def-chip-defined" data-testid="workbench-sketch-dof-chip" data-tooltip={workbenchText('WorkbenchToolRail.fullyDefined')}>
        <CheckCircle2 size={11} />
        <span>{workbenchText('WorkbenchToolRail.fullyDefined')}</span>
      </span>
    )
  }
  return (
    <span
      className="sketch-def-chip sketch-def-chip-under"
      data-testid="workbench-sketch-dof-chip"
      data-tooltip={workbenchText('WorkbenchToolRail.underDefinedDegreesOfFreedomRemain', { dof: String(status.dof) })}
    >
      <CircleDashed size={11} />
      <span>{workbenchText('WorkbenchToolRail.dof', { dof: String((status.dof) ?? '') })}</span>
    </span>
  )
}

/** WO SKC-16 (B3): CONSTRUCTION -- a MODE button, not an armed tool. With
 *  entities selected it flips THEIR construction flag (through the document
 *  port); with none it toggles draw-as-construction for new geometry. The 'q'
 *  key does the same. Lit while draw-as-construction MODE is on (CAM parity). */
// WO-045: the two hardcoded rail glyphs use the same shipped CAD set
// (module-scope so the component identity is stable across renders).
const ConstructionIcon = cadIcon('construction')
const MeasureIcon = cadIcon('measure')

function ConstructionButton() {
  const workbenchText = useText('sketch-and-model-workbench')
  const constructionMode = useSketcherTool((s) => s.constructionMode)
  return (
    <button
      type="button"
      data-testid="workbench-package-construction"
      aria-pressed={constructionMode}
      className={constructionMode ? 'sketch-tool-btn sketch-tool-btn-active' : 'sketch-tool-btn'}
      data-tooltip={workbenchText('WorkbenchToolRail.constructionQToggleSelectedEntitiesOrDrawNewEntities')}
      onClick={() => sketcherTools.toggleConstruction()}
    >
      <ConstructionIcon size={15} />
      <span>{workbenchText('WorkbenchToolRail.construction')}</span>
    </button>
  )
}

/** WO SKC-16 (B2): the RAIL Delete action -- the twin of the CAM MODIFY Delete
 *  button. Removes the selection, cascading referencing constraints/dimensions
 *  (one undo step). Del/Backspace already reach the SAME cascade through the
 *  package's key handler; this is the discoverable button. Enabled only while
 *  something is selected. */
function DeleteButton({ hasSelection }: { hasSelection: boolean }) {
  const workbenchText = useText('sketch-and-model-workbench')
  return (
    <button
      type="button"
      data-testid="workbench-package-delete"
      className="sketch-tool-btn"
      disabled={!hasSelection}
      data-tooltip={hasSelection ? workbenchText('WorkbenchToolRail.deleteSelectedDelBackspace') : workbenchText('WorkbenchToolRail.deleteSelectEntitiesFirst')}
      onClick={() => workbenchOverlaysPort.deleteSelection()}
    >
      <Trash2 size={15} />
      <span>{workbenchText('WorkbenchToolRail.delete')}</span>
    </button>
  )
}

/** WO-1859: the ASSOCIATIVE OFFSET row. Appears in MODIFY only while the selection holds
 *  an offset that still follows its source, and carries the two things that can be done to
 *  the link: re-offset at a new distance (in place - no second chain), and break it (the
 *  geometry stays exactly where it is). Both go through the shared engine
 *  (toolController.ts), so CAM's browser section and this rail run the SAME rule. */
function OffsetLinkRow({ sketch, selectedIds }: {
  sketch: Sketch | null
  selectedIds: readonly string[]
}) {
  const workbenchText = useText('sketch-and-model-workbench')
  const linkIds = sketch ? offsetLinkIdsIn(sketch.entities, selectedIds) : []
  const wanted = new Set(linkIds)
  const linked = sketch
    ? sketch.entities.filter((e) => e.offsetLink && wanted.has(e.offsetLink.id))
    : []
  const [typed, setTyped] = useState<string | null>(null)
  if (linked.length === 0) return null
  const distance = linked[0].offsetLink!.distance
  const commit = () => {
    const v = Number(typed)
    setTyped(null)
    if (typed !== null && Number.isFinite(v) && v > 0 && v !== distance) {
      sketcherTools.setLinkedOffsetDistance(v)
    }
  }
  return (
    <div className="sketch-snap-settings" data-testid="workbench-offset-link-row">
      <label
        className="sketch-snap-spacing"
        data-tooltip={workbenchText('WorkbenchToolRail.thisOffsetFollowsItsSourceChangeTheDistanceAnd')}
      >
        <span>{workbenchText('WorkbenchToolRail.offsetDistance')}</span>
        <input
          type="number"
          min={0}
          step={0.5}
          data-testid="workbench-offset-link-distance"
          value={typed ?? String(distance)}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        />
      </label>
      <button
        type="button"
        className="sketch-tool-btn"
        data-testid="workbench-offset-break-link"
        data-tooltip={
          workbenchText('WorkbenchToolRail.thisOffsetFollowsSource', { value1: String(linked[0].offsetLink!.source.length) }) +
          workbenchText('WorkbenchToolRail.entit', { value1: String(linked[0].offsetLink!.source.length === 1 ? 'y' : 'ies') }) +
          workbenchText('WorkbenchToolRail.breakTheLinkToLeaveItExactlyWhereIt')
        }
        onClick={() => sketcherTools.breakOffsetLink()}
      >
        <Unlink size={15} />
        <span>{workbenchText('WorkbenchToolRail.breakLink')}</span>
      </button>
    </div>
  )
}

function MeasureButton({ open }: { open: boolean }) {
  const workbenchText = useText('sketch-and-model-workbench')
  const key = SHORTCUT_KEY_BY_UTILITY.measure
  return (
    <button
      type="button"
      data-testid="workbench-package-measure"
      aria-pressed={open}
      className={open ? 'sketch-tool-btn sketch-tool-btn-active' : 'sketch-tool-btn'}
      data-tooltip={
        open
          ? workbenchText('WorkbenchToolRail.measureReadoutOpenClickOrPressToClose', { value1: String(key ?? 'I') })
          : workbenchText('WorkbenchToolRail.inspectSelectedGeometryWithoutCreatingADimension', { value1: String(key ? ` (${key})` : '') })
      }
      onClick={() => sketcherTools.toggleMeasure()}
    >
      <MeasureIcon size={15} />
      <span>{workbenchText('WorkbenchToolRail.measure')}</span>
    </button>
  )
}

/** WO-1865: select one sketch point, click Pierce, then click the model edge that crosses the
 *  sketch plane. Lit while the edge pick is waiting. */
function PierceButton({ sketch, selectedIds, armed }: {
  sketch: Sketch | null
  selectedIds: readonly string[]
  armed: SketchToolId
}) {
  const workbenchText = useText('sketch-and-model-workbench')
  const plan = sketch !== null
    ? piercePointForSelection(sketch, selectedIds)
    : { ok: false as const, reason: workbenchText('WorkbenchToolRail.noActiveSketch') }
  const waiting = armed === 'project' && sketcherTools.piercePending() !== null
  return (
    <button
      type="button"
      data-testid="workbench-package-constraint-pierce"
      className={waiting ? 'sketch-tool-btn sketch-tool-btn-active' : 'sketch-tool-btn'}
      aria-pressed={waiting}
      disabled={!plan.ok && !waiting}
      data-tooltip={waiting
        ? workbenchText('WorkbenchToolRail.pierceClickTheModelEdgeThatCrossesTheSketch')
        : plan.ok ? workbenchText('WorkbenchToolRail.pierceThenClickTheModelEdgeThatCrossesThe') : plan.reason}
      onClick={() => sketcherTools.beginPierce()}
    >
      <Crosshair size={15} />
      <span>{workbenchText('WorkbenchToolRail.pierce')}</span>
    </button>
  )
}

// WO-2512 (Operator ruling 2026-10-03: "drag the bar to the left and instead of it being
// three icons wide it could be four (dynamic button layout)"): the rail's width
// is the viewer's, kept in uiPrefs.panelSizes like every resizable panel, and
// its button grids fill that width. A column is never narrower than one of the
// default rail's three (4.875rem) and there are never fewer than three, so the
// default rail looks as before and each widening step adds a column.
const RAIL_WIDTH_KEY = 'workbench-rail'
const RAIL_WIDTH_MAX = 520
/** The viewport keeps at least this beside the rail (SolidsWorkbenchPage's WORKBENCH_VIEWPORT_MIN). */
const RAIL_VIEWPORT_MIN = 480
const RAIL_GRID_REFLOW = { gridTemplateColumns: 'repeat(auto-fill, minmax(min(4.875rem, calc(100% / 3 - 0.125rem)), 1fr))' }

/** The rail's default width in px: the --panel-right-w token (px, or rem when the interface is scaled). */
function railDefaultWidth(): number {
  if (typeof window === 'undefined') return 260
  const root = window.getComputedStyle(document.documentElement)
  const token = root.getPropertyValue('--panel-right-w').trim()
  const n = parseFloat(token)
  if (!(n > 0)) return 260
  return token.endsWith('rem') ? n * (parseFloat(root.fontSize) || 16) : n
}

export function WorkbenchToolRail({ sketchActive, modelingSections, sketchHistoryTools, onFinishSketch, onCancelSketch, onInsertReferenceImage }: WorkbenchToolRailProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const layout = useToolPaletteLayout('rail')
  // WO-2512: the viewer may drag the rail wider (never narrower than its
  // default); with no stored width the stylesheet's own width stands. The
  // rendered width also gives way to the row as it is now (a narrowed window,
  // a remembered width from a wider one), so the viewport always keeps its room.
  const railRef = useRef<HTMLElement>(null)
  const storedRailWidth = useUiPrefs((s) => s.panelSizes[RAIL_WIDTH_KEY])
  const railDefault = railDefaultWidth()
  const railMax = Math.max(railDefault, RAIL_WIDTH_MAX)
  const railFitted = useEdgePanelSize(railRef, storedRailWidth, { defaultSize: railDefault, minSize: railDefault, maxSize: railMax, restMinSize: RAIL_VIEWPORT_MIN })
  const railWidth = storedRailWidth === undefined ? undefined : railFitted
  // Compact keeps its own packed grid (toolPaletteLayout.css).
  const gridStyle = layout.compact ? undefined : RAIL_GRID_REFLOW
  const formActive = useFormStore((s) => s.active)
  const editVersion = useFormStore((s) => s.editVersion)
  const foldRule = useFormStore((s) => s.startFromRail)
  const hasStartFrom = !sketchActive && formActive && modelingSections.some((s) => s.id === 'form-create')
  useLayoutEffect(() => {
    if (foldRule.checkedEdit === editVersion) return
    // The aside clips its flex child; .panel-body is the rail's actual scrollport.
    const rail = railRef.current?.querySelector<HTMLElement>(':scope > .panel-body')
    // WO-2503: measure only at an edit, never on resize or an eligibility change.
    // A fitting rail can be reconsidered at a later edit; a manual choice wins.
    const folded = foldRule.folded || Boolean(hasStartFrom && !foldRule.manual && rail && rail.scrollHeight > rail.clientHeight)
    useFormStore.setState({ startFromRail: { ...foldRule, checkedEdit: editVersion, folded } })
  }, [editVersion, hasStartFrom, foldRule])
  const isCollapsed = (id: string) => layout.isCollapsed(id) || (id === 'form-create' && hasStartFrom && foldRule.folded)
  const toggleSection = (id: string) => {
    const collapsed = isCollapsed(id)
    if (id === 'form-create' && hasStartFrom) {
      useFormStore.setState({ startFromRail: { ...foldRule, folded: false, manual: true } })
    }
    layout.toggleSection(id, !collapsed)
  }
  const armed = useSketcherTool((s) => s.tool)
  const measureOpen = useSketcherTool((s) => s.measureOpen)
  // Live selection + document for the sketch-mode eligibility gates. Read only
  // in the sketchActive branch, but hooks must be unconditional.
  const selectedIds = useSketchSession((s) => s.selectedIds)
  const sketch = useSketchSession((s) => s.sketch)
  const hasSelection = selectedIds.length > 0
  // SKC-BLOCKS Stage 4: a live block edit-in-place session -> the Finish/Cancel banner, the one
  // persistent way back out (CAM's SketchToolbox.tsx twin of this read).
  const blockEditId = useSketchSession((s) => s.blockEditId)
  // SKC-BLOCKS Stage 2: exactly one block selected -> typed scale/rotation row
  // (CAM's SketchToolbox.tsx twin of this derivation).
  const selectedBlock: SketchBlockEntity | null =
    sketch && selectedIds.length === 1
      ? (() => {
          const e = sketch.entities.find((x) => x.id === selectedIds[0])
          return e && e.kind === 'block' ? e : null
        })()
      : null

  return (
    <>
    <PanelEdgeResizer prefKey={RAIL_WIDTH_KEY} testId="workbench-rail-resizer" label={workbenchText('WorkbenchToolRail.resizeToolRail')}
      size={railWidth ?? railDefault} defaultSize={railDefault} minSize={railDefault} maxSize={railMax} restMinSize={RAIL_VIEWPORT_MIN} />
    <aside ref={railRef} data-testid="workbench-right-rail" className={layout.compact ? 'panel-right workbench-rail is-compact' : 'panel-right workbench-rail'} data-rail-mode={sketchActive ? 'sketch' : 'modeling'}
      style={railWidth === undefined ? undefined : { width: railWidth, minWidth: railWidth }}>
      <div className="panel-header">
        <span className="panel-title">{sketchActive ? workbenchText('WorkbenchToolRail.sketch') : workbenchText('WorkbenchToolRail.modeling')}</span>
        {sketchActive && <SketchDofBadge />}
        <button
          type="button"
          className="rail-compact-btn"
          data-testid="workbench-rail-compact"
          aria-pressed={layout.compact}
          aria-label={layout.compact ? workbenchText('WorkbenchToolRail.showToolNames') : workbenchText('WorkbenchToolRail.compactToolsIconsOnly')}
          data-tooltip={layout.compact ? workbenchText('WorkbenchToolRail.showTheToolNamesUnderTheirIcons') : workbenchText('WorkbenchToolRail.compactIconsOnlyPackedTightHoverAToolFor')}
          onClick={layout.toggleCompact}
        >
          {layout.compact ? <Rows3 size={14} /> : <LayoutGrid size={14} />}
        </button>
      </div>
      <div className="panel-body">
        {sketchActive ? (
          <>
            <div
              data-testid="workbench-package-sketch-toolbar"
              className="sketch-finish-sticky"
            >
              {/* WO SKC-17 (BK-122(3)): CAM's shared `.sketch-finish-btn` green-checked language
                  (app.css:1257), not a bespoke modal-btn-primary -- one class, one look. */}
              <div className="sketch-session-actions sketch-session-actions-compact">
                <SketchFinishButton
                  hasEntities={sketch !== null && sketchHasUserContent(sketch)}
                  onClick={onFinishSketch}
                  testId="workbench-finish-package-sketch"
                />
                <SketchCancelButton
                  onClick={() => onCancelSketch?.()}
                  testId="workbench-cancel-package-sketch"
                />
                {sketchHistoryTools.map((tool) => {
                  const Icon = tool.icon
                  return (
                    <button
                      key={tool.testId}
                      type="button"
                      data-testid={tool.testId}
                      aria-label={tool.label}
                      data-tooltip={tool.title ?? tool.label}
                      disabled={tool.disabled === true}
                      className="sketch-session-history-btn"
                      onClick={tool.onClick}
                    >
                      <Icon size={15} />
                    </button>
                  )
                })}
              </div>
            </div>
            {blockEditId != null && (
              <BlockEditBanner
                onFinish={() => workbenchOverlaysPort.finishBlockEdit?.()}
                onCancel={() => workbenchOverlaysPort.cancelBlockEdit?.()}
              />
            )}
            <BlockPropertiesRow
              block={selectedBlock}
              onSetScale={(v) => selectedBlock && workbenchOverlaysPort.setBlockScale(selectedBlock.id, v)}
              onSetRotationDeg={(v) => selectedBlock && workbenchOverlaysPort.setBlockRotationDeg(selectedBlock.id, v)}
            />
            <div data-testid="workbench-package-sketch-tools">
            {SKETCH_SECTIONS.map((section) => (
              <div className="tree-section" key={section.id} data-testid={`workbench-rail-section-${section.id}`}>
                <RailSectionHeader title={section.title} sectionId={`sketch-${section.id}`} collapsed={layout.isCollapsed(`sketch-${section.id}`)} onToggle={() => layout.toggleSection(`sketch-${section.id}`)} />
                {!layout.isCollapsed(`sketch-${section.id}`) && <>
                <div className="sketch-tool-grid" style={gridStyle}>
                  {section.tools.map((tool) => {
                    const Icon = tool.icon
                    const isActive = armed === tool.id
                    const key = SHORTCUT_KEY_BY_TOOL[tool.id]
                    const idleTooltip = key ? `${tool.label} (${key})` : tool.label
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        data-testid={`workbench-package-tool-${tool.id}`}
                        aria-pressed={isActive}
                        aria-label={tool.label}
                        data-tooltip={isActive ? workbenchText('WorkbenchToolRail.armedEscToDisarm', { label: String(tool.label) }) : idleTooltip}
                        className={isActive ? 'sketch-tool-btn sketch-tool-btn-active' : 'sketch-tool-btn'}
                        onClick={() => sketcherTools.armTool(tool.id)}
                      >
                        <Icon size={15} />
                        <span>{tool.label}</span>
                      </button>
                    )
                  })}
                  {/* WO SKC-16: Construction sits in CREATE, Delete in MODIFY --
                      the exact placement CAM's SketchToolbox uses. */}
                  {section.id === 'create' && <ConstructionButton />}
                  {section.id === 'modify' && <DeleteButton hasSelection={hasSelection} />}
                  {section.id === 'utility' && <MeasureButton open={measureOpen} />}
                </div>
                {/* WO-1860: the DXF/SVG-into-sketch import row -- CAM's
                    SketchToolbox.tsx twin, same placement (outside the grid,
                    always visible in CREATE), same shared engine. */}
                {section.id === 'create' && <ImportIntoSketchRow sketchName={
                  String(sketchSessionStore.getDeps()?.dag.getNode(sketchSessionStore.getState().sketchNodeId ?? '')?.payload.name ?? 'Sketch')
                } />}
                {section.id === 'create' && onInsertReferenceImage && <ReferenceImageInsertRow onInsert={onInsertReferenceImage} />}
                {/* WO-1472: the polygon side-count + inscribed/circumscribed row --
                    CAM's SketchToolbox.tsx twin, same placement (outside the grid,
                    inside the CREATE section), same shared engine. */}
                {section.id === 'create' && armed === 'gear' && <GearRow />}
                {section.id === 'create' && armed === 'polygon' && <PolygonSidesRow />}
                {/* WO-1863: the conic tool's rho -- CAM's SketchToolbox.tsx row itself. */}
                {section.id === 'create' && armed === 'conic' && <ConicDrawRhoRow />}
                {/* WO-1859: the associative-offset row (re-offset / break link),
                    shown only while a linked offset is selected. */}
                {section.id === 'modify' && (
                  <OffsetLinkRow sketch={sketch} selectedIds={selectedIds} />
                )}
                {/* WO-1862: the bezier Smooth / Corner joint row -- CAM's
                    SketchToolbox.tsx row itself, same shared engine. */}
                {section.id === 'modify' && (
                  <BezierJointRow sketch={sketch} selectedIds={selectedIds} />
                )}
                {/* WO-1863: the selected conic arcs' rho -- CAM's SketchToolbox.tsx row itself. */}
                {section.id === 'modify' && (
                  <ConicRhoRow sketch={sketch} selectedIds={selectedIds} />
                )}
                {section.id === 'utility' && measureOpen && (
                  <SketchMeasureReadout
                    sketch={sketch}
                    selectedIds={selectedIds}
                    displayUnits={workbenchSketchDocumentPort.getDisplayUnits()}
                    testId="workbench-sketch-measure-readout"
                  />
                )}
                </>}
              </div>
            ))}
            {/* WO SKC-16 (B1): the CONSTRAINTS section. */}
            <div className="tree-section" data-testid="workbench-rail-section-constraints">
              <RailSectionHeader title={workbenchText('WorkbenchToolRail.constraints')} right={<GlyphToggle />} sectionId="sketch-constraints" collapsed={layout.isCollapsed('sketch-constraints')} onToggle={() => layout.toggleSection('sketch-constraints')} />
              {!layout.isCollapsed('sketch-constraints') && <>
              <div className="sketch-tool-grid" style={gridStyle}>
                {CONSTRAINT_BUTTONS.map(({ kind, label, icon: Icon }) => {
                  // Eligibility = planConstraintForSelection(...).ok -- the SAME
                  // planner the apply path runs, so a button is enabled exactly
                  // when a click would succeed. The disabled tooltip names what
                  // the constraint needs (the planner's own reason string).
                  const plan = sketch !== null
                    ? planConstraintForSelection(sketch, selectedIds, kind)
                    : { ok: false as const, reason: workbenchText('WorkbenchToolRail.noActiveSketch') }
                  return (
                    <button
                      key={kind}
                      type="button"
                      data-testid={`workbench-package-constraint-${kind}`}
                      className="sketch-tool-btn"
                      disabled={!plan.ok}
                      data-tooltip={plan.ok ? workbenchText('WorkbenchToolRail.applyToSelection', { label: String(label) }) : workbenchText('WorkbenchToolRail.value', { label: String(label), reason: String(plan.reason) })}
                      onClick={() => workbenchOverlaysPort.applyConstraint(kind)}
                    >
                      <Icon size={15} />
                      <span>{label}</span>
                    </button>
                  )
                })}
                {/* WO-1865: Pierce -- one sketch point + a MODEL edge (picked in the viewport after
                    this click), so it is not a selection-only constraint like the ones above. */}
                <PierceButton sketch={sketch} selectedIds={selectedIds} armed={armed} />
              </div>
              <PierceSection
                sketch={sketch}
                selectedIds={selectedIds}
                onSelect={(ids) => workbenchSketchDocumentPort.setSelection(ids)}
                onDelete={(id) => {
                  workbenchSketchDocumentPort.setSelection([id])
                  workbenchOverlaysPort.deleteSelection()
                }}
              />
              </>}
            </div>
            </div>
          </>
        ) : (
          <div data-testid="workbench-modeling-toolbar">
            {modelingSections.map((section) => (
              <div className="tree-section" key={section.id} data-testid={`workbench-rail-section-${section.id}`}>
                <RailSectionHeader title={section.title} sectionId={section.id} collapsed={isCollapsed(section.id)} onToggle={() => toggleSection(section.id)} />
                {!isCollapsed(section.id) && <div className="sketch-tool-grid" style={gridStyle}>
                  {section.tools.map((tool) => {
                    const Icon = tool.icon
                    return (
                      <button
                        key={tool.testId}
                        type="button"
                        data-testid={tool.testId}
                        aria-pressed={tool.active === true}
                        aria-label={tool.label}
                        data-tooltip={layout.compact && tool.title !== undefined ? workbenchText('WorkbenchToolRail.value2', { label: String(tool.label), title: String(tool.title) }) : (tool.title ?? tool.label)}
                        disabled={tool.disabled === true}
                        className={tool.active === true ? 'sketch-tool-btn sketch-tool-btn-active' : 'sketch-tool-btn'}
                        onClick={tool.onClick}
                      >
                        <Icon size={15} />
                        <span>{tool.label}</span>
                      </button>
                    )
                  })}
                </div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
    </>
  )
}
