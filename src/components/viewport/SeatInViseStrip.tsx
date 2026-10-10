import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
// WO-1586: WO-1574 built the seating math and a `SeatInViseCommand` component
// mounted nowhere. This file is the mount: a tiny cross-component open/close
// signal (PropertiesPanel's Workholding row is the opener, Viewport is the
// host) plus the presentational wrapper Viewport actually renders.
//
// No store/index.ts change: `useCamStore` already carries every field the
// command needs (geometry list, updateGeometryTransform); the one thing
// missing was a place for "which body did the operator click Seat in vise
// for" to live between two sibling components neither of which owns the
// other. A standalone Zustand store is the same shape `uiPrefs.ts` and the
// sketcher's own tool store already use for cross-component UI state that
// is not project data.
//
// WO-1587: the faces are now PICKED IN THE VIEWPORT. Hovering a face on the
// workholding body or the part highlights it; clicking picks it (world point
// + outward normal of the clicked triangle's planar region, from
// CNCViewport.enterSeatFacePickMode). Pick a vise face, then a part face, and
// the seat happens - no button, no dropdown, and a stepped jaw seats exactly
// like a flat one because the engine always consumed a point + normal.
//
// The six bounding-box face dropdowns WO-1574 shipped survive ONLY as the
// fallback for a body the viewport cannot raycast - an STL still loading, a
// 2D-only geometry - and only for THAT body: a loaded vise beside an unloaded
// part gets viewport picks for the vise and the dropdown for the part. The
// alternative was refusing to seat a box whose faces we already know exactly,
// which is rule 11 backwards. In the live app with both meshes loaded, which
// is every real seat, no face dropdown renders at all.
//
// Decide-and-log (rule 3): the strip's own markup moved HERE from
// `components/modals/SeatInViseCommand.tsx`, which this order's owned-paths
// do not grant. That file is now unreferenced by the product; deleting it
// (and repinning `seatInViseStrip.wo1586.test.tsx`, also out of lane) wants a
// one-line follow-up order granting those two paths.
// WO-1591 (mating S1): a FIXED STOCK can be either side of the pair. Its box
// faces are pickable in the viewport (CNCViewport.faceOverlaySource), and when
// the stock is the mover the seat goes through the existing fixed-stock
// position write with `rideFixture: false` - so the stock's member parts, a
// bound nest and a `stock_corner` work origin all stay where they are, and the
// console says so (store/index.ts updateFixedStock).
//
// WO-1596 (mating S2): WHICH BODY MOVES is one resolver, `resolveSeatMover`,
// and it reads the lock first (ASSEMBLY-MATING-REVIEW 11.1): exactly one locked
// -> the other moves; both locked -> nothing moves and the strip offers
// "Unlock <body> and move it"; neither -> pick order decides. The PART may now
// be the mover, and when it is the strip holds the pair and states what the
// move outdates before Apply, from the store's `previewGeometryMove` - the same
// selector the console line after the move reads.
//
// Decide-and-log (rule 3), what "pick order" means here: the side the strip
// asks for first, which is what WO-1574's engine and WO-1586's strip already
// take (review 10.1: "Pick order - nothing to build"). For a part that is the
// workholding (WO-1574); for a fixed stock it is the stock (WO-1591, Operator's own
// "stock seats on the vise"). The order the two faces are CLICKED in the
// viewport does not change it - WO-1587 ruled the strip invents no ordering
// rule there. "Move <other> instead" swaps it in one click whenever no lock
// has already decided. Re-reading click order as pick order is a one-line
// change in `firstPickSide` if Operator wants it.
//
// A fixed stock stores a world min corner and NO rotation, so a seat on it may
// spend translation and nothing else. That is not a special engine: it is
// `seatAgainstFace` given an `along-line` freedom, which closes the gap along
// the direction it is handed and leaves the rotation untouched. The direction
// is the contact normal for the first seat, and the part of it still free
// inside the first contact plane for the second.
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Anchor, Check, X, AlertTriangle } from 'lucide-react'
import { useCamStore } from '../../store'
import type { FixedStockItem, SceneStock, Vec3 } from '../../types'
import type { SeatFacePick } from '../../lib/viewport/CNCViewport'
import {
  seatFirstFace, seatSecondFace, seatAgainstFace, localBoxFace, worldBoxFace, localFaceFromWorld,
  BOX_FACE_KEYS, BOX_FACE_LABELS, type BoxFaceKey, type RigidPose, type FacePick,
  type SeatFreedom,
} from '../../lib/cam/workholdingSeat'

interface SeatInViseUiState {
  open: boolean
  workholdingId: string | null
  openSeatInVise: (workholdingId: string) => void
  closeSeatInVise: () => void
}

export const useSeatInViseUi = create<SeatInViseUiState>((set) => ({
  open: false,
  workholdingId: null,
  openSeatInVise: (workholdingId) => set({ open: true, workholdingId }),
  closeSeatInVise: () => set({ open: false, workholdingId: null }),
}))

