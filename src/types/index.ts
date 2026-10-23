// ============================================================
// LienCAM Core Types
// ============================================================

// CAM-1: the ModelReference body lives in src/lib/cam/types.ts (worker-protocol
// types), re-exported here so Operation can carry it. `import type` is fully
// erased at compile, so the lib/cam/types.ts <- types/index.ts cycle is
// type-only and never a runtime import cycle.
import type { ReferenceImage2d } from '../referenceImage/referenceImage'
import type { ModelReference } from '../lib/cam/types'
import type { VfdDefinition } from '../lib/machine/vfd'
// WO-1676: same type-only cycle as the ModelReference one above - erased at
// compile, so importing the tool table's and the action layer's types back
// here is never a runtime cycle.
import type { MachineToolTable, ProbePadChoice, ZProbeConfig } from '../lib/machine/toolTable'
import type { ActionColor, BuiltinActionId } from '../lib/machine/machineActions'
import { gcodeTableDialectOf, gcodeWordEntry, gcodeWordTable, gcodeWordTableWithOutputs } from '../lib/gcode/wordTable'
export type { ModelReference, ModelReferenceRole } from '../lib/cam/types'

// --- Geometry & Math ---
export interface Vec3 { x: number; y: number; z: number }
export interface Vec2 { x: number; y: number }
export interface BoundingBox { min: Vec3; max: Vec3; size: Vec3; center: Vec3 }

// --- Tool Types ---
export type ToolType =
  | 'flat_end_mill'
  | 'ball_end_mill'
  | 'bull_nose'
  | 'v_bit'
  | 'drill'
  | 'spot_drill'
  | 'thread_mill'
  | 'face_mill'
  | 'tap'
  | 'boring_bar'
  | 'chamfer_mill'
  | 'tapered_endmill'
  | 'countersink'
  | 'center_drill'
  | 'reamer'
  | 'dovetail_mill'
  | 'slitting_saw'
  | 'lollipop_mill'
  | 'probe'

export type ToolMaterial = 'hss' | 'carbide' | 'cobalt' | 'ceramic' | 'diamond_coated'
export type ToolCoating = 'none' | 'tin' | 'ticn' | 'tialn' | 'dlc' | 'zrn'
export type ToolCutHand = 'right' | 'left'
export type ProbeInput = 1 | 2
export type ProbeContact = 'normally_open' | 'normally_closed'

export interface Tool {
  id: string
  name: string
  type: ToolType
  diameter: number          // mm
  fluteLength: number       // mm
  shankDiameter: number     // mm
  overallLength: number     // mm
  shoulderLength?: number   // mm — non-fluted portion above flutes
  lengthBelowHolder?: number // mm — total stickout from holder
  numberOfFlutes: number
  cornerRadius?: number     // mm — for bull nose
  angleFromAxisDeg?: number  // degrees from tool axis (half-angle); pointed/tapered tools. Default 59 (= 118 included).
  tipDiameter?: number      // mm — tip flat diameter (cone/frustum/drillpoint families). 0 or undefined = sharp point.
  neckDiameter?: number     // mm — undercut neck diameter (lollipop/disc/dovetail/thread_mill). Must be < diameter.
  // ── Thread-mill geometry (additive; backward-compatible) ───────────────────
  // When threadPitch is undefined/<=0 a thread_mill draws as a plain cylinder
  // (legacy shape) so existing tools are unaffected with no migration needed.
  threadFormAngleDeg?: number // included thread V angle (60 metric/UN, 55 Whitworth); default treated as 60
  threadTeethCount?: number   // thread teeth stacked along the axis: 1 = single-point, N = full-form. Default 1.
  threadPitch?: number        // ground pitch (mm) the teeth are spaced/sized at; undefined = NO teeth drawn (plain cylinder)
  neckTransitionAngleDeg?: number // angle (from the tool AXIS, per ADR-0029) of the neck->shank transition cone; 90 = sharp radial step, smaller = gentler/taller taper. Thread mills only.
  // -- Probe (WO-2154; type 'probe' only) ------------------------------------
  // `diameter` is the ball (tip) diameter. Absent fields read as their defaults
  // (probe input 1, normally open, no calibration) - see lib/tool/probeTool.
  probeInput?: ProbeInput             // which controller probe input the probe is wired to
  probeContact?: ProbeContact         // normally open or normally closed
  probeEffectiveRadiusX?: number      // mm - calibrated effective radius in X; absent = ball radius
  probeEffectiveRadiusY?: number      // mm - calibrated effective radius in Y; absent = ball radius
  material: ToolMaterial
  coating: ToolCoating
  vendor?: string
  productId?: string
  toolNumber?: number
  /** Optional only for legacy serialized tools; absent/invalid data normalizes to right. */
  cutHand?: ToolCutHand
  /** Set by an importer when the source declared a cutter type this build didn't
   *  recognize (see lib/tool/toolValidation.resolveToolType). `type` above still
   *  holds a safe fallback so the tool is fully usable; this preserves what was
   *  actually declared instead of silently discarding it. */
  declaredTypeRaw?: string
  holderId?: string         // references a ToolHolder.id (optional)
  libraryId?: string        // references a ToolLibrary.id (which named library this tool belongs to)
  notes: string
  // Feeds & speeds per material (key = material name, 'default' for generic)
  feedsAndSpeeds: Record<string, FeedsAndSpeeds>
}

// --- Tool Holder & Library ---
// A holder profile is a stack of segments from the bottom (tool side) upward.
export interface HolderSegment {
  height: number          // mm
  lowerDiameter: number   // mm — diameter at the bottom of this segment
  upperDiameter: number   // mm — diameter at the top; equal dias = cylinder, unequal = cone
}

export interface ToolHolder {
  id: string
  name: string
  vendor?: string
  productId?: string
  description?: string
  gaugeLength?: number    // mm — reference gauge length
  segments: HolderSegment[]  // stacked from holder bottom (tool side) upward
}

// A named tool library that tools may belong to (Tool.libraryId).
export interface ToolLibrary {
  id: string
  name: string
}

export interface FeedsAndSpeeds {
  rpm: number
  feedRate: number          // mm/min
  plungeRate: number        // mm/min
  depthOfCut: number        // mm (axial)
  stepover: number          // mm (radial)
  rampFeedrate?: number     // mm/min
  leadInFeedrate?: number   // mm/min
  leadOutFeedrate?: number  // mm/min
  fastTraverseFeedrate?: number // mm/min — non-cutting reposition at depth through cleared stock
  finishFeedrate?: number   // mm/min — dedicated wall-finishing pass; defaults to the cutting feed
  rampAngle?: number        // degrees
  coolant?: 'none' | 'flood' | 'mist' | 'air' | 'vacuum'
  surfaceSpeed?: number     // m/min
  feedPerTooth?: number     // mm/tooth
}

// --- Machine Configuration ---
export type MachineType = 'gantry_router' | 'moving_table' | 'vertical_mill' | 'custom'
/** WHAT THIS MACHINE CUTS WITH (WO-1686, ADR-0049's CAM/control lenses on one
 *  record): a few kind filters decide which fields and use cases apply
 *  (Operator, COHESION-STANDARD s18). Absent means `'router'` - every machine that
 *  exists before this field does, and ADR-0040 forbids a migration to backfill
 *  it. Read only through `machineKind`, never this property directly. */
export type MachineKind = 'router' | 'plasma' | 'laser' | 'knife'
export type ToolChangerType = 'manual' | 'atc' | 'none'
// Controller == the active postprocessor dialect. Values are the built-in
// dialect ids (single source of truth: BUILT_IN_DIALECTS in src/lib/post).
// Legacy files can still carry an unknown runtime string, but dispatch must
// pass through resolveDeclaredController and refuse it rather than widening
// this declaration or silently choosing a controller.
export type ControllerType = 'uccnc' | 'grbl' | 'grblhal' | 'linuxcnc' | 'generic'

/** GRBL-family firmware assigns machine zero at the homing switch. It has no
 *  separate per-axis home coordinate for either LienCAM lens to choose. */
export function controllerZeroIsHomeSwitch(controller: ControllerType): boolean {
  return controller === 'grbl' || controller === 'grblhal'
}

export interface AxisFeedLimits {
  maxCutting: number  // mm/min
  maxRapid: number    // mm/min
}

/** The two physical choices that define an axis's machine-coordinate range:
 *  which end carries the home switch and which end is machine zero. The
 *  optional homePositionMm is retained for older imported profiles that
 *  stored the resulting coordinate directly. */
export interface AxisHomeConvention {
  homesToward: 'max' | 'min'
  machineZeroAt?: 'max' | 'min'
  homePositionMm?: number
}

export type MachineHomeConvention = {
  x: AxisHomeConvention
  y: AxisHomeConvention
  z: AxisHomeConvention
}

/** WO-1701 attempt 2: the key LienCAM records in `ControllerDefinition.stated`
 *  when a person sets one part of an axis's homing in the Machine area - the
 *  same pattern as `axisSoftLimitStatementKey` in resolvedMachineMotion.ts,
 *  under the machine's own controller. The UCCNC importer states this key too,
 *  while retaining `uccncAxisHomingKey` as the raw import/export alias. */
export function axisHomingStatementKey(axis: AxisName, part: 'direction' | 'homingValue'): string {
  return `liencam.homing.${axis}.${part}`
}

/** The UCCNC profile key carrying one part of an axis's homing. */
export function uccncAxisHomingKey(axis: AxisName, part: 'direction' | 'homingValue'): string {
  return `axessettingscontrol${axis}.${part === 'direction' ? 'Homedirectionpositive' : 'Homingvalue'}`
}

/** DID ANYONE STATE THIS PART OF THE AXIS'S HOMING? `homing.perAxis` is always
 *  populated on a definition built from defaults (`createDefaultControllerDefinition`),
 *  so the block's presence says nothing - its provenance does, exactly as for
 *  the soft limits (`axisSoftLimitsAreStated`). True when a person set it in
 *  the Machine area, or when a UCCNC profile the definition was read from
 *  carried the key. */
export function axisHomingIsStated(
  machine: Pick<MachineConfig, 'controller' | 'controllerDefinition'>,
  axis: AxisName,
  part: 'direction' | 'homingValue' = 'direction',
): boolean {
  // WO-1755: a GRBL-family homing value is not a controller fact. Old records
  // can carry the former app-authored key, but it must not regain authority.
  if (part === 'homingValue' && controllerZeroIsHomeSwitch(machine.controller)) return false
  const definition = machine.controllerDefinition
  if (!definition?.homing?.perAxis?.[axis]) return false
  return definitionStatesKey(definition, machine.controller, axisHomingStatementKey(axis, part))
    || (machine.controller === 'uccnc'
      && definitionStatesKey(definition, 'uccnc', uccncAxisHomingKey(axis, part)))
}

/** This definition with `parts` of one axis's homing recorded as stated by a
 *  person (the Machine area's home-at / homing value). The one write path for
 *  that provenance, so the reader above and the editor agree on the key. */
export function withAxisHomingStated(
  definition: ControllerDefinition,
  controller: ControllerType,
  axis: AxisName,
  parts: readonly ('direction' | 'homingValue')[],
): ControllerDefinition {
  let next = definition
  let stated = definition.stated ?? []
  let statedParts = parts
  if (controllerZeroIsHomeSwitch(controller)) {
    // The Machine area and Machine Library both write through this seam. A
    // typed or persisted GRBL home coordinate is therefore reduced to the
    // only value the board can establish, and is not recorded as a choice.
    const homing = definition.homing.perAxis[axis]
    if (homing && homing.homingValue !== 0) {
      next = {
        ...definition,
        homing: {
          ...definition.homing,
          perAxis: { ...definition.homing.perAxis, [axis]: { ...homing, homingValue: 0 } },
        },
      }
    }
    const obsoleteKey = axisHomingStatementKey(axis, 'homingValue').toLowerCase()
    const withoutObsolete = stated.filter((entry) => !(
      entry.controller === controller && entry.key.toLowerCase() === obsoleteKey
    ))
    if (withoutObsolete.length !== stated.length) stated = withoutObsolete
    statedParts = parts.filter((part) => part !== 'homingValue')
  }
  for (const part of statedParts) {
    const key = axisHomingStatementKey(axis, part)
    if (!definitionStatesKey({ settings: next.settings, stated }, controller, key)) {
      stated = [...stated, { controller, key }]
    }
  }
  return next === definition && stated === (definition.stated ?? []) ? definition : { ...next, stated }
}

/**
 * WO-1731: the key LienCAM records in `ControllerDefinition.stated` when a
 * person states one axis's home back-off - the same pattern as
 * `axisHomingStatementKey`, under the machine's OWN controller. The UCCNC
 * importer states this key too and retains `uccncAxisHomeBackOffKey` as the
 * raw import/export alias.
 */
export function axisHomeBackOffStatementKey(axis: AxisName): string {
  return `liencam.homing.${axis}.backOff`
}

/**
 * WO-1731: the key LienCAM records in `ControllerDefinition.stated` when a
 * machine's own record ADDRESSES one axis's home input - wired to a pin, or
 * stated as the input the machine has none of. A switchless machine states it
 * on every axis it owns with the input unassigned, and
 * `machineHasNoHomeSwitches` asks exactly that. The UCCNC importer's
 * `Homeportnumber`/`Homepinnumber` pair is the import alias for the same
 * fact.
 */
export function axisHomeInputStatementKey(axis: AxisName): string {
  return `liencam.homing.${axis}.homeInput`
}

/** This definition with one axis's home back-off recorded as stated by the
 *  machine, under its own controller - the write path that pairs with
 *  `homeBackOffProvenance`, exactly as `withAxisHomingStated` pairs with
 *  `axisHomingIsStated` (WO-1731). */
export function withAxisHomeBackOffStated(
  definition: ControllerDefinition,
  controller: ControllerType,
  axis: AxisName,
): ControllerDefinition {
  const stated = definition.stated ?? []
  const key = axisHomeBackOffStatementKey(axis)
  if (definitionStatesKey(definition, controller, key)) return definition
  return { ...definition, stated: [...stated, { controller, key }] }
}

/** This definition with one axis's home input recorded as addressed by the
 *  machine, under its own controller - the write path that pairs with the
 *  app-owned question inside `machineHasNoHomeSwitches` (WO-1731). */
export function withAxisHomeInputStated(
  definition: ControllerDefinition,
  controller: ControllerType,
  axis: AxisName,
): ControllerDefinition {
  const stated = definition.stated ?? []
  const key = axisHomeInputStatementKey(axis)
  if (definitionStatesKey(definition, controller, key)) return definition
  return { ...definition, stated: [...stated, { controller, key }] }
}

/** WO-1701 (ADR-0049): the home end ONE MACHINE RECORD states, per axis.
 *
 *  An axis whose homing the definition STATES (`axisHomingIsStated` - a UCCNC
 *  import's `Homedirectionpositive`, or a home-at set in the Machine area)
 *  takes its home end from `homing.perAxis`: the direction says which end the
 *  switch is at, and a stated `homingValue` (the coordinate set at the switch)
 *  says where machine zero is. The stored `homeConvention` is not consulted for
 *  that axis.
 *
 *  An axis whose homing is NOT stated keeps the stored `homeConvention` - the
 *  CAM lens's own statement. A definition built from defaults carries a
 *  placeholder homing block on every axis (`createDefaultAxisHomingDefinition`),
 *  and reading a placeholder as the home end would silently move where CAM
 *  thinks machine zero is: a machine fact nobody stated. With no definition at
 *  all the stored `homeConvention` is returned as-is.
 *
 *  GRBL and grblHAL are controller-shaped exceptions: their firmware makes
 *  the homing switch machine zero. Any older stored zero end or homing value
 *  is ignored, whether or not a definition has stated the home direction.
 *
 *  Read home ends through this, never through `machine.homeConvention` directly. */
/** WO-2712 (Operator 10-09): the shipped GRBL Sample router's home end while its
 *  record stores none - GRBL's default ($23 = 0): every axis homes to its max end,
 *  which is machine zero. A default, never stored: switching the record to
 *  another controller drops it, and any convention the operator saves wins. */
const SAMPLE_GRBL_HOME_CONVENTION: MachineHomeConvention = {
  x: { homesToward: 'max', machineZeroAt: 'max' },
  y: { homesToward: 'max', machineZeroAt: 'max' },
  z: { homesToward: 'max', machineZeroAt: 'max' },
}

function storedOrSampleHomeConvention(
  machine: Pick<MachineConfig, 'homeConvention' | 'controller'> & { id?: string },
): MachineHomeConvention | undefined {
  if (machine.homeConvention) return machine.homeConvention
  return machine.id === 'default-machine' && machine.controller === 'grbl'
    ? SAMPLE_GRBL_HOME_CONVENTION
    : undefined
}

export function machineHomeConvention(
  machine: Pick<MachineConfig, 'homeConvention' | 'controllerDefinition' | 'travel' | 'controller'> & { id?: string },
): MachineHomeConvention | undefined {
  const storedConvention = storedOrSampleHomeConvention(machine)
  const zeroIsHomeSwitch = controllerZeroIsHomeSwitch(machine.controller)
  const atHomeSwitch = (convention: AxisHomeConvention | undefined): AxisHomeConvention | undefined =>
    zeroIsHomeSwitch && convention
      ? { homesToward: convention.homesToward, machineZeroAt: convention.homesToward }
      : convention
  const perAxis = machine.controllerDefinition?.homing?.perAxis
  if (!perAxis) {
    const stored = storedConvention
    if (!stored || !zeroIsHomeSwitch) return stored
    return { x: atHomeSwitch(stored.x)!, y: atHomeSwitch(stored.y)!, z: atHomeSwitch(stored.z)! }
  }
  const axis = (key: 'x' | 'y' | 'z'): AxisHomeConvention | undefined => {
    const name = key.toUpperCase() as 'X' | 'Y' | 'Z'
    const homing = perAxis[name]
    const stored = storedConvention?.[key]
    if (!homing || !axisHomingIsStated(machine, name, 'direction')) return atHomeSwitch(stored)
    const homesToward: 'max' | 'min' = homing.direction === 'positive' ? 'max' : 'min'
    if (zeroIsHomeSwitch) return { homesToward, machineZeroAt: homesToward }
    if (!axisHomingIsStated(machine, name, 'homingValue')) {
      // Which end the switch is at is stated; where zero sits is not.
      // Every controller whose firmware does not own zero keeps the CAM
      // lens's zero statement if it made one, and invents none.
      return stored?.machineZeroAt !== undefined
        ? { homesToward, machineZeroAt: stored.machineZeroAt }
        : stored?.homePositionMm !== undefined
          ? { homesToward, homePositionMm: stored.homePositionMm }
          : { homesToward }
    }
    const value = homing.homingValue
    // WO-1698: travel has one reader.
    const travel = machineTravel(machine)[key]
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6
    if (!Number.isFinite(value) || near(value, 0)) return { homesToward, machineZeroAt: homesToward }
    const otherEnd = homesToward === 'max' ? travel : -travel
    if (Number.isFinite(travel) && travel > 0 && near(value, otherEnd)) {
      return { homesToward, machineZeroAt: homesToward === 'max' ? 'min' : 'max' }
    }
    // A switch coordinate that is neither end (an imported Homingvalue on a
    // machine whose stated travel differs) is kept as the coordinate itself.
    return { homesToward, homePositionMm: value }
  }
  const x = axis('x')
  const y = axis('y')
  const z = axis('z')
  return x && y && z ? { x, y, z } : undefined
}

/** True when this axis's home end comes from the definition's stated homing
 *  (so the Machine area is where it is edited) rather than the stored
 *  `homeConvention`. */
export function homeEndFromDefinition(
  machine: Pick<MachineConfig, 'controller' | 'controllerDefinition'>,
  axis: 'x' | 'y' | 'z',
): boolean {
  return axisHomingIsStated(machine, axis.toUpperCase() as AxisName, 'direction')
}

/** Machine-level defaults for touch-probe motion. Clear positioning, the
 *  coarse contact search, and the final measurement are intentionally three
 *  different speeds. Optional on MachineConfig for imported/legacy profiles. */
export interface MachineProbeDefaults {
  positioningFeed: number
  fastFeed: number
  slowFeed: number
  retract: number
  maxTravel: number
  surfaceClearance: number
  overtravel: number
  crossOverLift: number
  padThickness: number
  /** Fixed tool setter location in machine coordinates. Individual axes stay
   *  optional while a person is entering the fact; motion readers require a
   *  complete finite XYZ record and never invent a missing coordinate. */
  toolSetter?: Partial<Vec3>
}

// --- Probe calibration (WO-1817): tip diameter and runout as stated facts --

/** Where a calibration value came from: typed in by the operator (a ring
 *  gauge's printed diameter, a stylus datasheet), or produced by running the
 *  calibration routine against a known bore/boss/pad. Neither is a default -
 *  both are recorded facts with a date. */
export type ProbeCalibrationProvenance = 'stated' | 'measured'

/** One calibration value: what it is, where it came from, and when. `date`
 *  is an ISO 8601 date/time string so "last measured" can be shown and aged
 *  without a second stored field. */
export interface ProbeCalibrationFact {
  valueMm: number
  provenance: ProbeCalibrationProvenance
  date: string
}

/** The installed probe's own facts. Each is independently optional: a probe
 *  can have a stated tip diameter and no runout measurement yet, or the
 *  reverse. Neither field existing at all is UNCALIBRATED, not zero. */
export interface ProbeCalibration {
  tipDiameter?: ProbeCalibrationFact
  runout?: ProbeCalibrationFact
}

// --- Controller definition (WO-912): the machine a person BUILT ---------
//
// The editable description of a homebuilt CNC: axes, pins, homing and the
// machine-wide inputs. Every value here is something a person can read off a
// wiring diagram or a motor spec - never a derived value.
//
// STORAGE: these are NEW FIELDS ON MachineConfig. There is no separate
// document, no file of its own and no schemaVersion of its own. LienCAM
// already persists an editable machine library (store.machineLibrary, carried
// in the project payload under PERSISTED_USER_DATA_REGISTRY.activeProject);
// this rides on it. A second persistence path is a misreading of the design
// (Operator, 2026-08-23).

/** The six axes the UC100 API and the bridge both index in this order
 *  (pendant/uccnc-bridge/Machine.cs:146 `axisNames`). */
export type AxisName = 'X' | 'Y' | 'Z' | 'A' | 'B' | 'C'

export const AXIS_NAMES: readonly AxisName[] = ['X', 'Y', 'Z', 'A', 'B', 'C']

/** App-owned names for the axis facts that UCCNC calls CurrentHiLowPin,
 * RotaryAxis and RotaryRollover. The values still live once, in the typed
 * ControllerDefinition.settings row that an importer/exporter owns; appKey is
 * the controller-independent question the bridge reads from that row.
 *
 * Keeping the pin's three physical parts separate preserves all three states:
 * absent, explicitly unassigned (port 0 / pin 0), and assigned. A boolean key
 * likewise preserves absent separately from an explicit false. */
export type AxisDriveSettingPart =
  | 'currentHiLow.port'
  | 'currentHiLow.pin'
  | 'currentHiLow.negate'
  | 'rotary'
  | 'rotaryRollover'

export function axisDriveSettingKey(axis: AxisName, part: AxisDriveSettingPart): string {
  return `liencam.axes.${axis}.${part}`
}

/** A pin, as the PHYSICAL CONNECTOR LOCATION a person reads off a wiring
 *  diagram: which port, which pin on it, and whether the signal is inverted.
 *
 *  A PIN IS NEVER STORED AS A `UCpin`, AND `src/` NEVER COMPUTES ONE.
 *  The UC100 API wants a different number, and the mapping from (port, pin)
 *  to it is a scrambled per-board-type lookup table with no arithmetic rule
 *  (port 1 output pin 15 is one number, pin 9 another, with no pattern). The
 *  ONE copy of that table lives in the bridge, `AxbbPinDef` in
 *  pendant/uccnc-bridge/Machine.cs:45-98, and it is applied at the moment the
 *  board is called. A second copy in TypeScript would diverge from it
 *  INVISIBLY: the board accepts, plans and counts every move written to the
 *  wrong pin and emits nothing, which is exactly how a whole first hardware
 *  session ran silent. A pin number is carried here, never computed.
 *  Guarded by src/tests/machine/machineDefinition.wo912.test.ts. */
export interface PinRef {
  port: number
  pin: number
  /** Whether the signal is inverted - and `null` when NOBODY HAS TOLD US.
   *
   *  `false` is a claim: "this pin is not inverted". A record that has never
   *  been given a polarity may not make that claim. An unassigned pin has no
   *  polarity to have, and a profile that simply omits a negate key has not
   *  stated one, so both read `null` and the UI shows them as unknown rather
   *  than as an unchecked box. Inverting an e-stop is how a fabricated `false`
   *  gets someone hurt. The bridge already draws this distinction for the
   *  same reason: an unread fault signal stays `null` there rather than
   *  `false` - "which is what keeps `asserted` null rather than false"
   *  (pendant/uccnc-bridge/Machine.cs:1913-1919).
   *
   *  `null` crosses the wire AS `null`: the app translates no pin (WO-928), so
   *  the bridge - which already defaults an absent key itself, `Json.Bool(p,
   *  "negate", false)` at Machine.cs:1140 and `B(sec, ..., false)` at
   *  Machine.cs:771 - remains the one place the default is applied. */
  negate: boolean | null
}

/** "Nothing is wired here yet." Port 0 / pin 0 is also what the bridge's own
 *  translation returns for an unassigned pin, and what the UC100 API itself
 *  treats as unassigned, so the two agree without a table. */
export const UNASSIGNED_PIN: PinRef = { port: 0, pin: 0, negate: null }

export const isPinAssigned = (p: PinRef): boolean => p.port > 0 && p.pin > 0

export interface AxisDefinition {
  axis: AxisName
  enabled: boolean
  stepsPerUnit: number
  /** units/MIN - the number a person types, and the number a motor spec is
   *  written in. The bridge divides by 60 for the API; src/ does not. */
  maxVelocity: number
  /** units/sec^2, as the profile and the API both hold it. */
  acceleration: number
  softLimitMin: number
  softLimitMax: number
  /** The gantry pairing, e.g. Y slaved by A. `null` means NO SLAVE, and that
   *  is the only safe default: a slaving nobody asked for, or a slaving the
   *  board is not actually holding when a homing cycle starts, drives one
   *  side of a gantry into its switch alone and racks it
   *  (Machine.cs:296-303). Never invent one. */
  slaveAxis: AxisName | null
  stepPin: PinRef
  dirPin: PinRef
  homePin: PinRef
  limitMinusPin: PinRef
  limitPlusPin: PinRef
  enablePin: PinRef
  enableDelayMs: number
  backlash: { enabled: boolean; distance: number }
}

export interface AxisHomingDefinition {
  direction: 'negative' | 'positive'
  /** units/MIN - the search toward the switch. */
  fastSpeed: number
  /** units/MIN - the slow re-approach. */
  slowSpeed: number
  /** units. How far the axis reverses OFF the switch when the cycle ends.
   *  Worth a non-zero default: an axis parked on its own switch leaves the
   *  home input still made, so "did the cycle finish where it should" has no
   *  observable answer (Operator, at the machine 2026-08-21, on a profile whose
   *  home back-off was 0 - "back it off in our settings so you can tell it
   *  was done"). */
  backOff: number
  /** The machine coordinate set at the switch. */
  homingValue: number
  autoZero: boolean
}

/**
 * One exact value retained from an imported controller profile for display,
 * even though LienCAM has no catalogue entry and therefore no machine use for
 * it. It is persisted with the definition so All settings can keep showing
 * the whole imported file after a save, reload, or ordinary definition edit.
 *
 * These values are not ControllerSetting entries: exporters, definition
 * writers, and controller apply code consume the typed named fields and
 * `settings`, never this read-only profile snapshot.
 */
export interface ControllerProfileOnlySetting {
  controller: ControllerType
  section: string
  key: string
  value: string
}

/** One exact diagnostic produced while importing a controller definition.
 *  It lives on the definition so the diagnostic follows the machine through
 *  save, reload, and machine switching instead of being reconstructed from a
 *  controller-specific setting container or a machine id. */
export interface ControllerImportIssue {
  /** The controller's own key, or a section/file label when no key exists. */
  key: string
  message: string
}

