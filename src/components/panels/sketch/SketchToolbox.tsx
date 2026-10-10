import { ReferenceImage2dControls, ReferenceImage2dInsert } from './ReferenceImage2d'
import { Fragment, useRef, useState } from 'react'
import { useCamStore } from '../../../store'
import { useUiPrefs } from '../../../store/uiPrefs'
import { useSketcherTool, sketcherTools } from '../../../lib/sketch/sketcher'
import { SketchImportExportWindows } from './SketchImportExportWindows'
import { NumericInput } from '../../ui/NumericInput'
import { unitLabel } from '../../../lib/ui/unitFormat'
import { maxGearRootFillet } from '../../../lib/sketch/tools/gearTool'
import { DEFAULT_PRINT_OPTIONS, PRINT_PAPERS, type SketchPrintOptions } from '../../../lib/sketch/printDrawing'
import { ARMABLE_TOOLS, type SketchToolId } from '../../../lib/sketch/tools/toolMachine'
import { SHORTCUT_KEY_BY_TOOL, SHORTCUT_KEY_BY_UTILITY } from '../../../lib/sketch/tools/shortcuts'
import { planConstraintForSelection } from '../../../lib/sketch/constraintActions'
import { rowsForIds } from '../../../lib/sketch/browserModel'
import { ConstraintBrowser } from './ConstraintBrowser'
import { ConflictResolutionPanel } from './ConflictResolution'
import { SketchCancelButton, SketchFinishButton, SketchGlyphToggle } from './SketchChrome'
import { BlockPropertiesRow } from './BlockPropertiesRow'
import { BlockEditBanner } from './BlockEditBanner'
import { SketchMeasureReadout } from './SketchMeasureReadout'
import type { Sketch, SketchBlockEntity, SketchConstraintKind } from '../../../lib/sketch/types'
import { bezierJointSummary, conicSelectionSummary } from '../../../lib/sketch/spline'
import { sketchHasUserContent } from '../../../lib/sketch/sketchAnchors'
import { fontPickerOptions, SINGLE_LINE_FONT_VALUE } from '../../../lib/sketch/textOutline'
import {
  PenTool, ChevronRight, ChevronDown, Info, LayoutGrid, Rows3,
  CheckCircle2, AlertTriangle, CircleDashed,
  // Create
  Slash, Square, SquareDot, Radius, Tangent,
  Pentagon, Settings2, Type,
  // Modify
  Scissors, Split, ArrowRightFromLine, FlipHorizontal2,
  Grid3x3, Move, RotateCw, Scaling, Trash2, Waypoints,
  // Constraints
  Crosshair, Target,
  MoveHorizontal, MoveVertical, Equal,
  Lock, LocateFixed, Spline, Waves,
  // Dimensions
  Ruler,
  // Utility
  Import, Eye, Magnet, Wand2,
  type LucideIcon,
} from 'lucide-react'
// WO-045: shipped CAD-semantic glyphs (the workshop set Operator approved) for
// the tools the WO-043 audit flagged; audited-FINE tools keep lucide picks.
import { cadIcon } from '../../icons/cadIcons'
import { useToolPaletteLayout } from '../../common/useToolPaletteLayout'
import '../../common/toolPaletteLayout.css'

// Placeholder toolbox for Sketch mode (Stage 0). Every tool is present but
// disabled; tooltips name the stage in which the tool becomes functional
// (per docs/sketch-mode/PLAN.md sections 3.5 and 4).

interface ToolDef {
  id: string
  label: string
  icon: LucideIcon
  stage: number
}

interface SectionDef {
  id: string
  title: string
  tools: ToolDef[]
}

// CONSTRAINTS buttons -> document constraint kinds. Buttons are live
// (Stage 4): enabled iff the current selection is a valid operand set per
// planConstraintForSelection — the disabled tooltip names what is needed.
const CONSTRAINT_KIND_BY_BUTTON: Record<string, SketchConstraintKind> = {
  'coincident':    'coincident',
  'concentric':    'concentric',
  'parallel':      'parallel',
  'perpendicular': 'perpendicular',
  'collinear':     'collinear',
  'horizontal':    'horizontal',
  'vertical':      'vertical',
  'tangent':       'tangent',
  'equal':         'equal',
  'midpoint':      'midpoint',
  'symmetric':     'symmetric',
  'fix':           'fix',
  'point-on-obj':  'point_on_object',
  // WO-1866: a control spline held smooth where it meets a line or arc.
  'continuity-g1': 'continuity_g1',
  'continuity-g2': 'continuity_g2',
}

export const SECTIONS: SectionDef[] = [
  {
    id: 'create',
    title: 'Create',
    tools: [
      { id: 'line',          label: 'Line',          icon: Slash,               stage: 3 },
      { id: 'rect-corner',   label: 'Rectangle',     icon: Square,              stage: 3 },
      { id: 'rect-center',   label: 'Center Rect',   icon: SquareDot,           stage: 3 },
      { id: 'circle-center', label: 'Circle',        icon: cadIcon('circle-center'), stage: 3 },
      { id: 'circle-3pt',    label: '3-Pt Circle',   icon: cadIcon('circle-3pt'), stage: 3 },
      { id: 'ellipse',       label: 'Ellipse',       icon: cadIcon('ellipse'),  stage: 3 },
      { id: 'ellipse-arc',   label: 'Elliptical Arc', icon: cadIcon('ellipse-arc'), stage: 3 },
      { id: 'spline',        label: 'Spline',        icon: cadIcon('spline'),   stage: 3 },
      { id: 'spline-control', label: 'Control Spline', icon: cadIcon('spline-control'), stage: 3 },
      { id: 'bezier',        label: 'Bezier',        icon: cadIcon('bezier'),   stage: 3 },
      { id: 'conic',         label: 'Conic Arc',     icon: cadIcon('conic'),    stage: 3 },
      { id: 'text',          label: 'Text',          icon: Type,                stage: 3 },
      { id: 'arc-3pt',       label: '3-Pt Arc',      icon: cadIcon('arc-3pt'),  stage: 3 },
      { id: 'arc-tangent',   label: 'Tangent Arc',   icon: Tangent,             stage: 3 },
      { id: 'arc-center',    label: 'Center Arc',    icon: Radius,              stage: 3 },
      { id: 'gear',          label: 'Gear',          icon: Settings2,           stage: 6 },
      { id: 'polygon',       label: 'Polygon',       icon: Pentagon,            stage: 6 },
      { id: 'slot',          label: 'Slot',          icon: cadIcon('slot'),     stage: 6 },
      { id: 'slot-arc',      label: 'Arc Slot',      icon: cadIcon('slot-arc'), stage: 6 },
      { id: 'point',         label: 'Point',         icon: cadIcon('point'),    stage: 3 },
      { id: 'construction',  label: 'Construction',  icon: cadIcon('construction'), stage: 3 },
    ],
  },
  {
    id: 'modify',
    title: 'Modify',
    tools: [
      // Smart Dim. + Reference promoted here from the former bottom-relegated
      // DIMENSIONS section (sketch-panel-density pass): dimensioning is a
      // frequent action and should not require scrolling to the panel bottom.
      // Handlers/behavior unchanged - placement only.
      { id: 'smart-dimension',  label: 'Smart Dim.',   icon: Ruler,             stage: 4 },
      { id: 'toggle-reference', label: 'Reference',    icon: Eye,               stage: 4 },
      { id: 'trim',             label: 'Trim',         icon: Scissors,          stage: 6 },
      { id: 'split',            label: 'Split',        icon: Split,             stage: 6 },
      { id: 'extend',           label: 'Extend',       icon: ArrowRightFromLine, stage: 6 },
      { id: 'fillet',           label: 'Fillet',       icon: cadIcon('fillet'), stage: 6 },
      { id: 'chamfer',          label: 'Chamfer',      icon: cadIcon('chamfer'), stage: 6 },
      { id: 'offset',           label: 'Offset',       icon: cadIcon('offset'), stage: 6 },
      { id: 'mirror',           label: 'Mirror',       icon: FlipHorizontal2,   stage: 6 },
      { id: 'pattern-linear',   label: 'Linear Pat.',  icon: Grid3x3,           stage: 6 },
      { id: 'pattern-circular', label: 'Circular Pat.', icon: cadIcon('pattern-circular'), stage: 6 },
      { id: 'pattern-path',     label: 'Path Pat.',    icon: Waypoints,         stage: 6 },
      { id: 'move',             label: 'Move',         icon: Move,              stage: 6 },
      { id: 'rotate',           label: 'Rotate',       icon: RotateCw,          stage: 6 },
      { id: 'scale',            label: 'Scale',        icon: Scaling,           stage: 6 },
      { id: 'delete',           label: 'Delete',       icon: Trash2,            stage: 3 },
    ],
  },
  {
    id: 'constraints',
    title: 'Constraints',
    tools: [
      { id: 'coincident',    label: 'Coincident',    icon: Crosshair,             stage: 4 },
      { id: 'concentric',    label: 'Concentric',    icon: Target,                stage: 4 },
      { id: 'parallel',      label: 'Parallel',      icon: cadIcon('parallel'),   stage: 4 },
      { id: 'perpendicular', label: 'Perpendicular', icon: cadIcon('perpendicular'), stage: 4 },
      { id: 'collinear',     label: 'Collinear',     icon: cadIcon('collinear'),  stage: 4 },
      { id: 'horizontal',    label: 'Horizontal',    icon: MoveHorizontal,        stage: 4 },
      { id: 'vertical',      label: 'Vertical',      icon: MoveVertical,          stage: 4 },
      { id: 'tangent',       label: 'Tangent',       icon: Tangent,               stage: 4 },
      { id: 'equal',         label: 'Equal',         icon: Equal,                 stage: 4 },
      { id: 'midpoint',      label: 'Midpoint',      icon: cadIcon('midpoint'),   stage: 4 },
      { id: 'symmetric',     label: 'Symmetric',     icon: cadIcon('symmetric'),  stage: 4 },
      { id: 'fix',           label: 'Fix',           icon: Lock,                  stage: 4 },
      { id: 'point-on-obj',  label: 'On Object',     icon: LocateFixed,           stage: 4 },
      { id: 'continuity-g1', label: 'Tangent G1',    icon: Spline,                stage: 4 },
      { id: 'continuity-g2', label: 'Curvature G2',  icon: Waves,                 stage: 4 },
    ],
  },
  {
    id: 'utility',
    title: 'Utility',
    tools: [
      { id: 'measure',  label: 'Measure',       icon: cadIcon('measure'), stage: 6 },
      { id: 'project',  label: 'Project / Use', icon: Import,  stage: 6 },
    ],
  },
]