// Same live-viewport-sync contract PropertiesPanel's typed Position/Rotation
// commits use (PropertiesPanel.tsx's commitTransformAxis): updateGeometryTransform
// alone only updates the STORE. Without also calling the imperative viewport
// handle, the seated body's mesh stays at its pre-seat screen position until
// some unrelated event (undo, a full scene reload) forces a rebuild.
type VpHandle = {
  setPartTransform?: (id: string, pos: Vec3, rot: Vec3) => void
  canPickFacesFor?: (geoId: string) => boolean
  enterSeatFacePickMode?: (
    geoIds: readonly string[],
    onPick: (pick: SeatFacePick) => void,
    onHover?: ((pick: SeatFacePick | null) => void) | null,
  ) => void
  exitSeatFacePickMode?: () => void
  // WO-1591: a seated stock is a BOX the viewport drew, not a part group, so
  // the live-sync counterpart of setPartTransform is a stock rebuild - the same
  // call DesignTree makes after a typed stock edit.
  rebuildStock?: (config: SceneStock) => void
}
const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle) ?? null

type SeatStage = 'first' | 'second' | 'done'

function negate(v: Vec3): Vec3 { return { x: -v.x, y: -v.y, z: -v.z } }
function dot3(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z }
function sub3(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } }
function scale3(a: Vec3, k: number): Vec3 { return { x: a.x * k, y: a.y * k, z: a.z * k } }
function unit3(a: Vec3): Vec3 {
  const len = Math.sqrt(dot3(a, a))
  return len > 0 ? scale3(a, 1 / len) : a
}

/** Which side of the strip's pair: the workholding body, or the far side. */
export type SeatSide = 'workholding' | 'other'

/** WO-1596: THE resolver for who moves (ASSEMBLY-MATING-REVIEW 11.1). A lock is
 *  a stronger statement than a pick, so it is read first; pick order decides
 *  only what the locks leave open. Both locked is not a refusal - `mover` is
 *  null and the strip offers to unlock `firstPick` and move it. */
export function resolveSeatMover(
  firstPick: SeatSide,
  workholdingLocked: boolean,
  otherLocked: boolean,
): { mover: SeatSide | null; decidedBy: 'lock' | 'pick-order' | 'both-locked' } {
  if (workholdingLocked && otherLocked) return { mover: null, decidedBy: 'both-locked' }
  if (workholdingLocked) return { mover: 'other', decidedBy: 'lock' }
  if (otherLocked) return { mover: 'workholding', decidedBy: 'lock' }
  return { mover: firstPick, decidedBy: 'pick-order' }
}

/** The sentence that states a part move's cost before Apply, and the console
 *  line after it - one wording over one selector's result. */
export function moveImpactText(moverName: string, opNames: readonly string[], tense: 'before' | 'after'): string {
  const n = opNames.length
  if (n === 0) {
    return tense === 'before'
      ? tx('SeatInViseStrip.Moving_marks_no_operations_outdated', { p1: moverName })
      : tx('SeatInViseStrip.moved_No_operations_were_outdated', { p1: moverName })
  }
  const count = tx('SeatInViseStrip.Census_operation', { p1: n, p2: n === 1 ? '' : tx('SeatInViseStrip.Census_s') })
  return tense === 'before'
    ? tx('SeatInViseStrip.Moving_marks_outdated', { p1: moverName, p2: count, p3: opNames.join(', ') })
    : tx('SeatInViseStrip.moved_now_outdated', { p1: moverName, p2: count, p3: n === 1 ? tx('SeatInViseStrip.Census_is') : tx('SeatInViseStrip.Census_are'), p4: opNames.join(', ') })
}

/** A complete pair of faces: the workholding face in its own frame and in
 *  world space, and the far side's face in world space. */
interface SeatPair { holdLocal: FacePick; holdWorld: FacePick; partWorld: FacePick }

/** One seat, computed and not yet written. */
type PlannedSeat =
  | { kind: 'geometry'; id: string; name: string; position: Vec3; rotation: Vec3; contactNormal: Vec3 }
  | { kind: 'fixed-stock'; id: string; name: string; position: Vec3; contactNormal: Vec3 }

/** The far side of a pair: a body, a fixed stock, or an auto stock (which can
 *  only ever be named, never moved - it has no stored position to write). */
type SeatTarget =
  | { kind: 'body'; id: string; name: string; pose: RigidPose; box: { min: Vec3; max: Vec3 }; locked: boolean }
  | { kind: 'fixed-stock'; id: string; name: string; pose: RigidPose; box: { min: Vec3; max: Vec3 }; locked: boolean }
  | { kind: 'auto-stock'; id: string; name: string }

/** A fixed stock's stored `position` IS its world min corner and its box is
 *  axis-aligned, so its local frame is the min corner with no rotation. */