/**
 * A charge pump stated by the machine definition (WO-1729).
 *
 * The whole record is optional on `ControllerDefinition`: absent means nobody
 * has said this controller or drive enclosure uses a charge pump. Once the
 * record exists, `enabled: false` is a different, explicit fact. The output
 * pin and frequency remain independently optional because some boards choose
 * one or both themselves; LienCAM must not invent either value for them.
 */
export interface ChargePumpDefinition {
  enabled: boolean
  pin?: PinRef
  frequencyHz?: number
}

export interface ControllerDefinition {
  axes: AxisDefinition[]
  homing: {
    /** The sequence axes are homed in. Z FIRST IS A SAFETY DEFAULT, NOT A
     *  PREFERENCE - see DEFAULT_HOMING_ORDER. */
    order: AxisName[]
    perAxis: Partial<Record<AxisName, AxisHomingDefinition>>
  }
  /** Machine-wide inputs only. The per-axis limit/home/enable pins live on
   *  the AXIS, because that is where the bridge reads them from
   *  (Machine.cs:445-456). */
  io: {
    estop: PinRef
    probe: PinRef
    probe2: PinRef
  }
  /**
   * Controller-neutral drive-alarm inputs, in the order this machine states
   * them. Each entry is a physical port/pin/polarity record; no UC global pin
   * number or controller profile key crosses this boundary. Absent and empty
   * both state that this definition supplies no drive-fault input.
   *
   * WO-1729's bridge follow-up consumes this array instead of choosing one
   * controller-specific FaultSignals row at runtime.
   */
  driveFaultInputs?: PinRef[]
  /**
   * This machine's charge-pump fact. Absence is "not stated", which is not the
   * same as the explicitly disabled `{ enabled: false }` record.
   */
  chargePump?: ChargePumpDefinition
  /**
   * EVERY OTHER SETTING THIS CONTROLLER HAS, TYPED (WO-1037).
   *
   * `axes`, `homing` and `io` are the groups this software gave named fields
   * and the bridge drives field for field. They are 191 of the 1680 keys a
   * real UCCNC machine states. This group is the other 1489, and it is on
   * THIS TYPE and not beside it because this type IS the machine definition -
   * the thing ADR-0044 requirement 5 measures, the thing WO-1039 edits and
   * the thing WO-1038 exports. A definition that cannot hold 89% of what a
   * machine can be told is not a definition of that machine.
   *
   * These are typed against the CONTROLLER'S OWN CATALOGUE - a meaning, a
   * unit, a range, and a value that is a number when the setting is a number.
   * The catalogue itself lives beside its reader
   * (`lib/machine/uccncProfileImport.ts` for UCCNC, a GRBL one would live
   * beside a GRBL reader); nothing in this layer learns either vocabulary,
   * which is what ADR-0042 asks of it.
   *
   * A VALUE LIVES IN EXACTLY ONE PLACE. A key `axes`/`homing`/`io` already
   * owns is NOT repeated here - `ControllerSettingField.ownedBy` names the
   * field that holds it instead. Wiring a setting means MOVING it from here
   * into a named field, and that one edit removes it from here in the same
   * stroke.
   *
   * EMPTY AND ABSENT ARE DIFFERENT ANSWERS, which is why this is optional.
   * `createDefaultControllerDefinition` gives a hand-built machine an EMPTY
   * group - "this definition states no setting beyond its named groups yet",
   * the true answer for a machine somebody is still filling in, and the
   * container that makes a from-scratch definition fillable at all
   * (ADR-0044 Amendment 1). Absent means the definition predates this group
   * or was assembled by something that does not model settings; a reader
   * gets null from `controllerSettingValue` either way, and never a zero
   * this software chose.
   */
  settings?: ControllerSetting[]
  /**
   * WHICH KEYS THE PROFILE ACTUALLY STATED, for the settings this software
   * reads into a purpose-built field (WO-1037).
   *
   * THE DEFECT THIS CLOSES. `axes[X].softLimitMax` is a `number`. An omitted
   * `Softlimitpositive` therefore lands on it as a 0 nobody wrote, and from
   * that moment the definition says "this machine's positive soft limit is 0"
   * with the same confidence it says 738. That is the substituted home
   * back-off (`4dcf9701`) one field to the left, and it reached Operator's
   * machine once already.
   *
   * WHY IT IS PROVENANCE AND NOT NULLABILITY. Making all 191 purpose-built
   * fields `number | null` puts the check on every consumer of an axis - the
   * bridge, the jog limits, the boundary, the panels - to buy one fact. This
   * record buys the same fact additively: the FIELD keeps the default it has
   * today, so motion code is unchanged, and "the profile did not state this"
   * becomes a separate, askable thing. Ask it with `definitionStatesKey`.
   *
   * WHAT IS IN IT, EXACTLY: the keys a purpose-built field consumed. NOT the
   * keys in `settings` - a key's presence there IS its statement, and copying
   * that fact into a second list is how two lists start disagreeing about one
   * machine. `definitionStatesKey` reads both, so a caller never has to know
   * which side of that line a key falls on.
   *
   * An empty list is the true answer for a definition somebody is building by
   * hand: no profile has stated anything on it yet. Absent means the
   * definition predates this record - `definitionStatesKey` answers false
   * either way, which is the honest answer to "do we know the profile said
   * so".
   */
  stated?: ControllerSettingRef[]
  /**
   * Exact imported file values outside LienCAM's controller catalogue.
   * Optional means this definition was not imported from a profile; an empty
   * array means it was imported and the file had no display-only values.
   */
  profileOnlySettings?: ControllerProfileOnlySetting[]
  /** Exact diagnostics from the import that produced this definition.
   *  Optional means there is nothing to report: either it was not imported or
   *  its import completed cleanly. Import provenance lives in the existing
   *  profile-only/stated records; this field never duplicates that fact. */
  importIssues?: readonly ControllerImportIssue[]
  /**
   * WO-1649: **THE ONE LIST OF THIS MACHINE'S OUTPUTS.** Every switchable thing
   * on the machine is an entry here - flood, mist, a vacuum, a dust boot, a
   * pump, air - each with the word that switches it and the pin it switches.
   * Operator ruling 2026-09-17: "They define the pins. They point them at the use cases
   * like a pump or a vacuum or whatever they want to run in the macro and it
   * works." AND: "My machine is just the test bed. This needs to be able to be
   * used by anyone."
   *
   * WHAT CHANGED FROM WO-1637 AND WHY. WO-1637 kept the controller's OWN relays
   * (M7/M8 coolant, M3/M4 spindle) in `settings` under their UCCNC key names
   * and made the resolver read both containers. That is three models of one
   * fact - this list, `coolantCapability`, and five identical per-controller
   * action tables - and a resolver that could only be written for UCCNC. A GRBL
   * or hand-made machine could state a pump and never state flood. So the
   * coolant and spindle relays are ENTRIES HERE TOO: the UCCNC importer fills
   * them from the profile (`uccncProfileOutputs`), a hand-made machine fills
   * them by hand, and `resolveMachineOutputWord` reads THIS LIST AND NOTHING
   * ELSE. No legacy is owed to definitions written before that (ADR-0040);
   * Operator's own machine is re-derived from his `.pro` at module load.
   *
   * Absent and empty both mean "this machine states no outputs", and the
   * resolver's answer to every word is then "not an output word here" - the
   * word goes to the controller as written, which is what a GRBL board that
   * handles M8 itself needs.
   */
  outputs?: MachineOutputDefinition[]
}

/**
 * The controller board this machine definition STATES it uses.
 *
 * For a CNCdrive controller, `deviceType` is the positive DeviceInfo type
 * (the same identity `BoardPinTables` uses in the bridge). It is NOT the
 * bridge's BoardID: BoardID selects one connected controller and may be zero
 * or negative for a demo board, while deviceType identifies the board model.
 *
 * Optional by design. An absent value says nobody has stated the board; it
 * must never be filled from the machine name, controller kind, or a default.
 */
export interface MachineControllerBoard {
  deviceType: number
}

/** WO-1649: one output on the machine. Knows nothing about what is on the end
 *  of the wire - `name` is only ever shown. */
export interface MachineOutputDefinition {
  name: string
  /** The word that switches it on. */
  onCode: MachineMCode
  /** Its own off word; null when only the shared M9 switches it off. M9 always
   *  does, whatever this says (unless `besideWord` - see there). */
  offCode: MachineMCode | null
  /** Where it is wired, as the wiring diagram names it. */
  pin: PinRef
  /** How long motion waits after it switches on, as UCCNC's relay on-delays. */
  onDelayMs?: number
  /** How long motion waits after it switches off. A word that switches a GROUP
   *  off waits once, for the longest off-delay the group states - that is what
   *  UCCNC's single `M9delay` is, said generally. */
  offDelayMs?: number
  /**
   * WO-1649: WHICH CAM CHANNEL THIS OUTPUT **IS**, when it is one of the three
   * the CAM side can ask for by name. A pump, a dust boot or air has no role -
   * it is switched by its word and nothing asks for it abstractly.
   *
   * This is the fold of `coolantCapability.vacuum`: the vacuum's on-code used
   * to live on the capability record and its pin in a UCCNC setting, and the
   * post, the panel and the importer each reassembled the pair their own way.
   */
  role?: CoolantChannel
  /**
   * WO-1649: TRUE WHEN THE CONTROLLER ACTS ON THIS OUTPUT'S WORD BY ITSELF - a
   * relay wired to the spindle's own M3/M4/M5, which UCCNC switches BESIDE the
   * spindle call rather than instead of it. Two consequences, and they are the
   * whole reason the flag exists rather than a role taxonomy:
   *
   *   - an unassigned pin is SILENCE, not a refusal: the word still means what
   *     it meant to the controller, so there is nothing to tell the operator;
   *   - the shared off word (M9) does not reach it. M9 stops coolant and
   *     accessories; the spindle stops with M5.
   */
  besideWord?: boolean
  /**
   * WO-1703: TRUE WHEN THIS OUTPUT IS WIRED BUT SWITCHED OFF - its word
   * switches nothing, exactly as if no pin were assigned. `pin` still says
   * where it is really wired, so turning it back on needs no re-wiring.
   *
   * WHY A FLAG AND NOT A BLANKED PIN. A UCCNC profile can say
   * `Floodmistrelaysenabled=False` while `M8relaypin=14` still states the
   * wiring. Blanking the pin to say "off" put a fake 0/0 in the record, and
   * the next save wrote that 0/0 back over the real wiring. Absent means on.
   *
   * On an entry with `sharedSwitch`, this flag is the GROUP's, not the row's:
   * see there.
   */
  disabled?: boolean
  /**
   * WO-1703 fix round 3: OUTPUTS THE CONTROLLER TURNS ON AND OFF WITH ONE
   * SETTING. Entries carrying the same value are one switch: UCCNC has a
   * single `Floodmistrelaysenabled` for both its M7 and M8 relays, so the
   * importer stamps both with `'coolant relays'`. The group switches if ANY
   * member is not `disabled` - that is what the controller does with the one
   * flag the export writes (True unless every member is off) - and the
   * Outputs page shows one "in use" control for the group, writing every
   * member's `disabled` together, so a mixed state is never made there.
   * Absent: the entry is its own switch.
   */
  sharedSwitch?: string
}

/**
 * A machine setting this software can SHOW but cannot yet SEND (WO-947).
 *
 * WHY THIS IS A SEPARATE CONTAINER AND NOT A FLAG ON A FIELD, which is the
 * whole point of the order and the thing a later reader will be tempted to
 * "simplify":
 *
 *   `applyActiveMachineDefinition` sends `controllerDefinition` AND NOTHING
 *   ELSE. So "can this setting reach the machine" is not a property anybody
 *   maintains - it is WHICH CONTAINER THE VALUE LIVES IN. Wiring a setting
 *   means MOVING it out of here and into `ControllerDefinition`.
 *
 * A hand-kept list of wired keys would start lying the first time someone
 * wired one and forgot the list. This cannot drift, because the drift and the
 * fix are THE SAME EDIT. That is WO-960's rule applied to a data shape: an
 * unenforced convention does not survive contact with a tired session, and a
 * type does.
 *
 * IT IS EMPTY ON Operator'S PROFILE AS OF WO-1039, and that is the point of the
 * container rather than the end of it. It carried 1489 of his 1680 keys while
 * the definition page could read nothing else; the page now renders and edits
 * `ControllerDefinition.settings`, so a key reaches here only when the typed
 * model could NOT take it - no model for the key, or a value that would not
 * parse against the model it has. See `ProfileImportResult.unsent`.
 *
 * That is what makes it a measurement instead of a backlog.
 * `tools/pro-coverage.mjs` computes SENDABLE as "keys not in here", so the
 * day this software meets a `.pro` it cannot model, the completeness claim
 * drops by exactly that many keys with nobody maintaining a list. A hand-kept
 * list of wired keys would start lying the first time somebody wired one and
 * forgot it; this cannot, because the drift and the fix are the same edit.
 *
 * WHAT IT IS STILL FOR, and why it is not deleted: a key with no model has a
 * VALUE, and that value is a fact about somebody's machine. Dropping it on the
 * floor would make an import silently lossy - the one thing ADR-0044 says an
 * import may never be. Held as the controller's own text, it survives to be
 * shown, exported, and modelled later.
 */
export interface UnsentSetting {
  /**
   * WHICH CONTROLLER'S VOCABULARY `key` IS WRITTEN IN.
   *
   * Operator ruling 2026-08-24: "when the controller type changes the machine
   * definitions at your disposal to define and send the controller also need
   * to be able to change." A UCCNC `.pro` names its settings
   * `axessettingscontrolX.Compaccel`; GRBL numbers them `$130`. Neither is
   * "the" way a machine setting is named - each is one controller's own way.
   *
   * This field is what stops that difference from being a rewrite later. It
   * was `section: string` for about six hours, which put a UCCNC `.pro`
   * section name in the type layer and would have been correct only until the
   * first GRBL machine.
   */
  controller: ControllerType
  /** THE CONTROLLER'S OWN NAME for the setting, verbatim - UCCNC
   *  `axessettingscontrolX.Compaccel`, GRBL `$130`. Never a name this software
   *  invented: a renamed setting is one nobody can look up in the controller's
   *  own documentation. */
  key: string
  /**
   * THE MACHINE'S OWN VALUE, verbatim from its profile, as text.
   *
   * Text and not a number on purpose: this end does not yet know what the
   * setting MEANS, so parsing it would be inventing a type for a fact we have
   * not read. Verbatim is the only honest carriage for a value we are only
   * relaying.
   *
   * NEVER a default this software chose. A made-up machine fact is the exact
   * defect this order exists to prevent, and it is the one that already
   * reached Operator's machine once (`4dcf9701`, the substituted home back-off).
   */
  value: string
}

/** How a setting is named to a person, and in a test id: the controller that
 *  owns the vocabulary, then its own name for the thing. */
export const unsentSettingId = (s: Pick<UnsentSetting, 'controller' | 'key'>): string =>
  `${s.controller}:${s.key}`

/**
 * The machine's own value for a setting we cannot yet send, or null when this
 * machine's profile did not carry one.
 *
 * NULL IS RENDERED AS ABSENCE, NEVER AS A NUMBER. A machine defined by hand
 * rather than imported from a `.pro` has no value here, and showing a zero or
 * a placeholder in that case would be the same invention this whole container
 * exists to forbid.
 */
export function unsentSettingValue(
  settings: UnsentSetting[] | undefined,
  controller: ControllerType,
  key: string,
): string | null {
  if (!settings) return null
  const hit = settings.find((s) => s.controller === controller && s.key === key)
  return hit ? hit.value : null
}

// --- The modelled machine settings (WO-1037) ----------------------------
//
// `UnsentSetting` above carries a machine fact as TEXT, deliberately not
// knowing what it means. That was the honest container while this software had
// no model for those settings. It is not a machine definition: a text triple
// cannot be range-checked, cannot be unit-corrected, cannot be edited as
// anything but a string, and cannot be produced at all by a machine that was
// never imported from a file.
//
// ADR-0044 Amendment 1 sets the bar these types exist to meet: a definition
// built entirely in our UI must emit a profile carrying EVERY feature a
// controller-authored one carries. That is only true if every setting the
// controller has is something this software can HOLD - typed, with a meaning,
// a unit, and whatever range is actually known.
//
// THE VOCABULARY IS THE CONTROLLER'S, NOT OURS (ADR-0042). Nothing here names
// a profile section, a UCCNC key or a UCCNC spelling; `controller` says whose
// vocabulary `key` is written in, exactly as `UnsentSetting` already does. The
// UCCNC catalogue lives in `lib/machine/uccncProfileImport.ts`, a GRBL one
// would live beside its own reader, and this layer never learns either.

/** What shape a modelled setting's value has. `tuple` is for the compound,
 *  comma-separated records some controllers write as a single key - a record
 *  with known elements is structure, not a blob. */
export type ControllerSettingKind = 'number' | 'boolean' | 'text' | 'enum' | 'tuple'

/**
 * The unit a modelled number is written in, IN THE CONTROLLER'S TERMS.
 *
 * `units` rather than `mm` on purpose: a controller profile is written in
 * whatever linear unit that machine is set up in, and calling it millimetres
 * here would claim a conversion this software never performed.
 * `AxisDefinition` already says "units/MIN" for exactly this reason.
 *
 * `10ms-steps` looks absurd and is real: UCCNC stores a drive enable delay as
 * a COUNT OF 10 ms STEPS, and a reader that assumed milliseconds gives every
 * drive a tenth of the delay the machine actually uses (see this repository's
 * `uccncProfileImport` header). Naming the unit is what stops that trap being
 * rediscovered a third time.
 */
export type ControllerSettingUnit =
  | 'none' | 'units' | 'units/min' | 'units/sec^2' | 'steps/unit' | 'steps/rev'
  | 'ms' | '10ms-steps' | 's' | 'percent' | 'hz' | 'rpm' | 'rpm/sec'
  | 'degrees' | 'volts' | 'count' | 'port' | 'pin' | 'ratio' | 'baud'

/**
 * What the controller will accept, WHEN THAT IS ACTUALLY KNOWN.
 *
 * `null` is not "unbounded" - it is "no bound this software has established".
 * Inventing a maximum is the same class of lie as inventing a value: it makes
 * a UI refuse a number the machine would have taken. Absence of knowledge is
 * recorded as absence.
 */
export interface ControllerSettingRange {
  min: number | null
  max: number | null
}

/** One element of a `tuple`-shaped setting whose meaning IS established. */
export interface NamedSlot {
  named: true
  meaning: string
  kind: Exclude<ControllerSettingKind, 'tuple'>
  unit: ControllerSettingUnit
  range: ControllerSettingRange
  /** The vocabulary this element accepts, when it is a closed set. */
  options: readonly string[] | null
}

/**
 * ONE ELEMENT THAT IS TYPED BUT NOT NAMED.
 *
 * Some controllers pack a dozen values into one comma-separated key and
 * document none of them. The arity, the POSITION and the per-element TYPE are
 * readable off the controller's own file and are facts; WHICH setting the
 * fourth number is may not be. This is the slot that carries the facts and
 * NOTHING ELSE: its meaning is the literal `'unknown'`, so there is no
 * invented label for a UI to print, an exporter to trust, or a later reader to
 * mistake for knowledge. Earlier attempts wrote a plausible sentence here and
 * marked it "not established" beside itself - the sentence was still there,
 * and a sentence in a `meaning` field is read as a meaning.
 *
 * It is a modelled slot, not a gap: the value round-trips through it byte for
 * byte. What is missing is the NAME, and `named: false` makes that countable
 * rather than an impression.
 *
 * Naming one means establishing it from the controller's own documentation or
 * from observed machine behaviour - never from what the number looks like.
 */
export interface UnnamedSlot {
  named: false
  /** There is no name to show. The label IS "unknown" - not a placeholder for
   *  one this software could supply. */
  meaning: 'unknown'
  /** A fact: what the controller writes in this position parses as this. */
  kind: Exclude<ControllerSettingKind, 'tuple'>
  /** No unit is claimed. An unnamed slot cannot have an established unit -
   *  guessing "units" here is the same lie one field to the left. */
  unit: 'none'
  range: { min: null; max: null }
  options: null
}

/** One element of a `tuple`-shaped setting - named, or typed-but-unnamed. */
export type ControllerSettingPart = NamedSlot | UnnamedSlot

/** A modelled value. Absence is never one of these - see `ControllerSetting`. */
export type ControllerSettingScalar =
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'text'; value: string }
  | { kind: 'enum'; value: string }

export type ControllerSettingValue =
  | ControllerSettingScalar
  | { kind: 'tuple'; value: readonly ControllerSettingScalar[] }

/**
 * WHAT THE CONTROLLER CAN BE TOLD, described well enough to show it, edit it
 * and write it back out.
 *
 * One of these per setting the CONTROLLER has - not per setting a particular
 * machine happens to state. That is what makes a from-scratch definition
 * complete: the catalogue is the whole vocabulary, so a UI can offer every
 * setting and an exporter can emit every one the user filled in, on a machine
 * that never had a profile behind it.
 */
export interface ControllerSettingField {
  /** Whose vocabulary `key` is written in. Same contract as
   *  `UnsentSetting.controller`. */
  controller: ControllerType
  /** THE CONTROLLER'S OWN NAME for the setting, verbatim. Never a name this
   *  software invented - a renamed setting is one nobody can look up in the
   *  controller's own documentation. */
  key: string
  /** The controller's own grouping for the key, for a UI to lay out by. */
  group: string
  /** Set when the key is one cell of a repeating table, so 384 keys render as
   *  96 rows of 4 rather than as 384 boxes. `null` for a plain field. */
  row: { table: string; index: number; field: string } | null
  /** What the setting DOES, in one line. The whole difference between this
   *  and `UnsentSetting`. */
  meaning: string
  kind: ControllerSettingKind
  unit: ControllerSettingUnit
  range: ControllerSettingRange
  /** The accepted vocabulary for an `enum`, else null. */
  options: readonly string[] | null
  /** The elements of a `tuple`, in order, else null. */
  parts: readonly ControllerSettingPart[] | null
  /**
   * The `ControllerDefinition` field that ALREADY owns this setting's value -
   * for example `axes[X].maxVelocity` - or null when the value lives in
   * `ControllerDefinition.settings`.
   *
   * A SETTING'S VALUE LIVES IN EXACTLY ONE PLACE. A key an axis already holds
   * is not copied into `settings` as well: a second copy of a machine fact
   * that disagrees with the first is the defect this repository has lost more
   * evenings to than any other. This field is documentation of where to look,
   * never a second store.
   */
  ownedBy: string | null
}

/**
 * One setting's value, as this machine states it.
 *
 * ABSENCE IS ABSENCE. A setting this machine has not stated has NO entry here
 * - not a zero, not an empty string, not a null value pretending to be one.
 * A substituted zero has reached Operator's machine once already (`4dcf9701`, the
 * home back-off), and `unsentSettingValue` already draws the same line for
 * the text container this one replaces.
 */
export interface ControllerSetting {
  controller: ControllerType
  key: string
  /** App-owned question this raw controller key answers after import. The raw
   *  key/value remains the sole editable and exportable authority. */
  appKey?: string
  value: ControllerSettingValue
}

/**
 * A NAME WITH NO VALUE ATTACHED - one setting, pointed at rather than held.
 *
 * `controller` rides along for the same reason it does on `ControllerSetting`
 * and `UnsentSetting` (ADR-0042): a bare `axessettingscontrolX.Velocity` is a
 * string in UCCNC's vocabulary pretending to be a universal one, and the day a
 * second controller is read that string answers for a machine it knows
 * nothing about.
 */
export interface ControllerSettingRef {
  controller: ControllerType
  key: string
  /** App-owned question this raw controller key answers after import. */
  appKey?: string
}

/** Same identity rule as `unsentSettingId`: the controller that owns the
 *  vocabulary, then its own name for the thing. */
export const controllerSettingId = (
  s: Pick<ControllerSetting, 'controller' | 'key'>,
): string => `${s.controller}:${s.key}`

/**
 * ONE RULE FOR "THE SAME SETTING", used by every reader below.
 *
 * Provenance and value must never disagree about what counts as the same key.
 * They did: `definitionStatesKey` folded case and `controllerSettingValue`
 * compared exactly, so a definition imported from a profile that spelled a
 * section `[GENERALSETTINGS]` answered "yes, the machine stated
 * `Generalsettings.Softlimitsenable`" and then answered `null` when asked for
 * that same key's value. A consumer walking a catalogue of canonical keys saw
 * a stated setting it could not read.
 *
 * The importer now stores the catalogue's spelling, which closes it from the
 * writing end. This closes it from the reading end as well, so no future
 * writer of a `ControllerSetting` can reopen it: whatever spelling reached the
 * record, both questions are answered about the same key or about neither.
 *
 * Case is folded rather than compared because the controllers this software
 * reads name their settings case-insensitively - a `.pro` does, and GRBL's
 * `$130` has no case to get wrong. A controller whose vocabulary DOES
 * distinguish `X` from `x` needs this rule to become per-controller rather
 * than needing the two readers to drift apart again.
 */
const sameSettingKey = (stored: string, wanted: string): boolean =>
  stored === wanted || stored.toLowerCase() === wanted.toLowerCase()

/**
 * DID THE PROFILE SAY SO? - the one question a caller asks about provenance,
 * with one answer whichever container holds the key.
 *
 * `true` means a profile stated this key and this definition read it. `false`
 * means it did not, and whatever the field reads is a DEFAULT this software
 * chose - not this machine's number. Rendering (WO-1039) and exporting
 * (WO-1038) both turn on that difference: a value nobody stated must not be
 * written back out as though the machine had asked for it.
 *
 * It reads both containers because a value lives in exactly one of them: the
 * 1489 settings no named field claims are stated BY BEING IN `settings`, and
 * the ~190 a named field consumed are stated by being in `stated`. Neither
 * list repeats the other, and this function is why nothing outside has to
 * care.
 */
export function definitionStatesKey(
  definition: Pick<ControllerDefinition, 'settings' | 'stated'> | null | undefined,
  controller: ControllerType,
  key: string,
): boolean {
  if (!definition) return false
  const same = (entry: ControllerSettingRef): boolean =>
    entry.controller === controller
    && (sameSettingKey(entry.key, key)
      || (entry.appKey !== undefined && sameSettingKey(entry.appKey, key)))
  return (definition.settings ?? []).some(same) || (definition.stated ?? []).some(same)
}

/** This machine's value for a modelled setting, or null when it has not
 *  stated one. Keyed by the CONTROLLER'S vocabulary, so a UCCNC key can never
 *  answer for a GRBL machine - and by `sameSettingKey`, so it answers for
 *  exactly the keys `definitionStatesKey` says the machine stated. */
export function controllerSettingValue(
  settings: readonly ControllerSetting[] | undefined,
  controller: ControllerType,
  key: string,
): ControllerSettingValue | null {
  if (!settings) return null
  const hit = settings.find((s) => s.controller === controller && sameSettingKey(s.key, key))
  return hit ? hit.value : null
}

/**
 * THIS DEFINITION WITH ONE SETTING SET, OR TAKEN BACK OFF (WO-1039).
 *
 * The one write path for `ControllerDefinition.settings`, so the rules the
 * readers above depend on are enforced in a single place rather than at each
 * editing surface:
 *
 *  - `null` REMOVES the entry. Clearing a field must not leave an empty string
 *    behind pretending the machine stated one; absence is absence, and
 *    `definitionStatesKey` has to go back to answering false.
 *  - A key already present is REPLACED IN PLACE, keeping the stored spelling
 *    and the list's order, so an edit cannot reorder a machine's settings or
 *    leave two entries that `controllerSettingValue` would have to choose
 *    between.
 *  - Matching is `sameSettingKey`, the same rule the readers use, so an edit
 *    made against a catalogue's spelling lands on the entry a profile's
 *    spelling created.
 *
 * Returns a NEW array: this is React-facing state and the callers copy the
 * definition around it.
 */
export function withControllerSetting(
  settings: readonly ControllerSetting[] | undefined,
  controller: ControllerType,
  key: string,
  value: ControllerSettingValue | null,
): ControllerSetting[] {
  const current = settings ?? []
  const at = current.findIndex(
    (s) => s.controller === controller && sameSettingKey(s.key, key),
  )
  if (value === null) {
    return at === -1 ? [...current] : [...current.slice(0, at), ...current.slice(at + 1)]
  }
  if (at === -1) return [...current, { controller, key, value }]
  return [
    ...current.slice(0, at),
    { ...current[at], value },
    ...current.slice(at + 1),
  ]
}

