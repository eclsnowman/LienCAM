// WO SKC-14B: the sketch TOOL STATE, owned by the component package.
//
// Before this WO the armed tool, the chain, the snap flags, the woken alignment refs and the
// tool scalars lived in the CAM store (src/store/index.ts). That made the CAM store a WINDOW
// the workbench (S3) would have had to reimplement or reach through -- the "CAM-store window"
// the SKC-14-R1 audit named as S3-blocking. The state now lives HERE, in the package that owns
// every behavior that reads it, behind a store-free reactive store.
//
// STORE-FREE means exactly one thing: this file imports nothing from src/store, and neither does
// anything else under src/lib/sketch/sketcher/**. The guard is a capability scan
// (src/tests/sketch/oneSketchPointerOwner.test.ts, "the component package is store-free").
//
// WHY A MODULE SINGLETON, not an instance field:
//   The armed tool is a global UI mode -- the toolbox lights it, the prompt bar narrates it, the
//   confirm overlay edits its scalars, and the interaction layer dispatches on it. Those consumers
//   are scattered across the React tree and cannot thread a Sketcher instance down to themselves.
//   A singleton keeps the critic's law intact (there is exactly ONE file in which a second version
//   of tool state could be written), and two Sketcher instances can never hold a live session at
//   once (Sketcher.enter() is gated on isActive()). Tool state is therefore SHARED across mounts
//   and survives sketch entry/exit -- which is exactly CAM's behavior today, so nothing a user
//   feels changed. S3 (a second live mount over a different document) must clear the chain when it
//   takes the sink; see Sketcher.setDocumentPort().
//
// The reactive contract is `subscribe` + `getState` (the useSyncExternalStore pair). React
// consumers read through ./useSketcherTool; non-React consumers (the interaction layer, the
// controller) read `sketcherToolStore.getState()` directly.
import { DEFAULT_SNAP_FLAGS, type WokenRef } from '../snap'
import type { PendingSnap } from '../inference'
import type { CreationSizeDraft } from '../tools/drawValue'
import type { SketchToolId, ToolChainState } from '../tools/toolMachine'
import type { PolygonMode } from '../tools/polygonSlotTools'
import { DEFAULT_GEAR_PARAMS, type GearParams } from '../tools/gearTool'

/** The tool-machine state plus every scalar the armed tool reads. */
export interface SketcherToolState {
  // ---- Items 1-4: the tool machine ----
  tool: SketchToolId
  chain: ToolChainState | null
  gearParams: GearParams
  polygonSides: number
  polygonMode: PolygonMode
  splineClosed: boolean

  // ---- Item 5: hover-woken alignment references (most-recent 3) ----
  wakeRefs: readonly WokenRef[]

  // ---- Item 6: snap engine flags ----
  snapEntity: boolean
  snapGrid: boolean
  snapInference: boolean

  // ---- Tool parameters (rows 28-29): the scalars the confirm overlay edits and `toolClick` /
  //      `toolOverlay` read. They are the armed tool's arguments -- polygonSides' siblings -- and
  //      the overlay that edits them is package-rendered, so they ride with the tool state. ----
  constructionMode: boolean
  filletRadius: number
  chamferSetback: number
  offsetDistance: number
  linearPatternCount: number
  circularPatternCount: number
  circularPatternAngleDeg: number

  // ---- Utility readouts: UI display toggles that are NOT drawing tools (do
  //      not arm, do not enter the tool click machine, do not own a chain).
  //      `measureOpen` drives the Measure readout panel + the active button
  //      state. Lives HERE (store-free package state) so the CAM and Model
  //      sketch hosts cannot diverge -- the same toggle the toolbox button
  //      writes is the one the `I` shortcut writes, and both read the same
  //      value. Session-local presentation state: survives suspend/resume of
  //      the SAME live session, but closes on real document switches and
  //      Sketcher.exit() so it cannot leak into the next sketch. ----
  measureOpen: boolean
  creationSize: CreationSizeDraft | null
  creationSessionActive: boolean
  creationDocumentId: string | null
}

/** Item 8 (inference half): snapped clicks recorded across a chain, resolved into real constraints
 *  when the chain commits. Deliberately NOT reactive -- nothing renders it; it is an accumulator
 *  the controller drains. Kept beside the state it belongs to rather than as a module global in a
 *  9000-line store. */
let pendingSnaps: PendingSnap[] = []

export function recordPendingSnap(snap: PendingSnap): void {
  pendingSnaps.push(snap)
}
export function drainPendingSnaps(): PendingSnap[] {
  const drained = pendingSnaps
  pendingSnaps = []
  return drained
}
export function clearPendingSnaps(): void {
  pendingSnaps = []
}
export function peekPendingSnaps(): readonly PendingSnap[] {
  return pendingSnaps
}

function initialState(): SketcherToolState {
  return {
    tool: 'select',
    chain: null,
    gearParams: { ...DEFAULT_GEAR_PARAMS },
    polygonSides: 6,
    polygonMode: 'inscribed',
    splineClosed: false,
    wakeRefs: [],
    snapEntity: DEFAULT_SNAP_FLAGS.entity,
    snapGrid: DEFAULT_SNAP_FLAGS.grid,
    snapInference: DEFAULT_SNAP_FLAGS.inference,
    constructionMode: false,
    filletRadius: 2,
    chamferSetback: 2,
    offsetDistance: 2,
    linearPatternCount: 3,
    circularPatternCount: 4,
    circularPatternAngleDeg: 90,
    measureOpen: false,
    creationSize: null,
    creationSessionActive: false,
    creationDocumentId: null,
  }
}

type Listener = () => void

/**
 * The minimal `useSyncExternalStore` pair. Hand-rolled rather than pulled from a state library so
 * the package carries no state-management dependency at all -- a mount brings its own.
 *
 * `setState` is reference-equality gated: a write that changes nothing notifies nobody. That is
 * what lets the pointermove path call `wake()` on every move without re-rendering the toolbox.
 */
class SketcherToolStore {
  private state: SketcherToolState = initialState()
  private readonly listeners = new Set<Listener>()

  getState = (): SketcherToolState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setState = (
    partial: Partial<SketcherToolState> | ((s: SketcherToolState) => Partial<SketcherToolState>),
  ): void => {
    const next = typeof partial === 'function' ? partial(this.state) : partial
    // Every chain/tool transition invalidates locks. Kept at the state owner so
    // direct host restore writes and all controller routes obey the same rule.
    if ((next.tool !== undefined && next.tool !== this.state.tool) ||
        (next.chain !== undefined && next.chain !== this.state.chain)) next.creationSize = null
    let changed = false
    for (const key of Object.keys(next) as (keyof SketcherToolState)[]) {
      if (next[key] !== this.state[key]) {
        changed = true
        break
      }
    }
    if (!changed) return
    this.state = { ...this.state, ...next }
    for (const listener of [...this.listeners]) listener()
  }

  /** Test seam ONLY: restore initial state and drop the inference accumulator. Never called by
   *  production code -- a session reset goes through `Sketcher.enter()`. */
  __reset = (): void => {
    this.state = initialState()
    clearPendingSnaps()
    for (const listener of [...this.listeners]) listener()
  }
}

/** THE sketch tool state. One per process, by design (see the header). */
export const sketcherToolStore = new SketcherToolStore()

/** Convenience read used all over the controller and the interaction layer. */
export function toolState(): SketcherToolState {
  return sketcherToolStore.getState()
}