// Primary action at the very top of the toolbox (above the solve banner):
// bake the sketch to its geometry layer and return to the previous
// non-sketch mode. Switching modes via the top tabs takes the SAME bake
// path (finish/exit both bake — no surprise data loss); this button is the
// explicit, discoverable way out. An empty sketch finishes by discarding
// its auto-created layer instead (no junk).
// Tool tiles keep their label on one line (WO-1960, Operator): the tile gives up
// its side padding instead, so "Control Spline" fits the 78px column.
const TOOL_BTN_STYLE = { paddingLeft: 0, paddingRight: 0 } as const

function FinishSketchButton() {
  const finishSketch = useCamStore((s) => s.finishSketch)
  const cancelActiveSketch = useCamStore((s) => s.cancelActiveSketch)
  const hasEntities = useCamStore(
    (s) => s.activeSketch !== null && sketchHasUserContent(s.activeSketch)
  )
  return (
    <div className="sketch-session-actions sketch-session-actions-compact">
      <SketchFinishButton hasEntities={hasEntities} onClick={finishSketch} />
      <SketchCancelButton onClick={cancelActiveSketch} testId="cam-cancel-active-sketch" />
    </div>
  )
}

// Solve-status banner driven by real store state (Stage 2). Status
// precedence mirrors the solver layer: conflicts WIN over everything
// (planegcs can report Success while diagnosing conflicts), then
// dof == 0 = fully defined, else under-defined with the DoF count.
//
// Stage 4: an over-defined banner carries the conflict COUNT + the first
// few NAMES of the solver-named set and a "Resolve..." button opening the
// resolution flow (delete one of the named set). Redundant constraints
// surface the same way in amber — advisory, not an error.
const BANNER_NAME_MAX = 3

// Compact definition-state chip shown in the panel's TOP HEADER beside the
// "Sketch" title (sketch-panel-density pass): the plain under-defined / fully
// defined / solving / no-sketch status moved OUT of its own scrollable banner
// row into the header so it no longer consumes vertical space. Conflict and
// redundant states keep their detailed banner rows below (SolveBanner) because
// they carry named sets + a Resolve/Review action; the header chip then defers
// to the banner. DoF computation is untouched - this only relocates the readout.
function SketchDefinitionChip() {
  const activeSketch = useCamStore((s) => s.activeSketch)
  const liveStatus = useCamStore((s) => s.sketchSolveStatus)

  if (!activeSketch) {
    return (
      <span className="sketch-def-chip sketch-def-chip-idle" data-tooltip="No active sketch">
        <Info size={11} />
        <span>No sketch</span>
      </span>
    )
  }

  const status = liveStatus ?? activeSketch.solveStatus

  // null = NEVER SOLVED (fresh/empty sketch, or the first solve pass has not
  // answered yet). That is a missing VERDICT, not a solver-availability
  // problem: the CAM store exposes no availability signal to this component,
  // and drawing one ordinary line yields a DoF verdict with no solver error
  // at any point. Word it as the neutral no-verdict-yet state it is, matching
  // the workbench rail's "Not solved" chip for the same case.
  if (status === null) {
    return (
      <span
        className="sketch-def-chip sketch-def-chip-idle"
        data-testid="cam-sketch-dof-chip"
        data-tooltip="The solver has not produced a definition verdict"
      >
        <CircleDashed size={11} />
        <span>Not solved</span>
      </span>
    )
  }

  // FAILED solve (ADR 0003 fail loud): a status marked solveFailed came
  // from a solve that produced NO definition verdict (mapping error /
  // non-convergence / conflict) — its dof is a placeholder, and rendering
  // it below as "Fully defined" / "N DoF" was a false green safety signal.
  // Conflicts additionally keep their detailed red banner (SolveBanner)
  // with the named set + Resolve flow; the chip and banner agree.
  if (status.solveFailed) {
    return (
      <span
        className="sketch-def-chip sketch-def-chip-failed"
        data-testid="cam-sketch-dof-chip"
        data-tooltip={`Solve failed: ${status.failureMessage ?? 'see console for details'}`}
      >
        <AlertTriangle size={11} />
        <span>Solve failed</span>
      </span>
    )
  }

  // Conflict / redundant detail lives in the banner below; the header chip
  // shows the underlying definition state so the two never contradict.
  if (status.dof === 0) {
    return (
      <span
        className="sketch-def-chip sketch-def-chip-defined"
        data-testid="cam-sketch-dof-chip"
        data-tooltip="Fully defined"
      >
        <CheckCircle2 size={11} />
        <span>Fully defined</span>
      </span>
    )
  }

  return (
    <span
      className="sketch-def-chip sketch-def-chip-under"
      data-testid="cam-sketch-dof-chip"
      data-tooltip={`Under-defined: ${status.dof} degrees of freedom remain`}
    >
      <CircleDashed size={11} />
      <span>{status.dof} DoF</span>
    </span>
  )
}