/** The number this machine stated, or null. Null for absence AND for a value
 *  of another shape: a boolean is not a zero. */
export function controllerSettingNumber(
  settings: readonly ControllerSetting[] | undefined,
  controller: ControllerType,
  key: string,
): number | null {
  const value = controllerSettingValue(settings, controller, key)
  return value !== null && value.kind === 'number' ? value.value : null
}

/** The boolean this machine stated, or null. NEVER `false` for absence -
 *  `false` is a claim, and an unstated setting has not made it. */
export function controllerSettingBoolean(
  settings: readonly ControllerSetting[] | undefined,
  controller: ControllerType,
  key: string,
): boolean | null {
  const value = controllerSettingValue(settings, controller, key)
  return value !== null && value.kind === 'boolean' ? value.value : null
}

/** The text or enum member this machine stated, or null. An empty string is a
 *  STATED empty value and comes back as one; only absence returns null. */
export function controllerSettingText(
  settings: readonly ControllerSetting[] | undefined,
  controller: ControllerType,
  key: string,
): string | null {
  const value = controllerSettingValue(settings, controller, key)
  if (value === null) return null
  return value.kind === 'text' || value.kind === 'enum' ? value.value : null
}

/** Z FIRST, AND THAT IS A SAFETY DEFAULT RATHER THAN A PREFERENCE.
 *
 *  Homing Z last on a router with a tool in the spindle drives the tool
 *  through the work on its way to the X or Y switch. Retracting Z before
 *  anything else moves in the plane is the only order that cannot do that.
 *  Today the bridge hardcodes the same sequence as a C# literal
 *  (Machine.cs:1140) and the profile's own home sequence is parsed nowhere -
 *  so this is not "read the existing setting", it CREATES the setting, and
 *  the value it creates is the safe one. Asserted by a test that says so in
 *  its name. */
export const DEFAULT_HOMING_ORDER: readonly AxisName[] = ['Z', 'X', 'Y']

/** units. Non-zero on purpose - see AxisHomingDefinition.backOff.
 *
 *  Never set this to 0 to silence an axis that should not be carrying it.
 *  It is right for a machine somebody types in from scratch, which would
 *  otherwise finish homing on its own switch. Whether an imported value came
 *  from the machine is a provenance question, answered below. */
export const DEFAULT_HOME_BACK_OFF = 2

/** The UCCNC profile key carrying one axis's home back-off. WO-1731: this is
 *  an IMPORT ALIAS - the name the UCCNC importer records the statement under,
 *  which `homeBackOffProvenance` resolves. It is not the question a caller
 *  asks; `axisHomeBackOffStatementKey` is, and any controller's machine can
 *  state that one. */
export function uccncAxisHomeBackOffKey(axis: AxisName): string {
  return `axessettingscontrol${axis}.Homebackoff`
}

/**
 * Distinguish a machine's own reading (including 0) from LienCAM's own default.
 *
 * WO-1731: the question is asked of the app-owned statement
 * (`axisHomeBackOffStatementKey`, under the machine's own controller -
 * `withAxisHomeBackOffStated` is its write path), and the UCCNC profile's key
 * is resolved as the import alias it is - for a UCCNC machine only, exactly
 * as `axisHomingIsStated` answers its own alias that way (WO-1642: UCCNC's
 * key names are not another controller's words, and stating them on a GRBL
 * machine states nothing). The `controller` default keeps a definition read
 * back from a pre-WO-1731 project answering exactly as it did then; callers
 * holding a machine pass `machine.controller`.
 */
export function homeBackOffProvenance(
  definition: Pick<ControllerDefinition, 'settings' | 'stated'> | null | undefined,
  axis: AxisName,
  controller: ControllerType = 'uccnc',
): 'machine' | 'default' {
  if (definitionStatesKey(definition, controller, axisHomeBackOffStatementKey(axis))) return 'machine'
  if (controller !== 'uccnc') return 'default'
  return definitionStatesKey(definition, 'uccnc', uccncAxisHomeBackOffKey(axis))
    ? 'machine'
    : 'default'
}

export const DEFAULT_AXIS_STEPS_PER_UNIT = 400
export const DEFAULT_AXIS_MAX_VELOCITY = 6000   // units/MIN
export const DEFAULT_AXIS_ACCELERATION = 300

/** The blank axis a person then fills in. Pins are UNASSIGNED, not guessed:
 *  a guessed pin that happens to be wired to something is worse than none. */
export function createDefaultAxisDefinition(axis: AxisName): AxisDefinition {
  return {
    axis,
    enabled: axis === 'X' || axis === 'Y' || axis === 'Z',
    stepsPerUnit: DEFAULT_AXIS_STEPS_PER_UNIT,
    maxVelocity: DEFAULT_AXIS_MAX_VELOCITY,
    acceleration: DEFAULT_AXIS_ACCELERATION,
    softLimitMin: 0,
    softLimitMax: 0,
    slaveAxis: null,
    stepPin: { ...UNASSIGNED_PIN },
    dirPin: { ...UNASSIGNED_PIN },
    homePin: { ...UNASSIGNED_PIN },
    limitMinusPin: { ...UNASSIGNED_PIN },
    limitPlusPin: { ...UNASSIGNED_PIN },
    enablePin: { ...UNASSIGNED_PIN },
    enableDelayMs: 0,
    backlash: { enabled: false, distance: 0 },
  }
}

/** Homing defaults for one axis. The fast/slow ratio (a quarter and a
 *  sixteenth of the axis velocity) is the bridge's own fallback when a
 *  profile omits the homing speeds (Machine.cs:496-497), kept here so our
 *  default machine homes the way the bridge already would.
 *  Direction: Z homes POSITIVE (up, away from the work) - the same reason Z
 *  homes first. X and Y default negative, the common router convention; both
 *  are the user's to correct in the editor. */
export function createDefaultAxisHomingDefinition(
  axis: AxisName,
  maxVelocity: number = DEFAULT_AXIS_MAX_VELOCITY,
): AxisHomingDefinition {
  return {
    direction: axis === 'Z' ? 'positive' : 'negative',
    fastSpeed: maxVelocity / 4,
    slowSpeed: maxVelocity / 16,
    backOff: DEFAULT_HOME_BACK_OFF,
    homingValue: 0,
    autoZero: true,
  }
}

/** A blank three-axis definition with the SAFE homing order and no slaving.
 *  Everything a board actually needs is left unassigned so nothing is applied
 *  on a guess. */
export function createDefaultControllerDefinition(
  axes: readonly AxisName[] = ['X', 'Y', 'Z'],
): ControllerDefinition {
  const perAxis: Partial<Record<AxisName, AxisHomingDefinition>> = {}
  const axisDefs = axes.map((a) => createDefaultAxisDefinition(a))
  for (const a of axisDefs) {
    perAxis[a.axis] = createDefaultAxisHomingDefinition(a.axis, a.maxVelocity)
  }
  return {
    axes: axisDefs,
    homing: {
      order: DEFAULT_HOMING_ORDER.filter((a) => axes.includes(a)),
      perAxis,
    },
    io: {
      estop: { ...UNASSIGNED_PIN },
      probe: { ...UNASSIGNED_PIN },
      probe2: { ...UNASSIGNED_PIN },
    },
    // Empty, never pre-filled: a blank definition states no setting, and a
    // catalogue default written in here would be a machine fact nobody chose.
    settings: [],
    // And nothing has been stated about the named fields above either. Every
    // number in them is this software's default, which is exactly what an
    // empty `stated` says - the fields are populated, their provenance is not.
    stated: [],
  }
}

/** Every pin in a definition, each with a human label for a message.
 *  Board-independent: it reads what is stored and translates nothing. */
export function controllerDefinitionPins(
  def: ControllerDefinition,
): { label: string; pin: PinRef }[] {
  const out: { label: string; pin: PinRef }[] = []
  for (const a of def.axes) {
    out.push({ label: a.axis + ' step', pin: a.stepPin })
    out.push({ label: a.axis + ' dir', pin: a.dirPin })
    out.push({ label: a.axis + ' home', pin: a.homePin })
    out.push({ label: a.axis + ' limit-', pin: a.limitMinusPin })
    out.push({ label: a.axis + ' limit+', pin: a.limitPlusPin })
    out.push({ label: a.axis + ' enable', pin: a.enablePin })
  }
  out.push({ label: 'e-stop', pin: def.io.estop })
  out.push({ label: 'probe', pin: def.io.probe })
  out.push({ label: 'probe 2', pin: def.io.probe2 })
  for (const [index, pin] of (def.driveFaultInputs ?? []).entries()) {
    out.push({ label: `drive fault input ${index + 1}`, pin })
  }
  if (def.chargePump?.pin !== undefined) {
    out.push({ label: 'charge pump', pin: def.chargePump.pin })
  }
  return out
}

/** The ONLY validation this layer is allowed to do: RANGE and DUPLICATION.
 *  Both are board-independent, so neither needs the UCpin table - which is
 *  the whole point. Anything that would need the table (does this pin exist
 *  on this board? is it an output?) belongs to the bridge, which owns the
 *  table. Returns plain sentences; empty means valid. */
export function validateControllerDefinition(def: ControllerDefinition): string[] {
  const problems: string[] = []
  const isPositiveInt = (n: number) => Number.isInteger(n) && n > 0

  const seenAxes = new Set<AxisName>()
  for (const a of def.axes) {
    if (seenAxes.has(a.axis)) problems.push('Axis ' + a.axis + ' is listed more than once.')
    seenAxes.add(a.axis)
  }

  const claimed = new Map<string, string>()
  for (const { label, pin } of controllerDefinitionPins(def)) {
    if (pin.port === 0 && pin.pin === 0) continue          // unassigned, fine
    if (!isPositiveInt(pin.port) || !isPositiveInt(pin.pin)) {
      problems.push(
        'The ' + label + ' pin is port ' + pin.port + ' pin ' + pin.pin
        + '; port and pin must both be whole numbers above zero'
        + ' (or both zero for unassigned).',
      )
      continue
    }
    const key = pin.port + ':' + pin.pin
    const already = claimed.get(key)
    if (already !== undefined) {
      problems.push(
        'Port ' + pin.port + ' pin ' + pin.pin + ' is claimed by both '
        + already + ' and ' + label + '.',
      )
    } else {
      claimed.set(key, label)
    }
  }

  const seenOrder = new Set<AxisName>()
  for (const a of def.homing.order) {
    if (seenOrder.has(a)) problems.push('Homing order lists ' + a + ' more than once.')
    seenOrder.add(a)
    if (!seenAxes.has(a)) {
      problems.push('Homing order lists ' + a + ', which is not one of the axes.')
    }
  }

  return problems
}

// --- Gantry skew, the MEASUREMENT (WO-996) -------------------------------
//
// A gantry that is not perfectly square needs one slaved axis offset from the
// other after homing. This is that signed distance in millimetres.
//
// WHY THIS IS NOT INSIDE `ControllerDefinition`, which is the first place a
// reader will want to move it. `ControllerDefinition` has ONE meaning in this
// codebase - see `UnsentSetting`: "can this setting reach the machine" is not
// a property anybody maintains, it is WHICH CONTAINER THE VALUE LIVES IN, and
// `applyActiveMachineDefinition` sends `controllerDefinition` and nothing
// else. A skew measurement is not a static controller profile setting:
//
//   grep -ci 'skew|squar'  docs/machine/profiles/LienCNCV2.pro   ->  0
//   total keys in that profile                                  ->  2312
//
// UCCNC has no such profile setting to receive, so LienCAM owns the measured
// value and (WO-1006) passes it to the bridge's homing sequence.
// Putting it in the container whose whole meaning is "Apply sends this" would
// make the panel claim the board received a number the board has never heard
// of. So it is a SIBLING of `controllerDefinition`, for exactly the reason
// `unsentSettings` is one.
//
// It also means the default definition does not carry the key and cannot: the
// five files that assert definition shapes with `Object.keys` stay green
// without being touched.

/**
 * HOW FAR OUT OF SQUARE THIS MACHINE IS.
 *
 * ONE NUMBER, AND ONLY ONE. Two earlier attempts stored two representations
 * of the measurement behind a selector for choosing between
 * them, and both were failed at audit for the same thing: the lifecycle of a
 * stored value while switching entry methods (a typo deleted a saved
 * measurement; switching back resurrected a superseded one). There is nothing
 * to switch between here and no second copy to fall out of step, so neither
 * defect is spellable.
 *
 * HOW the number is established does not change what is STORED. Every method
 * produces this same signed offset; a method added later is an input aid that
 * writes this one field, not a second shape beside it.
 *
 * ABSENCE IS THE ONLY WAY TO SAY "NOBODY HAS MEASURED THIS" - there is no
 * sentinel and no zero standing in for one. A machine that has never had a
 * skew set does not carry the key at all, and `offsetMm: 0` therefore means
 * something REAL AND DIFFERENT: somebody measured this gantry and found it
 * square. Unknown is not zero, the same rule as the dashed machine readout, a
 * suppressed gantry verdict, and `PinRef.negate: null`.
 */
export interface MachineSkew {
  /**
   * SIGNED MILLIMETRES. The sign preserves the measured direction so the
   * controller bridge can decide which slaved axis moves and whether both
   * axes must back off first. The app stores the fact and derives no direction.
   */
  offsetMm: number
}

/**
 * The skew this machine actually carries, or `null` when none was ever set.
 *
 * One reader for the field so "unset" is decided in ONE place: absent,
 * explicitly-null, and persisted predecessor shapes all read as null. The
 * WO-996 `{ angleDeg }` value cannot be converted without rail spacing, so it
 * must never be mistaken for a millimetre measurement or reach a formatter.
 */
export function machineSkew(m: Pick<MachineConfig, 'skew'> | null | undefined): MachineSkew | null {
  return m?.skew && Number.isFinite(m.skew.offsetMm) ? m.skew : null
}

/** Millimetres at the 0.001 mm precision of a metric alignment indicator. */
export function formatSkewOffset(offsetMm: number): string {
  return `${offsetMm.toFixed(3)} mm`
}

/**
 * The one sentence about this machine's squaring, for a heading or a summary.
 *
 * NEVER "0.000 mm" for a machine nobody measured, and never the word
 * "corrected" - nothing applies this yet, and a surface that implies a
 * correction is being made is worse than no surface at all.
 */
export function describeSkew(skew: MachineSkew | null | undefined): string {
  if (!skew) return 'Not measured'
  return `${formatSkewOffset(skew.offsetMm)} - not applied`
}

/**
 * DOES THIS MACHINE EVEN HAVE COOLANT? (WO-965)
 *
 * Operator ruling 2026-08-24: "One condition I have is in machine definition I want to be
 * able to toggle if mist or flood even exist. If they do not, don't even show
 * the buttons. Not many hobby CNC users even have coolant. It is far more
 * likely to have vacuum. That is what I have. I have no coolant at all."
 *
 * THIS IS THE FIRST CAPABILITY FLAG ON THE MACHINE RECORD - a fact about what
 * the machine HAS, not a value read out of a `.pro` and not a setting anything
 * sends. Two channels, because M7 and M8 are two separate relays on two
 * separate pieces of plumbing and a machine can perfectly well have one.
 *
 * ABSENT IS NOT FALSE, AND THAT IS THE WHOLE SHAPE OF THIS TYPE. Both keys are
 * optional and the container itself is optional, so a machine record that has
 * never carried them states NOTHING - it is not a machine somebody told us has
 * no coolant, it is a machine nobody has told us about. `machineOffersCoolant`
 * reads absence as "show the control", so an existing profile cannot silently
 * lose its buttons on the version that adds this key. A stored `false` is a
 * different and real claim: somebody looked at this machine and said no.
 *
 * WHY IT IS ASKED FOR RATHER THAN READ. WO-965 required checking whether the
 * profile already answers this before adding a flag a person has to set by
 * hand, and Operator's own `.pro` settles it: `Floodmistrelaysenabled=True`,
 * `M7relaypin=16`, `M8relaypin=14` - a fully wired pair of coolant relays on
 * the machine of the man who says "I have no coolant at all". Those keys
 * describe how UCCNC was configured to SWITCH coolant, which is a different
 * question from whether there is any coolant on the end of the wire, and they
 * exist only for UCCNC at all. So the profile is shown beside the question as
 * evidence and is never taken as the answer.
 */
export type CoolantChannel = 'mist' | 'flood' | 'vacuum'

/** One machine M-code, normalized to the spelling the post and MDI path use. */
export type MachineMCode = `M${number}`

/**
 * A dust-extraction output is not coolant even when the controller reaches it
 * through UCCNC's M7 or M8 macro. The mapping records that distinction: the
 * physical accessory is vacuum, and `onCode` is only how this machine starts
 * it. M9 remains the common, stop-exempt off command.
 */
export interface MachineVacuumCapability {
  onCode: MachineMCode
}

/** The two coolant flags plus mapped dust extraction, each independently
 * statable and independently absent. */
export interface MachineCoolantCapability {
  /** M7. `true` this machine has mist, `false` it does not, ABSENT nobody has
   *  said - and absence is what every record written before WO-965 holds. */
  mist?: boolean
  /** M8. Same three answers, same reason. */
  flood?: boolean
  /** Dust extraction. `false` is a stated absence, an object is a stated
   *  capability plus its start command, and absence means nobody has answered.
   *  Unlike legacy mist/flood, absence never invents a new Control-page button. */
  vacuum?: false | MachineVacuumCapability
}

/** WO-1649: a machine as these two helpers read it - the one output list, and
 *  the coolant record that still answers "is there anything on the end of the
 *  wire" for mist and flood. `controllerDefinition` is optional so a caller
 *  holding a coolant-shaped slice still type-checks; an absent list is simply
 *  a machine that states no outputs. */
type CoolantAnswerMachine =
  Pick<MachineConfig, 'coolantCapability'> & Partial<Pick<MachineConfig, 'controllerDefinition'>>

/** WO-1649: the output in the machine's one list that IS this channel, or null.
 *  The list is the authority; `coolantCapability` answers only what the list
 *  does not. */
export function machineOutputForChannel(
  m: CoolantAnswerMachine | null | undefined,
  channel: CoolantChannel,
): MachineOutputDefinition | null {
  const outputs = m?.controllerDefinition?.outputs ?? []
  return outputs.find((output) => output.role === channel) ?? null
}

/** WHAT THE RECORD SAYS ABOUT ONE CHANNEL: `true`, `false`, or `null` for the
 *  machine nobody has answered for. The three-way return is the point - a
 *  caller that flattens it to a boolean has thrown away the distinction this
 *  order exists to keep, so the flattening lives in one named place below.
 *
 *  WO-1649: a vacuum in the output list IS the machine stating one, so it is
 *  read first. Mist and flood keep answering from `coolantCapability`, which is
 *  a different question from the list's: the list says WHICH PIN M8 switches,
 *  the record says whether there is any coolant on the end of that wire (Operator's
 *  own profile wires both relays and he has no coolant at all). */
export function statedCoolantCapability(
  m: CoolantAnswerMachine | null | undefined,
  channel: CoolantChannel,
): boolean | null {
  if (channel === 'vacuum' && machineOutputForChannel(m, 'vacuum') !== null) return true
  const stated = m?.coolantCapability?.[channel]
  if (channel === 'vacuum' && stated && typeof stated === 'object') return true
  return typeof stated === 'boolean' ? stated : null
}

/** The mapped vacuum record, without flattening stated No and Not stated.
 *  WO-1649: derived from the vacuum entry in the one output list when there is
 *  one - its `onCode` is the same fact the capability record used to carry. */
export function machineVacuumCapability(
  m: CoolantAnswerMachine | null | undefined,
): MachineVacuumCapability | null {
  const listed = machineOutputForChannel(m, 'vacuum')
  if (listed !== null) return { onCode: listed.onCode }
  const stated = m?.coolantCapability?.vacuum
  return stated && typeof stated === 'object' ? stated : null
}

/**
 * M-CODES NO ACCESSORY ON ANY MACHINE MAY TAKE, whoever is asking.
 *
 * M0/M1/M2/M30 stop or end the program, M3/M4/M5 are the spindle, M6 is the
 * tool change and M9 is the shared accessory OFF word every channel already
 * answers to. None of them can mean "start the dust extractor" on any machine
 * that exists, so this list is FLAT - it never depends on what the record says.
 *
 * M7 AND M8 ARE DELIBERATELY NOT HERE. They are reserved only while the machine
 * SHOWS the mist or flood button that owns them, which is a fact about this
 * record and not about M-codes, so it is decided in exactly one place -
 * `reconcileCoolantCapability` below - and nowhere else. A machine whose
 * definition says it has no flood may absolutely drive its vacuum with M8; that
 * is what Operator's own machine does.
 */
export const RESERVED_VACUUM_M_CODES: readonly MachineMCode[] = [
  'M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M9', 'M30',
]

export const RESERVED_VACUUM_M_CODE_REASON =
  'Use a custom M-code. M3, M4, and M5 control the spindle; M0, M1, M2, M6, M9, and M30 are reserved for program control, tool changes, or the shared accessory off. M7 and M8 are free only on a machine whose definition says it has no mist or no flood.'

/** Accept a safe custom `m200`, `M0200`, or whitespace spelling and store one
 * canonical machine word. Only the flat reserved list fails here; whether THIS
 * machine may use M7 or M8 is not a spelling question and is settled by
 * `reconcileCoolantCapability`, which moves a colliding code and says so. */
export function normalizeMachineMCode(value: string): MachineMCode | null {
  const match = /^\s*M0*(\d+)\s*$/i.exec(value)
  if (!match) return null
  const number = Number(match[1])
  if (!Number.isSafeInteger(number) || number < 0) return null
  const code: MachineMCode = `M${number}`
  return RESERVED_VACUUM_M_CODES.includes(code) ? null : code
}

/** WHETHER A SURFACE MAY OFFER THIS CHANNEL AT ALL. Legacy mist/flood remain
 * visible unless explicitly refused, preserving old machines. Vacuum follows
 * the newer absence rule: only a mapped Yes creates a control. */
export function machineOffersCoolant(
  m: Pick<MachineConfig, 'coolantCapability'> | null | undefined,
  channel: CoolantChannel,
): boolean {
  if (channel === 'vacuum') return statedCoolantCapability(m, channel) === true
  return statedCoolantCapability(m, channel) !== false
}

/** The one sentence for a heading, a tooltip or a summary. Never "no" for a
 *  machine nobody asked - see `describeSkew`, which is the same rule about a
 *  different fact. */
export function describeCoolantCapability(stated: boolean | null): string {
  if (stated === null) return 'Not stated'
  return stated ? 'Yes' : 'No'
}

/**
 * THE COARSE `coolant` BIT THIS RECORD SHOULD CARRY, GIVEN ITS CHANNELS.
 *
 * `MachineConfig.coolant` is OLDER THAN THIS ORDER and it is not a rival model
 * to be left alone: it is the same question - does this machine have coolant -
 * asked once for the whole machine instead of once per relay. It is required,
 * it is edited by the Machine Library's Coolant tick, and `resolveCoolant` in
 * the post refuses to post ANY coolant while it is `false`. Two claims about
 * one fact, each settable without the other, is a record that can contradict
 * itself; the WO-965 audit failed exactly that on 2026-08-27. So there is one
 * derivation, here, and every write of a channel answer goes through it.
 *
 * MONOTONE, AND ON EVIDENCE ONLY. A channel stated `true` PROVES the machine
 * has coolant. BOTH channels stated `false` PROVE it has none. Anything else -
 * one channel answered, an un-say, a machine nobody has asked - proves neither,
 * so the existing bit stays exactly where it was. This function never invents
 * an answer for the coarse question out of silence, which is the same rule
 * `machineOffersCoolant` follows for the fine one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: read the coarse bit back as a channel
 * answer. `coolant: false` is the FACTORY DEFAULT (`createLienCncMachine`, the
 * store's default machine and the Machine Library's new-machine form all write
 * it), so treating it as "somebody said no" would strip the coolant buttons
 * off every machine that already exists - the exact regression the order
 * forbids in capitals. Evidence flows fine -> coarse, never back.
 */
export function reconciledMachineCoolant(
  m: Pick<MachineConfig, 'coolant' | 'coolantCapability'>,
): boolean {
  const mist = statedCoolantCapability(m, 'mist')
  const flood = statedCoolantCapability(m, 'flood')
  if (mist === true || flood === true) return true
  if (mist === false && flood === false) return false
  return m.coolant
}

/**
 * WHETHER THIS RECORD'S TWO STATEMENTS AGREE. False only on a real
 * contradiction - the machine-wide tick saying no while a channel says yes, or
 * the tick saying yes while BOTH channels say no. A one-channel No on a machine
 * whose tick says yes is not a contradiction: the other channel may well exist.
 *
 * Nothing this file writes can produce a disagreement. The Machine Library
 * modal can, because its tick still patches `coolant` on its own, so the
 * definition page reads this and says so out loud rather than letting the two
 * drift in silence.
 */
export function coolantRecordAgrees(
  m: Pick<MachineConfig, 'coolant' | 'coolantCapability'>,
): boolean {
  return m.coolant === reconciledMachineCoolant(m)
}

/**
 * WRITE ONE CHANNEL, INCLUDING WRITING IT BACK TO UNSTATED.
 *
 * `null` TAKES THE KEY OFF rather than storing `false`, and when the last
 * stated channel goes the container goes with it - so a record that has been
 * answered and then un-answered is byte-for-byte the record of a machine
 * nobody ever asked. An un-say that leaves a husk behind is not an un-say.
 *
 * The cleared key is named as `undefined` rather than deleted, because the
 * store's `updateMachineInLibrary` MERGES (`{ ...m, ...updates }`): a key the
 * new record simply does not have would survive in the library entry while the
 * project mirror dropped it, which is the two-carriers-disagree drift WO-928
 * exists to have reconciled. `JSON.stringify` drops an undefined on the way to
 * storage, so a reload carries no key at all.
 *
 * AND IT MOVES THE COARSE BIT WITH IT, through `reconciledMachineCoolant`, so
 * the fine answer and the old machine-wide one are never two truths. This is
 * the ONLY writer of a mist/flood coolant capability answer in the app.
 */
export function withCoolantCapability<
  T extends Pick<MachineConfig, 'coolant' | 'coolantCapability'>,
>(
  m: T,
  channel: Exclude<CoolantChannel, 'vacuum'>,
  stated: boolean | null,
): T {
  const next: MachineCoolantCapability = { ...m.coolantCapability }
  if (stated === null) delete next[channel]
  else next[channel] = stated
  return storeCoolantCapability(m, next)
}

/** Store or un-say the vacuum mapping without changing the mist/flood fact.
 *  Like every other channel write it lands through the single reconcile, so a
 *  mapping stored here can no longer come to mean what a shown button means. */
export function withVacuumCapability<
  T extends Pick<MachineConfig, 'coolant' | 'coolantCapability'>,
>(
  m: T,
  capability: MachineVacuumCapability | false | null,
): T {
  const next: MachineCoolantCapability = { ...m.coolantCapability }
  if (capability === null) delete next.vacuum
  else next.vacuum = capability
  return storeCoolantCapability(m, next)
}

/** The word each fixed coolant channel says on every controller LienCAM posts
 *  for. Mist and flood cannot be remapped - the controller defines them - which
 *  is why the vacuum, the one channel that CAN move, is the one that yields. */
const COOLANT_CHANNEL_M_CODE: Readonly<
  Record<Exclude<CoolantChannel, 'vacuum'>, MachineMCode>
> = {
  mist: 'M7',
  flood: 'M8',
}

/** Where a displaced vacuum goes. Ten user codes against two fixed coolant
 *  words and a flat reserved list: the search below cannot come up empty. */
const VACUUM_CUSTOM_DEFAULT_CODES: readonly MachineMCode[] = [
  'M10', 'M11', 'M12', 'M13', 'M14', 'M15', 'M16', 'M17', 'M18', 'M19',
]

/** The code a brand-new vacuum answer starts from. M8 is the one Operator's own
 *  machine uses, and on a machine that shows a Flood button the reconcile moves
 *  it off M8 immediately - so this default never has to know. */
const NEW_VACUUM_DEFAULT_CODE: MachineMCode = 'M8'