function fixedStockTarget(stock: FixedStockItem): SeatTarget {
  return {
    kind: 'fixed-stock',
    id: stock.id,
    name: stock.name,
    pose: { position: stock.position, rotation: { x: 0, y: 0, z: 0 } },
    box: { min: { x: 0, y: 0, z: 0 }, max: { x: stock.width, y: stock.height, z: stock.depth } },
    locked: stock.locked === true,
  }
}

/** The freedom a TRANSLATION-ONLY mover has left. `anchorNormalWorld` is the
 *  outward normal of the face it is being seated against; the mover's own face
 *  normal has to end up opposed to it, which is the direction the gap closes
 *  along. After a first contact whose plane normal is `firstContactNormal`,
 *  only the part of that direction lying IN that plane is still free - the turn
 *  about the plane normal, which `seatAgainstFace` would otherwise spend, is
 *  not a freedom an axis-aligned stock box has. */
function translationFreedom(anchorNormalWorld: Vec3, firstContactNormal: Vec3 | null): SeatFreedom {
  const target = negate(unit3(anchorNormalWorld))
  if (!firstContactNormal) return { state: 'along-line', direction: target }
  const n1 = unit3(firstContactNormal)
  const inPlane = sub3(target, scale3(n1, dot3(target, n1)))
  if (Math.sqrt(dot3(inPlane, inPlane)) < 1e-6) {
    throw new Error(
      tx('SeatInViseStrip.Seat_in_vise_the_second_face_is_parallel_to') +
      tx('SeatInViseStrip.sliding_along_it_can_never_close_this_gap'),
    )
  }
  return { state: 'along-line', direction: unit3(inPlane) }
}

/** Mounted unconditionally by Viewport.tsx; renders nothing until the
 *  Properties panel opens it.
 *
 *  The gate is a SEPARATE component from the body on purpose: the body's
 *  `useState(initialWorkholdingId)` only reads its initial value on mount, so
 *  the body has to be mounted fresh each time the strip opens. Folding the two
 *  into one always-mounted component silently drops the preselected
 *  workholding body (caught by WO-1587's own capture, which then saw the
 *  bounding-box fallback where the viewport picks belong). */
export function SeatInViseStrip() {
  useText('cam-operations-new-operation')
  const open = useSeatInViseUi((s) => s.open)
  const workholdingId = useSeatInViseUi((s) => s.workholdingId)
  const closeUi = useSeatInViseUi((s) => s.closeSeatInVise)
  if (!open) return null
  return <SeatInViseStripBody onClose={closeUi} initialWorkholdingId={workholdingId ?? undefined} />
}