// Conflict / redundant detail banner (sketch-panel-density pass). The plain
// under-defined / fully-defined / solving / idle readout moved to the header
// (SketchDefinitionChip); this banner now renders ONLY when there is a
// conflict or a redundant advisory to surface - otherwise it renders nothing
// and reclaims the row entirely.
function SolveBanner() {
  const activeSketch = useCamStore((s) => s.activeSketch)
  const liveStatus = useCamStore((s) => s.sketchSolveStatus)
  const [resolveOpen, setResolveOpen] = useState(false)

  if (!activeSketch) return null

  // Live solve status if a solve has run this session, else the status
  // persisted on the document (so a re-opened sketch shows state at once).
  const status = liveStatus ?? activeSketch.solveStatus

  // null = NEVER SOLVED: the header chip shows "Not solved"; no banner.
  if (status === null) return null

  // First few NAMES of a solver-named set ("Distance: Line 1 = 70 mm")
  // — ids mean nothing to the user; the chip title carries the operands.
  const nameChips = (ids: string[]) => {
    const rows = rowsForIds(activeSketch, ids)
    const extra = rows.length - BANNER_NAME_MAX
    return (
      <span className="sketch-conflict-ids">
        {rows.slice(0, BANNER_NAME_MAX).map((r) => (
          <code key={r.id} data-tooltip={`${r.label}: ${r.operands}`}>{r.label}</code>
        ))}
        {extra > 0 && <code>+{extra} more</code>}
      </span>
    )
  }

  const resolvePanel = resolveOpen && (
    <ConflictResolutionPanel onClose={() => setResolveOpen(false)} />
  )

  if (status.conflicting.length > 0) {
    return (
      <>
        <div className="sketch-solve-banner sketch-solve-banner-conflict">
          <AlertTriangle size={12} />
          <div className="sketch-solve-banner-text">
            <span>
              Over-defined: {status.conflicting.length} conflicting
            </span>
            {nameChips(status.conflicting)}
          </div>
          <button
            className="sketch-resolve-btn"
            onClick={() => setResolveOpen((o) => !o)}
            data-tooltip="List the conflicting set - remove one to resolve"
          >
            Resolve...
          </button>
        </div>
        {resolvePanel}
      </>
    )
  }

  // Redundant with no conflict: the sketch solves, the banner reports the
  // real definition state, and an amber advisory row names the redundant
  // set (same flow, removal optional).
  const redundantRow = status.redundant.length > 0 && (
    <div className="sketch-solve-banner sketch-solve-banner-redundant">
      <Info size={12} />
      <div className="sketch-solve-banner-text">
        <span>{status.redundant.length} redundant (advisory)</span>
        {nameChips(status.redundant)}
      </div>
      <button
        className="sketch-resolve-btn"
        onClick={() => setResolveOpen((o) => !o)}
        data-tooltip="List the redundant constraints - removal optional"
      >
        Review...
      </button>
    </div>
  )

  // No conflict: the plain defined / under-defined readout is in the header
  // chip. Only the redundant advisory (if any) + its resolve panel render here;
  // when there is nothing redundant, the banner reclaims its row entirely.
  if (!redundantRow) return null
  return (
    <>
      {redundantRow}
      {resolvePanel}
    </>
  )
}

// "Show constraints" glyph-visibility toggle (USER-REQUESTED at the Stage 2
// gate). Density pass: relocated from its own full-width top row INTO the
// CONSTRAINTS section header as a small icon toggle, reclaiming the top row.
// Behavior unchanged - hides only the constraint glyph badges in the viewport;
// dimension labels and definition coloring are unaffected (sketchLayer gates
// badge building on glyphsVisible alone). Default ON; state in the sketch slice.
// stopPropagation keeps clicks from also collapsing the section header.
function ConstraintGlyphToggle() {
  const glyphsVisible = useCamStore((s) => s.sketchGlyphsVisible)
  const toggleSketchGlyphs = useCamStore((s) => s.toggleSketchGlyphs)
  return (
    <SketchGlyphToggle
      visible={glyphsVisible}
      onToggle={toggleSketchGlyphs}
      testId="cam-sketch-glyph-toggle"
    />
  )
}

// Snap toggles + grid spacing (UTILITY section, PLAN 3.5). The toggles
// drive the snap engine via the sketch slice; the spacing input writes
// viewer.gridSpacing — the SAME state the drawn viewport grid uses (and
// the ViewportToolbar input edits), so grid snap and the visible grid can
// never disagree.
function SnapSettings() {
  const entity = useSketcherTool((s) => s.snapEntity)
  const grid = useSketcherTool((s) => s.snapGrid)
  const inference = useSketcherTool((s) => s.snapInference)
  const toggleFlag = sketcherTools.toggleSnapFlag
  const gridSpacing = useCamStore((s) => s.viewer.gridSpacing)
  const setGridSpacing = useCamStore((s) => s.setGridSpacing)
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)

  const toggles: Array<{
    flag: 'entity' | 'grid' | 'inference'
    on: boolean
    icon: LucideIcon
    label: string
    title: string
  }> = [
    {
      flag: 'entity', on: entity, icon: Magnet, label: 'Entity snaps',
      title: 'Snap to endpoints, midpoints, centers, and intersections',
    },
    {
      flag: 'grid', on: grid, icon: Grid3x3, label: 'Grid snap',
      title: 'Snap to grid points (spacing below)',
    },
    {
      flag: 'inference', on: inference, icon: Wand2, label: 'Inference',
      title: 'H/V alignment guides and automatic constraints on commit',
    },
  ]

  return (
    <div className="sketch-snap-settings">
      {toggles.map(({ flag, on, icon: Icon, label, title }) => (
        <button
          key={flag}
          className={`sketch-display-toggle${on ? ' sketch-display-toggle-on' : ''}`}
          onClick={() => toggleFlag(flag)}
          data-tooltip={title}
        >
          <Icon size={13} />
          <span>{label}</span>
        </button>
      ))}
      <label className="sketch-snap-spacing" data-tooltip={`Grid spacing (${unitLabel(displayUnits)}) - shared by the drawn grid and grid snap`}>
        <span>Grid spacing ({unitLabel(displayUnits)})</span>
        <NumericInput min={1} step={1} value={gridSpacing} onChange={setGridSpacing} units={displayUnits} />
      </label>
    </div>
  )
}

// Fillet radius input (MODIFY section, shown while the fillet tool is
// armed). Same row styling as the grid-spacing input; the value drives
// filletClick via the store and persists for the session.
function FilletRadiusRow() {
  const radius = useSketcherTool((s) => s.filletRadius)
  const setRadius = sketcherTools.setFilletRadius
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  return (
    <div className="sketch-snap-settings">
      <label
        className="sketch-snap-spacing"
        data-tooltip={`Fillet radius (${unitLabel(displayUnits)}) - applied by the next fillet click`}
      >
        <span>Fillet radius ({unitLabel(displayUnits)})</span>
        <NumericInput min={0.1} step={0.5} value={radius} onChange={setRadius} units={displayUnits} />
      </label>
    </div>
  )
}

// Chamfer setback input (MODIFY section, shown while the chamfer tool is
// armed). Same row styling as the fillet radius input; the value drives
// chamferClick via the store and persists for the session (equal-distance
// chamfer v1: one setback applied to both legs).
function ChamferSetbackRow() {
  const setback = useSketcherTool((s) => s.chamferSetback)
  const setSetback = sketcherTools.setChamferSetback
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  return (
    <div className="sketch-snap-settings">
      <label
        className="sketch-snap-spacing"
        data-tooltip={`Chamfer setback (${unitLabel(displayUnits)}) - applied equally to both legs by the next chamfer`}
      >
        <span>Chamfer setback ({unitLabel(displayUnits)})</span>
        <NumericInput min={0.1} step={0.5} value={setback} onChange={setSetback} units={displayUnits} />
      </label>
    </div>
  )
}