/**
 * ONE MEANING PER CODE - THE INVARIANT, AND THE ONLY PLACE THAT ENFORCES IT.
 *
 * Five attempts at this order each closed the hole at a different door - the
 * definition panel's new-Yes path, then the M-code box, then Flood = Yes, then
 * Not stated - and the next round found another door (the Machine Library's
 * Coolant tick, which un-says two Nos and re-creates a shared M8). Guards at
 * doors do not close a house. So the rule lives HERE, downstream of every write
 * of every channel from every surface, and nothing else decides it.
 *
 * The rule, whole:
 *   (a) A channel whose button WOULD BE SHOWN owns its code. Shown is WO-965's
 *       rule, not a truthy read: mist and flood are shown unless stated No, so
 *       "nobody has said" still owns M7 and M8.
 *   (b) No two shown channels share a code. Mist and flood cannot move - the
 *       controller owns those words - so the vacuum is what yields, whichever
 *       channel was just written. It takes the first user code no shown channel
 *       owns, and `describeCoolantCodeMove` turns that into plain words.
 *   (c) A vacuum sitting on a flatly reserved code (a hand-edited file, an old
 *       record, a future importer) is moved by the same step. Nothing here
 *       trusts the value it was handed.
 *
 * IT IS PURE AND IDEMPOTENT: reconciling a reconciled record changes nothing,
 * so a surface may safely run it over a record it merely READ - which is how a
 * project loaded from disk with a collision already in it gets one meaning per
 * code without a second copy of this rule.
 *
 * IT NEVER MOVES A CODE BACK. Stating No to flood later does not drag the
 * vacuum back onto M8; the person may well have rewired. Only a collision moves
 * anything, which is what keeps this monotone and testable.
 */
export function reconcileCoolantCapability<
  T extends Pick<MachineConfig, 'coolant' | 'coolantCapability'>,
>(m: T): T {
  const coolantCapability = m.coolantCapability
  const coolant = reconciledMachineCoolant({ coolant: m.coolant, coolantCapability })
  const vacuum = machineVacuumCapability(m)
  if (!vacuum) return { ...m, coolantCapability, coolant }

  // WO-1649: A VACUUM THE OUTPUT LIST STATES IS NOT THIS RECORD'S TO MOVE.
  // This reconcile exists because the capability record's `onCode` was a word
  // with no wiring behind it, so two buttons could claim one word and only one
  // of them could mean anything. A listed output carries its OWN pin: M8 naming
  // both flood and a vacuum switches both pins, which is a machine wired that
  // way and not a collision. Rewriting it would also be a lie - the answer
  // comes from the list, so a `coolantCapability` this function rewrote would
  // change nothing and this function would stop being idempotent.
  if (machineOutputForChannel(m, 'vacuum') !== null) return { ...m, coolantCapability, coolant }

  const shownCodes = new Set<MachineMCode>()
  for (const channel of ['mist', 'flood'] as const) {
    if (machineOffersCoolant(m, channel)) shownCodes.add(COOLANT_CHANNEL_M_CODE[channel])
  }
  const conflicted = shownCodes.has(vacuum.onCode)
    || RESERVED_VACUUM_M_CODES.includes(vacuum.onCode)
  if (!conflicted) return { ...m, coolantCapability, coolant }

  const onCode = VACUUM_CUSTOM_DEFAULT_CODES.find((code) =>
    !shownCodes.has(code) && !RESERVED_VACUUM_M_CODES.includes(code))!
  return {
    ...m,
    coolantCapability: { ...coolantCapability, vacuum: { onCode } },
    coolant,
  }
}

/** Drop an emptied container, then reconcile. Every channel write in the app
 *  ends here, which is what makes `reconcileCoolantCapability` unavoidable. */
function storeCoolantCapability<
  T extends Pick<MachineConfig, 'coolant' | 'coolantCapability'>,
>(m: T, next: MachineCoolantCapability): T {
  const empty = typeof next.mist !== 'boolean'
    && typeof next.flood !== 'boolean'
    && next.vacuum === undefined
  return reconcileCoolantCapability({ ...m, coolantCapability: empty ? undefined : next })
}

/**
 * WHAT THE RECONCILE JUST DID, IN WORDS A PERSON CAN ACT ON.
 *
 * This decides NOTHING - it reads the record before a write and the record the
 * reconcile returned and reports the difference. Every surface says it the same
 * way because there is only one sentence, and a surface that forgets to call it
 * changes no behaviour, only how quiet the console is. `null` means the write
 * moved nothing, which is the ordinary case.
 */
export function describeCoolantCodeMove<
  T extends Pick<MachineConfig, 'coolant' | 'coolantCapability'>,
>(before: T, after: T): string | null {
  return describeVacuumCodeMove(machineVacuumCapability(before)?.onCode, after)
}

/**
 * THE SAME SENTENCE, ASKED THE ONLY QUESTION THAT CAN ANSWER IT HONESTLY.
 *
 * `from` is the code the write ASKED FOR - the one the person typed, or the one
 * the record carried before an answer elsewhere changed - and `after` is what
 * the single reconcile settled on. A surface that knows what it requested
 * passes it; one that only knows the previous record passes that, through
 * `describeCoolantCodeMove` above.
 */
export function describeVacuumCodeMove<
  T extends Pick<MachineConfig, 'coolant' | 'coolantCapability'>,
>(from: MachineMCode | undefined, after: T): string | null {
  const to = machineVacuumCapability(after)?.onCode
  if (!from || !to || from === to) return null
  /**
   * A CHANGED CODE IS NOT PROOF THE RECONCILE CHANGED IT.
   *
   * This used to name a reason for EVERY difference, with "reserved" as the
   * fallback - so an operator retyping a perfectly legal M200 as a perfectly
   * legal M300 was told the app had moved it because M200 was reserved. Both
   * halves of that sentence were false, on the one surface this order promised
   * would say why. The reconcile only ever moves a code AWAY from one it
   * refuses, so unless `from` is a word a shown Mist or Flood owns, or is
   * flatly reserved, this was the person's own edit and there is no automatic
   * move to explain. The surface that made the edit says what the edit did.
   */
  const owner = from === 'M7' && machineOffersCoolant(after, 'mist')
    ? 'Mist uses M7'
    : from === 'M8' && machineOffersCoolant(after, 'flood')
      ? 'Flood uses M8'
      : RESERVED_VACUUM_M_CODES.includes(from)
        ? `${from} is reserved for the spindle, program control, tool changes, or the shared accessory off`
        : null
  if (!owner) return null
  return `Vacuum moved from ${from} to ${to} because ${owner}; each accessory button must own a different M-code.`
}

/** Enable one accessory. The default vacuum word is simply M8; if this machine
 *  shows a Flood button the single reconcile moves it, so there is no second
 *  opinion about collisions anywhere in this file. Running every new Yes answer
 *  through here keeps both enable orders on the one code path. */
export function withEnabledCoolantCapability<
  T extends Pick<MachineConfig, 'coolant' | 'coolantCapability'>,
>(
  m: T,
  channel: CoolantChannel,
): T {
  if (channel !== 'vacuum') return withCoolantCapability(m, channel, true)
  return withVacuumCapability(
    m,
    machineVacuumCapability(m) ?? { onCode: NEW_VACUUM_DEFAULT_CODE },
  )
}

/**
 * ANSWER THE MACHINE-WIDE QUESTION, THROUGH THE SAME SEAM AS THE FINE ONE.
 *
 * The Machine Library's Coolant tick asks "does this machine have coolant" for
 * the whole machine, which is the SAME FACT the two channel answers carry at a
 * finer grain. Until WO-965's second attempt the tick patched `coolant` by
 * itself, so the record could be made to say yes while both channels said no -
 * the contradiction the 2026-08-27 audit failed. It writes through here now,
 * and here writes through `withCoolantCapability`, so there is still exactly
 * one place in this app that answers this question.
 *
 * NO: a stated No for the machine is a stated No for BOTH relays. That is what
 * the person means - "I have no coolant at all" - and it is the answer that
 * takes both buttons off the Control page.
 *
 * YES: the machine has coolant, and NOTHING NEW ABOUT EITHER RELAY. A Yes here
 * must not invent `mist: true`; the tick cannot tell them apart. So the
 * channels are left exactly as they are - including a single No, which does not
 * contradict a machine that has the other one. The one case that WOULD
 * contradict is both channels stated No, and there the Nos are UN-SAID rather
 * than overwritten: the person has just said the machine has coolant, so the
 * honest record is "has coolant, nobody has said which", not "has coolant and
 * has neither".
 */
export function withMachineCoolant<
  T extends Pick<MachineConfig, 'coolant' | 'coolantCapability'>,
>(m: T, has: boolean): T {
  if (!has) {
    return withCoolantCapability(withCoolantCapability(m, 'mist', false), 'flood', false)
  }
  const bothNo = statedCoolantCapability(m, 'mist') === false
    && statedCoolantCapability(m, 'flood') === false
  const base = bothNo
    ? withCoolantCapability(withCoolantCapability(m, 'mist', null), 'flood', null)
    : m
  // Through the reconcile like every other write, and NOT because this
  // branch changes a channel - it does not. Un-saying two Nos makes both
  // coolant buttons appear, which can put a vacuum on a word one of them
  // now owns; and a record that arrived here already contradicting itself
  // has no business leaving here still doing so.
  return reconcileCoolantCapability({ ...base, coolant: true })
}

export type MachineReferencePositionNumber = 1 | 2 | 3 | 4

export interface MachineReferencePosition {
  x: number
  y: number
  z: number
}

export type MachineReferencePositions = Partial<Record<MachineReferencePositionNumber, MachineReferencePosition>>

export interface MachineConfig {
  id: string
  name: string
  type: MachineType
  /** Router, plasma, laser or knife (WO-1686). Absent means `'router'` -
   *  read through `machineKind`, never this field directly. Not a `.pro` key:
   *  UCCNC has no such setting, so export is unaffected by it. */
  kind?: MachineKind
  controller: ControllerType
  /** App-owned declared board identity. Read through `controllerBoardName`;
   *  absence or an unknown device type stays unnamed. */
  controllerBoard?: MachineControllerBoard
  travel: { x: number; y: number; z: number }   // mm
  /** Per-axis home-switch and machine-zero ends as the CAM lens states them.
   *  For any axis whose homing the `controllerDefinition` STATES, the home end
   *  is derived from its `homing.perAxis` instead (WO-1701, ADR-0049); an axis
   *  whose homing is unstated keeps this. Read it through
   *  `machineHomeConvention`, never this field directly. */
  homeConvention?: MachineHomeConvention
  /**
   * G30 reference positions in machine coordinates (WO-1362). Point 1 is set
   * from MDI with G30.1; points 2-4 are definition parameters. Optional so a
   * legacy/imported machine still says exactly what it said before: no stored
   * reference point, and a G30 naming one is refused by number.
   */
  referencePositions?: MachineReferencePositions
  /**
   * THE USER'S MACROS - as many as they want, in their order (WO-1680). Each
   * is a button on the Macros panel and, when it names an M-code, what that
   * typed word runs. `body` is JavaScript, run by the macro sandbox
   * (`lib/machine/macros/`). Absent and empty both mean "none made".
   *
   * A PARK IS A MACRO OF THIS MODEL (WO-1681): its body is one `positionMacroBody`
   * call (a "go to machine position" step), so it is a button like any other
   * and can carry other steps before or after it. `G30 P1..P4` are the first
   * four position macros, in order (`machineReferencePositions`); a machine
   * with none falls back to `referencePositions`. There is no separate park
   * list any more - `parkMacroPositions` (machineActions.ts) reads this one.
   */
  macros?: MachineMacro[]
  /**
   * WO-1643: the M-code range this machine's controller runs as user macros,
   * when the machine states one (`to: null` = "and up"). Absent, the dialect's
   * range stands (UCCNC M1000 and up, LinuxCNC M100-M199, GRBL none); `null`
   * states the controller runs none. Codes bound to `macros` are macro calls
   * whatever this says. Read through `gcodeWordTableForMachine`.
   */
  macroMCodeRange?: { from: number; to: number | null } | null
  /**
   * WO-1652: this record has had its "Clamp pause" macro (M2001, the UCCNC
   * import's) put on it once. Set with the macro in the same write, so a
   * clamp pause the operator deletes or rebinds is never put back.
   */
  clampPauseMacroAdded?: true
  /**
   * Machine-coordinate safe Z (mm) typed on this machine. Read only through
   * `machineSafeZ`, and only when the controller's own profile states none -
   * a UCCNC machine's safe Z is its `Generalsettings.SafeZ`, never retyped.
   */
  safeZMachine?: number | null
  /**
   * WO-2437: WHERE AN OPERATOR STOP PARKS (machine coordinates, mm) - the
   * user's own setting, edited beside the G30 points. The posted operator stop
   * and Control's clamp pause both read it through `workholdingStopPark`
   * (clampPauseMacro.ts). Absent or null: the machine's Park 1.
   */
  operatorStopPark?: MachineReferencePosition | null
  /**
   * THIS MACHINE'S SENDER-SIDE TOOL TABLE (WO-1676): each tool's probed
   * machine Z on the fixed pad, the tool diameter/note, and which tool is
   * starred as the reference. Used to live outside the definition, keyed by
   * machine id in `machineToolTableStore` - a second store that an export
   * never carried, so importing a machine into a clean install lost every
   * measured length (audit finding 7). Absent means no rows yet; read
   * through `machineToolTable` (`lib/machine/toolTable.ts`), never this
   * field directly.
   */
  toolTable?: MachineToolTable
  /**
   * OPERATOR OVERRIDES OF THIS MACHINE'S PROBE MOTION (WO-1676): fast/slow
   * feed, retract, max travel and PAD THICKNESS, layered over `probing`
   * (the machine's own defaults) the same way `resolveProbeConfig` always
   * layered them - only the storage moved, off `machineToolTableStore` and
   * onto the definition, so export/import carries an operator's pad
   * thickness and feed changes instead of quietly losing them.
   */
  probeOverrides?: Partial<ZProbeConfig>
  /** Operator-saved removable part pads (WO-1797). When `activeProbePadId`
   * names one, its thickness is the authoritative effective pad thickness;
   * `probeOverrides.padThickness` remains the legacy/free-value carrier only. */
  probePads?: ProbePadChoice[]
  activeProbePadId?: string
  /**
   * PER-MACHINE REPLACEMENT COMMAND LINES FOR THE BUILT-IN SPINDLE/COOLANT
   * ACTIONS (WO-1676's "M-code overrides"): absent for an action means it
   * sends its controller/output default (`builtinDefaultLines`). Used to
   * live outside the definition in `machineActionsStore.byMachine[id]
   * .overrides`; moved onto the definition for the same reason as
   * `toolTable` above - an exported machine carried nothing here.
   */
  actionOverrides?: Partial<Record<BuiltinActionId, string[]>>
  /** True when this machine has no homing switches at all (WO-301): the
   *  operator jogs to a corner by eye and zeroes the work coordinate system
   *  there every time. Machine coordinates on such a machine are not
   *  "unknown until homed" - there is no datum, by design, and never will
   *  be, so `homeConvention` is meaningless here regardless of what it
   *  holds. Optional; absent means today's behaviour for every existing
   *  profile and project - this machine has switches. */
  noHomingSwitches?: boolean
  /** Defaults used by workpiece and fixed-pad probing, plus the fixed tool
   *  setter's machine-coordinate position. A per-machine override on the
   *  Probing/Tools screens may replace individual motion values. */
  probing?: MachineProbeDefaults
  /**
   * THE INSTALLED PROBE'S OWN FACTS (WO-1817): its effective tip diameter and
   * stylus runout, each with provenance (stated by the operator, or measured
   * by the calibration routine) and the date that value was current. Every
   * probing number above - bore centres, corners, tool setter, part Z - is
   * offset by these two facts for the specific probe installed; before this
   * they were assumed. Absent means UNCALIBRATED, a named state read through
   * `lib/machine/probeCalibration.ts`'s `describeProbeCalibration`/
   * `resolveTipRadiusMm` - never a silent default radius.
   */
  probeCalibration?: ProbeCalibration
  rapidRate: number         // mm/min (global default, overridden by axisLimits)
  /** Optional spindle bounds. Absence means this machine has not stated a
   *  bound, so consumers must neither invent one nor clamp against one. */
  maxSpindleRpm?: number
  minSpindleRpm?: number
  spindleDirection: 'cw' | 'ccw'
  /**
   * How this machine's spindle is driven. The command surface is the same for
   * every driven kind (direction, RPM, stop); this definition only tells the
   * controller adapter how those commands reach the hardware.
   *
   * Optional for definitions created before WO-1723. A stored VFD link still
   * resolves to `modbus-vfd`; otherwise absence resolves to `manual`.
   */
  spindleDrive?: MachineSpindleDriveDefinition
  toolChanger: ToolChangerType
  /** DOES THIS MACHINE HAVE COOLANT AT ALL - the machine-wide half of the
   *  question WO-965 also asks per channel. `resolveCoolant` posts every
   *  operation dry while this is `false`, and the Machine Library's Coolant
   *  tick edits it. Required, and `false` by default in every factory, so it
   *  is NOT evidence that anybody looked at the machine - see
   *  `reconciledMachineCoolant`, which is the only thing allowed to move it
   *  from a channel answer, and `coolantCapability` below. */
  coolant: boolean
  axisLimits?: {
    x: AxisFeedLimits
    y: AxisFeedLimits
    z: AxisFeedLimits
  }
  /** The editable description of the machine this person BUILT: axes, pins,
   *  homing and the machine-wide inputs (WO-912). Optional, because a GRBL
   *  machine and the simulator have no such thing and `controller` already
   *  records which kind this is - ABSENCE MEANS "not defined for this
   *  controller", never "the defaults are fine". Persisted by the mechanism
   *  that already persists this profile; there is no second storage path. */
  controllerDefinition?: ControllerDefinition
  /**
   * The Modbus spindle document this machine owns (WO-1053). The bridge's
   * `--vfd` file is only a seed: once present here, this is the definition the
   * app edits and sends on every matching bridge connection.
   *
   * `undefined` means no source has stated a link yet and permits the first
   * matching hello to seed one. `null` is a stated absence and must stay absent.
   */
  spindleLinkDefinition?: MachineSpindleLinkDefinition | null
  /**
   * Settings read off this machine's profile that this software can SHOW but
   * cannot yet SEND (WO-947). Deliberately a SIBLING of
   * `controllerDefinition` rather than part of it: everything in
   * `controllerDefinition` goes to the controller on Apply, and nothing here
   * does. The separation IS the honesty marker - see `UnsentSetting`.
   *
   * Optional and absent by default. Absence means "this machine was not
   * imported from a profile", never "there are no gaps".
   */
  unsentSettings?: UnsentSetting[]
  /**
   * How far out of square this gantry is (WO-996). A SIBLING of
   * `controllerDefinition` on purpose - see `MachineSkew`: everything in
   * `controllerDefinition` is what Apply writes to the board, and no
   * controller has a skew setting to receive.
   *
   * OPTIONAL AND ABSENT BY DEFAULT, and absence is the ONLY way this record
   * says "nobody has measured it". No factory writes this key. `offsetMm: 0`
   * is a different and real claim - somebody measured this gantry and found
   * it square.
   */
  skew?: MachineSkew
  /**
   * DOES THIS MACHINE HAVE MIST, FLOOD, OR MAPPED VACUUM EXTRACTION?
   *
   * A SIBLING of `controllerDefinition` and `skew`, for the same reason both of
   * those are: `controllerDefinition` is what Apply writes to the board, and no
   * controller has a setting that means "this machine has a mist tank". These
   * These answers never go on the wire. They change what THIS software offers.
   *
   * OPTIONAL AND ABSENT BY DEFAULT, and absence is the only way this record
   * says "nobody has answered". No factory writes this key. See
   * `MachineCoolantCapability` for why absent may never be read as false.
   *
   * THE FINE HALF OF `coolant` ABOVE, NOT A SECOND OPINION ABOUT IT. `coolant`
   * is the same question for the whole machine and the post reads it;
   * `withCoolantCapability` is the only writer of these answers and it keeps
   * that bit in step through `reconciledMachineCoolant`. Read the two together
   * with `coolantRecordAgrees`.
   */
  coolantCapability?: MachineCoolantCapability
  notes: string
}

/**
 * Operator's four existing UCCNC park macros, exposed as G30 reference positions.
 * These are the literal G53 targets in M200/M2001, M201, M202 and M203 on his
 * machine as read back on 2026-09-12. DATA for his seeded machine record only
 * (`createLienCncMachine`); no resolver looks a machine up by id to find them.
 */
export const LIENCNC_REFERENCE_POSITIONS: Readonly<Required<MachineReferencePositions>> = {
  1: { x: 738, y: 724.5, z: 128 },
  2: { x: 738, y: 50, z: 128 },
  3: { x: 50, y: 50, z: 128 },
  4: { x: 50, y: 724.5, z: 128 },
}

/** A fresh id for a new macro (WO-1706's editor) - the same shape
 *  `newCustomActionId` (machineActions.ts) uses for a custom button. */
export function newMachineMacroId(): string {
  return `macro_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** One user macro on a machine definition (WO-1680). */
export interface MachineMacro {
  /** WO-2677: explicit output selection for the button readback; absent means none. */
  drivesOutput?: string
  id: string
  name: string
  /** The M-code that runs it when typed, if the user bound one. */
  mCode?: number
  /** JavaScript, run by the macro sandbox with the macro API in scope. */
  body: string
  /** This macro is where the guided/automatic tool change parks (the spindle
   *  over the probe pad) - a property of the macro itself, on the one macro
   *  model (WO-1681 fix round). At most one macro carries this. */
  usedForToolChange?: boolean
  /** WO-1707: the older custom-button system folded into this one - a
   *  button's colour, absent reads as neutral (`ACTION_COLORS`). */
  color?: ActionColor
  /** WO-1707: two-press arming before this macro runs, carried over from a
   *  folded custom button (`macroRuntime.ts`'s panel arms it the same way). */
  confirm?: boolean
  /** WO-1707: kept off the Macros panel - a custom button the operator had
   *  hidden moves across hidden. WO-2657 (machine session 2026-10-07: "If they're
   *  suppressed from view, they also need to be suppressed from running"): a
   *  hidden macro is OFF. It stays in the macro editor, but nothing runs it -
   *  not its M-code typed or in a program, not the M6 prelude, and it is no
   *  park or tool-change park; its code reads as if no macro were bound.
   *  Showing it on the panel turns it back on (`shownMacros`, macroRuntime.ts). */
  hidden?: boolean
}

/** The fields a "go to machine position" macro body states (WO-1681): the
 *  built-in step a park is. Machine coordinates, mm. `zFirst` true moves Z
 *  before X Y; false moves X Y first - either way both legs are G53 moves. */
export interface PositionMacroFields {
  x: number
  y: number
  z: number
  zFirst: boolean
}

function positionMacroNumber(n: number): string {
  return String(Number(n.toFixed(3)))
}

/** The body a position macro carries: one `goTo` call in the macro API's own
 *  syntax (`lib/machine/macros/macroRuntime.ts`), so it runs like any other
 *  macro and a user can add steps before or after it. */
export function positionMacroBody(fields: PositionMacroFields): string {
  const target = `{ x: ${positionMacroNumber(fields.x)}, y: ${positionMacroNumber(fields.y)}, z: ${positionMacroNumber(fields.z)} }`
  return fields.zFirst ? `goTo(${target})` : `goTo(${target}, { zFirst: false })`
}

/** Mark (or clear) which macro is used for tool change - at most one, so
 *  setting it strips the flag from every other macro first (WO-1681 fix
 *  round: a property of the macro, on the one machine record, not a
 *  separate designation table). */
export function withMacroToolChangeFlag(machine: MachineConfig, macroId: string, used: boolean): MachineConfig {
  const macros = (machine.macros ?? []).map((m) => {
    const { usedForToolChange: _drop, ...rest } = m
    return used && m.id === macroId ? { ...rest, usedForToolChange: true } : rest
  })
  return { ...machine, macros }
}

const POSITION_MACRO_BODY_RE =
  /^goTo\(\s*\{\s*x:\s*(-?\d+(?:\.\d+)?)\s*,\s*y:\s*(-?\d+(?:\.\d+)?)\s*,\s*z:\s*(-?\d+(?:\.\d+)?)\s*\}\s*(?:,\s*\{\s*zFirst:\s*(true|false)\s*\}\s*)?\)$/

/** The position a macro's body states, when the WHOLE body is one `goTo` call
 *  of that shape - the built-in "go to machine position" step a park is
 *  (WO-1681). Any other body (an edited one, or one with other steps beside
 *  it) is an ordinary macro, not a position - one macro model, no separate
 *  "type" flag. */
export function parsePositionMacroBody(body: string): PositionMacroFields | null {
  const m = POSITION_MACRO_BODY_RE.exec(body.trim())
  if (!m) return null
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]), zFirst: m[4] !== 'false' }
}

/** The definition's own points - WO-1642: whatever machine it is, the
 * definition is the only source. WO-1681: a position macro (a park) IS a G30
 * point now - the first four, in the user's macro order - so a park edited
 * or reordered on the Macros panel is the point G30 goes to. A machine with
 * no position macro falls back to the typed/imported points below. */
export function machineReferencePositions(
  machine: Pick<MachineConfig, 'referencePositions' | 'macros'>,
): MachineReferencePositions | undefined {
  const positions = (machine.macros ?? [])
    .map((macro) => parsePositionMacroBody(macro.body))
    .filter((fields): fields is PositionMacroFields => fields !== null)
  if (positions.length === 0) return machine.referencePositions
  const points: MachineReferencePositions = {}
  positions.slice(0, 4).forEach((fields, index) => {
    points[(index + 1) as MachineReferencePositionNumber] = { x: fields.x, y: fields.y, z: fields.z }
  })
  return points
}

/** One G30 point offered as a park, when a machine has typed or imported
 *  reference points but no position macro of its own (a machine whose
 *  profile or G30.1 stated them needs nothing retyped). */
export interface MachineReferencePositionPark {
  id: string
  label: string
  x: number
  y: number
  z: number
  zFirst: boolean
}

/** This machine's G30 points, offered as parks in point order - read only
 *  when the machine has no position macro (`machineActions.ts`'s
 *  `machineParkList` tries those first). */
export function machineParks(
  machine: Pick<MachineConfig, 'referencePositions'> | null | undefined,
): MachineReferencePositionPark[] {
  if (!machine) return []
  const points = machine.referencePositions ?? {}
  const parks: MachineReferencePositionPark[] = []
  for (const point of [1, 2, 3, 4] as const) {
    const p = points[point]
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) continue
    parks.push({ id: `g30-p${point}`, label: `G30 P${point}`, x: p.x, y: p.y, z: p.z, zFirst: true })
  }
  return parks
}

/** THIS MACHINE'S KIND, absent read as `'router'` (WO-1686) - every place
 *  that cares what a machine cuts with reads this, never `MachineConfig.kind`
 *  directly, so "nobody has said" and "router" stay one answer. */
export function machineKind(machine: Pick<MachineConfig, 'kind'> | null | undefined): MachineKind {
  return machine?.kind ?? 'router'
}

/**
 * WO-1681: A DEFINITION SAVED WITH WO-1670'S SEPARATE `parks` LIST, FOLDED
 * INTO THE ONE MACRO LIST. Each park becomes a macro whose body is the
 * built-in "go to machine position" step, keeping the same id (and M-code,
 * when it had one) so a bound M-code or a designated tool-change park keeps
 * pointing at it. A park with no Z states this machine's safe Z (else its
 * stated top of Z travel; else it moves nothing and says why) at the
 * moment of conversion - a one-time bake, not a live binding (ADR-0040: no
 * migration owed, but converting a saved list is one function and costs
 * nothing). A record with no `parks` key comes back as itself. Run at every
 * load door (`store/index.ts`'s `adoptMachineDocument`), before other
 * reconciliation sees the macro list.
 *
 * `toolChangeParkId` (WO-1681 fix round 2): the pre-1681 wiring-store
 * designation (`MachineActionConfig.toolChangeParkId`, read by the caller
 * from `machineActionsStore` for this machine - this module stays store-
 * free). When it names one of the parks being converted, that macro comes
 * out flagged `usedForToolChange: true` - the same one-time bake as the Z
 * default, so the operator's old designation keeps working after the fold
 * without a second, hidden resolution path staying alive forever.
 */
export function convertParksToMacros(m: MachineConfig, toolChangeParkId?: string | null): MachineConfig {
  const legacy = (m as unknown as { parks?: unknown }).parks
  if (legacy === undefined) return m
  const rest = { ...(m as unknown as Record<string, unknown>) }
  delete rest.parks
  if (!Array.isArray(legacy) || legacy.length === 0) {
    return { ...(rest as unknown as MachineConfig), macros: m.macros ?? [] }
  }
  // A park with no Z of its own meant "this machine's safe Z". With none
  // stated, the top of Z travel is the next height the record knows; with
  // neither, no height is known and the park is converted to a macro that
  // does not move and says why - never to a height nobody stated.
  const safeZ = machineSafeZ(m)?.z ?? statedTopOfZTravel(m)
  const converted: MachineMacro[] = legacy.map((raw) => {
    const park = raw as {
      id: string
      label: string
      x: number
      y: number
      z: number | null
      zFirst?: boolean
      mCode?: number | null
    }
    const z = typeof park.z === 'number' && Number.isFinite(park.z) ? park.z : safeZ
    return {
      id: park.id,
      name: park.label,
      ...(typeof park.mCode === 'number' ? { mCode: park.mCode } : {}),
      ...(toolChangeParkId && park.id === toolChangeParkId ? { usedForToolChange: true as const } : {}),
      body: z === null
        ? parkWithNoKnownHeightBody(park.label, park.x, park.y)
        : positionMacroBody({ x: park.x, y: park.y, z, zFirst: park.zFirst !== false }),
    }
  })
  return { ...(rest as unknown as MachineConfig), macros: [...converted, ...(m.macros ?? [])] }
}

/** The top of this machine's Z travel (machine mm) - its upper Z soft limit -
 *  only when a person or an imported profile stated it. The field alone is a
 *  0 placeholder on a blank axis (`createDefaultAxisDefinition`), so the
 *  statement is what makes it a height. Keys as `resolvedMachineMotion.ts`'s
 *  `axisSoftLimitsAreStated` reads them (this module imports no values). */
function statedTopOfZTravel(m: MachineConfig): number | null {
  const def = m.controllerDefinition
  const z = def?.axes.find((axis) => axis.axis === 'Z')
  if (!def || !z || !Number.isFinite(z.softLimitMax)) return null
  const stated = definitionStatesKey(def, m.controller, 'liencam.axes.Z.softLimitMax')
    || (m.controller === 'uccnc' && definitionStatesKey(def, 'uccnc', 'axessettingscontrolZ.Softlimitpositive'))
  return stated ? z.softLimitMax : null
}

/** True when BOTH soft-limit ends of `axis` came from a person or an imported
 *  profile, never from the 0 placeholders `createDefaultAxisDefinition` puts on
 *  a blank axis. Keys as `resolvedMachineMotion.ts`'s `axisSoftLimitStatementKey`
 *  writes them (this module imports no values). */
export function definitionStatesAxisSoftLimits(
  m: Pick<MachineConfig, 'controller' | 'controllerDefinition'>,
  axis: AxisName,
): boolean {
  const def = m.controllerDefinition
  if (!def || !def.axes.some((candidate) => candidate.axis === axis)) return false
  const liencam = definitionStatesKey(def, m.controller, `liencam.axes.${axis}.softLimitMin`)
    && definitionStatesKey(def, m.controller, `liencam.axes.${axis}.softLimitMax`)
  if (liencam) return true
  return m.controller === 'uccnc'
    && definitionStatesKey(def, 'uccnc', `axessettingscontrol${axis}.Softlimitnegative`)
    && definitionStatesKey(def, 'uccnc', `axessettingscontrol${axis}.Softlimitpositive`)
}

/**
 * WO-1698: THIS MACHINE'S TRAVEL (mm per axis) - THE ONE READER (ADR-0049).
 *
 * Travel is the span an axis's soft limits describe, so once a definition
 * exists its axis soft limits ARE the travel: the Machine area edits them, and
 * the CAM envelope and the Machine Library modal both read them here. The
 * standalone `travel` field is what a machine begun in the CAM lens (no
 * definition yet) is complete with, and what an axis the definition does not
 * yet state its soft limits for falls back to - never a second live copy.
 */
export function machineTravel(
  m: Pick<MachineConfig, 'controller' | 'controllerDefinition' | 'travel'>,
): { x: number; y: number; z: number } {
  const axisTravel = (key: 'x' | 'y' | 'z', axis: AxisName): number => {
    const configured = m.controllerDefinition?.axes.find((candidate) => candidate.axis === axis)
    if (!configured || !definitionStatesAxisSoftLimits(m, axis)) return m.travel[key]
    const span = configured.softLimitMax - configured.softLimitMin
    return Number.isFinite(span) && span > 0 ? span : m.travel[key]
  }
  return { x: axisTravel('x', 'X'), y: axisTravel('y', 'Y'), z: axisTravel('z', 'Z') }
}

/** WO-1698: the modal's Travel fields write the standalone field only while no
 *  definition exists; after that the Machine area is where travel is edited. */
export function travelEditableInMachineLibrary(
  m: Pick<MachineConfig, 'controllerDefinition'> | null | undefined,
): boolean {
  return !m?.controllerDefinition
}

/** The body a converted park gets when no height for it is known: it moves
 *  nothing and says why, and keeps its X/Y where the user will add a Z. */
function parkWithNoKnownHeightBody(label: string, x: number, y: number): string {
  const why = `Park "${label}" did not move: it has no Z of its own, and this machine states no safe Z `
    + `(${UCCNC_SAFE_Z_KEY}) and no top of Z travel, so no safe height is known. `
    + `Give it a Z in this macro to use it.`
  return [
    `// Park "${label}": machine X${positionMacroNumber(x)} Y${positionMacroNumber(y)}, height not known.`,
    `say(${JSON.stringify(why)})`,
  ].join('\n')
}