function SeatInViseStripBody(
  { onClose, initialWorkholdingId }: { onClose: () => void; initialWorkholdingId?: string },
) {
  useText('cam-operations-new-operation')
  const geometry = useCamStore((s) => s.project.geometry)
  const sceneStock = useCamStore((s) => s.project.sceneStock)
  const physicalStocks = useCamStore((s) => s.project.stocks)
  // Read so the cost sentence re-renders when an operation's status changes.
  useCamStore((s) => s.project.setups)
  const updateGeometryTransform = useCamStore((s) => s.updateGeometryTransform)
  const updateFixedStock = useCamStore((s) => s.updateFixedStock)
  const addFixedStock = useCamStore((s) => s.addFixedStock)
  const previewGeometryMove = useCamStore((s) => s.previewGeometryMove)
  const setGeometryLocked = useCamStore((s) => s.setGeometryLocked)
  const setFixedStockLocked = useCamStore((s) => s.setFixedStockLocked)
  const addConsoleEvent = useCamStore((s) => s.addConsoleEvent)

  const fixedStocks = sceneStock.fixedStocks ?? []
  const autoStocks = sceneStock.autoStocks ?? []
  const workholdingOptions = geometry.filter((g) => g.workholding)
  // WO-1591: the far side of a pair is a part OR a stock. Both kinds of stock
  // are offered - an auto stock is named rather than hidden, because hiding it
  // would leave the operator hunting for a stock that is right there in the
  // tree, and the strip has one honest line for it (outcome 4).
  const partOptions: Array<{ id: string; label: string }> = [
    ...geometry.filter((g) => !g.workholding).map((g) => ({ id: g.id, label: g.name })),
    ...fixedStocks.map((fs) => ({ id: fs.id, label: tx('SeatInViseStrip.stock', { p1: fs.name }) })),
    ...autoStocks.map((as) => ({ id: as.id, label: tx('SeatInViseStrip.auto_stock', { p1: as.name }) })),
  ]

  const [workholdingId, setWorkholdingId] = useState<string>(initialWorkholdingId ?? '')
  const [partId, setPartId] = useState<string>('')
  const [holdFace, setHoldFace] = useState<BoxFaceKey>('nx')
  const [partFace, setPartFace] = useState<BoxFaceKey>('px')
  const [stage, setStage] = useState<SeatStage>('first')
  const [firstContactNormal, setFirstContactNormal] = useState<Vec3 | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Viewport picks waiting for their partner. A seat fires the moment both
  // sides are filled, in whichever order the operator clicked them.
  const [heldPick, setHeldPick] = useState<SeatFacePick | null>(null)
  const [partPick, setPartPick] = useState<SeatFacePick | null>(null)
  const [hovered, setHovered] = useState<SeatFacePick | null>(null)
  // WO-1596: "Move <other> instead" flips pick order; a lock still wins.
  const [swapped, setSwapped] = useState(false)
  // A complete pair held for Apply: when the part moves (its cost is stated
  // first) or when both are locked (the unlock button completes it).
  const [heldPair, setHeldPair] = useState<SeatPair | null>(null)
  // Bumped after every committed seat: the bodies moved, so the viewport's
  // pre-computed face overlays are stale and the mode must re-arm.
  const [seatEpoch, setSeatEpoch] = useState(0)

  // The armed pick callbacks are registered ONCE per arm but must always see
  // the current stage and pending picks, so they bounce through a ref.
  const onPickRef = useRef<(pick: SeatFacePick) => void>(() => {})

  const workholding = geometry.find((g) => g.id === workholdingId)

  const targetOf = (id: string): SeatTarget | null => {
    const geo = geometry.find((g) => g.id === id)
    if (geo) {
      return {
        kind: 'body', id: geo.id, name: geo.name,
        pose: { position: geo.position, rotation: geo.rotation },
        box: geo.boundingBox, locked: geo.locked === true,
      }
    }
    const fixed = fixedStocks.find((fs) => fs.id === id)
    if (fixed) return fixedStockTarget(fixed)
    const auto = autoStocks.find((as) => as.id === id)
    if (auto) return { kind: 'auto-stock', id: auto.id, name: auto.name }
    return null
  }
  const target = partId ? targetOf(partId) : null
  const isAutoStock = target?.kind === 'auto-stock'

  /** Pick order (see the file header): the side the strip asks for first,
   *  flipped by the swap button. */
  const defaultFirst: SeatSide = target?.kind === 'fixed-stock' ? 'other' : 'workholding'
  const firstPickSide: SeatSide = swapped ? (defaultFirst === 'workholding' ? 'other' : 'workholding') : defaultFirst
  const resolution = !workholding || !target || target.kind === 'auto-stock'
    ? null
    : resolveSeatMover(firstPickSide, workholding.locked === true, target.locked)
  const mover: SeatSide | null = resolution?.mover ?? null
  const bothLocked = resolution?.decidedBy === 'both-locked'
  const moverName = !workholding || !target ? null
    : mover === 'workholding' ? workholding.name : mover === 'other' ? target.name : null
  const anchorName = !workholding || !target ? null
    : mover === 'workholding' ? target.name : mover === 'other' ? workholding.name : null
  // The PART is the mover: its cost is stated before Apply, so its pair waits.
  const partMoves = mover === 'other' && target?.kind === 'body'

  const vp = getVp()
  const canPickInViewport = typeof vp?.enterSeatFacePickMode === 'function'
  const pickHoldInViewport = canPickInViewport && !!workholding && vp?.canPickFacesFor?.(workholdingId) === true
  const pickPartInViewport = canPickInViewport && !!target && vp?.canPickFacesFor?.(partId) === true

  const resetSeat = () => {
    setStage('first'); setFirstContactNormal(null); setError(null)
    setHeldPick(null); setPartPick(null); setHeldPair(null)
  }

  const close = () => { resetSeat(); getVp()?.exitSeatFacePickMode?.(); onClose() }

  const pickWorkholding = (id: string) => { setWorkholdingId(id); setSwapped(false); resetSeat() }
  const pickPart = (id: string) => { setPartId(id); setSwapped(false); resetSeat() }

  // Acceptance: "Done or Escape closes the strip." No text input lives in
  // this strip (every field is a <select>), so there is no typing-target case
  // to guard, unlike FilletDialog's radius field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // WO-1587: arm viewport face picking over whichever of the two bodies the
  // viewport can actually raycast. Re-arms after every seat (seatEpoch) so the
  // overlays follow the vise that just moved, and tears down on close so no
  // stray crosshair survives the strip.
  const armIds = [
    pickHoldInViewport ? workholdingId : null,
    pickPartInViewport ? partId : null,
  ].filter((id): id is string => id !== null)
  const armKey = armIds.join('|')
  useEffect(() => {
    const handle = getVp()
    if (stage === 'done' || armKey === '' || !handle?.enterSeatFacePickMode) return
    handle.enterSeatFacePickMode(
      armKey.split('|'),
      (pick) => onPickRef.current(pick),
      (pick) => setHovered(pick),
    )
    return () => { setHovered(null); handle.exitSeatFacePickMode?.() }
  }, [stage, armKey, seatEpoch])

  /** ONE seat, computed but not written. `holdLocal`/`holdWorld` are the same
   *  workholding face in the body's own frame and in world space (the caller
   *  has both cheaply, and round-tripping one into the other would move today's
   *  numbers); `partWorld` is the far side's face in world space. `who` is the
   *  mover, resolved above. Throws the engine's own refusal. */
  const planSeat = (pair: SeatPair, who: SeatSide | null): PlannedSeat | null => {
    if (!workholding || !target || target.kind === 'auto-stock' || who === null) return null
    const { holdLocal, holdWorld, partWorld } = pair
    if (who === 'other' && target.kind === 'fixed-stock') {
      // The STOCK moves onto the workholding face. Translation only: the box
      // has no stored rotation, and a mate answers where, never how big - so
      // width/height/depth are never in the update at all.
      const freedom = translationFreedom(holdWorld.normal, stage === 'first' ? null : firstContactNormal)
      const seated = seatAgainstFace(target.pose, freedom, localFaceFromWorld(target.pose, partWorld), holdWorld)
      return {
        kind: 'fixed-stock', id: target.id, name: target.name,
        position: seated.pose.position, contactNormal: negate(holdWorld.normal),
      }
    }
    if (who === 'other') {
      // WO-1596: the PART moves into the workholding - the same engine with the
      // roles swapped: the part's face in its own frame, the jaw's in world.
      const partLocal = localFaceFromWorld(target.pose, partWorld)
      const seated = stage === 'first' || !firstContactNormal
        ? seatFirstFace(target.pose, partLocal, holdWorld)
        : seatSecondFace(target.pose, firstContactNormal, partLocal, holdWorld)
      return {
        kind: 'geometry', id: target.id, name: target.name,
        position: seated.position, rotation: seated.rotation, contactNormal: negate(holdWorld.normal),
      }
    }
    const currentPose: RigidPose = { position: workholding.position, rotation: workholding.rotation }
    const seated = stage === 'first' || !firstContactNormal
      ? seatFirstFace(currentPose, holdLocal, partWorld)
      : seatSecondFace(currentPose, firstContactNormal, holdLocal, partWorld)
    return {
      kind: 'geometry', id: workholding.id, name: workholding.name,
      position: seated.position, rotation: seated.rotation, contactNormal: negate(partWorld.normal),
    }
  }

  const clearPicks = () => { setHeldPick(null); setPartPick(null); setHeldPair(null) }

  /** Compute and WRITE one seat. The console line for a body move is read off
   *  `previewGeometryMove` immediately before the write - the same selector
   *  the strip's sentence came from, so the two cannot disagree. */
  const runSeat = (pair: SeatPair, who: SeatSide | null = mover) => {
    if (!workholding || !target) return
    setError(null)
    try {
      const plan = planSeat(pair, who)
      if (!plan) { clearPicks(); return }
      if (plan.kind === 'fixed-stock') {
        updateFixedStock(plan.id, { position: plan.position }, { rideFixture: false })
        getVp()?.rebuildStock?.(useCamStore.getState().project.sceneStock)
        console.info(
          `[SeatInVise] ${plan.name} seated on ${workholding.name}: ` +
          `${plan.position.x.toFixed(3)}, ${plan.position.y.toFixed(3)}, ${plan.position.z.toFixed(3)} mm`,
        )
      } else {
        const impact = useCamStore.getState().previewGeometryMove(plan.id, plan.position, plan.rotation)
        updateGeometryTransform(plan.id, plan.position, plan.rotation)
        // WO-1590's contract: the viewport hears only poses the store HOLDS,
        // never the plan it may have declined - and a locked body in the pair
        // is re-told its held pose last, so nothing the strip sends can leave
        // a locked body anywhere on screen but where the data keeps it.
        const held = useCamStore.getState().project.geometry
        const vp = getVp()
        for (const id of new Set([plan.id, workholding.id, target.id])) {
          const geo = held.find((g) => g.id === id)
          if (!geo || (id !== plan.id && geo.locked !== true)) continue
          vp?.setPartTransform?.(geo.id, geo.position, geo.rotation)
        }
        if (impact.moved) {
          addConsoleEvent({
            severity: impact.opNames.length > 0 ? 'warning' : 'info',
            source: 'model',
            message: moveImpactText(plan.name, impact.opNames, 'after'),
            entityRef: { kind: 'geometry', id: plan.id },
          })
        }
      }
      if (stage === 'first') { setFirstContactNormal(plan.contactNormal); setStage('second') }
      else setStage('done')
      clearPicks()
      setSeatEpoch((n) => n + 1)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[SeatInVise] refused: ${message}`)
      setError(message)
      clearPicks()
    }
  }

  /** A pair is complete: a workholding or stock mover seats at once (WO-1587's
   *  shipped flow); a part mover, or a both-locked pair, waits on the strip. */
  const completePair = (pair: SeatPair) => {
    if (partMoves || bothLocked) { setHeldPair(pair); setHeldPick(null); setPartPick(null); return }
    runSeat(pair)
  }

  /** The workholding face, in both frames, however it was chosen. */
  const holdFaces = (): { local: FacePick; world: FacePick } | null => {
    if (!workholding) return null
    const pose: RigidPose = { position: workholding.position, rotation: workholding.rotation }
    if (heldPick) return { local: localFaceFromWorld(pose, heldPick), world: heldPick }
    return {
      local: localBoxFace(workholding.boundingBox, holdFace),
      world: worldBoxFace(workholding.boundingBox, pose, holdFace),
    }
  }

  /** The dropdown fallback's Seat button: whichever side the viewport cannot
   *  pick contributes its bounding-box face. */
  const pairFromControls = (): SeatPair | null => {
    const hold = holdFaces()
    if (!hold || !target || target.kind === 'auto-stock') return null
    const partWorld = partPick ?? worldBoxFace(target.box, target.pose, partFace)
    return { holdLocal: hold.local, holdWorld: hold.world, partWorld }
  }
  const runSeatFromControls = () => {
    const pair = heldPair ?? pairFromControls()
    if (pair) runSeat(pair)
  }

  /** Outcome 4: an auto stock sizes itself to its members, so there is no
   *  position a seat could write. Rather than refuse, the strip makes a FIXED
   *  stock of the same box and selects it - and leaves the auto stock exactly
   *  where it was, so nothing was silently converted. */
  const makeAutoStockFixed = () => {
    if (!target || target.kind !== 'auto-stock') return
    const twin = (physicalStocks ?? []).find((ps) => ps.id === target.id)
    const min = twin?.bounds.min, max = twin?.bounds.max
    if (!min || !max || max.x - min.x <= 0 || max.y - min.y <= 0 || max.z - min.z <= 0) {
      setError(
        tx('SeatInViseStrip.has_no_parts_assigned_yet_so_it_has_no', { p1: target.name }) +
        tx('SeatInViseStrip.Assign_a_part_to_it_or_add_a_fixed'),
      )
      return
    }
    const created: FixedStockItem = {
      id: crypto.randomUUID(),
      name: tx('SeatInViseStrip.Census_fixed', { p1: target.name }),
      width: max.x - min.x, height: max.y - min.y, depth: max.z - min.z,
      position: { x: min.x, y: min.y, z: min.z },
    }
    addFixedStock(created)
    getVp()?.rebuildStock?.(useCamStore.getState().project.sceneStock)
    pickPart(created.id)
  }

  // A pick completes the pair whenever the other side is already in hand -
  // vise-then-part (the order the strip asks for) or part-then-vise, because
  // refusing the second order would be us inventing a rule the math does not
  // have. A re-pick of the same side simply replaces it.
  onPickRef.current = (pick: SeatFacePick) => {
    if (!workholding || !target) return
    setError(null)
    const currentPose: RigidPose = { position: workholding.position, rotation: workholding.rotation }
    if (pick.geoId === workholdingId) {
      console.info(`[SeatInVise] ${workholding.name}: face picked at ` +
        `${pick.point.x.toFixed(2)}, ${pick.point.y.toFixed(2)}, ${pick.point.z.toFixed(2)} mm`)
      if (partPick) completePair({ holdLocal: localFaceFromWorld(currentPose, pick), holdWorld: pick, partWorld: partPick })
      else { setHeldPair(null); setHeldPick(pick) }
      return
    }
    if (pick.geoId === partId) {
      console.info(`[SeatInVise] ${target.name}: face picked at ` +
        `${pick.point.x.toFixed(2)}, ${pick.point.y.toFixed(2)}, ${pick.point.z.toFixed(2)} mm`)
      if (heldPick) completePair({ holdLocal: localFaceFromWorld(currentPose, heldPick), holdWorld: heldPick, partWorld: pick })
      else { setHeldPair(null); setPartPick(pick) }
    }
  }

  // The fallback Seat button exists only while at least one side still comes
  // from a dropdown; with both sides picked in the viewport the second pick IS
  // the commit and a button would be a second way to do the same thing.
  const needsButton = !pickHoldInViewport || !pickPartInViewport
  const canRun = mover !== null && stage !== 'done'

  // WO-1596 outcome 3: the part's cost, stated before Apply. With a pair in
  // hand (held viewport picks, or the dropdown faces) it is the exact seated
  // pose; before that there is no pose yet, and the sentence counts what any
  // move of the part outdates (a 1 mm probe through the same selector).
  const plannedPair = heldPair ?? (needsButton ? pairFromControls() : null)
  let impactText: string | null = null
  if (partMoves && stage !== 'done' && target?.kind === 'body') {
    let names: string[] | null = null
    if (plannedPair) {
      try {
        const plan = planSeat(plannedPair, 'other')
        if (plan?.kind === 'geometry') names = previewGeometryMove(plan.id, plan.position, plan.rotation).opNames
      } catch {
        names = null // the engine's own refusal shows when Apply runs it
      }
    }
    if (names === null) {
      const { position, rotation } = target.pose
      names = previewGeometryMove(target.id, { ...position, z: position.z + 1 }, rotation).opNames
    }
    impactText = moveImpactText(target.name, names, 'before')
  }

  // Swap is offered whenever no lock has decided (a lock is the operator's
  // own stronger statement), before the first seat commits.
  const canSwap = resolution?.decidedBy === 'pick-order' && stage === 'first'
  const swapTarget = mover === 'workholding' ? target?.name : workholding?.name

  /** Both locked: unlock the pick-order body and seat it with the pair in
   *  hand. A PART is only unlocked - its cost is then stated before Apply. */
  const unlockAndMove = () => {
    if (!workholding || !target || target.kind === 'auto-stock') return
    if (firstPickSide === 'workholding') setGeometryLocked(workholding.id, false)
    else if (target.kind === 'fixed-stock') setFixedStockLocked(target.id, false)
    else { setGeometryLocked(target.id, false); return }
    const pair = heldPair ?? (needsButton ? pairFromControls() : null)
    if (pair) runSeat(pair, firstPickSide)
  }
  const unlockName = firstPickSide === 'workholding' ? workholding?.name : target?.name

  const nameOf = (id: string) => targetOf(id)?.name ?? geometry.find((g) => g.id === id)?.name ?? id
  const hoverText = hovered ? tx('SeatInViseStrip.face_under_the_cursor', { p1: nameOf(hovered.geoId) }) : null
  const pendingText =
    heldPick ? tx('SeatInViseStrip.face_picked_now_click_the_face_it_should_touch', { p1: nameOf(heldPick.geoId) })
    : partPick ? tx('SeatInViseStrip.face_picked_now_click_the_workholding_face_that_should', { p1: nameOf(partPick.geoId) })
    : null

  // ASSEMBLY-MATING-REVIEW 11.1: the strip names the mover FIRST, before
  // anything is pressed, so which body is about to move is never a surprise.
  const moverText =
    moverName && anchorName ? tx('SeatInViseStrip.moves_to', { p1: moverName, p2: anchorName })
    : bothLocked && target && workholding
      ? tx('SeatInViseStrip.and_are_both_locked_so_neither_can_move_Unlock', { p1: workholding.name, p2: target.name })
    : null

  const instruction =
    stage === 'first'
      ? (moverName && anchorName
        ? tx('SeatInViseStrip.Pick_a_face_on_it_moves_and_the_face', { p1: moverName, p2: anchorName })
        : tx('SeatInViseStrip.Pick_a_face_on_the_workholding_body_a_jaw'))
    : stage === 'second'
      ? (moverName && anchorName
        ? tx('SeatInViseStrip.The_first_contact_holds_Pick_the_second_face_on', { p1: moverName, p2: anchorName })
        : tx('SeatInViseStrip.The_first_contact_holds_Pick_the_second_workholding_face'))
    : tx('SeatInViseStrip.Seated_Both_contacts_hold_Undo_backs_out_either_seat')

  return (
    <div
      className={`sketch-confirm-overlay seat-in-vise-strip${error !== null ? ' seat-in-vise-strip--refusal' : ''}`}
      data-testid="seat-in-vise-strip"
      role="toolbar"
      aria-label={tx('SeatInViseStrip.Seat_in_vise')}
    >
      <Anchor size={13} aria-hidden="true" />
      <span className="sketch-confirm-title">{tx('SeatInViseStrip.Seat_in_vise')}</span>
      <span className="sketch-confirm-hint" data-testid="seat-in-vise-instruction">{instruction}</span>

      <label className="sketch-confirm-field">
        <span>{tx('SeatInViseStrip.Workholding')}</span>
        <select
          value={workholdingId}
          onChange={(e) => pickWorkholding(e.target.value)}
          data-testid="seat-in-vise-workholding"
          disabled={stage !== 'first'}
        >
          <option value="">{tx('SeatInViseStrip.Choose')}</option>
          {workholdingOptions.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </label>

      <label className="sketch-confirm-field">
        <span>{tx('SeatInViseStrip.Part_or_stock')}</span>
        <select
          value={partId}
          onChange={(e) => pickPart(e.target.value)}
          data-testid="seat-in-vise-part"
          disabled={stage !== 'first'}
        >
          <option value="">{tx('SeatInViseStrip.Choose')}</option>
          {partOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>

      {moverText !== null && (
        <span className="sketch-confirm-hint" data-testid="seat-in-vise-mover">{moverText}</span>
      )}
      {impactText !== null && (
        <span className="sketch-confirm-hint" data-testid="seat-in-vise-impact">{impactText}</span>
      )}
      {canSwap && swapTarget && (
        <button
          type="button"
          className="sketch-prompt-btn"
          data-testid="seat-in-vise-swap"
          onClick={() => { setSwapped((v) => !v); clearPicks(); setError(null) }}
        >
          <span>{tx('SeatInViseStrip.Move_instead', { p1: swapTarget })}</span>
        </button>
      )}
      {bothLocked && unlockName && stage !== 'done' && (
        <button
          type="button"
          className="sketch-prompt-btn"
          data-testid="seat-in-vise-unlock-move"
          onClick={unlockAndMove}
        >
          <span>{tx('SeatInViseStrip.Unlock_and_move_it', { p1: unlockName })}</span>
        </button>
      )}

      {isAutoStock && target && (
        <>
          <span className="sketch-confirm-hint" data-testid="seat-in-vise-auto-stock">{tx('SeatInViseStrip.sizes_itself_to_the_parts_assigned_to_it_so', { p1: target.name })}</span>
          <button
            type="button"
            className="sketch-prompt-btn"
            data-testid="seat-in-vise-make-fixed"
            onClick={makeAutoStockFixed}
          >
            <span>{tx('SeatInViseStrip.Make_a_fixed_stock_this_size')}</span>
          </button>
        </>
      )}

      {!pickHoldInViewport && !isAutoStock && (
        <label className="sketch-confirm-field">
          <span>{tx('SeatInViseStrip.face', { p1: workholding ? workholding.name : tx('SeatInViseStrip.Workholding') })}</span>
          <select
            value={holdFace}
            onChange={(e) => setHoldFace(e.target.value as BoxFaceKey)}
            data-testid="seat-in-vise-hold-face"
          >
            {BOX_FACE_KEYS.map((key) => <option key={key} value={key}>{BOX_FACE_LABELS[key]}</option>)}
          </select>
        </label>
      )}

      {!pickPartInViewport && !isAutoStock && (
        <label className="sketch-confirm-field">
          <span>{tx('SeatInViseStrip.face', { p1: target ? target.name : tx('SeatInViseStrip.Part') })}</span>
          <select
            value={partFace}
            onChange={(e) => setPartFace(e.target.value as BoxFaceKey)}
            data-testid="seat-in-vise-part-face"
          >
            {BOX_FACE_KEYS.map((key) => <option key={key} value={key}>{BOX_FACE_LABELS[key]}</option>)}
          </select>
        </label>
      )}

      {pendingText !== null && (
        <span className="sketch-confirm-hint" data-testid="seat-in-vise-pending">{pendingText}</span>
      )}
      {hoverText !== null && (
        <span className="sketch-confirm-hint" data-testid="seat-in-vise-hover">{hoverText}</span>
      )}

      {error !== null && (
        <span
          className="fillet-command-status fillet-command-status--error"
          data-testid="seat-in-vise-error"
          data-tooltip={error}
          aria-live="polite"
        >
          <AlertTriangle size={13} style={{ verticalAlign: 'text-bottom', marginRight: 4 }} aria-hidden="true" />
          {error}
        </span>
      )}

      <span className="sketch-confirm-actions">
        {stage !== 'done' && partMoves && !needsButton && heldPair && (
          <button
            type="button"
            className="sketch-prompt-btn sketch-prompt-btn-confirm"
            data-testid="seat-in-vise-apply"
            onClick={() => runSeat(heldPair)}
          >
            <Check size={12} aria-hidden="true" />
            <span>{tx('SeatInViseStrip.Apply')}</span>
          </button>
        )}
        {stage !== 'done' && needsButton && !isAutoStock && (
          <button
            type="button"
            className="sketch-prompt-btn sketch-prompt-btn-confirm"
            data-testid="seat-in-vise-run"
            aria-label={stage === 'first' ? tx('SeatInViseStrip.Seat_this_face') : tx('SeatInViseStrip.Seat_second_face')}
            onClick={runSeatFromControls}
            disabled={!canRun}
          >
            <Check size={12} aria-hidden="true" />
            <span>{stage === 'first' ? tx('SeatInViseStrip.Seat_this_face') : tx('SeatInViseStrip.Seat_second_face')}</span>
          </button>
        )}
        <button
          type="button"
          className="sketch-prompt-btn"
          data-testid="seat-in-vise-close"
          aria-label={stage === 'done' ? tx('SeatInViseStrip.Close') : tx('SeatInViseStrip.Cancel')}
          onClick={close}
        >
          <X size={12} aria-hidden="true" />
          <span>{stage === 'done' ? tx('SeatInViseStrip.Close') : tx('SeatInViseStrip.Cancel')}</span>
        </button>
      </span>
    </div>
  )
}