// Offset distance input (MODIFY section, shown while the offset tool is
// armed). Live: editing it while a chain is selected updates the preview
// (the viewport reads the store value per cursor move).
function OffsetDistanceRow() {
  const distance = useSketcherTool((s) => s.offsetDistance)
  const setDistance = sketcherTools.setOffsetDistance
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  return (
    <div className="sketch-snap-settings">
      <label
        className="sketch-snap-spacing"
        data-tooltip={`Offset distance (${unitLabel(displayUnits)}) - the cursor side picks the offset side`}
      >
        <span>Offset distance ({unitLabel(displayUnits)})</span>
        <NumericInput min={0.1} step={0.5} value={distance} onChange={setDistance} units={displayUnits} />
      </label>
    </div>
  )
}

// Polygon side count (CREATE section, shown while the polygon tool is
// armed). Default 6, min 3; the value drives both the live preview and
// the committed entity/constraint set.
//
// EXPORTED (WO-1472): WorkbenchToolRail.tsx renders this SAME row for its
// own copy of the polygon tool -- both rails arm the polygon tool through
// the same useSketcherTool/sketcherTools engine, so one row definition
// serves both hosts with no host-specific props.
export function GearRow() {
  const p = useSketcherTool((s) => s.gearParams)
  return (
    <div className="sketch-snap-settings" data-testid="gear-row">
      <label className="sketch-snap-spacing">
        <span>Teeth</span>
        <NumericInput ariaLabel="Gear teeth" min={6} max={200} step={1} value={p.teeth} onChange={(teeth) => sketcherTools.setGearParams({ teeth })} />
      </label>
      <label className="sketch-snap-spacing">
        <span>Module (mm)</span>
        <NumericInput ariaLabel="Gear module" min={0.01} max={100} step={0.1} value={p.module} onChange={(module) => sketcherTools.setGearParams({ module })} />
      </label>
      <label className="sketch-snap-spacing">
        <span>Pressure angle</span>
        <select aria-label="Gear pressure angle" value={p.pressureAngle} onChange={(e) => sketcherTools.setGearParams({ pressureAngle: Number(e.target.value) as 14.5 | 20 | 25 })}>
          <option value={14.5}>14.5 deg</option>
          <option value={20}>20 deg</option>
          <option value={25}>25 deg</option>
        </select>
      </label>
      <label className="sketch-snap-spacing">
        <span>Root fillet (mm)</span>
        <NumericInput ariaLabel="Gear root fillet" min={0} max={maxGearRootFillet(p)} step={0.1} value={p.rootFillet} onChange={(rootFillet) => sketcherTools.setGearParams({ rootFillet })} />
      </label>
    </div>
  )
}

export function PolygonSidesRow() {
  const sides = useSketcherTool((s) => s.polygonSides)
  const mode = useSketcherTool((s) => s.polygonMode)
  const setSides = sketcherTools.setPolygonSides
  return (
    <div className="sketch-snap-settings">
      <label
        className="sketch-snap-spacing"
        data-tooltip="Polygon sides (>= 3) - click center, then a vertex"
      >
        <span>Sides</span>
        <NumericInput min={3} step={1} value={sides} onChange={(v) => setSides(Math.round(v))} />
      </label>
      <label
        className="sketch-snap-spacing"
        data-tooltip="Inscribed: click a vertex. Circumscribed: click a side midpoint."
      >
        <span>Mode</span>
        <select
          data-testid="polygon-mode"
          value={mode}
          onChange={(event) => sketcherTools.setPolygonMode(
            event.target.value as 'inscribed' | 'circumscribed',
          )}
        >
          <option value="inscribed">Inscribed</option>
          <option value="circumscribed">Circumscribed</option>
        </select>
      </label>
    </div>
  )
}