/** The UCCNC key its profile states the machine's safe Z under. WO-1731: an
 *  IMPORT ALIAS - the name the UCCNC importer carries the value under, which
 *  `machineSafeZ` resolves and the All-settings table edits. The fact itself
 *  is `LIENCAM_SAFE_Z_KEY`; a UCCNC key name must not be what decides whether
 *  a machine stated one (ADR-0044). */
export const UCCNC_SAFE_Z_KEY = 'Generalsettings.SafeZ'

/**
 * WO-1731: the key LienCAM states a machine's own safe Z under, in the
 * machine's OWN controller vocabulary inside `ControllerDefinition.settings`
 * - presence there IS the statement, exactly as for every other setting no
 * named field claims. Any controller's machine can state it; the UCCNC
 * profile's `Generalsettings.SafeZ` is the import alias for the same fact,
 * and that entry stays where it is (All settings edits it and the exporter
 * emits it) - `machineSafeZ` reads the app key first, then the alias.
 */
export const LIENCAM_SAFE_Z_KEY = 'liencam.safeZ'

/**
 * THIS MACHINE'S SAFE Z, machine coordinates (mm), and who owns it (WO-1670,
 * WO-1781). A definition can state the clearable LienCAM app key for any
 * controller (WO-1731), or the non-clearable UCCNC profile alias for an
 * imported machine. A machine whose definition states none carries the value
 * typed on it. Null = nobody has said, and nothing here guesses one.
 */
export function machineSafeZ(
  machine: Pick<MachineConfig, 'controllerDefinition' | 'safeZMachine'>
    & { controller?: ControllerType } | null | undefined,
): { z: number; from: 'app' | 'profile' | 'typed' } | null {
  if (!machine) return null
  if (machine.controller) {
    const statedByDefinition = definitionStatesKey(
      machine.controllerDefinition, machine.controller, LIENCAM_SAFE_Z_KEY,
    )
    const own = controllerSettingNumber(
      machine.controllerDefinition?.settings, machine.controller, LIENCAM_SAFE_Z_KEY,
    )
    if (statedByDefinition && own !== null && Number.isFinite(own)) {
      // Storage inside a definition does not make this an imported profile
      // value. LienCAM owns this key, so every app editor may also clear it.
      return { z: own, from: 'app' }
    }
    // A UCCNC import states the app-owned fact while keeping the value in its
    // raw profile alias. That alias remains the one export and All settings
    // edit; it is never duplicated into a second numeric authority.
    if (statedByDefinition && machine.controller === 'uccnc') {
      const alias = controllerSettingNumber(
        machine.controllerDefinition?.settings, 'uccnc', UCCNC_SAFE_Z_KEY,
      )
      if (alias !== null && Number.isFinite(alias)) return { z: alias, from: 'profile' }
    }
  }
  // Compatibility for definitions imported before WO-1731 added the app-owned
  // statement. Newly imported definitions take the app-key route above.
  if (!machine.controller || machine.controller === 'uccnc') {
    const stated = controllerSettingNumber(
      machine.controllerDefinition?.settings, 'uccnc', UCCNC_SAFE_Z_KEY,
    )
    if (stated !== null && Number.isFinite(stated)) return { z: stated, from: 'profile' }
  }
  const typed = machine.safeZMachine
  return typeof typed === 'number' && Number.isFinite(typed) ? { z: typed, from: 'typed' } : null
}

/**
 * THIS MACHINE'S EVERYDAY RAPID, mm/min (WO-1700, ADR-0049; Operator's ruling
 * 2026-09-19: "Fast speed may be different than max speed").
 *
 * - `ceiling`: the slowest X/Y/Z max velocity the definition's axis table
 *   states - the machine cannot rapid faster. Null when no axis states one.
 * - `mmMin`: the effective rapid. The typed `rapidRate` is the everyday rapid,
 *   capped at the ceiling: min(typed, ceiling) when both exist, the ceiling
 *   alone when nothing valid is typed, the typed alone when the definition
 *   states no speeds.
 * - `from`: which one won - 'typed' when the typed rapid is below the ceiling
 *   (or there is no ceiling), 'definition' when the ceiling caps it.
 *
 * Null = neither says.
 */
export function machineRapidRate(
  machine: Pick<MachineConfig, 'controllerDefinition' | 'rapidRate'> | null | undefined,
): { mmMin: number; from: 'definition' | 'typed'; ceiling: number | null } | null {
  if (!machine) return null
  const speeds = (machine.controllerDefinition?.axes ?? [])
    .filter((a) => a.axis === 'X' || a.axis === 'Y' || a.axis === 'Z')
    .map((a) => a.maxVelocity)
    .filter((v) => Number.isFinite(v) && v > 0)
  const ceiling = speeds.length > 0 ? Math.min(...speeds) : null
  const typed = machine.rapidRate
  const typedValid = Number.isFinite(typed) && typed > 0
  if (ceiling === null) return typedValid ? { mmMin: typed, from: 'typed', ceiling: null } : null
  if (typedValid && typed < ceiling) return { mmMin: typed, from: 'typed', ceiling }
  return { mmMin: ceiling, from: 'definition', ceiling }
}

/** The same record with its safe Z set. A definition edit always creates or
 *  updates `LIENCAM_SAFE_Z_KEY` for that machine's controller, except that an
 *  imported UCCNC definition keeps its one numeric authority in the raw
 *  `Generalsettings.SafeZ` alias used by export and All settings. A machine
 *  without a definition retains the older typed-record path. Null removes an
 *  app-owned setting, or clears the typed value when no definition owns one. */
export function withMachineSafeZ(machine: MachineConfig, z: number | null): MachineConfig {
  const def = machine.controllerDefinition
  const ownSetting = def && machine.controller
    ? controllerSettingNumber(def.settings, machine.controller, LIENCAM_SAFE_Z_KEY)
    : null
  if (def && machine.controller && ownSetting !== null) {
    const { safeZMachine: _typed, ...withoutTyped } = machine
    void _typed
    return {
      ...withoutTyped,
      controllerDefinition: {
        ...def,
        settings: withControllerSetting(
          def.settings,
          machine.controller,
          LIENCAM_SAFE_Z_KEY,
          z === null ? null : { kind: 'number', value: z },
        ),
      },
    }
  }
  if (z !== null && def && machine.controller === 'uccnc'
    && controllerSettingNumber(def.settings, 'uccnc', UCCNC_SAFE_Z_KEY) !== null) {
    const { safeZMachine: _typed, ...withoutTyped } = machine
    void _typed
    return {
      ...withoutTyped,
      controllerDefinition: {
        ...def,
        settings: withControllerSetting(def.settings, 'uccnc', UCCNC_SAFE_Z_KEY, { kind: 'number', value: z }),
      },
    }
  }
  if (z !== null && def && machine.controller) {
    const { safeZMachine: _typed, ...withoutTyped } = machine
    void _typed
    return {
      ...withoutTyped,
      controllerDefinition: {
        ...def,
        settings: withControllerSetting(
          def.settings,
          machine.controller,
          LIENCAM_SAFE_Z_KEY,
          { kind: 'number', value: z },
        ),
      },
    }
  }
  return { ...machine, safeZMachine: z }
}

/** Provenance for the machine-owned copy of a VFD document. Its existing
 * bridge/file origin remains an honest answer until an operational field is
 * edited; app-only choices carry their own separate provenance below. */
export type MachineSpindleLinkDefinition = Omit<VfdDefinition, 'provenance'> & {
  provenance: VfdDefinition['provenance'] | {
    kind: 'seeded-from-bridge' | 'edited-here'
    source?: string
  }
  /** OUR choice, not a correction to the inverter manual. When true, a
   * clockwise LienCAM command is sent using the drive's counter-clockwise
   * command (and vice versa). Absence is the backwards-compatible false. */
  directionInverted?: boolean
  /** Who made the machine-local direction choice. Kept separate from the VFD
   * document provenance because the drive's own definition did not say it. */
  directionInvertedProvenance?: {
    kind: 'liencam-ui' | 'operator'
    source: string
  }
}

/** A board speed command maps requested RPM onto one physical speed output.
 * Null means the machine definition has not stated that part of the mapping;
 * it is never replaced with a controller-specific default. */
export interface MachineBoardSpeedSpindleDrive {
  kind: 'board-speed'
  signal: 'pwm' | 'analog-0-10v'
  output: Pick<PinRef, 'port' | 'pin'> & { negate?: PinRef['negate'] }
  frequencyHz: number | null
  minimumRpm: number | null
  maximumRpm: number | null
  minimumPercent: number | null
  maximumPercent: number | null
}

/** The machine-owned spindle drive choice. Relay direction/run wiring stays in
 * ControllerDefinition.outputs (M3/M4 on, M5 off), so it is not duplicated
 * here. Likewise the Modbus document stays in spindleLinkDefinition. */
export type MachineSpindleDriveDefinition =
  | { kind: 'modbus-vfd' }
  | MachineBoardSpeedSpindleDrive
  | { kind: 'relay' }
  | { kind: 'manual' }

/** Resolve old and new records through one question. Existing VFD machines
 * remain driven without a migration; every other unstated record is manual. */
export function resolvedMachineSpindleDrive(
  machine: Pick<MachineConfig, 'spindleDrive' | 'spindleLinkDefinition'>,
): MachineSpindleDriveDefinition {
  if (machine.spindleDrive !== undefined) return machine.spindleDrive
  return machine.spindleLinkDefinition != null ? { kind: 'modbus-vfd' } : { kind: 'manual' }
}

export function machineDrivesSpindle(
  machine: Pick<MachineConfig, 'spindleDrive' | 'spindleLinkDefinition'>,
): boolean {
  return resolvedMachineSpindleDrive(machine).kind !== 'manual'
}

/**
 * A MACHINE WITH NO DATUM, AS A PROPERTY OF THE MACHINE (WO-985).
 *
 * Operator, 2026-08-25, ruling on WO-969: jog stays open on an unreferenced
 * machine so a crash can be cleared, and no G-code runs until it is homed -
 * "the caveat is if the user has no defined home switches. in that
 * configuration the user is taking the responsibility on themselves ... at
 * which point machine coordinate readout should probably be dashed out".
 *
 * THIS IS A MODE, NOT A PER-MOVE GUESS. Operator ruled that shape on the E-STOP
 * button (2026-08-22): the control has two modes and the mode decides,
 * "which removes the guess rather than repairing it". So the question is
 * asked once, of the MACHINE, and every surface derives from the answer.
 *
 * Two ways a machine says it: the WO-301 declaration (`noHomingSwitches`, the
 * operator ticking the box), and an owning controller profile which explicitly
 * stated that every relevant axis has no home pin. A default 0/0 pin is only a
 * software placeholder; without provenance it says nothing about the machine.
 *
 * ABSENT IS NOT SWITCHLESS. No definition at all means "not described yet",
 * and dashing a readout on the strength of a machine nobody has described
 * would fabricate the very fact this exists to stop fabricating. Disabled
 * spare axes are not evidence about enabled motion axes. The mode only ever
 * opens on evidence about the axes the controller actually owns or slaves.
 */
export function machineHasNoHomeSwitches(
  machine: (Pick<MachineConfig, 'noHomingSwitches' | 'controllerDefinition'>
    & { controller?: ControllerType }) | null | undefined,
): boolean {
  if (!machine) return false
  if (machine.noHomingSwitches === true) return true
  const def = machine.controllerDefinition
  if (!def || def.axes.length === 0) return false

  const enabled = def.axes.filter((axis) => axis.enabled)
  const slaved = new Set(enabled.map((axis) => axis.slaveAxis).filter((axis): axis is AxisName => axis !== null))
  const relevant = def.axes.filter((axis) => axis.enabled || slaved.has(axis.axis))
  if (relevant.length === 0) return false

  // A locally-created definition has carried explicit empty provenance since
  // that record was introduced. Preserve its established WO-985 meaning: the
  // operator opened a blank wiring definition and left every home input
  // unassigned. This marker is independent of unrelated definition settings:
  // adding an app-owned Safe Z must not invent home switches. A real assigned
  // home pin still closes the mode through the `every` check. A legacy/imported
  // definition with `stated` ABSENT is the observed WO-1144 defect and must not
  // take this compatibility path.
  if (def.stated?.length === 0) {
    return relevant.every((axis) => !isPinAssigned(axis.homePin))
  }
  if (relevant.some((axis) => isPinAssigned(axis.homePin))) return false

  // WO-1731: the app-owned question - this machine's record addressed each
  // axis's home input (`axisHomeInputStatementKey`, stated under the
  // machine's own controller; `withAxisHomeInputStated` is its write path)
  // and left it unassigned. A GRBL or hand-built machine states switchless
  // exactly as a UCCNC profile does. The UCCNC `Homeportnumber`/
  // `Homepinnumber` pair is the import alias for the same fact, resolved for
  // the definitions the importer wrote before this key existed; a generic
  // 0/0 guess is still deliberately not a fallback.
  const controller = machine.controller
  if (!controller) return false
  return relevant.every((axis) => {
    if (definitionStatesKey(def, controller, axisHomeInputStatementKey(axis.axis))) return true
    if (controller !== 'uccnc') return false
    const root = `axessettingscontrol${axis.axis}`
    return definitionStatesKey(def, 'uccnc', `${root}.Homeportnumber`)
      && definitionStatesKey(def, 'uccnc', `${root}.Homepinnumber`)
  })
}

// --- Stock ---
export type StockType = 'rectangular' | 'cylindrical' | 'from_model'

export interface Stock {
  type: StockType
  // Rectangular
  width?: number; height?: number; depth?: number   // mm
  // Cylindrical
  diameter?: number; length?: number
  // Offsets from model bounding box
  offsetX: number; offsetY: number
  offsetZTop: number; offsetZBottom: number
  material: string
}

// --- Origin binding (coordinate hierarchy) ---

/** A pickable feature on a part, used to bind a WCS origin to geometry. */
export type FeatureRef =
  | { kind: 'vertex'; localPt: Vec3 }
  | {
      /** WO-294: a setup origin bound to a picked internal bore wall on a
       *  modeled body - X0/Y0 at the bore's axis centre, Z0 at its top rim.
       *  WO-336: also carries an external BOSS pick (a full circular wall) -
       *  the "bore_center" name is kept verbatim (this stays the one setup-
       *  origin circular-feature binding; only the CENTRE math widened, not
       *  the schema) rather than adding a second, near-identical kind.
       *  Carries the same durable identity NewOperationModalBody's bore pick
       *  already produces (bodyId/modelItemId/faceStableId) so a later order
       *  can re-resolve it against the frozen kernel; CAM-2's job, not this
       *  one's. */
      kind: 'bore_center'
      geoId: string
      bodyId: string
      modelItemId: string
      faceStableId: string
      /** Feature centre in the model body's OWN local (pre-Placement) frame -
       *  x/y the axis centre, z the selected rim - the bore/boss-origin analogue
       *  of the vertex kind's localPt. */
      localCenter: Vec3
      diameter: number
      /** WO-366: explicit end chosen in the workspace. Missing on older files
       *  means the historical Top default. */
      end?: 'top' | 'bottom'
    }
  | {
      /** WO-366: the center of one closed circular modeled-body edge. Unlike a
       *  cylindrical face this edge has one unambiguous Z plane, so no end
       *  choice is persisted. */
      kind: 'circle_center'
      geoId: string
      bodyId: string
      modelItemId: string
      edgeStableId: string
      /** Center in the model body's local frame, including the edge's own Z. */
      localCenter: Vec3
      diameter: number
    }

/** Unified description of WHAT a WCS origin is bound to. Supersedes the parallel
 *  legacy WCS fields (stockId/cornerRow/cornerCol/cornerFace and
 *  snapGeoId/snapLocalPt). Phase 0 only POPULATES this from those legacy fields
 *  via migrateProjectToHierarchy; resolvers still read the legacy fields until
 *  Phase 3 flips the readers. */
export type OriginBinding =
  | { kind: 'stock_corner'; stockId: string; cornerRow: number; cornerCol: number; cornerFace: 'top' | 'bottom' }
  | {
      kind: 'part_feature'
      geoId: string
      featureRef: FeatureRef
      /** The physical stock this setup machines. The origin still follows the
       *  feature; this separate association proves stock heights and ownership
       *  for CAM operations that use a model-driven origin. */
      stockId?: string
      /** WO-1427: set when the store last tried to confirm this binding's
       *  source and could not (the part was deleted, the picked face or edge
       *  is gone, or the feature no longer derives). The WCS origin keeps its
       *  last-known value; this is the plain-words reason shown instead of
       *  "Tracking". Absent = nothing has contradicted the source. */
      sourceUnresolved?: string
    }
  | { kind: 'manual' }

// --- Work Coordinate System ---
export interface WCS {
  id: string
  label: string             // e.g. "G54"
  fixtureOffset: number     // 54–59
  origin: Vec3              // relative to model
  xAxis: Vec3
  yAxis: Vec3
  zAxis: Vec3
  stockId?: string          // FixedStockItem.id this WCS was pinned to (undefined = not pinned)
  cornerRow?: number        // 0-2 (back→front) — stored so origin tracks stock movement
  cornerCol?: number        // 0-2 (left→right)
  cornerFace?: 'top' | 'bottom'
  snapGeoId?: string        // ImportedGeometry.id the WCS was snapped to (snap mode)
  snapLocalPt?: Vec3        // vertex in geometry local space — recomputed when geo moves
  // Unified origin binding (coordinate hierarchy). Populated by
  // migrateProjectToHierarchy from the legacy fields above. Readers treat this
  // as authoritative when present; legacy fields remain for old-file loading.
  originBinding?: OriginBinding
}

// --- 2D Geometry ---

export interface Layer2D {
  id: string
  name: string
  color: string      // '#rrggbb'
  visible: boolean
  projectionPlane?: ProjectionPlane  // set when this layer holds STL projection loops
  // Where the layer's loops come from: 'import' (DXF/SVG/projection) or
  // 'sketch' (baked from a parametric sketch document). Absent on layers
  // created before sketch mode existed — treat as 'import'.
  sourceType?: 'import' | 'sketch'
  // Sticky provenance for editable DXF/SVG layers. sourceType changes to
  // 'sketch' after bake, so it cannot by itself say where the layer began.
  sourceOrigin?: 'import'
  // True only after authored sketch content differs from the opened import.
  sourceEdited?: true
  // Locked layers reject edits in sketch/layer tooling (enforcement lands
  // with the Stage 6 lock UI; the flag persists from day one).
  locked?: boolean
  // Coordinate frame of this layer's loop points and projectionPlane Z.
  // 'geometry_local' = raw model coordinates from the B-rep worker (set by
  // deriveBrepLayer for ALL derive kinds); dispatch must apply the owning
  // geometry's rotation.z + position (mirrors the DXF/SVG dispatch branch) and
  // the viewport parents these loops under the part group so they follow moves.
  // Absent = legacy/world-baked: STL projections bake WORLD coordinates at
  // projection time (DesignTree collectWorldPositions) and are sent as-is.
  frame?: 'geometry_local'
  // Hole features backing a derived "Holes (n)" layer (B-rep Stage 3 derivation).
  // Present only on layers created by deriveBrepLayer(geoId, 'holes'); the layer's
  // circle loops are generated FROM these features (one CCW circle per hole).
  // NOTE: on layers with frame === 'geometry_local', HoleFeature center/topZ/
  // bottomZ are GEOMETRY-LOCAL model coordinates (dispatch adds the geometry
  // transform).
  holes?: HoleFeature[]
  // Cylinder features (bores AND bosses) backing a derived "Cylinder (n)" layer
  // (B-rep cylinderFeatures). Present only on layers created by
  // deriveBrepLayer(geoId, 'cylinder'); the layer's top-rim circle loops are
  // generated FROM these features (one CCW circle per cylinder at its topZ).
  // Same geometry_local coordinate caveat as `holes`.
  cylinders?: CylinderFeature[]
  // Tree-display flag: true for layers auto-generated by deriveBrepLayer
  // (face-loops, edge-loops, holes, cylinder, section projections). The
  // geometry tree groups these under a collapsible "Derived geometry (N)" row
  // (default collapsed) so they don't flood the tree. Purely a DISPLAY hint:
  // it does NOT affect `visible` (viewport rendering), loop output, or loopId
  // resolution. Absent on a part's intrinsic/base import/sketch layers.
  derived?: boolean
  // Point-in-time provenance for a Section-at-Z snapshot of a modeled body.
  // The content fingerprint is stable across session-local version resets.
  sectionSource?: {
    bodyId: string
    // WO-1400: the source body's ModelBodyRef.lineageId at capture time, when
    // the body had one yet. A feature edit can publish a new bodyId on the
    // SAME lineage (e.g. F1 replaces IMP1); matching on lineageId (when both
    // sides have one) survives that swap, unlike exact bodyId equality. Absent
    // on sections captured before this field existed - those fall back to the
    // original exact-bodyId match (ADR-0040: no migration, regenerate).
    lineageId?: string
    geometryFingerprint: string
    // WO-1400: modelReferenceFrameFingerprint of the resolved world-space
    // Placement (position + rotation) at capture time. A moved/rotated source
    // body changes this even when its content fingerprint above does not, so a
    // world-space tracked section at the body's OLD pose is caught as stale.
    // Absent on sections captured before this field existed - untracked for
    // placement staleness until the section is regenerated.
    frameFingerprint?: string
  }
  // Recomputed on each real model-body sync. Only true renders a warning.
  sectionStale?: boolean
}

/** Durable topology provenance for a detected physical feature. The feature's
 * current coordinates are deliberately separate: placement can move a feature
 * without replacing it, while a topology change must change the fingerprint. */
export interface DetectedFeatureSourceIdentity {
  stableId: string
  sourceVersion: number
  sourceFingerprint: string
  /** Coordinate frame of the accompanying center/top/bottom facts. Older
   * imported B-rep payloads omit this and inherit their Layer2D frame. */
  evidenceFrame?: 'geometry_local' | 'world'
}

/** Cylindrical hole detected on a B-rep solid (model worker holeFeatures). */
export interface HoleFeature {
  center: [number, number]  // hole axis in world XY (axis is parallel to Z)
  diameter: number          // mm
  topZ: number              // top of the cylindrical wall (face bbox max Z)
  bottomZ: number           // bottom of the cylindrical wall (face bbox min Z)
  // true when bottomZ reaches the solid's bbox bottom (within tolerance).
  // LIMITATION: a blind hole ending in an internal void above bbox-bottom is
  // reported as NOT through; see derive.ts holeFeatures.
  through: boolean
  // Id of the circle Loop2D generated FROM this hole by deriveBrepLayer(kind
  // 'holes'). Links the feature to its drillable loop so drill dispatch can
  // resolve per-hole bottom depths (hole identity by id, not array order).
  loopId?: string
  /** Present when the detector can provide topology identity independently of
   * the projected loop id (notably live Model-body re-derivation). */
  sourceIdentity?: DetectedFeatureSourceIdentity
}