// Single-line TEXT string + cap height (CREATE section, shown while the text
// tool is armed). Placement is WYSIWYG: a click commits an EMPTY text entity
// and opens the in-canvas editor on it (toolController.ts) — no cursor ghost,
// no string threaded to placement. So the string field itself stays hidden
// until a placed entity is actually being edited (sketchTextEditId set);
// height/rotation/style/mirror/letter-spacing stay live pre-placement since
// the committed entity does honor those as session defaults. Editing the
// inputs never fires a single-key shortcut (the focus guard treats INPUT as
// a typing target).
function TextInputRow() {
  const value = useCamStore((s) => s.sketchTextValue)
  const setValue = useCamStore((s) => s.setSketchTextValue)
  const height = useCamStore((s) => s.sketchTextHeight)
  const setHeight = useCamStore((s) => s.setSketchTextHeight)
  const style = useCamStore((s) => s.sketchTextStyle)
  const rotationDeg = useCamStore((s) => s.sketchTextRotationDeg)
  const setRotation = useCamStore((s) => s.setSketchTextRotation)
  const mirrored = useCamStore((s) => s.sketchTextMirrored)
  const setMirrored = useCamStore((s) => s.setSketchTextMirrored)
  const letterSpacing = useCamStore((s) => s.sketchTextLetterSpacing)
  const setLetterSpacing = useCamStore((s) => s.setSketchTextLetterSpacing)
  const editing = useCamStore((s) => s.sketchTextEditId != null)
  const editId = useCamStore((s) => s.sketchTextEditId)
  // WO-1488: a fresh placement vs a double-click edit of existing text. Esc
  // behaves differently for each, so the hint below must be keyed off it.
  const editIsNew = useCamStore((s) => s.sketchTextEditIsNew)
  const commitEdit = useCamStore((s) => s.commitSketchTextEdit)
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  // Text-on-path binding (only meaningful while editing a placed text).
  const pathId = useCamStore((s) => s.sketchTextPathId)
  const pathOffset = useCamStore((s) => s.sketchTextPathOffsetMm)
  const pathFlip = useCamStore((s) => s.sketchTextPathFlip)
  const picking = useCamStore((s) => s.sketchPickPathForTextId != null)
  const beginPickPath = useCamStore((s) => s.beginPickTextPath)
  const cancelPickPath = useCamStore((s) => s.cancelPickTextPath)
  const unbindPath = useCamStore((s) => s.unbindSketchTextPath)
  const setPathOffset = useCamStore((s) => s.setSketchTextPathOffset)
  const setPathFlip = useCamStore((s) => s.setSketchTextPathFlip)
  const fontFamily = useCamStore((s) => s.sketchTextFontFamily)
  const setFont = useCamStore((s) => s.setSketchTextFont)
  const importFont = useCamStore((s) => s.importSketchFont)
  // Re-derive the picker options when the imported set changes (the list itself
  // lives in the font registry; importedFonts is the reactive trigger).
  const importedFonts = useCamStore((s) => s.importedFonts)
  const options = fontPickerOptions()
  void importedFonts // subscription only — options are read from the registry
  // The unified picker's current value: single-line -> the sentinel; outline ->
  // the selected family. One dropdown, always visible, no hidden style toggle.
  const fontValue = style === 'single-line' ? SINGLE_LINE_FONT_VALUE : fontFamily
  const fileInputRef = useRef<HTMLInputElement>(null)
  return (
    <div
      className="sketch-snap-settings"
      // While editing a placed text, Enter finalizes the live edit (matches
      // the click-away commit); the field values already applied in place.
      onKeyDown={editing ? (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commitEdit()
          ;(document.activeElement as HTMLElement | null)?.blur?.()
        }
      } : undefined}
    >
      {editing && (
        <div className="sketch-snap-spacing" style={{ opacity: 0.75 }}>
          <span data-testid="sketch-text-edit-hint">
            {editIsNew
              ? value.trim().length > 0
                // A fresh placement with typed work survives Escape (it commits
                // instead of cancelling), so say so.
                ? 'Placing new text — Enter to finish, Esc to keep the typed text'
                // A fresh, still-empty placement is removed by Escape.
                : 'Placing new text — Enter to finish, Esc to discard it'
              // Editing existing text: Escape restores its pre-edit value.
              : 'Editing placed text — Enter to finish, Esc to revert to the original text'}
          </span>
        </div>
      )}
      {editing && (
        <label
          className="sketch-snap-spacing"
          data-tooltip="Text to engrave - placed left-to-right from the click point"
        >
          <span>Text</span>
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            style={{ flex: 1, minWidth: 0 }}
          />
        </label>
      )}
      <label
        className="sketch-snap-spacing"
        data-tooltip={`Cap height (${unitLabel(displayUnits)}) of the engraved text`}
      >
        <span>Height ({unitLabel(displayUnits)})</span>
        <NumericInput min={0.1} step={0.5} value={height} onChange={setHeight} units={displayUnits} />
      </label>
      <label
        className="sketch-snap-spacing"
        data-tooltip="Baseline angle in degrees (CCW). 0 = horizontal; the ghost and placed text rotate live."
      >
        <span>Angle (deg)</span>
        <NumericInput step={15} value={rotationDeg} onChange={setRotation} />
      </label>
      {/* LETTER SPACING (tracking): absolute mm added between glyphs. Negative
          tightens, positive widens; 0 = the font's natural spacing. Threads
          through the ONE local layout, so render, bake, pick and alignment all
          inherit it. Session default for the next placement + live patch of an
          open edit, like height/angle. */}
      <label
        className="sketch-snap-spacing"
        data-tooltip="Letter spacing (tracking) in mm added between glyphs. Negative tightens, positive widens; 0 = the font's natural spacing."
      >
        <span>Letter spacing (mm)</span>
        <NumericInput step={0.1} value={letterSpacing} onChange={setLetterSpacing} />
      </label>
      {/* MIRROR (flip-TEXT, spec T5b): mirror-image the glyphs in place --
          reads reversed, same span. Lives HERE with font/height because it
          applies to FREE text too (the on-path anchor pill carries the same
          toggle for text on a curve, next to flip-SIDE). Session default for
          the next placement + live patch of an open edit, like height. */}
      <label
        className="sketch-snap-spacing"
        data-tooltip="Mirror the glyphs (reads reversed, same position). Independent of the on-path Flip side toggle."
      >
        <span>Mirror</span>
        <button
          type="button"
          className={`sketch-header-toggle${mirrored ? ' sketch-header-toggle-on' : ''}`}
          aria-pressed={mirrored}
          onClick={() => setMirrored(!mirrored)}
        >
          {mirrored ? 'Mirrored' : 'Normal'}
        </button>
      </label>
      {/* UNIFIED FONT PICKER (always visible while the text tool is armed or a
          placed text is being edited). One dropdown lists the single-line
          Hershey/engrave face FIRST, then every outline family. Selecting an
          entry sets BOTH the style and the family in one action (store
          .setSketchTextFont) - the user never has to discover an "outline"
          toggle to see the font options. The Import button sits next to it;
          imported faces are outline and appear at the bottom of the list. */}
      <label
        className="sketch-snap-spacing"
        data-tooltip={
          'Pick a font. "Hershey (single-line / engrave)" cuts open centerline '
          + 'strokes with the tool tip; every other face is an outline (closed '
          + 'filled-glyph contours + holes) you can pocket or contour.'
        }
      >
        <span>Font</span>
        <select
          value={fontValue}
          onChange={(e) => setFont(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <label
        className="sketch-snap-spacing"
        data-tooltip="Import a .ttf / .otf / typeface .json font. Converted in-browser (no upload) and saved with your project settings. Imported faces are outline."
      >
        <span>Add font</span>
        <button
          type="button"
          className="sketch-header-toggle"
          onClick={() => fileInputRef.current?.click()}
        >
          Import font...
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".ttf,.otf,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void importFont(file)
            e.target.value = '' // allow re-picking the same file
          }}
        />
      </label>
      {/* TEXT-ON-PATH: attach the placed text to a curve so it follows it. Only
          offered while editing a placed text (you attach after placement, like
          standard parametric CAD). Not bound -> Attach; bound -> Detach + offset +
          flip. The Attach button enters a pick mode; the next canvas click on a
          curve binds it (status hint shown), Esc cancels. */}
      {editing && (
        // WO-1501: an implicit <label> here wrapped TWO unrelated buttons; a
        // label with no single control hands its whole computed name to every
        // focusable descendant. It is a caption, not a control label -> a plain
        // <div>, so each button keeps its own accessible name.
        <div
          className="sketch-snap-spacing"
          data-tooltip="Attach this text to a curve (line, arc, circle, ellipse, spline) so it follows the path."
        >
          <span>On path</span>
          {pathId == null ? (
            <button
              type="button"
              className={`sketch-header-toggle${picking ? ' sketch-header-toggle-on' : ''}`}
              onClick={() => (picking ? cancelPickPath() : editId && beginPickPath(editId))}
            >
              {picking ? 'Click a curve… (Esc)' : 'Attach to path'}
            </button>
          ) : (
            <span style={{ display: 'flex', gap: 4, flex: 1, minWidth: 0 }}>
              <button
                type="button"
                className="sketch-header-toggle"
                onClick={() => editId && unbindPath(editId)}
              >
                Detach
              </button>
              <button
                type="button"
                className={`sketch-header-toggle${pathFlip ? ' sketch-header-toggle-on' : ''}`}
                aria-pressed={pathFlip}
                data-tooltip="Flip the text to the other side of the curve"
                onClick={() => setPathFlip(!pathFlip)}
              >
                Flip side
              </button>
            </span>
          )}
        </div>
      )}
      {/* POSITION ALONG PATH: exact numeric position (arc-length from the
          path start). Live — the text re-flows as it changes (render/bake
          re-warp). Setting it forces align FREE (setSketchTextPathOffset:
          under L/C/R the value would be silently ignored -- ADR-0003);
          sliding/aligning lives on the on-canvas anchor pill (spec T2: the
          range slider DIED). Shown whenever a text-on-path is being edited
          (attach flow OR born-on-path flow). */}
      {editing && pathId != null && (
        <label
          className="sketch-snap-spacing"
          data-tooltip={`Exact position along the path (${unitLabel(displayUnits)} of arc-length from the path start). Typing a value switches the anchor to Free.`}
        >
          <span>Position along path ({unitLabel(displayUnits)})</span>
          <NumericInput step={0.5} value={pathOffset} onChange={setPathOffset} units={displayUnits} />
        </label>
      )}
    </div>
  )
}

// WO-1860: a DXF or SVG file lands as editable entities in THIS sketch (no CAM
// layer, no separate lift step) -- always visible in CREATE, not tied to any
// armed tool (it is a one-shot file action, same shape as TextInputRow's "Add
// font" button below). sketcherTools.importFileIntoSketch is host-neutral, so
// this same handler is what WorkbenchToolRail.tsx wires for the other host.
//
// EXPORTED (WO-1860, same convention as PolygonSidesRow / WO-1472):
// WorkbenchToolRail.tsx renders this SAME row -- both rails arm the shared
// sketcherTools engine, so one row definition serves both hosts.
export function ImportIntoSketchRow({ sketchName = 'Sketch', referenceImageImport = false }: { sketchName?: string; referenceImageImport?: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Keep options in the host row: closing either window must not reset them.
  const [window, setWindow] = useState<'import' | 'export' | null>(null)
  const [printOptions, setPrintOptions] = useState<SketchPrintOptions>(DEFAULT_PRINT_OPTIONS)
  // WO-1904: both hosts read the remembered Settings > DXF import choice.
  const keepOrigin = useUiPrefs((s) => s.dxfKeepOrigin)
  const [traceWidthMm, setTraceWidthMm] = useState(100)
  const [traceThreshold, setTraceThreshold] = useState(128)
  return (
    <div className="sketch-snap-settings">
      <div className="sketch-import-export-row">
        <button type="button" className="sketch-header-toggle"
          data-testid="cam-sketch-import-into-sketch" onClick={() => setWindow('import')}>
          Import...
        </button>
        <button type="button" className="sketch-header-toggle"
          data-testid="sketch-export-print-open" onClick={() => setWindow('export')}>
          Export / Print...
        </button>
      </div>
      <SketchImportExportWindows window={window} onClose={() => setWindow(null)}
        importControls={<>
          {referenceImageImport && <ReferenceImage2dInsert onInserted={() => setWindow(null)} />}
          <button type="button" className="modal-btn modal-btn-primary"
            data-tooltip="Import a DXF or SVG file, or trace a PNG/JPG picture, as editable geometry in this sketch, chained and constrained like drawn geometry."
            onClick={() => fileInputRef.current?.click()}>Choose DXF / SVG / PNG / JPG...</button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".dxf,.svg,.png,.jpg,.jpeg"
            data-testid="cam-sketch-import-into-sketch-input"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) {
                void sketcherTools.importFileIntoSketch(file, { keepOrigin, traceWidthMm, traceThreshold })
                setWindow(null)
              }
              e.target.value = '' // allow re-picking the same file
            }}
      />
          <p className="sketch-import-picture-note">Picture choices apply to PNG / JPG pictures.</p>
      <label
        className="sketch-snap-spacing"
        data-tooltip="Picture import: how wide the traced picture is, in mm. The height follows the picture."
      >
        <span>Picture width (mm)</span>
        <input
          type="number"
          min={1}
          step={1}
          value={traceWidthMm}
          data-testid="cam-sketch-trace-width"
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v) && v > 0) setTraceWidthMm(v)
          }}
        />
      </label>
      <label
        className="sketch-snap-spacing"
        data-tooltip="Picture import: pixels darker than this (0 black to 255 white) become shapes."
      >
        <span>Picture threshold</span>
        <input
          type="number"
          min={1}
          max={254}
          step={1}
          value={traceThreshold}
          data-testid="cam-sketch-trace-threshold"
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v) && v >= 1 && v <= 254) setTraceThreshold(v)
          }}
        />
      </label>
        </>}
        exportControls={<>
      <label className="sketch-snap-spacing">
        <span>Paper</span>
        <select aria-label="Print paper" value={printOptions.paper} style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setPrintOptions({ ...printOptions, paper: e.target.value as SketchPrintOptions['paper'] })}>
          {Object.keys(PRINT_PAPERS).map((paper) => <option key={paper} value={paper}>{paper}</option>)}
        </select>
      </label>
      <label className="sketch-snap-spacing">
        <span>Orientation</span>
        <select aria-label="Print orientation" value={printOptions.orientation} style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setPrintOptions({ ...printOptions, orientation: e.target.value as SketchPrintOptions['orientation'] })}>
          <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
        </select>
      </label>
      <label className="sketch-snap-spacing">
        <span>Scale</span>
        <select aria-label="Print scale" value={printOptions.scale} style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setPrintOptions({ ...printOptions, scale: e.target.value as SketchPrintOptions['scale'] })}>
          <option value="actual">Actual size (1:1)</option><option value="fit">Fit to page</option>
        </select>
      </label>
      <div className="sketch-snap-spacing">
        <button type="button" className="modal-btn modal-btn-primary"
          data-testid="sketch-export-svg"
          data-tooltip="Save this sketch as an SVG in millimetres. Print at 100% scale for a 1:1 template."
          onClick={() => { void sketcherTools.exportSketchSvg(sketchName) }}>
          Export SVG...
        </button>
        <button type="button" className="modal-btn modal-btn-primary"
          data-testid="sketch-print"
          data-tooltip="Print this sketch using the chosen paper and scale. Choose 100% / Actual size in the print dialog for a 1:1 template."
          onClick={() => sketcherTools.printSketch(sketchName, printOptions)}>
          Print...
        </button>
      </div>
        </>}
      />
    </div>
  )
}

/** WO-1862: the bezier JOINT row. Appears in MODIFY while the selection holds a bezier with at
 *  least two segments: Smooth keeps each joint's two handles collinear (the curve stays tangent
 *  across it through later handle drags), Corner lets them move independently. Both hosts render
 *  this one row; both buttons run the shared engine action. */
export function BezierJointRow({ sketch, selectedIds }: {
  sketch: Sketch | null
  selectedIds: readonly string[]
}) {
  const found = sketch ? bezierJointSummary(sketch.entities, selectedIds) : null
  if (!found) return null
  const what = `${found.joints} bezier joint${found.joints === 1 ? '' : 's'}`
  return (
    <div className="sketch-snap-settings" data-testid="sketch-bezier-joint-row">
      <span className="sketch-snap-spacing">Bezier joints</span>
      <button
        type="button"
        className={`sketch-tool-btn${found.allSmooth ? ' sketch-tool-btn-active' : ''}`}
        style={TOOL_BTN_STYLE}
        data-testid="sketch-bezier-joint-smooth"
        aria-pressed={found.allSmooth}
        data-tooltip={`Make ${what} smooth - the handles stay in line, the curve stays tangent`}
        onClick={() => sketcherTools.setBezierJointsSmooth(true)}
      >
        <span>Smooth</span>
      </button>
      <button
        type="button"
        className="sketch-tool-btn"
        style={TOOL_BTN_STYLE}
        data-testid="sketch-bezier-joint-corner"
        data-tooltip={`Make ${what} corners - each handle moves on its own`}
        onClick={() => sketcherTools.setBezierJointsSmooth(false)}
      >
        <span>Corner</span>
      </button>
    </div>
  )
}

const CONIC_RHO_TIP = 'Conic rho (0 to 1): 0.5 is a parabola, below it an ellipse arc, above it a hyperbola arc'

/** WO-1863: the conic tool's rho (CREATE, shown while the conic tool is armed). The next conic
 *  arc is drawn at it; a conic being placed reshapes at once. Out-of-range values are drawn at the
 *  nearest drawable rho (console line, no notice). Both hosts render this one row. */
export function ConicDrawRhoRow() {
  const chain = useSketcherTool((s) => s.chain)
  const [, setVersion] = useState(0)
  const rho = chain?.kind === 'conic' ? chain.rho : sketcherTools.conicDrawRhoValue()
  return (
    <div className="sketch-snap-settings" data-testid="sketch-conic-draw-rho-row">
      <label className="sketch-snap-spacing" data-tooltip={CONIC_RHO_TIP}>
        <span>Rho</span>
        <NumericInput
          step={0.05}
          value={rho}
          ariaLabel="Conic rho"
          onChange={(v) => { sketcherTools.setConicDrawRho(v); setVersion((k) => k + 1) }}
        />
      </label>
    </div>
  )
}

/** WO-1863: the rho of the selected conic arcs (MODIFY, shown while the selection holds one).
 *  Editing it reshapes each selected conic in place -- start, apex and end unmoved -- as one undo
 *  step. Both hosts render this one row. */
export function ConicRhoRow({ sketch, selectedIds }: {
  sketch: Sketch | null
  selectedIds: readonly string[]
}) {
  const found = sketch ? conicSelectionSummary(sketch.entities, selectedIds) : null
  if (!found) return null
  const what = `${found.entityIds.length} conic arc${found.entityIds.length === 1 ? '' : 's'}`
  return (
    <div className="sketch-snap-settings" data-testid="sketch-conic-rho-row">
      <label className="sketch-snap-spacing" data-tooltip={`${CONIC_RHO_TIP} - sets ${what}`}>
        <span>{found.mixed ? 'Rho (mixed)' : 'Rho'}</span>
        <NumericInput
          step={0.05}
          value={found.rho}
          ariaLabel="Selected conic rho"
          onChange={(v) => sketcherTools.setSelectedConicsRho(v)}
        />
      </label>
    </div>
  )
}

// Spline "Close loop" toggle (CREATE section, shown while either spline tool
// is armed -- through-point or control-point, WO-1861). Off = OPEN curve (default, unchanged behavior); on = the curve
// wraps back to its first through-point. Drives both the live preview and the
// committed entity's `closed` flag.
function SplineClosedRow() {
  const closed = useSketcherTool((s) => s.splineClosed)
  const setClosed = sketcherTools.setSplineClosed
  return (
    <div className="sketch-snap-settings">
      <label
        className="sketch-snap-spacing"
        data-tooltip="Close loop - wrap the spline back to its first point (default: open). Tip: with 3+ points you can also click the START point to close it."
      >
        <span>Close loop</span>
        <button
          type="button"
          className={`sketch-header-toggle${closed ? ' sketch-header-toggle-on' : ''}`}
          aria-pressed={closed}
          onClick={() => setClosed(!closed)}
        >
          {closed ? 'Closed' : 'Open'}
        </button>
      </label>
    </div>
  )
}