/**
 * A vertical cylindrical feature on a B-rep solid (model worker cylinderFeatures).
 * Superset of HoleFeature: same geometry fields plus `kind` distinguishing a bore
 * (inward wall, drillable hole) from a boss (outward wall, e.g. a thread-mill
 * boss). Axis is parallel to Z in v1; non-vertical picks fail loud upstream.
 */
export interface CylinderFeature {
  center: [number, number]  // cylinder axis in world XY (axis is parallel to Z)
  diameter: number          // mm
  topZ: number              // top of the cylindrical wall (face bbox max Z)
  bottomZ: number           // bottom of the cylindrical wall (face bbox min Z)
  // true when bottomZ reaches the solid's bbox bottom (within tolerance); see
  // the HoleFeature.through limitation note (same blind-void caveat).
  through: boolean
  kind: 'bore' | 'boss'     // inward wall (bore) vs outward wall (boss)
  // Id of the top-rim circle Loop2D generated FROM this cylinder by
  // deriveBrepLayer(kind 'cylinder'); links the feature to its loop by id.
  loopId?: string
  sourceIdentity?: DetectedFeatureSourceIdentity
}

// A fitted arc or line segment (populated by the loop optimizer for clean G-code export)
export type LoopSegment =
  | { type: 'line'; to: Vec2 }
  | { type: 'arc'; to: Vec2; center: Vec2; radius: number; clockwise: boolean }

// A single continuous path (open polyline or closed loop)
export interface Loop2D {
  id: string
  /** Optional user label. Geometry identity remains `id`; this is durable
   *  presentation metadata used by the design tree and operation pickers. */
  name?: string
  points: Vec2[]
  closed: boolean
  type: 'contour' | 'hole' | 'open'
  layerId: string
  area: number       // mm² (absolute); used for display / future op targeting
  segments?: LoopSegment[]  // arc/line segments from optimizer; undefined = use points for rendering
  /** WO-3066: the part-local Z an STL edge chain lies at (bottom of the part = 0,
   *  the same number its name shows). Absent on every other loop, whose plane
   *  is its layer's. */
  z?: number
}

// --- Geometry Import ---
// 'model' (INT-17A Stage 1) = a body modeled in the Model workbench, surfaced
// as a first-class CAM geometry entry. It is a NEW type value precisely so that
// every existing `.type === 'mesh'|'brep'|'curves_2d'` op/nest/stock filter
// EXCLUDES it by construction (fail-closed) - Stage 1 is read-only, no ops on
// modeled geometry (that is Stage 3). Its identity rides the Model kernel's
// ElementMap EXCLUSIVELY (DECISIONS 2026-07-18 ruling 1); a modeled body must
// NEVER be routed through the occt-model STEP import path.
export type GeometryType = 'mesh' | 'brep' | 'curves_2d' | 'model'

/** INT-17A Stage 1: the durable, ModelReference-shaped handle a model-backed CAM
 *  geometry entry carries. `bodyId` is the Model-kernel DAG node id (immutable,
 *  caller-assigned, never minted by the DAG - src/doc/dag.ts) so the same body
 *  always maps to the same CAM entry across regens; `stableIds` are the body's
 *  ElementMap face/edge StableIds (the Model kernel's identity, never occt). */
export interface ModelBodyRef {
  bodyId: string
  /** Stable body-lineage root. Unlike bodyId (the current feature leaf), this
   *  survives appended features and direct edits. Optional for projects saved
   *  before BUG-AC-FRAME-2026-08-01; load/sync reconciliation backfills it. */
  lineageId?: string
  stableIds: string[]
  /** GeometryCache-style version, bumped every re-derive. A change signals the
   *  display payload was refreshed; lets consumers detect a stale derived cache
   *  by keying on (bodyId, version) - mirrors CachedBody.version. */
  version: number
}

/** INT-17A Stage 1 (B2a): the tessellated display payload persisted DIRECTLY on
 *  a model-backed CAM geometry entry, so the entry draws from its own data on a
 *  reload where the Part tab is never (re)visited and no regen pass fires (the
 *  live regen hook is responsible for FRESHNESS while the Model tab is live, not
 *  for the entry's drawable data). Plain number arrays so it JSON-serializes into
 *  the .camproject exactly as loops/layers2d do. Positions/normals are xyz
 *  triples; edgeOffsets is a CSR point-index table (edge i occupies edgePositions
 *  points [edgeOffsets[i], edgeOffsets[i+1])), mirroring TessBuffers. */
export interface ModelBodyDisplay {
  positions: number[]
  normals: number[]
  indices: number[]
  edgePositions: number[]
  edgeOffsets: number[]
  bbox: { min: [number, number, number]; max: [number, number, number] }
  /** CAM-BINDING Stage 5: per-FACE stable ids (ElementMap identity, one entry
   *  per distinct face - NOT per triangle), and `triFace` mapping each
   *  triangle (by triangle index, `indices[i*3..i*3+2]`) to its position in
   *  `faceIds` - the SAME compact scheme the Model kernel's own CachedBody
   *  already uses (src/viewport3d/GeometryCache.ts), captured verbatim so a
   *  face can be identified without a second tessellation or a live kernel
   *  call. Optional + additive (mirrors every other ModelBodyDisplay/CAM-
   *  BINDING field's precedent): absent on a project saved before this stage,
   *  or before the body's first post-Stage-5 regen - a consumer that needs
   *  per-face identity (face-boundary picking) must treat absence as "not yet
   *  face-pickable, re-sync (open the Model tab) to enable it", never as an
   *  error and never by inventing a face id. */
  faceIds?: string[]
  triFace?: number[]
  /** Stable Model-kernel edge identities in the same order as edgeOffsets.
   * Optional for projects saved before shared viewport presentation shipped.
   * Consumers must not invent identities when it is absent; re-sync the body
   * from Model before offering topology-dependent edge tools. */
  edgeIds?: string[]
}

export interface ModelBody {
  ref: ModelBodyRef
  // The tessellated display payload. PRESENT in the live store and in the durable
  // .camproject FILE (B2a - that is what makes a card draw on a file reload with
  // the Part tab never visited). STRIPPED from the localStorage rehydrate blob
  // (persistPartialize) so dozens of bodies of tessellation never blow the ~5MB
  // quota (mirrors how toolpathMoves and brep mesh buffers are kept out of
  // localStorage; browser-headroom D-014). When absent (a browser-refresh
  // rehydrate), the entry re-derives its display the moment the Part workspace
  // next mounts and regenerates (the load/seed fullResync fires syncModelBodies
  // over every body). Consumers MUST treat an absent display as "not yet
  // drawable", never as an error.
  display?: ModelBodyDisplay
}

export interface ImportedGeometry {
  id: string
  name: string
  filename: string
  type: GeometryType
  // 'sketch' = the in-app sketches container (holds layers baked from
  // parametric sketches; no source file, loops live in the project state).
  // 'model' = a body modeled in the Model workbench (INT-17A Stage 1); its
  // drawable + durable handle ride on `modelBody` below, not on loops/bytes.
  format: 'stl' | 'step' | 'iges' | 'obj' | 'dxf' | 'svg' | 'sketch' | 'model'
  boundingBox: BoundingBox
  faceCount?: number
  position: Vec3   // world position of this part in the scene
  rotation: Vec3   // Euler rotation in degrees (X, Y, Z)
  color?: string   // '#rrggbb' — user-chosen display color
  loaded: boolean
  hidden?: boolean             // true = 3D mesh hidden in viewport (projected loops still shown)
  // 2D geometry (svg/dxf import, or STL projection)
  loops?: Loop2D[]
  layers2d?: Layer2D[]
  // Parametric sketch documents stored alongside the layers they baked to
  // (PLAN.md D5: non-destructive re-edit; one document per layer, keyed by
  // Sketch.layerId). Persists with the project like loops/layers do.
  sketches?: import('../lib/sketch/types').Sketch[]
  // STL projection settings
  projectionTolerance?: number // mm — per-model simplification tolerance (default 0.02)
  // True when the transform changed in a way that invalidates this geometry's
  // projected/derived loops: STL world-baked projections = ANY move (coords are
  // baked at projection time; re-project button highlights); step geos = X/Y
  // tilt only (translation/Z-rotation are re-applied at dispatch; the loud
  // dispatch guard is the backstop — no step re-derive UI yet).
  projectionStale?: boolean
  loopsVersion?: number        // incremented on every setGeometryLoops call; drives viewport refresh
  // Set when loops were projected onto an arbitrary face plane (not a horizontal Z-slice)
  projectionPlane?: ProjectionPlane
  // Physical stock membership; the KEYSTONE link of the coordinate hierarchy
  // (geometry lives inside a PhysicalStock). Populated by migrateProjectToHierarchy;
  // no reader yet (Phase 1 sorts members by containment and reads it).
  stockId?: string
  // manual stock assignment lock; set by setGeometryStock; auto-assign skips locked geometry
  stockIdLocked?: boolean
  // Geometry-folder membership (Stage A). A GeometryFolder.id, or null/undefined =
  // the part lives at the DesignTree root (no folder). Folders are an organisational
  // grouping only; they do NOT participate in the coordinate hierarchy (stockId is
  // the keystone link, unaffected by folder moves).
  folderId?: string | null
  // WO-1572: this body is WORKHOLDING (a vise, clamp or fixture), not a part.
  // Saved with the project. Workholding never sizes derived stock, is never an
  // all-parts cut source or a stock-roughing target, and never bears a stock.
  // Set and cleared by setGeometryWorkholding (one undo step). Absent = a part.
  workholding?: boolean
  // WO-1590 (mating S0): this body is LOCKED in place. Saved with the project.
  // A locked body's position/rotation cannot be changed by any of the three
  // write paths that move one (the transform action, the viewport gizmo, a
  // mate/seat command) - all three funnel through updateGeometryTransform,
  // the one guarded seam (store/index.ts). Locking is position-only: it never
  // changes geometry, stock membership, operations or toolpaths. Set and
  // cleared by setGeometryLocked (one undo step). Absent = unlocked.
  locked?: boolean
  // Owned-seed link (ADR 0025 §2, refined deep-copy seed model). Set when this
  // geometry is a nest's INTEGRATED seed copy: createNest deep-copies each source
  // part into a NEW ImportedGeometry whose ownerNestId is the owning nest's id.
  // Such a copy is self-contained (ties to the source are broken) — it renders
  // ONLY as that nest's seed slot (suppressed from the standalone viewport),
  // appears ONLY as the nest's child row in the DesignTree (no root/folder row),
  // and is removed together with the nest. Absent/undefined = an ordinary
  // workspace geometry owned by no nest. NEVER points at a deleted nest (removeNest
  // deletes its owned seeds in the same step).
  ownerNestId?: string
  // INT-17A Stage 1: present IFF format === 'model'. The durable Model-kernel
  // handle (ref) plus the persisted tessellated display (B2a). Absent on every
  // other geometry kind. A model entry is derived from a live Model body and is
  // read-only in the CAM tab this stage (no ops, no click-to-edit).
  modelBody?: ModelBody
  // WO INT-17C Stage C1 step 7 (v12 migration): which ModelItemRecord.id this
  // model-backed row belongs to. Present IFF format === 'model' AND this row
  // has been claimed by a Model Item -- the v12 migration backfills it to the
  // legacy item's id for every pre-existing model row (LEGACY_MODEL_ITEM_ID,
  // src/doc/documentHolder.ts) so a lossless migration never leaves a model
  // row's ownership ambiguous. Absent on every non-model row and on a
  // pre-migration file (undefined, not an error -- mirrors stockId/folderId's
  // own optional-reference contract immediately above).
  modelItemId?: string
  // GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stage 1: this format:'step' row has
  // been WRAPPED as an editable Model Item and is waiting to be ADOPTED as
  // that item's first body on the item's first successful regen
  // (reconcileModelBodies pass 2, modelBodyAdapter.ts). Deliberately NOT
  // `modelItemId` -- that field is present IFF format === 'model' and every
  // shipped nav affordance gates on it, so a still-STEP pending row must not
  // light up model-row UI. On adoption the row's id + fields are preserved,
  // its format flips to 'model', and this field is cleared. Absent on every
  // ordinary row. A pending row that never adopts (multi-body cold-load / the
  // wrap was undone) keeps working as an ordinary STEP row untouched.
  pendingModelItemId?: string
  // GEO-UNIFY Stage 4: solid-body count from the STEP file, persisted at
  // import time (BrepModelPayload.solidCount) so the "Edit as model" wrap can
  // refuse a multi-body STEP BY NAME without the runtime payload registry
  // being loaded (a cold reload where the Part tab never drew). Present only
  // on format:'step' rows imported after this field shipped; undefined = count
  // unknown, in which case the wrap falls back to the runtime payload and, if
  // that too is absent, lets the import node's own multi-body refusal fire at
  // first regen (INT-IMPORT-EDIT.plan.md sec 2 step 1). Optional additive
  // field, no migration -- same contract as modelItemId above.
  solidCount?: number
  // IMPORT-MULTIBODY-CHOICE (Operator Q-76): the user's chosen landing shape for a
  // multi-body STEP import -- 'combined' = keep all bodies in this ONE row
  // (the historical default, least surprise), 'individual' = fan each solid out
  // to its own editable row (routed through the "Edit as model" wrap). Recorded
  // at import time (and on a later re-choose) so the choice modal can preselect
  // the user's prior pick when the decision is revisited (edit-reuses-original-
  // UI law). Present only on format:'step' rows that carried 2+ solids at import;
  // undefined on single-body imports and every pre-feature file. Additive +
  // optional, no migration -- same contract as solidCount above. When the user
  // picks 'individual' the row is wrapped and adopted as body 1, so the flag may
  // ride the adopted row harmlessly; its live consumer is the still-combined
  // (format:'step') row's re-choose preselect.
  multiBodyMode?: 'combined' | 'individual'
  // MSH-4-BOOLEAN-EDIT (Operator Q-70 A + Q-72 A): this format:'stl' row is a
  // one-shot boolean of an imported mesh against a Model body. It rides
  // format:'stl' (indistinguishable from an import in format switches, R6); the
  // `approximate` marker below disambiguates. `approximate` is TRUE when the
  // model body had any curved face (its display mesh approximated it at the
  // kernel's display fidelity), FALSE when every face was planar (the cut is
  // EXACT - only the geometry type changed to mesh). The result is a STATIC
  // snapshot, never a live parametric feature; it goes stale if an operand later
  // changes, exactly like any import (booleanProvenance names both operands so
  // the user knows what it was cut from). Additive + optional (mirrors
  // solidCount/modelItemId); absent on every ordinary row.
  approximate?: boolean
  booleanProvenance?: BooleanMeshProvenance
  // WO-1845 / ADR-0051: this format:'stl' row's EDIT JOURNAL - an ordered list
  // of edits replayed over the row's own imported bytes every time its shape is
  // needed. The bytes are never rewritten (s1.1); the mesh every consumer sees
  // is source-bytes + this journal, resolved through ONE function
  // (src/mesh/edit/resolve.ts, s1.2). Each entry selects facets by index into
  // the mesh the edits before it produced and carries a geometric witness, so a
  // selection that no longer matches STOPS replay loudly instead of editing a
  // different region (s1.4). Additive + optional under ADR-0027, no migration
  // (ADR-0040): absent or empty = this STL behaves exactly as it does today,
  // byte for byte. Rides in the project JSON on the row; the source bytes
  // already embed under Project.binaries (s5.3). Added and removed through the
  // store's normal history, one undo step per edit (s5.1).
  meshEdits?: import('../mesh/edit/types').MeshEditRecord[]
}

/** MSH-4-BOOLEAN-EDIT: provenance + result stats for a boolean-mesh-vs-model-body
 *  result row (present IFF booleanProvenance is set on an ImportedGeometry).
 *  Carries operand ids (Edit re-runs a fresh snapshot), operand names (feedback
 *  copy), and result stats (Properties Panel facts, so the panel is synchronous
 *  without re-reading the cached mesh). */
export interface BooleanMeshProvenance {
  op: import('../mesh/types').MeshBooleanOperation
  sourceMeshId: string
  sourceMeshName: string
  modelBodyId: string
  modelBodyName: string
  triangleCount: number
  volumeMm3: number
  curvedFaceCount: number
}

/** A DesignTree organisational folder for grouping imported geometry (Stage A:
 *  data model + store only; the tree UI is Stage B). v1 creates ROOT folders only
 *  (parentId null/undefined), but the model carries parentId so NESTED folders are
 *  possible later without a schema change. parentId references another
 *  GeometryFolder.id; absent/null = the folder is at the root. */
export interface GeometryFolder {
  id: string
  name: string
  /** Parent GeometryFolder.id for FUTURE nesting; null/undefined = root folder. */
  parentId?: string | null
  /** Optional '#rrggbb' folder tint for the tree (Stage B styling). */
  color?: string
}

/** WO INT-17C Stage C1 step 6: one independently-modelable authored unit
 *  (Q-40 Option 1's "Model Item") - tree-visible list membership + display
 *  identity ONLY. The modeling document itself (dag/features) is NOT stored
 *  here: it lives in the documentHolder registry (src/doc/documentHolder.ts),
 *  keyed by this record's own `id`, so a Model Item's shape never doubles up
 *  inside the JSON project the way `Project.document` (:1252) explicitly
 *  warns against for the single legacy document. Mirrors GeometryFolder's
 *  shape immediately above: a small, JSON-plain project-array record. */
export interface ModelItemRecord {
  id: string
  name: string
  /** Lightweight browser-persistence manifest. The archive itself stays in
   * binary storage; localStorage carries only whether genesis is intentional
   * or an authored document must be acquired before entering Model. */
  documentState?: 'empty' | 'authored' | 'unknown'
  documentStorageKey?: string
  documentRevision?: number
  // GEO-UNIFY Stage 2 (plan sec 1.4): which geometry folder an EMPTY item's
  // placeholder tree row (DesignTree's renderPlaceholderModelRow) presents
  // under, mirroring ImportedGeometry.folderId (:422). Optional -> every
  // pre-Stage-2 project and every item never dragged into a folder reads
  // `undefined` (root), no migration needed -- same optional-presentational
  // precedent as geometryFolders itself (:1286-1288 comment). Once the item
  // gains its first body row, that row's OWN folderId (types/index.ts:422)
  // takes over as the source of truth (seeded from this field once in
  // syncModelBodies, store/index.ts) and this field is no longer consulted
  // for that item's presentation until it goes empty again.
  folderId?: string | null
}

/** WO INT-17C Stage C1 step 7 (v12 migration): the PERSISTED half of a Model
 *  Item's placement -- project-owned, lives outside every model archive.
 *  Field-for-field mirror of src/lib/cam/modelItemPlacement.ts's
 *  `ModelItemPlacement` (the AS-SHIPPED contract, INT-17C.md coordinator
 *  ruling 5) -- deliberately NOT imported from there: that module imports
 *  `Vec3` FROM this file, so the reverse import would be circular. Renamed
 *  `...Record` (not `Placement`) for the SAME reason ModelItemRecord isn't
 *  just `ModelItem` -- distinct identifier from the lib/cam seam type and
 *  from nesting/types.ts's own unrelated `Placement`, per the WO's own
 *  naming ruling, even though the shapes are structurally interchangeable.
 *  `bodyId` omitted = the item's one automatic whole-item Placement; present
 *  = the body-filtered form the v12 migration writes to preserve each
 *  pre-existing Stage-1 geometry row's own pose without merging distinct
 *  poses into one. */
export interface ModelItemPlacementRecord {
  modelItemId: string
  bodyId?: string
  position: Vec3
  rotation: Vec3
}

/** Symbolic Z reference for a projection plane's origin.z (the height-vocabulary
 *  pattern, ADR 0002). Lets a plane placed on a stock-relative preset RE-RESOLVE
 *  its Z live when the stock moves, instead of freezing the number at creation.
 *    - 'absolute'     : origin.z is a literal snapshot (today's behavior).
 *    - 'floor'        : origin.z = 0 + offset (constant; never moves).
 *    - 'stock-top'    : origin.z = stockBounds.max.z + offset.
 *    - 'stock-bottom' : origin.z = stockBounds.min.z + offset.
 *  Absent zAnchor == 'absolute' (back-compat for all existing data). Face picks
 *  set NO zAnchor — they follow the part via the owning-geometry frame. */
export interface ProjectionZAnchor {
  ref: 'absolute' | 'floor' | 'stock-top' | 'stock-bottom'
  offset: number
}

/** 3-D coordinate frame for a projected plane — loops' (x,y) live in this frame. */
export interface ProjectionPlane {
  origin: Vec3   // world-space point on the plane
  xAxis:  Vec3   // world-space 2-D frame X axis (unit)
  yAxis:  Vec3   // world-space 2-D frame Y axis (unit)
  normal: Vec3   // world-space normal (unit) — Z axis of the frame
  // Optional symbolic Z reference; when stock-relative, origin.z is re-resolved
  // live on stock-bounds change (resolveAnchoredZ / reanchorProjectionLayers).
  zAnchor?: ProjectionZAnchor
}

// --- Scene Stock ---

/** A named, positioned fixed-stock block (used when SceneStock.mode === 'fixed'). */
export interface FixedStockItem {
  id: string
  name: string
  width: number     // mm X
  height: number    // mm Y
  depth: number     // mm Z
  position: Vec3    // world-space min corner (bottom-left-front)
  // WO-1590 (mating S0): this fixed stock (e.g. a vise or work fixture) is
  // LOCKED in place. Guarded at updateFixedStock and moveFixedStockLive
  // (store/index.ts) - position-only, mirrors ImportedGeometry.locked.
  locked?: boolean
}

/** A named AUTO stock whose bounds are COMPUTED (derived) from the member
 *  geometry explicitly assigned to it (geometry.stockId === this.id +
 *  stockIdLocked). Coexists with FixedStockItem: a fixed stock stores its size
 *  authoritatively, an auto stock sizes itself to its members + offsets. Each
 *  AutoStockItem maps to one mode:'derived' PhysicalStock (id === this.id). */
export interface AutoStockItem {
  id: string
  name: string
  autoOffsetXY: number       // mm padding on each X and Y side
  autoOffsetZTop: number     // mm above the highest member point
  // mm of stock reserved BELOW the lowest member point (flip / backside
  // machining allowance). OPTIONAL for back-compat: projects saved before this
  // field load with undefined, and every read boundary coalesces it to 0 via
  // `?? 0` (preserving the prior base === members' min Z behavior exactly).
  autoOffsetZBottom?: number
}

export interface SceneStock {
  mode: 'auto' | 'fixed'
  autoOffsetXY: number       // mm padding on each X and Y side (AUTO)
  autoOffsetZTop: number     // mm above highest point of all parts (AUTO)
  // mm of stock reserved BELOW the lowest part point (AUTO, the global
  // fallback when a named AutoStockItem has no own value). OPTIONAL for
  // back-compat: projects saved before this field load with undefined and read
  // boundaries coalesce it to 0 via `?? 0` (prior base === min Z preserved).
  autoOffsetZBottom?: number
  // Default dimensions used when creating the first FixedStockItem
  fixedWidth: number         // mm X
  fixedHeight: number        // mm Y
  fixedDepth: number         // mm Z
  // Named fixed stocks — when non-empty, these replace the single default block above.
  // Empty array = show single block using fixedWidth/Height/Depth at origin.
  fixedStocks: FixedStockItem[]
  // Named AUTO stocks — each sizes to its explicitly-assigned member geometry.
  // OPTIONAL for back-compat: projects saved before this field load unchanged
  // (undefined === no named auto stocks).
  autoStocks?: AutoStockItem[]
}

/** First-class, scene-level physical stock — the FIXTURING unit of the
 *  coordinate hierarchy (geometry has physical membership via
 *  ImportedGeometry.stockId; a setup's WCS can bind to a stock corner).
 *
 *  NOTE: distinct from the legacy per-setup `Stock` config interface above
 *  (Setup.stock); the plan's eventual reconcile of SceneStock/FixedStockItem/
 *  Setup.stock into this one type is deferred. Populated by
 *  migrateProjectToHierarchy; read starting Phase 1.
 *
 *  mode 'derived'  = bounds are COMPUTED from member geometry
 *                    (geometry.stockId === this.id) — done in Phase 1; the
 *                    stored `bounds` is a placeholder until then.
 *  mode 'explicit' = bounds + position are stored authoritatively. */
export interface PhysicalStock {
  id: string
  name: string
  mode: 'derived' | 'explicit'
  bounds: BoundingBox
  position: Vec3
  /** Controller work-offset slot assigned to this physical stock. Optional for
   *  backward compatibility: a legacy stock without one continues to use its
   *  setup WCS fixtureOffset until the user assigns the stock explicitly. */
  fixtureOffset?: number
  // Optional secondary work offset relative to the setup's primary WCS.
  // DATA ONLY in Phase 0 — emission is deferred.
  workOffset?: Vec3
}

// --- Toolpath Moves ---
export type MoveRole =
  | 'rapid'
  | 'cut'
  | 'helix'
  | 'ramp'
  | 'plunge'
  | 'stepover'
  | 'fast_traverse' // non-cutting reposition at depth through cleared stock; the
                    // postprocessor feeds it at the machine traverse/rapid rate
  | 'lead_in'
  | 'lead_out'
  | 'loop_back'
  | 'wall_follow'
  | 'finish' // dedicated wall-finishing pass (wallFinish feature); distinct from
             // wall_follow (which is a between-pass wall skim during roughing)

export interface ToolpathMove {
  type: 'rapid' | 'feed' | 'arc_cw' | 'arc_ccw'
  x: number
  y: number
  z: number
  /** Optional rotary endpoint coordinates, in degrees. These belong only to
   *  controller/file moves; CAM geometry remains Cartesian. */
  a?: number
  b?: number
  c?: number
  feed?: number      // mm/min
  cx?: number        // arc centre X (absolute)
  cy?: number        // arc centre Y (absolute)
  role?: MoveRole
  /** Peak radial engagement (mm) along this move. Set on 'cut' and deliberate 'wall_follow' moves;
   *  undefined on link/rapid roles. */
  engagement?: number
  /** Timed pause (milliseconds) the machine holds AFTER arriving at this move's end point,
   *  before the next move. The one canonical representation of a dwell (drill G82 bottom
   *  pause): the runtime estimate adds it, the canned-cycle post reads it as the G82 P word,
   *  and the expanded post emits it as a G4 block. Undefined = no pause. (WO-1516) */
  dwellMs?: number
}

// --- CAM Operations ---
export type OperationType =
  // 2.5D
  | 'face'
  | 'contour_2d'
  | 'pocket_2d'
  | 'adaptive_clearing_2d'
  | 'drill'
  | 'bore'
  | 'thread_mill'
  | 'engrave'
  | 'vcarve'
  | 'chamfer'
  | 'pattern'
  // 3D
  | 'parallel_3d'
  | 'waterline_3d'
  | 'adaptive_3d'
  | 'scallop_3d'
  | 'steep_shallow_3d'
  | 'pencil_3d'

// CAM-1 added 'degraded': a CAM op whose ModelReference lost its B-rep geometry
// (a referenced subshape is GONE). Distinct from 'outdated' (stale, still
// recomputable): degraded keeps its last-known toolpath, renders RED, blocks
// posting, and is STICKY (clears only when re-resolution later succeeds or the
// user re-selects geometry). 'outdated' stays amber (stale, needs re-post).
//
// CAM-BINDING Stage 1 added 'unsupported': an op whose declared SOURCE is a
// modeled body (format:'model', now a legal op-picker selection per Stage 1 -
// coordination/work-orders/CAM-BINDING.md) but whose compute path does not yet
// exist (Stage 2 builds it). Distinct from 'error' on purpose: nothing is
// broken - the source and the op are both valid, the app just cannot compute
// this shape's geometry yet. Distinct from 'pending' on purpose too: a bare
// 'pending' op recomputes cleanly the moment Compute is pressed; an
// 'unsupported' op will refuse again by name until Stage 2 ships (never a
// silent 'ready', never a false 'error'). Carries its explanatory message in
// `errorMessage` (same field 'error' uses - a generic "why can't this
// compute" slot, not an error-only one). No last-known toolpath exists for
// this status (an op can only reach it from 'pending', pre-first-compute), so
// unlike 'degraded' there is nothing stale to protect - it needs no schema
// version bump (mirrors migrateEmbedGeometryBinaries's "additive, benign to
// an older build" precedent, NOT CAM-1's "silently postable stale toolpath"
// hazard the v5 bump guarded against).
export type OperationStatus = 'pending' | 'computing' | 'ready' | 'error' | 'outdated' | 'degraded' | 'unsupported'

export interface FeedrateOverride {
  enabled: boolean
  rpm: number
  feedRate: number        // mm/min — cutting
  plungeRate: number      // mm/min — plunge
  rampFeedrate: number    // mm/min — ramp entry
  leadInFeedrate: number  // mm/min — lead-in arc
  leadOutFeedrate: number // mm/min — lead-out arc
  fastTraverseFeedrate: number // mm/min — fast traverse (keep-down reposition); clamped to machine rapidRate
  finishFeedrate?: number      // mm/min — wall-finishing pass; optional, defaults to the cutting feed
}

export type HeightPlaneName = 'clearance' | 'retract' | 'feed' | 'top' | 'bottom'

export type HeightReference =
  | HeightPlaneName
  | 'stock_top'
  | 'stock_bottom'
  | 'model_top'
  | 'model_bottom'
  | 'geometry_plane'
  | 'selected_feature_top'
  | 'selected_feature_bottom'
  | 'picked_surface'
  | 'wcs_plane'
  | 'machine_plane'
  | 'remaining_stock'

export type HeightIntentProvenance = 'default' | 'inferred' | 'user'

export interface HeightValueIntent {
  reference: HeightReference
  offset: number
  provenance: HeightIntentProvenance
}

export interface HeightIntentV1 {
  version: 1
  clearance: HeightValueIntent
  retract: HeightValueIntent
  feed: HeightValueIntent
  top: HeightValueIntent
  bottom: HeightValueIntent
}

/** Durable Smart Height V2 authority. Payloads cross the raw JSON boundary as
 * unknown and must pass the Smart Height runtime validator before use. */
export type PersistedOperationHeightState = {
  kind: 'smart_v2'
  intent: unknown
}

export interface ResolvedHeightSnapshotV1 {
  version: 1
  wcs: Record<HeightPlaneName, number>
  machine: Record<HeightPlaneName, number>
  intent: HeightIntentV1
  dependencyIds: string[]
}

export interface HeightParams {
  clearanceHeight: number
  clearanceHeightMode: 'absolute' | 'relative'
  retractHeight: number
  feedHeight: number
  topHeight: number
  topHeightMode: 'stock_top' | 'model_top' | 'absolute' | 'selected_face'
  bottomHeight: number
  bottomHeightMode: 'model_bottom' | 'absolute' | 'selected_face'
  // Data source for bottomHeightMode 'selected_face' (B-rep Stage 4): the
  // GEOMETRY-LOCAL model Z of the picked face plane at derive time (a derived
  // layer's projectionPlane.origin.z), or the min hole bottomZ for
  // drill-from-detected-holes. It is NOT world Z: the model may be moved after
  // the op is created, so dispatch adds the source geometry's position.z (step
  // sources only) and then converts to a WCS-relative bottomHeight (ADR 0002:
  // modes never reach the worker; bottomHeight stays the only Z the operation
  // sees).
  selectedFaceZ?: number
  // true when the user explicitly set the bottom of cut (typed a value, changed
  // the reference plane, or Cleared a picked-face bottom). Suppresses
  // recompute-time smart re-binding (cylinder-floor inference). Undefined/false =
  // auto: a smart default may re-resolve on recompute.
  bottomManual?: boolean
  /** CAM-15 authored height meaning. Legacy numeric fields remain during the
   * staged migration, but all new resolution/display code reads this record. */
  heightIntent?: HeightIntentV1
}

export interface PassParams {
  stepdown: number          // mm axial per pass
  stepover: number          // mm radial
  finishStepover?: number
  stockToLeave: number      // mm — for roughing
  /** Axial stock to leave (mm) - material left on the FLOOR / bottom of cut for a
   *  later finishing pass. The floor analog of the radial `stockToLeave`. Default 0.
   *  Honored by every cutting op that has a floor (contour/pocket/adaptive/face);
   *  meaningless for drill/chamfer/engrave/thread. When 0 (the default) the emitted
   *  toolpath is byte-identical to the pre-field behavior. The shared field WINS over
   *  a legacy per-op field (PocketParams.floorStockToLeave / FaceParams.floorStockToLeave),
   *  which is retained only as a back-compat fallback. */
  floorStockToLeave?: number
  finishPasses: number
  springPasses: number
  overlapMm?: number        // mm past loop start to prevent witness marks on closed contours
}

export interface LinkingParams {
  entryType: 'plunge' | 'ramp_linear' | 'ramp_helical' | 'arc'
  rampAngle: number
  rampLength: number
  leadInRadius: number
  leadOutRadius: number
  retractType: 'full' | 'partial' | 'minimum'
  transitionType: 'safe_height' | 'direct' | 'avoid_stock'
  /** WO-2835: how far (mm) the tool lifts over a cleared floor on a travel between two
   *  cuts, to avoid witness marks (operator ruling 2026-10-15: "0.2 to 0.5mm in most instances").
   *  Absent is moves/ DEFAULT_FLOOR_HOP_MM (0.3); 0 keeps the operation's old travel. */
  floorHopMm?: number
}

export interface AdaptiveRoughRegionBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface AdaptiveRoughRegionIssue {
  kind: 'skipped' | 'partial'
  z: number
  levelIndex: number
  componentIndex: number
  bounds: AdaptiveRoughRegionBounds
  reason: string
  passCount: number
}

export interface AdaptiveRoughDiagnostics {
  effectiveCellSize: number
  toolDiameter: number
  helixDiameter: number
  levelCount: number
  plannedRegions: number
  machinedRegions: number
  skippedRegions: number
  partialRegions: number
  reasonCounts: Record<string, number>
  issues: AdaptiveRoughRegionIssue[]
}

export interface OperationDiagnostics {
  adaptiveRough?: AdaptiveRoughDiagnostics
}

/**
 * WO-1223. The faces a 3D FINISHING pass is aimed at: "machine these faces,
 * not the whole part".
 *
 * `faceIds` are BRep face ids in the ONE numbering the whole app already uses
 * for a STEP solid -- the stable subshape index (TopExp_Explorer DFS
 * first-encounter order over the healed shape, ADR 0018 D3). That is the same
 * index the viewport face picker reports, the same `BrepModelPayload.faceRanges`
 * slot, and the same value `PartMesh.faceIds` carries per triangle
 * (cam3d/input/step.ts faceIdsFromRanges). One number, three consumers, no
 * translation table.
 *
 * ABSENT OR EMPTY MEANS THE WHOLE PART. Every operation authored before this
 * shipped therefore keeps its exact previous output, byte for byte, and an
 * old .camproject needs no migration (ADR-0040). A mesh with no `faceIds` at
 * all (every STL) cannot honour a scope and runs whole-part with one console
 * line -- the control is disabled there rather than lying about what it does.
 *
 * Stored in `Operation.params.faceScope`, the established home for every
 * 3D-finishing parameter (stepover, tolerance, stock to leave), not as a new
 * top-level Operation field: it is an operation PARAMETER, and params already
 * round-trips verbatim through save/load and the generation fingerprint.
 */
export interface Cam3dFaceScope {
  /** BRep face ids this pass may cut. Empty = the whole part. */
  faceIds: number[]
}

/** WO-2663: the plain reason an operation turned 'outdated'. `earlier-*`
 *  name the earlier operation in the setup whose change it was built on. */
export type OperationOutdatedReason =
  | { kind: 'earlier-changed' | 'earlier-removed' | 'earlier-enabled' | 'earlier-disabled'; operationName: string }
  | {
      kind:
        | 'order' | 'tool' | 'geometry' | 'settings' | 'stock' | 'origin' | 'parts'
        | 'workholding' | 'machine' | 'nest' | 'changed-while-computing' | 'history'
        | 'interrupted' | 'no-toolpath' | 'opened' | 'inputs'
    }

export interface Operation {
  id: string
  name: string
  type: OperationType
  enabled: boolean
  /** Optional membership in this operation's Setup.operationFolders. */
  folderId?: string | null
  status: OperationStatus
  toolId: string
  geometrySelections: string[]   // face/edge/body IDs from imported geometry
  /** CAM-1: typed references to B-rep MODEL geometry (bodyId + stableIds + role).
   *  Re-resolved on model regen by the re-resolution hook; drives stale/degraded.
   *  Optional + additive: absent on all pre-CAM-1 projects and populated only by
   *  CAM-2's boundary/stock/origin binding, so it needs no schema-version bump
   *  (verbatim (de)serialization; same precedent as floorStockToLeave/progress). */
  modelReferences?: ModelReference[]
  /** CAM-1: human-readable note attached by the re-resolution hook when a
   *  ModelReference fell back (which ids) or was lost (which body/ids). Rendered
   *  as the op status-badge tooltip. Cleared when re-resolution succeeds clean. */
  modelReferenceNote?: string
  /** WO-2663: why this operation turned 'outdated', recorded by the store the
   *  moment it does and dropped once it leaves 'outdated' (it recomputes).
   *  Rendered on the amber badge hover and the Summary Status row. */
  outdatedReason?: OperationOutdatedReason
  heights: HeightParams
  /** Smart Height V2 authority. Missing or invalid state is deliberately
   * non-computable until the user reauthors and saves the operation. */
  smartHeight?: PersistedOperationHeightState
  /** Exact effective planes used by the last successful generation. */
  resolvedHeights?: ResolvedHeightSnapshotV1
  /** Full immutable V2 resolution used by the last successful generation. */
  resolvedHeightPlan?: import('../lib/cam/smartHeights/types').ResolvedHeightPlanV2
  /** Deterministic claim binding saved moves to the exact resolved inputs. */
  generationFingerprint?: string
  passes: PassParams
  linking: LinkingParams
  feedrateOverride?: FeedrateOverride
  // Operation-specific params stored as a generic record
  params: Record<string, unknown>
  // Computed result
  toolpathMoves?: ToolpathMove[]
  computeTimeMs?: number
  /** Estimated machine execution ("cut") time for the computed moves (ms). */
  estimatedCutTimeMs?: number
  /** Set instead of estimatedCutTimeMs when the moves can't be timed: a
   *  legacy/degraded move reached the estimate without a finite positive feed
   *  (ADR-0003 refusal -- see estimateRuntimeMsOrError). Rendered as a named
   *  refusal state on the op card, never a silently-substituted number. */
  estimatedCutTimeMsError?: string
  errorMessage?: string
  /** Live recompute progress 0..1 while status === 'computing'; cleared when done. */
  progress?: number
  /** Optional human-readable phase label accompanying `progress` (e.g. "Z level 2/4"). */
  progressPhase?: string
  /** Structured strategy diagnostics surfaced in the operation properties. */
  diagnostics?: OperationDiagnostics
  /** WO-1683: set when the reach trim (WO-1565/1678) stopped this operation
   *  short of the depth it was asked to cut - the tree row and the operation's
   *  own panel show it. Cleared on a generation nothing trimmed. */
  reachShortfall?: import('../lib/cam/holderClearanceGate').OperationReachShortfall
  /** Contour holding-tab editor preview: each closed finish contour as a world
   *  XY polyline in cut order (seam first) plus the world tab-top Z. Derived
   *  at contour dispatch when tabs are enabled (computeContourTabPreviewLoop —
   *  the exact geometry the engine cuts, so viewport tab markers and cut tabs
   *  can never disagree). Optional + additive: absent everywhere else, no
   *  schema-version bump (verbatim (de)serialization, same precedent as
   *  modelReferences). */
  contourTabPreview?: ContourTabPreview
}

/** One closed finish contour of a contour op, as cut (see Operation.contourTabPreview). */
export interface ContourTabPreviewLoop {
  loopId: string
  /** Finish-contour polyline, world XY, cut order, seam (cut start) first. */
  path: Vec2[]
  /** Closed arc length of `path` (mm). Tab fractions are of THIS perimeter. */
  perimeter: number
}

export interface ContourTabPreview {
  loops: ContourTabPreviewLoop[]
  /** World Z of the retained tab tops (stock bottom + tab height). */
  tabTopZ: number
}

export interface OperationFolder {
  id: string
  name: string
  parentId?: string | null
  color?: string
}

// --- Setup ---

/** Records that a setup IS the second side of another: the same physical block
 *  of material, turned over about one axis, machined again (WO-288). Written at
 *  creation only. The two sides share one stock and therefore one work offset;
 *  src/lib/cam/flipSetup.ts owns the arithmetic and the refusals. */
export interface SetupFlip {
  /** The first side. */
  setupId: string
  /** Axis the part was turned over about. Turning about X is not the same as
   *  turning about Y, so it is recorded, never inferred. */
  axis: 'x' | 'y'
}

export interface Setup {
  id: string
  name: string
  wcs: WCS
  stock: Stock
  /** Present only on a setup created as the second side of another. */
  flipOf?: SetupFlip
  /** Authored setup-wide defaults inherited by newly-created operations.
   *  Optional only for backward compatibility; load migration backfills the
   *  canonical default intent. */
  defaultHeightIntent?: HeightIntentV1
  /** Setup-local organizational folders for CAM operations. */
  operationFolders?: OperationFolder[]
  operations: Operation[]
  /** WO-2437: machine actions (an operator stop, ...) in this setup's
   *  operation list, in list order. Absent and empty both mean none. */
  machineActions?: MachineAction[]
  /** Free note; the Setup panel edits it (WO-2438). */
  notes: string
  /** How the stock is held (WO-2438). Absent = none chosen. Information only. */
  holdingMethod?: import('../lib/workholding/holdingMethods').HoldingMethodId
}

/** WO-2437: a MACHINE ACTION - a step in the operation list that tells the
 *  machine or the operator something instead of cutting. It sits in the list
 *  like an operation (order, drag, on/off, rename) and posts at its place.
 *  A new action type adds its kind here, its own fields beside
 *  OperatorStopAction, and its entry in MACHINE_ACTION_TYPES. */
export type MachineActionKind = 'operator_stop' | 'run_macro'

interface MachineActionBase {
  id: string
  kind: MachineActionKind
  name: string
  /** Off = skipped by the post, like a suppressed operation. */
  enabled: boolean
  /** The operation this action runs immediately after, in list order; null =
   *  before the setup's first operation. */
  afterOpId: string | null
}

/** Retract, park at the machine's Operator stop park, show the message and
 *  wait for Cycle Start (for example to drive hold-down screws). */
export interface OperatorStopAction extends MachineActionBase {
  kind: 'operator_stop'
  /** Shown to the operator at the stop. May be empty. */
  message: string
}

/** Call the selected macro on the active machine by its current M-code. */
export interface RunMacroAction extends MachineActionBase {
  kind: 'run_macro'
  macroId: string
  /** The shared action update surface permits this; only Operator stop uses it. */
  message?: string
}

export type MachineAction = OperatorStopAction | RunMacroAction

/** Match the runtime's first shown binding for each M-code. A hidden macro
 *  does not run, and a second macro on the same code cannot be addressed. */
export function callableMachineMacros(machine: Pick<MachineConfig, 'macros' | 'controller' | 'controllerDefinition' | 'coolantCapability'>): Array<MachineMacro & { mCode: number }> {
  const dialect = gcodeTableDialectOf(machine.controller) ?? 'generic'
  const outputs = [...(machine.controllerDefinition?.outputs ?? [])]
  const vacuum = machineOutputForChannel(machine, 'vacuum') === null ? machineVacuumCapability(machine)?.onCode : undefined
  const table = gcodeWordTableWithOutputs(gcodeWordTable(dialect), vacuum
    ? [...outputs, { name: 'vacuum', onCode: vacuum, offCode: null }] : outputs)
  const seen = new Set<number>()
  return (machine.macros ?? []).filter((macro): macro is MachineMacro & { mCode: number } => {
    if (macro.hidden || typeof macro.mCode !== 'number' || !Number.isSafeInteger(macro.mCode) || macro.mCode < 0 || seen.has(macro.mCode)) return false
    seen.add(macro.mCode)
    // The program reader executes table/output codes as their standard
    // actions. M6 alone also runs its bound macro, as a tool-change prelude.
    if (macro.mCode !== 6 && gcodeWordEntry(table, 'M', macro.mCode) !== null) return false
    return true
  })
}

/** WO-2437: every machine action type, in the order the New operation menu's
 *  Machine actions group lists them. */
export const MACHINE_ACTION_TYPES: ReadonlyArray<{ kind: MachineActionKind; label: string }> = [
  { kind: 'operator_stop', label: 'Operator stop' },
  { kind: 'run_macro', label: 'Run macro' },
]

/** WO-2437: the name a machine action type shows by. */
export function machineActionLabel(kind: MachineActionKind): string {
  return MACHINE_ACTION_TYPES.find((type) => type.kind === kind)?.label ?? kind
}

/** WO-2437: a new machine action of `kind` with its default fields. */
export function newMachineAction(kind: MachineActionKind, id: string, afterOpId: string | null): MachineAction {
  switch (kind) {
    case 'operator_stop':
      return { id, kind, name: machineActionLabel(kind), enabled: true, afterOpId, message: '' }
    case 'run_macro':
      return { id, kind, name: machineActionLabel(kind), enabled: true, afterOpId, macroId: '' }
  }
}

// --- Units (display/export preference) ---
// Canonical internal unit is millimeters (ADR-0022). `Units` names the two
// user-facing choices; conversion happens only at the two edges (the UI shim
// src/lib/ui/unitFormat.ts and the postprocessor export formatter). The shared
// definition lives here so both the store/types and the shim reuse ONE type.
export type Units = 'mm' | 'inch'

// Named B-rep render-fidelity tiers (tessellation quality). Each maps to a
// (linearDeflection, angularDeflection) pair in
// src/lib/cam/geometry/occt/model/quality.ts. Higher fidelity = smoother
// curved surfaces but more mesh memory and slower STEP load.
export type BrepTessellationQuality = 'performance' | 'balanced' | 'high'

// Stock-simulation engine selection (ADR-0028). 'voxel' = the 3D raymarched SDF
// engine (true material removal incl. undercuts, needs a WebGL2 GPU with
// float-3D-texture linear filtering); 'heightmap' = the legacy 2.5D engine
// (lighter, runs on almost anything); 'auto' = voxel when the GPU supports it,
// else fall back to heightmap (the SimulationPanel resolves the effective
// engine at sim-init via CNCViewport.supportsVoxelSim()).
export type SimulationEngine = 'auto' | 'voxel' | 'heightmap'

// --- App settings (global preferences) ---
// App-level preferences that persist across projects in localStorage. These
// are deliberately NOT part of `Project` and never round-trip through the
// .camproject file — they live as a sibling of `project` at the store root so
// saveProjectToFile (which serializes only `project`) cannot leak them.
export interface AppSettings {
  /**
   * WO-937: has this browser been given the LienCNC machine yet?
   *
   * `machineLibrary` is persisted, so seeding the initial state alone never
   * reaches a browser that already has a saved library - which is exactly
   * Operator's, holding the GRBL "My CNC Router" he opened and complained about.
   *
   * Absent means "this blob predates the seed": add the machine ONCE and set
   * the flag. Present means leave the library alone. The default settings
   * carry `true`, so any state built from defaults is already considered
   * seeded and the persistence round-trip stays byte-faithful - a migration
   * that ran on every rehydrate would break the "what you saved is what you
   * get back" contract that INT-21 exists to defend.
   */
  liencncSeeded?: boolean
  // Default STL->2D projection simplification tolerance (mm), used when a
  // geometry has no per-model `projectionTolerance` of its own. The per-model
  // control was removed (now global); legacy projects with a pinned value
  // still override this via the `geo.projectionTolerance ?? default` chain.
  projectionToleranceDefault: number
  // 3D-view navigation: which CAD-package mouse scheme orbits/pans/zooms the
  // viewport (applied to Three.js OrbitControls `.mouseButtons`/`.touches`),
  // plus invert toggles for zoom and pan direction. App-level input habit, not
  // project data. See NAV_PRESETS for the id -> button-mapping table.
  navPreset: NavPresetId
  invertZoom: boolean
  invertPan: boolean
  // Units shown and entered in the UI (display) and the units of the exported
  // g-code (export). Independent (ADR-0022): a user may design in inch but post
  // mm, or vice versa. Both default to 'mm'; the internal model stays mm-only,
  // these only drive the UI shim and the post export formatter.
  displayUnits: Units
  exportUnits: Units
  // Default Z thickness prefilled into the nest thickness selector + new bound
  // stocks (N1d).
  defaultStockThicknessMm: number
  // Default XY padding added around a nest sheet when sizing its bound stock (N1d).
  defaultStockPaddingXYMm: number
  // Id of the user's preferred default machine (a MachineConfig.id in the
  // machine library). A NEW project binds a copy of this profile instead of the
  // generic placeholder. null = no default set (fall back to the generic
  // 'My CNC Router'). Persisted in localStorage; back-compat via the persistMerge
  // spread (no migration needed). Cleared if the referenced machine is removed.
  defaultMachineId: string | null
  // B-rep (STEP) render fidelity tier. Drives the BRepMesh deflection used when
  // tessellating imported STEP solids (see quality.ts). Applies at import and on
  // project reload; lower it on weak hardware. Back-compat via persistMerge spread.
  brepTessellationQuality: BrepTessellationQuality
  // Stock-simulation engine preference (ADR-0028). 'auto' uses the 3D voxel
  // engine when the GPU supports it (WebGL2 + float-3D-texture linear filtering)
  // and falls back to the 2.5D heightmap otherwise; 'voxel'/'heightmap' force
  // one engine. Back-compat via the persistMerge spread (no migration needed).
  simulationEngine: SimulationEngine
  // Whether the LienCAM intro splash animation plays on app load. Read
  // SYNCHRONOUSLY by the inline boot script in index.html (straight from the
  // persisted localStorage blob, before React mounts) so unchecking it is
  // honored on the very next boot. Default true. Back-compat via persistMerge.
  showSplash: boolean
}

// --- Navigation presets (3D viewport mouse scheme) ---
// A preset maps each mouse button to a camera action. Two kinds coexist:
//
//  - BARE-BUTTON presets (a button alone performs its action, no modifiers) —
//    expressed directly by Three.js OrbitControls `.mouseButtons`.
//  - MODIFIER-GATED presets reserve LEFT for select and gate orbit-vs-pan-vs-zoom
//    on a modifier + MIDDLE drag. OrbitControls `.mouseButtons` has no per-button
//    slots, so these carry a `modifierRules` table that a capture-phase
//    pointer layer in the viewport resolves per gesture (see resolveNavAction
//    + CNCViewport.applyNavPreset / the modifier remapper). See
//    docs/planning/NAV-MODIFIER-SPIKE.md for why this is sound.
//
// A preset with NO `modifierRules` is a pure bare-button preset and behaves
// exactly as before — the modifier remapper is not installed for it.
export type NavPresetId =
  | 'liencnc-default'
  | 'onshape'
  | 'orbit-middle'
  | 'fusion'
  | 'solidworks'
  | 'inventor'
  | 'creo'

// The camera action a mouse button performs. 'none' leaves the button free for
// selection/marquee (it is mapped to `null` in OrbitControls). The viewport
// layer translates these to THREE.MOUSE.ROTATE/PAN/DOLLY (see CNCViewport).
export type NavButtonAction = 'orbit' | 'pan' | 'zoom' | 'none'

// The modifier state read off a pointer event (subset of MouseEvent flags).
export interface NavModifierState {
  shift: boolean
  ctrl: boolean
  alt: boolean
}

// One modifier-gated rule: when `button` is pressed with EXACTLY this modifier
// combination, perform `action`. A rule with all-false modifiers is the
// bare-button case for that button. Rules are matched most-specific-first by
// resolveNavAction; an unmatched gesture falls back to the static mouseButtons
// mapping for that button.
export interface NavModifierRule {
  button: 'LEFT' | 'MIDDLE' | 'RIGHT'
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
  action: NavButtonAction
}

export interface NavPreset {
  label: string
  // Static bare-button mapping for the three mouse buttons. Always present —
  // it is the fallback when no modifier rule matches (and the whole mapping for
  // a bare-button preset).
  mouseButtons: { LEFT: NavButtonAction; MIDDLE: NavButtonAction; RIGHT: NavButtonAction }
  // Optional modifier-gated rules (faithful CAD presets). When present, the
  // viewport installs a capture-phase pointer remapper that resolves the
  // effective action per gesture via resolveNavAction. Absent => pure
  // bare-button preset (today's behavior, no remapper installed).
  modifierRules?: NavModifierRule[]
  // Touch mapping kept simple/uniform: 1-finger orbits, 2-finger dolly+pans —
  // the OrbitControls default — across all presets for now.
  touches: { ONE: 'orbit' | 'pan'; TWO: 'dolly-pan' | 'dolly-rotate' }
}

// Presets. Order here is the dropdown order in the Settings Navigation section.
export const NAV_PRESETS: Record<NavPresetId, NavPreset> = {
  // Current Three.js OrbitControls default: LEFT orbits, RIGHT pans, MIDDLE
  // (and wheel) zooms. This is today's shipping behavior — the safe default.
  // WO-268: the id `liencnc-default` is PERSISTED in appSettings and must not
  // be renamed (it would orphan every saved navigation preference). Only the
  // user-visible label carries the product name.
  'liencnc-default': {
    label: 'LienCAM default (left-orbit)',
    mouseButtons: { LEFT: 'orbit', MIDDLE: 'zoom', RIGHT: 'pan' },
    touches: { ONE: 'orbit', TWO: 'dolly-pan' },
  },
  // Right-button orbit scheme: RIGHT orbits, MIDDLE pans, LEFT is free for select.
  onshape: {
    label: 'Right-button orbit',
    mouseButtons: { LEFT: 'none', MIDDLE: 'pan', RIGHT: 'orbit' },
    touches: { ONE: 'orbit', TWO: 'dolly-pan' },
  },
  // MIDDLE orbits, RIGHT pans, LEFT is free for select (middle-button-orbit
  // for the orbit button; not a faithful modifier-gated CAD scheme).
  'orbit-middle': {
    label: 'Orbit on middle button',
    mouseButtons: { LEFT: 'none', MIDDLE: 'orbit', RIGHT: 'pan' },
    touches: { ONE: 'orbit', TWO: 'dolly-pan' },
  },
  // --- Faithful modifier-gated presets (RECON AREA 3) ---
  // Pan-first scheme: MIDDLE = pan, Shift+MIDDLE = orbit, wheel = zoom, LEFT = select.
  fusion: {
    label: 'Middle-button pan + Shift orbit',
    mouseButtons: { LEFT: 'none', MIDDLE: 'pan', RIGHT: 'none' },
    modifierRules: [
      { button: 'MIDDLE', action: 'pan' },                  // bare MMB = pan
      { button: 'MIDDLE', shift: true, action: 'orbit' },   // Shift+MMB = orbit
    ],
    touches: { ONE: 'orbit', TWO: 'dolly-pan' },
  },
  // Orbit-first Ctrl-pan scheme: MIDDLE = orbit, Ctrl+MIDDLE = pan, Shift+MIDDLE = zoom,
  // wheel = zoom, LEFT = select.
  solidworks: {
    label: 'Middle-button orbit + Ctrl pan',
    mouseButtons: { LEFT: 'none', MIDDLE: 'orbit', RIGHT: 'none' },
    modifierRules: [
      { button: 'MIDDLE', action: 'orbit' },                // bare MMB = orbit
      { button: 'MIDDLE', ctrl: true, action: 'pan' },      // Ctrl+MMB = pan
      { button: 'MIDDLE', shift: true, action: 'zoom' },    // Shift+MMB = zoom
    ],
    touches: { ONE: 'orbit', TWO: 'dolly-pan' },
  },
  // Pan-first Ctrl-zoom scheme: MIDDLE = pan, Shift+MIDDLE = orbit,
  // Ctrl+MIDDLE = zoom, wheel = zoom, LEFT = select.
  inventor: {
    label: 'Middle-button pan + Shift orbit + Ctrl zoom',
    mouseButtons: { LEFT: 'none', MIDDLE: 'pan', RIGHT: 'none' },
    modifierRules: [
      { button: 'MIDDLE', action: 'pan' },                  // bare MMB = pan
      { button: 'MIDDLE', shift: true, action: 'orbit' },   // Shift+MMB = orbit
      { button: 'MIDDLE', ctrl: true, action: 'zoom' },     // Ctrl+MMB = zoom
    ],
    touches: { ONE: 'orbit', TWO: 'dolly-pan' },
  },
  // Orbit-first Shift-pan scheme: MIDDLE = orbit, Shift+MIDDLE = pan, Ctrl+MIDDLE = zoom,
  // wheel = zoom, LEFT = select.
  creo: {
    label: 'Middle-button orbit + Shift pan + Ctrl zoom',
    mouseButtons: { LEFT: 'none', MIDDLE: 'orbit', RIGHT: 'none' },
    modifierRules: [
      { button: 'MIDDLE', action: 'orbit' },                // bare MMB = orbit
      { button: 'MIDDLE', shift: true, action: 'pan' },     // Shift+MMB = pan
      { button: 'MIDDLE', ctrl: true, action: 'zoom' },     // Ctrl+MMB = zoom
    ],
    touches: { ONE: 'orbit', TWO: 'dolly-pan' },
  },
}