// Rotated (free-angle) rectangle toggle, shown while a rectangle tool is
// armed. Surfaces the otherwise hidden Tab shortcut (toggleSketchRectRotated)
// as a discoverable button + hint. Reads the live rotated flag off the rect
// chain so it stays in sync whether the user clicked here or pressed Tab.
function RectRotatedRow() {
  const rotated = useSketcherTool((s) =>
    s.chain?.kind === 'rect' ? s.chain.rotated === true : false,
  )
  const toggle = sketcherTools.toggleRectRotated
  return (
    <div className="sketch-snap-settings">
      <label
        className="sketch-snap-spacing"
        data-tooltip="Rotated rectangle - draw at any angle (3 clicks: corner, edge, width). Shortcut: Tab"
      >
        <span>Rotated (Tab)</span>
        <button
          type="button"
          className={`sketch-header-toggle${rotated ? ' sketch-header-toggle-on' : ''}`}
          aria-pressed={rotated}
          onClick={() => toggle()}
        >
          {rotated ? 'Angled' : 'Axis'}
        </button>
      </label>
    </div>
  )
}

// Linear pattern count (MODIFY section, shown while the tool is armed).
// The step vector comes from two clicks in the viewport.
function LinearPatternRow() {
  const count = useSketcherTool((s) => s.linearPatternCount)
  const setCount = sketcherTools.setLinearPatternCount
  return (
    <div className="sketch-snap-settings">
      <label
        className="sketch-snap-spacing"
        data-tooltip="Instance count (>= 2) - two clicks define the step vector"
      >
        <span>Instances</span>
        <NumericInput min={2} step={1} value={count} onChange={(v) => setCount(Math.round(v))} />
      </label>
    </div>
  )
}

// Circular pattern count + per-step angle. Changing the count resets the
// angle to 360/count (full circle); the angle input then overrides it.
function CircularPatternRow() {
  const count = useSketcherTool((s) => s.circularPatternCount)
  const angle = useSketcherTool((s) => s.circularPatternAngleDeg)
  const setCount = sketcherTools.setCircularPatternCount
  const setAngle = sketcherTools.setCircularPatternAngle
  return (
    <div className="sketch-snap-settings">
      <label
        className="sketch-snap-spacing"
        data-tooltip="Instance count (>= 2) - a click places the rotation center"
      >
        <span>Instances</span>
        <NumericInput min={2} step={1} value={count} onChange={(v) => setCount(Math.round(v))} />
      </label>
      <label
        className="sketch-snap-spacing"
        data-tooltip="Per-step angle (deg) - count changes reset this to 360/count"
      >
        <span>Step angle</span>
        <NumericInput step={5} value={angle} onChange={(v) => { if (v !== 0) setAngle(v) }} />
      </label>
    </div>
  )
}

export function SketchToolbox() {
  // folds and compact mode, remembered per viewer (useToolPaletteLayout)
  const layout = useToolPaletteLayout('cam-sketch')
  const sketchTool = useSketcherTool((s) => s.tool)
  const setSketchTool = sketcherTools.armTool
  const constructionMode = useSketcherTool((s) => s.constructionMode)
  const toggleSketchConstruction = sketcherTools.toggleConstruction
  // Measure is a utility readout, not a drawing tool: its open/closed state
  // lives in the store-free Sketcher tool state so the `I` shortcut and this
  // button read+write the SAME flag (CAM and Model sketch hosts cannot diverge).
  const measureOpen = useSketcherTool((s) => s.measureOpen)
  const toggleMeasure = sketcherTools.toggleMeasure
  const hasSelection = useCamStore((s) => s.sketchSelectedIds.length > 0)
  const deleteSketchSelection = useCamStore((s) => s.deleteSketchSelection)
  const activeSketch = useCamStore((s) => s.activeSketch)
  const selectedIds = useCamStore((s) => s.sketchSelectedIds)
  const sketchName = useCamStore((s) => s.project.geometry
    .filter((g) => !activeSketch?.ownerGeometryId || g.id === activeSketch.ownerGeometryId)
    .flatMap((g) => g.layers2d ?? []).find((l) => l.id === activeSketch?.layerId)?.name ?? 'Sketch')
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const applySketchConstraint = useCamStore((s) => s.applySketchConstraint)
  // A live placed-text edit (double-click) shows the text inputs even though
  // the select tool — not the text tool — is armed.
  const editingText = useCamStore((s) => s.sketchTextEditId != null)
  // SKC-BLOCKS Stage 4: a live block edit-in-place session -> the Finish/
  // Cancel banner (BlockEditBanner), the one persistent way back out.
  const blockEditId = useCamStore((s) => s.sketchBlockEditId)
  // SKC-BLOCKS Stage 2: exactly one block selected -> typed scale/rotation row.
  const selectedBlock: SketchBlockEntity | null =
    activeSketch && selectedIds.length === 1
      ? (() => {
          const e = activeSketch.entities.find((x) => x.id === selectedIds[0])
          return e && e.kind === 'block' ? e : null
        })()
      : null

  const toggleSection = layout.toggleSection
  // compact hides the names: every hover hint then starts with the tool's name
  const hint = (label: string, text: string) => (layout.compact && !text.startsWith(label) ? `${label}: ${text}` : text)

  return (
    <>
    <ReferenceImage2dControls />
    <div className={layout.compact ? 'panel properties-panel sketch-toolbox is-compact' : 'panel properties-panel sketch-toolbox'}>
      <div className="panel-header">
        <span className="panel-title">
          <PenTool size={13} />
          Sketch
        </span>
        <SketchDefinitionChip />
        <button
          type="button"
          className="rail-compact-btn"
          data-testid="cam-sketch-compact"
          aria-pressed={layout.compact}
          aria-label={layout.compact ? 'Show tool names' : 'Compact tools (icons only)'}
          data-tooltip={layout.compact ? 'Show the tool names under their icons' : 'Compact: icons only, packed tight (hover a tool for its name)'}
          onClick={layout.toggleCompact}
        >
          {layout.compact ? <Rows3 size={14} /> : <LayoutGrid size={14} />}
        </button>
      </div>

      <div className="panel-body">
        <div className="sketch-finish-sticky">
          <FinishSketchButton />
        </div>
        <div className="sketch-toolbox-scroll-content" style={{ position: 'relative' }}>
          <SolveBanner />
          {blockEditId != null && (
            <BlockEditBanner
              onFinish={() => useCamStore.getState().finishSketchBlockEdit()}
              onCancel={() => useCamStore.getState().cancelSketchBlockEdit()}
            />
          )}
          <BlockPropertiesRow
            block={selectedBlock}
            onSetScale={(v) => selectedBlock && useCamStore.getState().setSketchBlockScale(selectedBlock.id, v)}
            onSetRotationDeg={(v) => selectedBlock && useCamStore.getState().setSketchBlockRotation(selectedBlock.id, v)}
          />

          {SECTIONS.map((section) => {
          const isCollapsed = layout.isCollapsed(section.id)
          return (
            <Fragment key={section.id}>
            <div className="tree-section">
              <div
                className="tree-section-header tree-section-header-btn"
                onClick={() => toggleSection(section.id)}
              >
                <span>{section.title}</span>
                {/* "Show constraints" glyph toggle relocated into the
                    CONSTRAINTS header (density pass) - reclaims the old top row. */}
                {section.id === 'constraints' && <ConstraintGlyphToggle />}
                <span className="tree-section-header-chevron">
                  {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                </span>
              </div>

              {!isCollapsed && (
                <>
                <div className="sketch-tool-grid">
                  {section.tools.map(({ id, label, icon: ToolIcon, stage }) => {
                    // Construction is a MODE button, not an armed tool:
                    // with entities selected it flips their construction
                    // flag; otherwise it toggles draw-as-construction for
                    // newly drawn entities ('q' does the same).
                    if (id === 'construction') {
                      return (
                        <button
                          key={id}
                          className={`sketch-tool-btn${constructionMode ? ' sketch-tool-btn-active' : ''}`}
                          style={TOOL_BTN_STYLE}
                          onClick={toggleSketchConstruction}
                          data-tooltip={'Construction (q): toggle selected entities, or draw new entities as construction'}
                        >
                          <ToolIcon size={15} />
                          <span>{label}</span>
                        </button>
                      )
                    }
                    // Delete is an ACTION button (pulled forward from
                    // Stage 6 by user request): removes the selection,
                    // cascading referencing constraints/dimensions.
                    // Enabled only while something is selected.
                    if (id === 'delete') {
                      return (
                        <button
                          key={id}
                          className="sketch-tool-btn"
                          style={TOOL_BTN_STYLE}
                          disabled={!hasSelection}
                          onClick={deleteSketchSelection}
                          data-tooltip={hasSelection
                            ? 'Delete selected (Del / Backspace)'
                            : 'Delete - select entities first'}
                        >
                          <ToolIcon size={15} />
                          <span>{label}</span>
                        </button>
                      )
                    }

                    // Driving <-> reference toggle: ACTION button on the
                    // selected dimension(s). reference -> driving takes
                    // the conflict-reject path (auto-revert + named set).
                    if (id === 'toggle-reference') {
                      const dimIds = activeSketch
                        ? selectedIds.filter((sid) =>
                            activeSketch.dimensions.some((d) => d.id === sid))
                        : []
                      return (
                        <button
                          key={id}
                          className="sketch-tool-btn"
                          style={TOOL_BTN_STYLE}
                          disabled={dimIds.length === 0}
                          onClick={() => {
                            const toggle =
                              useCamStore.getState().toggleDimensionDriving
                            dimIds.forEach((dimId) => toggle(dimId))
                          }}
                          data-tooltip={dimIds.length > 0
                            ? hint(label, 'Toggle driving <-> reference on the selected dimension(s)')
                            : 'Reference - select a dimension label first'}
                        >
                          <ToolIcon size={15} />
                          <span>{label}</span>
                        </button>
                      )
                    }
                    if (id === 'measure') {
                      // Key hint derived from the SAME utility shortcut map the
                      // key handler dispatches on (SHORTCUT_KEY_BY_UTILITY), so
                      // the tooltip can never drift from the `I` shortcut.
                      const measureKey = SHORTCUT_KEY_BY_UTILITY['measure']
                      const keySuffix = measureKey ? ` (${measureKey})` : ''
                      return (
                        <button
                          key={id}
                          data-testid="cam-sketch-measure"
                          className={`sketch-tool-btn${measureOpen ? ' sketch-tool-btn-active' : ''}`}
                          style={TOOL_BTN_STYLE}
                          aria-pressed={measureOpen}
                          onClick={() => toggleMeasure()}
                          data-tooltip={
                            measureOpen
                              ? `Measure readout open - click or press ${measureKey ?? 'it'} to close`
                              : hint(label, `Inspect selected geometry without creating a dimension${keySuffix}`)
                          }
                        >
                          <ToolIcon size={15} />
                          <span>{label}</span>
                        </button>
                      )
                    }
                    // CONSTRAINTS are ACTION buttons: apply the kind to
                    // the current selection. Enabled iff the selection is
                    // a valid operand set; the disabled tooltip names what
                    // the constraint needs. A conflicting application is
                    // auto-rejected by the store with a named notice.
                    const constraintKind = CONSTRAINT_KIND_BY_BUTTON[id]
                    if (constraintKind) {
                      const plan = activeSketch
                        ? planConstraintForSelection(activeSketch, selectedIds, constraintKind)
                        : { ok: false as const, reason: 'no active sketch' }
                      return (
                        <button
                          key={id}
                          className="sketch-tool-btn"
                          style={TOOL_BTN_STYLE}
                          disabled={!plan.ok}
                          onClick={() => applySketchConstraint(constraintKind)}
                          data-tooltip={plan.ok
                            ? `${label}: apply to selection`
                            : `${label} - ${plan.reason}`}
                        >
                          <ToolIcon size={15} />
                          <span>{label}</span>
                        </button>
                      )
                    }
                    // CREATE buttons arm the tool state machine; armed
                    // tools stay armed until Esc (or clicking the button
                    // again). Only tools with live behavior are enabled.
                    if (ARMABLE_TOOLS.has(id as SketchToolId)) {
                      const armed = sketchTool === id
                      // Single-key shortcut hint (Stage 6): derived from
                      // the SAME map the key handler dispatches on.
                      const key = SHORTCUT_KEY_BY_TOOL[id as SketchToolId]
                      const idle = key ? `${label} (${key})` : label
                      return (
                        <button
                          key={id}
                          className={`sketch-tool-btn${armed ? ' sketch-tool-btn-active' : ''}`}
                          style={TOOL_BTN_STYLE}
                          onClick={() => setSketchTool(armed ? 'select' : (id as SketchToolId))}
                          data-tooltip={armed ? `${label} (armed - Esc to disarm)` : idle}
                        >
                          <ToolIcon size={15} />
                          <span>{label}</span>
                        </button>
                      )
                    }
                    return (
                      <button
                        key={id}
                        className="sketch-tool-btn"
                        style={TOOL_BTN_STYLE}
                        disabled
                        data-tooltip={`${label} - coming in Stage ${stage}`}
                      >
                        <ToolIcon size={15} />
                        <span>{label}</span>
                      </button>
                    )
                  })}
                </div>
                {section.id === 'create' && <ImportIntoSketchRow sketchName={sketchName} referenceImageImport />}
                {section.id === 'create' && sketchTool === 'gear' && <GearRow />}
                {section.id === 'create' && sketchTool === 'polygon' && <PolygonSidesRow />}
                {section.id === 'create' && sketchTool === 'conic' && <ConicDrawRhoRow />}
                {section.id === 'create' && (sketchTool === 'text' || editingText) && <TextInputRow />}
                {section.id === 'create' &&
                  (sketchTool === 'spline' || sketchTool === 'spline-control' || sketchTool === 'bezier') &&
                  <SplineClosedRow />}
                {section.id === 'create' &&
                  (sketchTool === 'rect-corner' || sketchTool === 'rect-center') && (
                    <RectRotatedRow />
                  )}
                {section.id === 'modify' && (
                  <BezierJointRow sketch={activeSketch} selectedIds={selectedIds} />
                )}
                {section.id === 'modify' && (
                  <ConicRhoRow sketch={activeSketch} selectedIds={selectedIds} />
                )}
                {section.id === 'modify' && sketchTool === 'fillet' && <FilletRadiusRow />}
                {section.id === 'modify' && sketchTool === 'chamfer' && <ChamferSetbackRow />}
                {section.id === 'modify' && sketchTool === 'offset' && <OffsetDistanceRow />}
                {section.id === 'modify' && sketchTool === 'pattern-linear' && <LinearPatternRow />}
                {section.id === 'modify' && sketchTool === 'pattern-circular' && <CircularPatternRow />}
                {section.id === 'utility' && measureOpen && (
                  <SketchMeasureReadout
                    sketch={activeSketch}
                    selectedIds={selectedIds}
                    displayUnits={displayUnits}
                  />
                )}
                {section.id === 'utility' && <SnapSettings />}
                </>
              )}
            </div>
            {/* BROWSER section (Stage 4): all constraints + dimensions of
                the active sketch. Rendered after the last section (UTILITY)
                now that DIMENSIONS was folded into MODIFY (density pass). */}
            {section.id === 'utility' && <ConstraintBrowser />}
            </Fragment>
          )
          })}
        </div>
      </div>
    </div>
    </>
  )
}