// --- Pure modifier -> action resolver (unit-testable, no DOM/Three) ---
// Given a preset, the pressed button, and the modifier state, return the
// camera action the FAITHFUL scheme intends. The viewport remapper then
// compensates for OrbitControls' own modifier swap (see NAV-MODIFIER-SPIKE.md)
// before writing controls.mouseButtons.
//
// Matching: among the preset's modifierRules for `button`, pick the rule whose
// shift/ctrl/alt EXACTLY equals the gesture's modifier state (a rule omitting a
// modifier means that modifier must be false). If none matches, fall back to
// the static mouseButtons mapping for that button. A preset with no
// modifierRules always uses the static mapping.
export function resolveNavAction(
  preset: NavPreset,
  button: 'LEFT' | 'MIDDLE' | 'RIGHT',
  mods: NavModifierState,
): NavButtonAction {
  const rules = preset.modifierRules
  if (rules) {
    for (const rule of rules) {
      if (rule.button !== button) continue
      const wantShift = rule.shift ?? false
      const wantCtrl = rule.ctrl ?? false
      const wantAlt = rule.alt ?? false
      if (wantShift === mods.shift && wantCtrl === mods.ctrl && wantAlt === mods.alt) {
        return rule.action
      }
    }
  }
  return preset.mouseButtons[button]
}

// --- Navigation invert sign helpers (pure, unit-testable) ---
// OrbitControls treats zoomSpeed/panSpeed as MAGNITUDE only, so direction
// inversion is done by flipping the SIGN of the wheel/pan deltas before
// OrbitControls consumes them. These two helpers are the single source of
// truth for that sign so the viewport interceptors and the tests agree.
//
// Wheel (zoom): OrbitControls dollies IN when deltaY < 0 and OUT when
// deltaY > 0 (see OrbitControls._handleMouseWheel). Inverting zoom = negate
// deltaY so wheel-up becomes zoom-out and vice versa. invert=false is the
// identity (byte-identical to the default wheel behavior).
export function navInvertWheelDeltaY(deltaY: number, invertZoom: boolean): number {
  return invertZoom ? -deltaY : deltaY
}

// Pan (drag): OrbitControls._pan(deltaX, deltaY) moves the camera target by
// the screen-space deltas. Inverting pan = negate BOTH deltas so a drag moves
// the view the opposite way. invert=false is the identity.
export function navInvertPanDelta(
  deltaX: number,
  deltaY: number,
  invertPan: boolean,
): { x: number; y: number } {
  return invertPan ? { x: -deltaX, y: -deltaY } : { x: deltaX, y: deltaY }
}

// --- Nesting (instanced data model, ADR 0024) ---
// The nest is stored as a record set, NOT duplicated geometry: it references
// each source part by geometryId and holds the engine's placements. The renderer
// (P3.2) instances each placement from the single stored source geometry. The
// engine shapes (NestStyle / Spacing / Placement) are imported from the nesting
// module so this record stays the single source of truth and never drifts.
import type { NestStyle, Spacing, Placement, SolverMode } from '../lib/cam/nesting/types'

/** A stored nest: one sheet packed with placements of source parts. References
 *  source geometry by id (NO geometry duplication, ADR 0024). `unplaced` is kept
 *  EXPLICITLY (ADR 0003 — leftovers are reported, never silently dropped). Surfaces
 *  as a renameable pseudo "Nest Geometry" node in the design tree (P3.3). */
export interface NestRecord {
  id: string
  name: string
  /** Sheet stock the parts are packed onto (mm) — fixed size, or the size the
   *  solver produced for a fixQty request. */
  sheet: { width: number; height: number }
  /** Rotation freedom used for the pack (mirrors the engine request). */
  style: NestStyle
  /** Orientation samples used for style 'arbitrary' (mirrors the engine request;
   *  ignored for 'ninety'). Stored so EDIT can faithfully prefill an
   *  arbitrary-style nest's rotation count. Optional for back-compat with nests
   *  persisted before this field existed (prefill falls back to 4). */
  rotationCount?: number
  /** Clearances applied via polygon offsets (mm). */
  spacing: Spacing
  /** Solver objective the pack ran under (fixSheet max-qty vs fixQty min-sheet).
   *  Stored so a recompute reproduces the SAME objective instead of silently
   *  reverting to a default. Optional for back-compat with nests persisted before
   *  this field existed (recompute falls back to fixSheet). */
  solver?: SolverMode
  /** Deterministic seed — same inputs + seed => byte-identical placements. */
  seed: number
  /** Douglas-Peucker tolerance for the NFP/placement proxy rings (mm). Omitted =>
   *  the engine default. Stored so a recompute reproduces the same pack. */
  curveTolerance?: number
  /** Source parts and how many of each were requested. geometryId references the
   *  project's ImportedGeometry; the loops are resolved fresh at compute time.
   *  `locked` (P4.1) pins that source to its source orientation on (re)compute. */
  sources: {
    geometryId: string
    quantity: number
    locked?: boolean
    /** true when the source part was imported from within the nest modal (lives only inside the nest); false/undefined = a pre-existing workspace geometry that stays at root. */
    ownedByNest?: boolean
  }[]
  /** Engine output: one record per placed instance (poses are in sheet coords). */
  placements: Placement[]
  /** Engine output: leftovers grouped by source part with exact counts (ADR 0003). */
  unplaced: { partId: string; count: number }[]
  /** Engine output: placed source-area / sheet area in [0,1]. */
  utilization: number
  /** Wall-clock ms the worker spent packing this nest (diagnostic; mirrors
   *  Operation.computeTimeMs). Absent on a freshly-created 'computing' record and
   *  on nests persisted before this field existed. Rides persistence (a result
   *  fact like utilization), unlike the transient status/error below. */
  computeTimeMs?: number
  /** Viewport visibility toggle (P3.2/P3.3). Absent => visible. */
  visible?: boolean
  /** STALE flag (owned-seed model): set true when an owned seed's loops change
   *  (edit/delete a layer) AFTER the pack, so the stored placements no longer
   *  reflect the seed's current footprint. The user clicks Recompute to re-pack
   *  (no auto-repack — Operator's decision). PERSISTED (a fact about the stored pack,
   *  unlike the transient status/error below); applyNestResult clears it because a
   *  fresh (re)pack is up to date. Absent => fresh. */
  needsRecompute?: boolean
  /** TRANSIENT compute state (P4.2) — NOT persisted (stripped in
   *  persistPartialize so a reload never leaves a stale 'computing'). The New
   *  Nest modal subscribes to this to drive its spinner / result summary /
   *  error message (ADR 0003 — a failed pack surfaces, never silently stuck).
   *  'computing' = a pack is in flight; 'ready' = applyNestResult landed;
   *  'error' = the worker reported NEST_ERROR. Absent + has placements => ready. */
  status?: 'computing' | 'ready' | 'error'
  /** Failure message set alongside status==='error' (ADR 0003). Transient. */
  error?: string
  /** TRANSIENT wall-clock start of the in-flight pack (Date.now() when status
   *  flips to 'computing'). Drives the persistent "Computing... Ns" live timer in
   *  NestProperties / the status bar (the modal keeps its own). NOT persisted
   *  (stripped in persistPartialize alongside status/error so a reload never
   *  restores a stale start). applyNestResult need not clear it — every surface
   *  gates on status==='computing'. Absent => show "Computing..." with no number. */
  computeStartedAt?: number
  /** Sheet Z thickness in mm; seeds + syncs with the bound fixed stock's depth (N1d). */
  thickness?: number
  /** id of the FixedStockItem auto-created to back this nest's sheet (N1d). */
  boundStockId?: string
  /** Nest world origin (XY); the bound stock + render group ride this. Default
   *  treated as {x:0,y:0}. Forward-looking for move-coupling. */
  origin?: Vec2
  /** P7 multi-copy cut ordering (ADR 0024 Amendment 1). 'by-operation' = each
   *  op runs across ALL copies before the next op (fewer tool changes);
   *  'by-part' = all ops finish one copy before the next (frees parts as you go).
   *  Consumed by the nest expander; does NOT restale the seed toolpaths (they are
   *  seed-local). Optional: undefined === 'by-operation' (the default). */
  machiningOrder?: 'by-operation' | 'by-part'
}

// --- Project ---

/** Portable, selection-capable STEP render payload. Typed arrays use a fixed
 *  little-endian binary contract and are base64-encoded so the payload remains
 *  valid JSON. Versioned independently from the project schema: readers that do
 *  not understand this optional field can continue restoring from `step`. */
export interface PortableBrepModelPayloadV1 {
  version: 1
  encoding: 'base64-le'
  displayContractVersion: 1
  /** Present only when mesh.ao carries the version-1 deterministic AO bake. */
  aoVersion?: 1
  sourceSha256: string
  tessellation: {
    linearDeflection: number
    angularDeflection: number
  } | null
  faceCount: number
  edgeCount: number
  solidCount: number
  bbox: { min: [number, number, number]; max: [number, number, number] }
  mesh: {
    positions: string
    normals: string
    indices: string
    faceRanges: string
    ao?: string
  }
  edges: {
    positions: string
    edgeRanges: string
  }
  faceTypes: string
}

/** Embedded binary payloads that make a .camproject self-contained (schema v4,
 *  ADR-0027). Raw STL/STEP source remains the required portable truth. STEP
 *  entries may additionally carry a validated render payload so project open can
 *  draw immediately without parsing/healing/tessellating the raw source first.
 *  Optional + absent for 2D-only projects and older files. */
export interface ProjectBinaries {
  [geometryId: string]: {
    stl?: string
    step?: string
    stepDisplay?: PortableBrepModelPayloadV1
  }
}

export interface Project {
  /** Display-only pictures for tracing in the 2D Sketch tab; absent in older projects. */
  referenceImages2d?: ReferenceImage2d[]
  id: string
  name: string
  version: string
  // Portable .camproject document schema version (ADR-0027); absent => v0.
  schemaVersion?: number
  createdAt: string
  updatedAt: string
  machine: MachineConfig
  toolLibrary: Tool[]
  toolLibraries?: ToolLibrary[]   // named library defs carried with the project
  holders?: ToolHolder[]          // holders used by the project's tools
  geometry: ImportedGeometry[]
  // DesignTree organisational folders (Stage A). Optional -> old persisted/loaded
  // projects with no folders read as `undefined` (everything is at the root); no
  // migration needed. Geometry references a folder via ImportedGeometry.folderId.
  geometryFolders?: GeometryFolder[]
  // WO INT-17C Stage C1 step 6: the project's Model Items list (tree-visible
  // "Model Items" group, "New Model Item" command). Optional -> absent on
  // every pre-C1 project and on any project that has not used the feature
  // yet; absence means "no Model Items created", not an error - every
  // reader defaults to `[]` (mirrors geometryFolders' own optional-array
  // contract immediately above). UNRELATED to and unchanged by `document`
  // (:1252) in step 6 - the v12 migration (Stage C1 step 7) is what wraps
  // an existing `document` into this same list for OLD projects; step 6
  // only lets a project grow ADDITIONAL items alongside the untouched
  // legacy single-document flow.
  modelItems?: ModelItemRecord[]
  // WO INT-17C Stage C1 step 7 (v12 migration): the project-owned Placement
  // registry for `modelItems` above. Optional -> absent whenever no Model
  // Item has ever needed one (every pre-C1 project; every project with no
  // model-backed geometry rows). The v12 migration is the FIRST writer,
  // backfilling one body-filtered record per pre-existing model row so the
  // migration is lossless; Stage C1 ships no UI to create one by hand (the
  // WO's own "Placement seam ships as an identity-stub" scoping, Stage C2
  // is what makes these user-editable).
  modelItemPlacements?: ModelItemPlacementRecord[]
  setups: Setup[]
  activeSetupId: string | null
  activeOperationId: string | null
  sceneStock: SceneStock
  // First-class scene-level physical stocks (coordinate hierarchy). Populated by
  // migrateProjectToHierarchy; read starting Phase 1. Coexists with sceneStock
  // (the legacy stock-rendering config) until the Phase-1+ reconcile.
  stocks?: PhysicalStock[]
  // Stored nests (instanced data model, ADR 0024). Optional -> old persisted/
  // loaded projects with no nests read as `undefined`; no migration needed (the
  // field rides through persistPartialize and loadProjectFromFile by spread).
  nests?: NestRecord[]
  // Embedded STL/STEP binary payloads (schema v4, ADR-0027). Optional -> 2D-only
  // projects and pre-v4 files have none (they read mesh/brep bytes from IndexedDB
  // as before). Populated on save by collectProjectBinaries; consumed on load by
  // hydrateCachesFromBinaries BEFORE the scene restore. See src/lib/projectBinaries.ts.
  binaries?: ProjectBinaries
  // The parametric modeling document (schema v9, WO INT-14): the DOC-3 zip
  // archive (src/doc/persist/format.ts) base64-encoded, so the model rides
  // INSIDE the .camproject and Save/Open carry it with no second file. Optional
  // -> a 2D-only project (and every pre-v9 file) has none and omits the field
  // entirely, exactly as `binaries` above is omitted for a project with no
  // STL/STEP parts. Populated on save from the live workbench document (or the
  // loaded bytes, passed through untouched when the Model workspace was never
  // opened); consumed on load by loadDocumentArchive. The document carries its
  // OWN schema axis (versioning.ts's CURRENT_SCHEMA_VERSION), independent of
  // this project schemaVersion. See src/doc/documentHolder.ts.
  //
  // A FILE field, NOT live session state: loadProjectFromFile decodes it into
  // the document holder and strips it from the project it installs, and
  // saveProjectToFile always re-derives it from the holder rather than trusting
  // a copy on the project object. So this is populated on a project that was
  // just parsed from (or is about to be written to) disk, and absent on the one
  // in the store. Two live copies of the model is exactly the drift this note
  // exists to prevent.
  document?: string
  // WO INT-17C Stage C1 CLOSURE (gap 1): per-item archive bytes for every
  // NON-legacy Model Item -- the legacy item's own archive keeps riding on
  // `document` immediately above, UNCHANGED (step 7's own disclosed
  // deviation stays exactly as shipped; this field only extends the
  // save/load boundary AROUND it, per the closure mission's binding
  // constraint not to touch that decision). Keyed by ModelItemRecord.id
  // (the legacy id is NEVER a key here -- that archive is `document`),
  // base64 of the SAME liencam-3d-zip archive format `document` uses
  // (ADR-0034's format reused unchanged, only cardinality changes, per
  // INT-17C.md's own data-model ruling). Optional/absent-per-key mirrors
  // `document`'s own contract: omitted for an item that has no capturable
  // content at save time (mirrors isEmptyDocument's "don't perturb an
  // untouched document" rule, and is also what a live-authored item whose
  // Editing Space was switched away from without a stash-on-unmount path
  // yields today -- see the CLOSURE commit's disclosed limitation) -- an
  // absent key is NOT an error. Populated on save by iterating
  // `Project.modelItems` (skipping the legacy id) and calling
  // collectDocumentArchive(item.id); consumed on load, item-by-item, by
  // stashLoadedDocument -- decode-validated for EVERY item (legacy +
  // every non-legacy entry present here) BEFORE any project state
  // installs, so one corrupt item's archive aborts the WHOLE open
  // (ADR-0003), never a silent partial load. A FILE field, NOT live
  // session state -- same two-copy-drift warning `document`'s own comment
  // states immediately above, stripped on the way in and re-derived fresh
  // on the way out.
  modelItemDocuments?: Record<string, string>
  // WO-2167 (workholding assemblies, slice 1): reusable workholding
  // DEFINITIONS (a vise = several components, one on a linear joint; a clamp =
  // one component) and setup-scoped INSTANCES (a placed copy: world pose,
  // joint values, setups). Saved with the project; every edit is one undo
  // step. Absent = none defined - a body marked `ImportedGeometry.workholding`
  // still counts, resolved as a one-component instance in every setup (see
  // src/lib/workholding/resolveWorkholding.ts, the ONE resolver).
  workholding?: WorkholdingModel
  // WO-2637: per-program tool numbers, toolId -> the number that tool posts
  // as in this project's programs, chosen on the Post Process screen to
  // resolve a shared tool number. The tool library keeps its own numbers.
  // Saved with the project; absent = every tool posts its library number
  // (src/lib/post/toolNumbers.ts, read by buildPostInput).
  postToolNumbers?: Record<string, number>
  notes: string
}

// --- Workholding assemblies (WO-2167, docs/design/WORKHOLDING-ASSEMBLIES.md) ---

/** A rigid placement: position in mm plus Euler rotation in DEGREES applied in
 *  three.js 'XYZ' order - the same convention ImportedGeometry and the viewport
 *  group use (rotationMatrixXYZ). */
export interface WorkholdingPose {
  position: Vec3
  rotation: Vec3
}

/** A component that slides along one axis of its definition's frame (a vise's
 *  moving jaw). The saved joint value is a displacement in mm along `axis`
 *  (normalised when resolved), kept within [minMm, maxMm]. */
export interface WorkholdingLinearJoint {
  kind: 'linear'
  axis: Vec3
  minMm: number
  maxMm: number
  /** The value a new instance starts at, and the value used when none is saved. */
  closedAtMm: number
}

export interface WorkholdingComponent {
  id: string
  name: string
  /** A project geometry row whose shape this component uses. The row is shape
   *  data only: the resolver places it, never the row's own scene pose. */
  geometryId: string
  /** The component's shape frame within the definition frame. */
  localPose: WorkholdingPose
  joint?: WorkholdingLinearJoint
}

export interface WorkholdingDefinition {
  id: string
  revision: number
  name: string
  kind: 'vise' | 'clamp' | 'fixture'
  components: WorkholdingComponent[]
}

export type WorkholdingSetupScope =
  | { kind: 'all' }
  | { kind: 'setups'; setupIds: string[] }

export type WorkholdingPlacement =
  | { kind: 'free' }
  | {
      kind: 'boundary'
      target: { kind: 'stock' | 'part'; id: string; loopId: string }
      fraction: number
      normalOffsetMm: number
      yawOffsetDeg: number
      lastResolvedWorldPose: WorkholdingPose
    }

export interface WorkholdingInstance {
  id: string
  definitionId: string
  definitionRevision: number
  setupScope: WorkholdingSetupScope
  /** The definition frame in the world (project coordinates, not a WCS). */
  worldPose: WorkholdingPose
  /** Joint displacement in mm, keyed by component id. */
  jointValuesMm: Record<string, number>
  placement?: WorkholdingPlacement
}

export interface WorkholdingModel {
  definitions: WorkholdingDefinition[]
  instances: WorkholdingInstance[]
}

// --- B-rep subshape selection (ADR 0018 D3) ---
// Identity = integer face/edge index in TopExp_Explorer DFS order over the
// healed shape (stable for same STEP bytes + same OCCT build). Indices line up
// 1:1 with BrepModelPayload.mesh.faceRanges / edges.edgeRanges.
export interface BrepSelection {
  geoId: string
  kind: 'face' | 'edge'
  index: number
}

// --- UI State (not persisted) ---
export type ViewMode = 'setup' | 'toolpath' | 'simulation' | 'sketch'
/** INT-13A (D2.1): which top-level application workspace is active — CAM (setups,
 *  toolpaths, simulation, sketch) or the 3D modeling workspace (the parametric B-rep modeller).
 *  Orthogonal to ViewMode, deliberately NOT folded into it: `viewer.mode` describes
 *  what the CAM viewport shows and is only meaningful when `workspace === 'cam'`.
 *  Keeping this a separate axis is what keeps `setViewerMode`'s sketch-lifecycle side
 *  effects (baking/deleting the active CAM sketch layer) from firing on a workspace
 *  switch — see setWorkspace in store/index.ts.
 *  MACHINE-CONTROL: 'control' is the machine-control workspace (GRBL sender) —
 *  same axis, same rationale: a live serial session must survive tab switches,
 *  so the Control host is retained like the Model workbench, never unmounted. */
export type Workspace = 'cam' | 'part' | 'control'
export type PanelId = 'operations' | 'tools' | 'stock' | 'machine' | 'properties'

/** CAD viewport shading display modes. 'shaded-edges' is the default and renders
 *  identically to the historical look (baseline restore). See displayModes.ts. */
export type ShadingMode = 'shaded-edges' | 'shaded-no-edges' | 'unshaded' | 'translucent'
export type StockSimulationDisplayMode = 'stock' | 'compare' | 'target'
/** Section-view clip axis (world space). The actual clipping UI is plumbed in a
 *  later task; the state + a working setSectionView land now. */
export type SectionAxis = 'x' | 'y' | 'z'

/** PP-MOVE-PICK: a toolpath MOVE/SEGMENT picked in the viewport (Toolpath view).
 *  Stores the RESOLVED facts of the picked segment captured at pick time, so the
 *  Properties panel renders them directly without re-sectioning / re-sampling the
 *  operation (the drawn toolpath is a flat concat of arc-sampled sections; the
 *  raw section a segment came from is not cheaply reconstructable in the panel).
 *  TRANSIENT (viewer slice, not persisted). Cleared when the toolpath re-renders,
 *  the view leaves Toolpath mode, or a competing selection is made. */
export interface SelectedMove {
  /** The operation this move belongs to (jump-to-op affordance + owner label). */
  operationId: string
  /** Index of the owning move within that operation's drawn section (0-based). */
  moveIndex: number
  /** Total moves in that operation's drawn section (for "Move N of M"). */
  moveCount: number
  /** The ORIGINAL move type (arc types preserved even though drawn as sampled
   *  linear feed segments). */
  moveType: ToolpathMove['type']
  /** Effective move role (cut/rapid/lead_in/finish/...); ADR-0002/0004 vocab. */
  role: string
  /** Segment start (world mm) = previous move's target. */
  from: Vec3
  /** Segment end (world mm) = this move's target. */
  to: Vec3
  /** Straight-line 3D length of the drawn segment (mm). */
  lengthMm: number
  /** The baked feed on the owning move (mm/min), if any. Undefined on rapids and
   *  feedless-by-design roles (fast_traverse/finish) — the panel resolves the
   *  effective rate + its SOURCE from role/type + the operation/machine. */
  feed?: number
}

export interface ViewerState {
  mode: ViewMode
  showStock: boolean
  showWorkpiece: boolean
  showToolpath: boolean
  showMachine: boolean
  showGrid: boolean
  showAxes: boolean
  showSeedOutline: boolean
  showMeasurements: boolean
  showHeightPlanes: boolean
  /** Toolpath-only adaptive roughing stock diagnostic. Defaults off so it does
   *  not obscure the part; users may enable it without affecting the ordinary
   *  toolpath or the Simulation mode stock-removal display. */
  showRoughingPreview: boolean
  /** Active CAD shading mode (default 'shaded-edges' = historical render). */
  shadingMode: ShadingMode
  /** Section-view state. The clipping UI comes later; these defaults are inert
   *  (sectionEnabled false -> setSectionView clears all clip planes). */
  sectionEnabled: boolean
  sectionAxis: SectionAxis
  sectionPosition: number
  sectionFlip: boolean
  sectionDragEnabled: boolean
  hiddenToolpathRoles: string[]
  hiddenHeightPlanes: string[]
  gridSpacing: number
  selectedFaceIds: string[]
  selectedEdgeIds: string[]
  /** Typed B-rep face/edge selections (Stage 2 picking). */
  brepSelections: BrepSelection[]
  selectedGeometryId: string | null
  /** TRANSIENT (NOT persisted): the nest currently selected in the DesignTree,
   *  mutually exclusive with selectedGeometryId AND the active operation
   *  (activeSetupId/activeOperationId). At most one of {geometry, op, nest} is
   *  selected at a time; selecting any one clears the other two. Drives the
   *  Properties panel showing the nest's settings (N1a). Lives in the viewer
   *  slice, so persistPartialize (which omits viewer) keeps it transient. */
  selectedNestId: string | null
  /** TRANSIENT (NOT persisted): the stock currently selected in the DesignTree /
   *  targeted by the viewport gizmo. TRI-EXCLUSION (ADR 0025 selection model):
   *  selectedGeometryId / selectedNestId / selectedStockId are mutually
   *  exclusive, and selecting ANY of the three clears the active operation
   *  (activeOperationId). At most one of {geometry, op, nest, stock} is selected
   *  at a time; selecting any one clears the others. Lives in the viewer slice so
   *  persistPartialize (which omits viewer) keeps it transient. */
  selectedStockId: string | null
  /** TRANSIENT (NOT persisted): the tree LAYER row currently selected
   *  (PP-UTILITY Stage 3). `selectedLayerGeoId` names the owning geometry —
   *  required because a layer id alone does not uniquely resolve a layer
   *  (DXF layer ids ARE the layer name and SVG ids collide on re-import,
   *  same reasoning `openSketchForLayer`'s own `geoId` param documents).
   *  Mutually exclusive with `selectedFolderId`, `selectedGeometryId`,
   *  `selectedNestId`, and `selectedStockId` — selecting any one of the five
   *  clears the other four. Selecting geometry/nest/stock also clears an
   *  active layer selection (extends, but does not change, the existing
   *  ADR-0025 tri-exclusion + N1a rules those three already had). */
  selectedLayerId: string | null
  /** Owning geometry id for `selectedLayerId`; null whenever the layer
   *  selection itself is null. */
  selectedLayerGeoId: string | null
  /** TRANSIENT (NOT persisted): the tree FOLDER row currently selected
   *  (PP-UTILITY Stage 3) — either a geometry-list organizational folder
   *  (the project's `geometryFolders` array) or a per-setup operation folder
   *  (`Setup.operationFolders`). `selectedFolderKind` disambiguates which;
   *  `selectedFolderSetupId` names the owning setup for an operation folder
   *  (folder ids are only unique WITHIN a setup) and is null for a geometry
   *  folder. Mutually exclusive with `selectedLayerId`, `selectedGeometryId`,
   *  `selectedNestId`, and `selectedStockId`, on the same terms as
   *  `selectedLayerId` above. */
  selectedFolderId: string | null
  selectedFolderKind: 'geometry' | 'operation' | null
  selectedFolderSetupId: string | null
  /** TRANSIENT (NOT persisted): the toolpath MOVE/SEGMENT picked in the viewport
   *  (Toolpath view). Mutually exclusive with geometry/nest/stock/layer/folder
   *  selections — selecting any of those clears it; setting it clears them and
   *  activates its owning operation (so clearing the move falls back to that
   *  operation's Properties). See `SelectedMove`. */
  selectedMove: SelectedMove | null
  highlightedOperationId: string | null
  simulationProgress: number
  stockSimEnabled: boolean
  stockSimResolution: number   // mm per cell — drives HeightmapSimulator cell size
  /** Sim-only toolpath visibility. When false AND mode === 'simulation' the
   *  toolpath lines hide so the busy path stops obscuring the receding stock.
   *  Does NOT affect toolpath-mode visibility (that stays governed by
   *  showToolpath); this flag only narrows visibility inside the sim view.
   *  Default false = toolpath VISIBLE; tick "Hide Toolpath" (true) to hide. */
  simHideToolpath: boolean
  /** Which stock-removal result is emphasized in Simulation mode:
   *  stock = carved stock only, compare = translucent stock over target,
   *  target = target model only. */
  stockSimDisplayMode: StockSimulationDisplayMode
  /** Opacity (0.15..1) of the simulated stock mesh/volume so the target model
   *  (workpieceGroup, already shown during sim) reads THROUGH it and the user
   *  can judge how close the cut got. 1 = fully opaque (default, unchanged look). */
  stockSimOpacity: number
}
