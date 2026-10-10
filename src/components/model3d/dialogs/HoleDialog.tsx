// WO UI-13A: hole dialog -- GEO-5's makeHole wired into the 3D modeling workspace UI,
// combined with linear/circular PLACEMENT in one dialog per the WO's own
// invitation ("ONE dialog w/ pattern options is acceptable if the backend
// models it that way"). Read the backend first (geom-service.ts's
// HoleRequest): there is no separate "pattern of holes" op -- HoleRequest
// already takes an arbitrary `points: Vec3[]` array in ONE makeHole call, so
// a linear/circular arrangement of holes is purely a UI computation that
// expands to more points, never a second backend request. GEO-5's own
// applyBodyPattern (body-level pattern) is a DIFFERENT op that repeats an
// ENTIRE body, not specifically holes, and is out of scope for this feature
// (the WO's enumeration bundles "linear/circular pattern" under Hole, not as
// an eighth feature).
//
// The face + first point are picked in-viewport (single-shot, mirrors
// handlePushPullPick's arm->pick->mount shape in SolidsWorkbenchPage.tsx);
// additional points for a linear/circular placement are computed from that
// point using an in-plane (u,v) basis derived from the face normal
// (dressUpGeometry.ts's perpBasis) -- no second pick required per point.
//
// WO UI-16 (C4): the seed origin is a typed X/Y/Z field initialized from the
// face click. Eligible points come from sketches drawn on this exact face and
// are projected to world through projectSketchPointToWorld.
//
// WO UI-67: those same candidates are now projected back into the viewport as
// hover/click targets. The Snap-to list remains a fallback and both routes
// write the same seed state. No target UI appears when the face has no sketch
// points.
//
// WO-042 (UI-107 slice 4): the dialog's live-preview seam on the delivered
// DRESS-UP template (fillet/chamfer/shell: single owner body, face ref,
// numeric params) -- NOT the extrude profile template. The preview intent is
// the EXACT payload the next Apply will commit (owner + face + ONE picked
// seed + computed pattern points + style + ONE shared depth), so the ghost is
// exactly the committed result. The page owns the FeaturePreviewSession;
// Apply routes through onApplyGuard BEFORE any history command executes.

import { useEffect, useMemo, useRef, useState } from 'react'
import { NumericInput } from '../../ui/NumericInput'
import type { CommandHistory, DagNodeSnapshot, FeatureDag } from '../../../doc'
import type { HoleStyle, Vec3 } from '../../../geom/geom-service'
import type { Sketch as CamSketch } from '../../../lib/sketch/sketcher'
import { isFacePlaneDatumPayload } from '../../../sketch3d/datumPlane'
import type { PlaneFrame } from '../../../sketch3d/planeMath'
import { DialogShell } from './DialogShell'
import { createFeatureCommand } from './createFeatureCommand'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'
import { nextId } from './nextId'
import { addScaled, camSketchPointSamples, perpBasis, projectSketchPointToWorld } from './dressUpGeometry'

export interface HoleSnapCandidate {
  id: string
  label: string
  world: Vec3
}

/** WO UI-16 (C4): every candidate snap point from a sketch drawn on the
 *  EXACT (ownerId, faceId) the hole is being placed on -- a structural
 *  match on the face-plane datum's own consumes/refs (mirrors
 *  SolidsWorkbenchPage's reattach-path match at handleCanvasClick's
 *  `payload.planeNodeId === forDatumId` loop), not a geometric
 *  coplanarity test against every plane in the document. */
export function computeHoleSnapCandidates(
  dag: FeatureDag,
  ownerId: string,
  faceId: string,
): HoleSnapCandidate[] {
  // EVERY matching datum, not just the first: each separate Sketch-on-face
  // action mints its OWN face datum, so a find() here silently dropped every
  // later sketch on the same picked face (UI-16 audit major 1).
  const datums = dag
    .nodeIds()
    .map((id) => dag.getNode(id))
    .filter(
      (n): n is DagNodeSnapshot =>
        n !== undefined && n.kind === 'datum' && n.consumes.includes(ownerId) && n.refs.some((r) => r.id === faceId),
    )
  const frames = new Map<string, PlaneFrame>()
  for (const datum of datums) {
    if (!isFacePlaneDatumPayload(datum.payload)) continue
    const frame = datum.payload.lastGoodFrame
    if (frame !== undefined) frames.set(datum.id, frame)
  }
  if (frames.size === 0) return []
  const out: HoleSnapCandidate[] = []
  for (const id of dag.nodeIds()) {
    const node = dag.getNode(id)
    if (node === undefined || node.kind !== 'sketch') continue
    const payload = node.payload as { sketch?: CamSketch; planeNodeId?: string }
    if (payload.planeNodeId === undefined || payload.sketch === undefined) continue
    const frame = frames.get(payload.planeNodeId)
    if (frame === undefined) continue
    for (const sample of camSketchPointSamples(payload.sketch)) {
      out.push({ id: `${id}:${sample.id}`, label: `${sample.label} (${id})`, world: projectSketchPointToWorld(frame, sample.local) })
    }
  }
  return out
}

export type HolePlacement =
  | { kind: 'single' }
  | { kind: 'linear'; count: number; spacing: number }
  | { kind: 'circular'; count: number; radius: number; startAngleDeg: number }

export interface HoleFeaturePayload {
  opType: 'hole'
  ownerId: string
  faceId: string
  points: Vec3[]
  style: HoleStyle
  depth: { kind: 'blind'; distance: number } | { kind: 'throughAll' }
  /** Added with edit-after-creation. Optional for legacy single holes. */
  seed?: Vec3
  normal?: Vec3
  placement?: HolePlacement
  name: string
}

/** WO-042: one preview request. The payload IS the payload the next Apply
 *  will commit (create: the full new-feature payload under the id the next
 *  Apply will mint; edit: the saved payload with the dialog's fields merged
 *  the exact way handleApply merges them). */
export interface HolePreviewIntent {
  featureId: string
  payload: HoleFeaturePayload
}

export type HolePreviewState =
  | { status: 'idle' | 'pending' | 'ready' }
  | { status: 'refused'; message: string }

interface HoleDialogCommonProps {
  dag: FeatureDag
  history: CommandHistory
  onApplied(featureId: string): void
  onClose(): void
  /** WO-042: page-owned preview session status (idle/pending/ready/refused). */
  previewState?: HolePreviewState
  /** WO-042: emitted on every geometric change; null when the current values
   *  cannot form a valid preview (invalid style/depth/pattern/seed). */
  onPreviewIntent?: (intent: HolePreviewIntent | null) => void
  /** WO-042: commit-time guard, REQUIRED semantics from day one (WO-030's
   *  audit lesson): runs BEFORE history.execute and refuses Apply unless the
   *  dialog intent IS the accepted ready intent and the session baseline
   *  fingerprint still matches the authored model. */
  onApplyGuard?: (intent: HolePreviewIntent) => Promise<string | undefined>
}

export type HoleDialogProps = HoleDialogCommonProps & (
  | {
      mode: 'create'
      ownerId: string
      faceId: string
      origin: Vec3
      normal: Vec3
      snapCandidates?: readonly HoleSnapCandidate[]
      selectedSnapId?: string
      onSeedChange?(seed: Vec3, snapId: string): void
      featureId?: never
    }
  | {
      mode: 'edit'
      featureId: string
      ownerId?: never
      faceId?: never
      origin?: never
      normal?: never
      snapCandidates?: never
      selectedSnapId?: never
      onSeedChange?: never
    }
)

export interface HolePointPickerOverlayProps {
  candidates: readonly HoleSnapCandidate[]
  selectedId: string
  /** Hover may originate from either the visible marker or the canvas's
   *  projected-point picker. Keeping one controlled value makes both routes
   *  show the same anchoring feedback. */
  hoveredId?: string | null
  onHoveredIdChange?(candidateId: string | null): void
  projectToCanvas(point: Vec3): { x: number; y: number } | null
  onPick(candidate: HoleSnapCandidate): void
}

/** A point marker is deliberately small enough to describe the exact sketch
 *  location, but its pick area must not demand pixel-perfect mouse control.
 *  This is the shared projection-space primitive used by both the marker and
 *  the workbench canvas event path. */
export const HOLE_POINT_PICK_TOLERANCE_PX = 20

export function pickProjectedHolePoint(
  candidates: readonly HoleSnapCandidate[],
  projectToCanvas: (point: Vec3) => { x: number; y: number } | null,
  pointer: { x: number; y: number },
  tolerance = HOLE_POINT_PICK_TOLERANCE_PX,
): HoleSnapCandidate | null {
  const maxDistanceSquared = tolerance * tolerance
  let closest: HoleSnapCandidate | null = null
  let closestDistanceSquared = maxDistanceSquared
  for (const candidate of candidates) {
    const projected = projectToCanvas(candidate.world)
    if (projected === null) continue
    const dx = projected.x - pointer.x
    const dy = projected.y - pointer.y
    const distanceSquared = dx * dx + dy * dy
    if (distanceSquared <= closestDistanceSquared) {
      closest = candidate
      closestDistanceSquared = distanceSquared
    }
  }
  return closest
}

/** Camera-tracking viewport targets for the same candidates used by the
 *  dialog fallback list. The overlay reuses SceneRuntime.projectToCanvas;
 *  it does not invent a B-rep vertex or a parallel geometry selection. */
export function HolePointPickerOverlay({
  candidates,
  selectedId,
  hoveredId: controlledHoveredId,
  onHoveredIdChange,
  projectToCanvas,
  onPick,
}: HolePointPickerOverlayProps) {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [localHoveredId, setLocalHoveredId] = useState<string | null>(null)
  const candidatesRef = useRef(candidates)
  const projectRef = useRef(projectToCanvas)
  candidatesRef.current = candidates
  projectRef.current = projectToCanvas
  const hoveredId = controlledHoveredId ?? localHoveredId
  const setHoveredId = (candidateId: string | null): void => {
    if (onHoveredIdChange !== undefined) onHoveredIdChange(candidateId)
    else setLocalHoveredId(candidateId)
  }

  useEffect(() => {
    let frame = 0
    const tick = (): void => {
      const next: Record<string, { x: number; y: number }> = {}
      for (const candidate of candidatesRef.current) {
        const projected = projectRef.current(candidate.world)
        if (projected !== null) next[candidate.id] = projected
      }
      setPositions((previous) => {
        const previousIds = Object.keys(previous)
        const nextIds = Object.keys(next)
        if (
          previousIds.length === nextIds.length &&
          nextIds.every((id) =>
            previous[id]?.x === next[id].x && previous[id]?.y === next[id].y)
        ) {
          return previous
        }
        return next
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div
      className="hole-point-pick-layer"
      data-testid="hole-point-pick-layer"
      data-hovered-id={hoveredId ?? ''}
    >
      {candidates.map((candidate) => {
        const position = positions[candidate.id]
        if (position === undefined) return null
        const selected = candidate.id === selectedId
        const hovered = candidate.id === hoveredId
        return (
          <button
            key={candidate.id}
            type="button"
            className={[
              'hole-point-pick-target',
              selected ? 'hole-point-pick-target--selected' : '',
              hovered ? 'hole-point-pick-target--hovered' : '',
            ].filter(Boolean).join(' ')}
            style={{ left: position.x, top: position.y }}
            data-testid={`hole-point-pick-${candidate.id}`}
            data-hole-point-id={candidate.id}
            data-hovered={hovered ? 'true' : 'false'}
            aria-label={`Use ${candidate.label}`}
            data-tooltip={candidate.label}
            onPointerEnter={() => setHoveredId(candidate.id)}
            onPointerLeave={() => setHoveredId(
              hoveredId === candidate.id ? null : hoveredId)}
            onClick={() => onPick(candidate)}
          />
        )
      })}
    </div>
  )
}

function computePoints(origin: Vec3, normal: Vec3, placement: HolePlacement): Vec3[] {
  if (placement.kind === 'single') return [origin]
  const { u, v } = perpBasis(normal)
  if (placement.kind === 'linear') {
    return Array.from({ length: placement.count }, (_, i) => addScaled(origin, u, i * placement.spacing, v, 0))
  }
  const startRad = (placement.startAngleDeg * Math.PI) / 180
  return Array.from({ length: placement.count }, (_, i) => {
    const theta = startRad + (i * 2 * Math.PI) / placement.count
    return addScaled(origin, u, placement.radius * Math.cos(theta), v, placement.radius * Math.sin(theta))
  })
}

function readVec3(value: unknown): Vec3 | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<Vec3>
  if (![candidate.x, candidate.y, candidate.z].every((component) => typeof component === 'number' && Number.isFinite(component))) return undefined
  return { x: candidate.x!, y: candidate.y!, z: candidate.z! }
}

function readPoints(value: unknown): Vec3[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const points = value.map(readVec3)
  return points.every((point): point is Vec3 => point !== undefined) ? points : undefined
}

function readPlacement(value: unknown): HolePlacement | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<HolePlacement> & Record<string, unknown>
  if (candidate.kind === 'single') return { kind: 'single' }
  if (
    candidate.kind === 'linear' &&
    typeof candidate.count === 'number' && Number.isFinite(candidate.count) &&
    typeof candidate.spacing === 'number' && Number.isFinite(candidate.spacing)
  ) {
    return { kind: 'linear', count: candidate.count, spacing: candidate.spacing }
  }
  if (
    candidate.kind === 'circular' &&
    typeof candidate.count === 'number' && Number.isFinite(candidate.count) &&
    typeof candidate.radius === 'number' && Number.isFinite(candidate.radius) &&
    typeof candidate.startAngleDeg === 'number' && Number.isFinite(candidate.startAngleDeg)
  ) {
    return { kind: 'circular', count: candidate.count, radius: candidate.radius, startAngleDeg: candidate.startAngleDeg }
  }
  return undefined
}

function holeStyleError(style: unknown): string | undefined {
  if (typeof style !== 'object' || style === null) return 'Hole style is missing.'
  const value = style as Partial<HoleStyle> & Record<string, unknown>
  if (value.kind !== 'simple' && value.kind !== 'counterbore' && value.kind !== 'countersink') return 'Hole style is invalid.'
  if (typeof value.diameter !== 'number' || !Number.isFinite(value.diameter) || value.diameter <= 0) return 'Hole diameter must be greater than zero.'
  if (value.kind === 'counterbore') {
    if (typeof value.cbDiameter !== 'number' || !Number.isFinite(value.cbDiameter) || value.cbDiameter <= 0) return 'Counterbore diameter must be greater than zero.'
    if (typeof value.cbDepth !== 'number' || !Number.isFinite(value.cbDepth) || value.cbDepth <= 0) return 'Counterbore depth must be greater than zero.'
  }
  if (value.kind === 'countersink') {
    if (typeof value.csDiameter !== 'number' || !Number.isFinite(value.csDiameter) || value.csDiameter <= 0) return 'Countersink diameter must be greater than zero.'
    if (typeof value.csAngleDeg !== 'number' || !Number.isFinite(value.csAngleDeg) || value.csAngleDeg <= 0 || value.csAngleDeg >= 180) return 'Countersink angle must be between 0 and 180 degrees.'
  }
  return undefined
}

function holeDepthError(depth: unknown): string | undefined {
  if (typeof depth !== 'object' || depth === null) return 'Hole depth is missing.'
  const value = depth as { kind?: unknown; distance?: unknown }
  if (value.kind === 'throughAll') return undefined
  if (value.kind !== 'blind') return 'Hole depth type is invalid.'
  if (typeof value.distance !== 'number' || !Number.isFinite(value.distance) || value.distance <= 0) return 'Blind depth must be greater than zero.'
  return undefined
}

function placementError(placement: HolePlacement, hasNormal: boolean): string | undefined {
  if (placement.kind === 'single') return undefined
  if (!hasNormal) return 'Pattern edit refused: the original hole has no stored face normal.'
  if (!Number.isInteger(placement.count) || placement.count < 2) return 'Hole pattern count must be at least 2.'
  if (placement.kind === 'linear' && (!Number.isFinite(placement.spacing) || placement.spacing <= 0)) return 'Hole pattern spacing must be greater than zero.'
  if (placement.kind === 'circular' && (!Number.isFinite(placement.radius) || placement.radius <= 0)) return 'Hole pattern radius must be greater than zero.'
  if (placement.kind === 'circular' && !Number.isFinite(placement.startAngleDeg)) return 'Hole pattern start angle must be finite.'
  return undefined
}

function editReferenceError(dag: FeatureDag, featureId: string): string | undefined {
  const node = dag.getNode(featureId)
  if (node === undefined || node.kind !== 'feature' || node.payload.opType !== 'hole') {
    return `Hole edit refused: '${featureId}' is not a Hole feature`
  }
  const ownerId = node.payload.ownerId
  if (typeof ownerId !== 'string' || ownerId.length === 0 || dag.getNode(ownerId) === undefined) {
    return `Hole edit refused: owner '${String(ownerId)}' is not available`
  }
  if (!node.consumes.includes(ownerId)) {
    return `Hole edit refused: owner '${ownerId}' is missing from the feature dependencies`
  }
  const order = dag.featureOrder()
  if (order.indexOf(ownerId) < 0 || order.indexOf(ownerId) >= order.indexOf(featureId)) {
    return `Hole edit refused: owner '${ownerId}' is not an upstream body feature`
  }
  if (typeof node.payload.faceId !== 'string' || node.payload.faceId.length === 0) {
    return `Hole edit refused: '${featureId}' has no valid face reference`
  }
  const points = readPoints(node.payload.points)
  if (points === undefined) return `Hole edit refused: '${featureId}' has no valid placement points`
  const styleError = holeStyleError(node.payload.style)
  if (styleError !== undefined) return `Hole edit refused: ${styleError}`
  const depthError = holeDepthError(node.payload.depth)
  if (depthError !== undefined) return `Hole edit refused: ${depthError}`

  if (node.payload.placement === undefined) {
    if (points.length > 1) return `Hole edit refused: '${featureId}' is a legacy pattern with no placement metadata`
    return undefined
  }
  const placement = readPlacement(node.payload.placement)
  if (placement === undefined || readVec3(node.payload.seed) === undefined) {
    return `Hole edit refused: '${featureId}' has invalid placement metadata`
  }
  const normal = readVec3(node.payload.normal)
  const patternError = placementError(placement, normal !== undefined)
  return patternError === undefined ? undefined : `Hole edit refused: ${patternError}`
}

export function HoleDialog(props: HoleDialogProps) {
  const { dag, history, onApplied, onClose } = props
  const editing = props.mode === 'edit'
  const existing = editing ? dag.getNode(props.featureId) : undefined
  const existingPayload = existing?.payload
  const existingPoints = readPoints(existingPayload?.points)
  const existingPlacement = readPlacement(existingPayload?.placement)
  const existingNormal = readVec3(existingPayload?.normal)
  const ownerId = editing && typeof existingPayload?.ownerId === 'string' ? existingPayload.ownerId : props.mode === 'create' ? props.ownerId : ''
  const faceId = editing && typeof existingPayload?.faceId === 'string' ? existingPayload.faceId : props.mode === 'create' ? props.faceId : ''
  const origin = editing
    ? readVec3(existingPayload?.seed) ?? existingPoints?.[0] ?? { x: 0, y: 0, z: 0 }
    : props.origin
  const normal = editing ? existingNormal ?? { x: 0, y: 0, z: 1 } : props.normal
  const suppliedSnapCandidates = props.mode === 'create' ? props.snapCandidates : undefined
  const suppliedSelectedSnapId = props.mode === 'create' ? props.selectedSnapId : undefined
  const onSeedChange = props.mode === 'create' ? props.onSeedChange : undefined

  // WO UI-16 (C4): the typed seed origin -- initialized from the face-click point (`origin`), then
  // user-editable (typed X/Y/Z, or a snap-list selection). computePoints below reads THIS, never the
  // raw `origin` prop directly, so an untouched dialog reproduces today's exact seed unchanged.
  const [localSeed, setLocalSeed] = useState<Vec3>(origin)
  const [localSelectedSnapId, setLocalSelectedSnapId] = useState<string>('')
  const computedSnapCandidates = useMemo(
    () => computeHoleSnapCandidates(dag, ownerId, faceId),
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- advisory: no React Compiler runs in this build; the manual memo is intentional
    [dag, ownerId, faceId],
  )
  const snapCandidates = suppliedSnapCandidates ?? computedSnapCandidates
  const seed = onSeedChange === undefined ? localSeed : origin
  const selectedSnapId = suppliedSelectedSnapId ?? localSelectedSnapId
  const updateSeed = (next: Vec3, snapId: string): void => {
    if (onSeedChange !== undefined) {
      onSeedChange(next, snapId)
      return
    }
    setLocalSeed(next)
    setLocalSelectedSnapId(snapId)
  }
  const existingStyle = typeof existingPayload?.style === 'object' && existingPayload.style !== null
    ? existingPayload.style as Partial<HoleStyle> & Record<string, unknown>
    : undefined
  const initialStyleKind: HoleStyle['kind'] =
    existingStyle?.kind === 'counterbore' || existingStyle?.kind === 'countersink' ? existingStyle.kind : 'simple'
  const existingDepth = typeof existingPayload?.depth === 'object' && existingPayload.depth !== null
    ? existingPayload.depth as { kind?: unknown; distance?: unknown }
    : undefined
  const initialPlacement = existingPlacement ?? ({ kind: 'single' } as const)
  const [styleKind, setStyleKind] = useState<HoleStyle['kind']>(initialStyleKind)
  const [diameter, setDiameter] = useState<number>(typeof existingStyle?.diameter === 'number' ? existingStyle.diameter : 6)
  const [cbDiameter, setCbDiameter] = useState<number>(typeof existingStyle?.cbDiameter === 'number' ? existingStyle.cbDiameter : 9)
  const [cbDepth, setCbDepth] = useState<number>(typeof existingStyle?.cbDepth === 'number' ? existingStyle.cbDepth : 2)
  const [csDiameter, setCsDiameter] = useState<number>(typeof existingStyle?.csDiameter === 'number' ? existingStyle.csDiameter : 9)
  const [csAngleDeg, setCsAngleDeg] = useState<number>(typeof existingStyle?.csAngleDeg === 'number' ? existingStyle.csAngleDeg : 90)
  const [depthKind, setDepthKind] = useState<'blind' | 'throughAll'>(existingDepth?.kind === 'throughAll' ? 'throughAll' : 'blind')
  const [blindDistance, setBlindDistance] = useState<number>(typeof existingDepth?.distance === 'number' ? existingDepth.distance : 5)
  const [placementKind, setPlacementKind] = useState<HolePlacement['kind']>(initialPlacement.kind)
  const [count, setCount] = useState<number>(initialPlacement.kind === 'single' ? 3 : initialPlacement.count)
  const [spacing, setSpacing] = useState<number>(initialPlacement.kind === 'linear' ? initialPlacement.spacing : 10)
  const [radius, setRadius] = useState<number>(initialPlacement.kind === 'circular' ? initialPlacement.radius : 10)
  const [startAngleDeg, setStartAngleDeg] = useState<number>(initialPlacement.kind === 'circular' ? initialPlacement.startAngleDeg : 0)
  const [applyError, setApplyError] = useState<string | undefined>(undefined)

  const placement: HolePlacement =
    placementKind === 'single'
      ? { kind: 'single' }
      : placementKind === 'linear'
        ? { kind: 'linear', count, spacing }
        : { kind: 'circular', count, radius, startAngleDeg }

  const style: HoleStyle =
    styleKind === 'simple'
      ? { kind: 'simple', diameter }
      : styleKind === 'counterbore'
        ? { kind: 'counterbore', diameter, cbDiameter, cbDepth }
        : { kind: 'countersink', diameter, csDiameter, csAngleDeg }

  const depth = depthKind === 'throughAll' ? ({ kind: 'throughAll' } as const) : ({ kind: 'blind', distance: blindDistance } as const)

  const referenceError = editing ? editReferenceError(dag, props.featureId) : undefined
  const configurationError =
    readVec3(seed) === undefined
      ? 'Hole seed point must contain finite coordinates.'
      : holeStyleError(style) ?? holeDepthError(depth) ?? placementError(placement, !editing || existingNormal !== undefined)
  const invalid = referenceError !== undefined || configurationError !== undefined

  const previewControlled = props.onPreviewIntent !== undefined
  // WO-042: the id the next create Apply will mint against this same
  // (fingerprinted) dag -- ShellDialog's exact shape.
  const previewFeatureId = editing ? props.featureId : nextId(dag, 'F')
  const hasExistingNormal = existingNormal !== undefined
  // Serialized so the memo below keys on CONTENT: dag.getNode may hand back a
  // fresh snapshot object every render, and an identity dep would re-emit an
  // identical intent each render (an infinite request loop through the page's
  // pending-state re-render).
  const existingPayloadKey = editing ? JSON.stringify(existingPayload ?? null) : ''
  const previewIntent = useMemo<HolePreviewIntent | null>(() => {
    if (invalid) return null
    const intentSeed: Vec3 = { x: seed.x, y: seed.y, z: seed.z }
    const intentNormal: Vec3 = { x: normal.x, y: normal.y, z: normal.z }
    const intentPlacement: HolePlacement =
      placementKind === 'single'
        ? { kind: 'single' }
        : placementKind === 'linear'
          ? { kind: 'linear', count, spacing }
          : { kind: 'circular', count, radius, startAngleDeg }
    const intentStyle: HoleStyle =
      styleKind === 'simple'
        ? { kind: 'simple', diameter }
        : styleKind === 'counterbore'
          ? { kind: 'counterbore', diameter, cbDiameter, cbDepth }
          : { kind: 'countersink', diameter, csDiameter, csAngleDeg }
    const intentDepth = depthKind === 'throughAll' ? ({ kind: 'throughAll' } as const) : ({ kind: 'blind', distance: blindDistance } as const)
    const points = computePoints(intentSeed, intentNormal, intentPlacement)
    if (editing) {
      const base = JSON.parse(existingPayloadKey) as Record<string, unknown> | null
      if (base === null) return null
      const nextPayload: Record<string, unknown> = {
        ...base,
        points,
        style: intentStyle,
        depth: intentDepth,
        seed: intentSeed,
        placement: intentPlacement,
      }
      if (hasExistingNormal) nextPayload.normal = intentNormal
      else delete nextPayload.normal
      return { featureId: previewFeatureId, payload: nextPayload as unknown as HoleFeaturePayload }
    }
    return {
      featureId: previewFeatureId,
      payload: {
        opType: 'hole',
        ownerId,
        faceId,
        points,
        style: intentStyle,
        depth: intentDepth,
        seed: intentSeed,
        normal: intentNormal,
        placement: intentPlacement,
        name: `Hole ${previewFeatureId}`,
      },
    }
  }, [blindDistance, cbDepth, cbDiameter, count, csAngleDeg, csDiameter, depthKind, diameter, editing, existingPayloadKey, faceId, hasExistingNormal, invalid, normal.x, normal.y, normal.z, ownerId, placementKind, previewFeatureId, radius, seed.x, seed.y, seed.z, spacing, startAngleDeg, styleKind])

  const onPreviewIntent = props.onPreviewIntent
  useEffect(() => {
    onPreviewIntent?.(previewIntent)
  }, [onPreviewIntent, previewIntent])

  const onApplyGuard = props.onApplyGuard
  const handleApply = async (): Promise<void> => {
    if (invalid) return
    setApplyError(undefined)
    // WO-042: commit-time guard BEFORE any history command (WO-030's audit
    // lesson, REQUIRED from day one). A refusal never reaches execute.
    if (onApplyGuard !== undefined) {
      if (previewIntent === null) {
        setApplyError('Hole Apply refused: the accepted preview is no longer available.')
        return
      }
      const refusal = await onApplyGuard(previewIntent)
      if (refusal !== undefined) {
        setApplyError(refusal)
        return
      }
    }
    const points = computePoints(seed, normal, placement)
    if (editing) {
      const live = dag.getNode(props.featureId)
      const liveReferenceError = editReferenceError(dag, props.featureId)
      if (live === undefined || liveReferenceError !== undefined) {
        setApplyError(liveReferenceError ?? `Hole edit refused: '${props.featureId}' is no longer available`)
        return
      }
      const nextPayload: Record<string, unknown> = {
        ...live.payload,
        points,
        style,
        depth,
        seed,
        placement,
      }
      if (existingNormal === undefined) delete nextPayload.normal
      else nextPayload.normal = normal
      try {
        history.execute(new EditFeaturePayloadCommand(props.featureId, nextPayload, live.consumes))
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : String(err))
        return
      }
      onApplied(props.featureId)
      onClose()
      return
    }

    const id = nextId(dag, 'F')
    const payload = { opType: 'hole', ownerId, faceId, points, style, depth, seed, normal, placement, name: `Hole ${id}` }
    try {
      history.execute(createFeatureCommand(dag, { id, kind: 'feature', consumes: [ownerId], payload }))
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
      return
    }
    onApplied(id)
    onClose()
  }

  return (
    <DialogShell
      title={editing ? 'Edit Hole' : 'Hole'}
      onApply={() => { void handleApply() }}
      onCancel={onClose}
      applyDisabled={invalid || (previewControlled && props.previewState?.status === 'refused')}
      allowViewportInteraction={!editing && snapCandidates.length > 0}
      // WO-042: the extrude/revolve UI-107 presentation -- a centered dimming
      // modal would hide the live ghost the shared preview session exists to
      // show. The palette keeps the viewport visible and interactive.
      floatingPalette
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ borderTop: '1px solid var(--border-subtle, #2a3540)', paddingBottom: 8, color: 'var(--text-muted)' }}>Seed point</div>
        {!editing && snapCandidates.length > 0 && (
          <div
            data-testid="hole-viewport-point-hint"
            style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}
          >
            Pick a highlighted sketch point in the viewport, or use Snap to below.
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 12, color: 'var(--text-muted)' }}>X</span>
          <span data-testid="hole-seed-x" style={{ flex: 1, minWidth: 0 }}>
            <NumericInput value={seed.x} onChange={(v) => updateSeed({ ...seed, x: v }, '')} style={{ width: '100%' }} />
          </span>
          <span style={{ width: 12, color: 'var(--text-muted)' }}>Y</span>
          <span data-testid="hole-seed-y" style={{ flex: 1, minWidth: 0 }}>
            <NumericInput value={seed.y} onChange={(v) => updateSeed({ ...seed, y: v }, '')} style={{ width: '100%' }} />
          </span>
          <span style={{ width: 12, color: 'var(--text-muted)' }}>Z</span>
          <span data-testid="hole-seed-z" style={{ flex: 1, minWidth: 0 }}>
            <NumericInput value={seed.z} onChange={(v) => updateSeed({ ...seed, z: v }, '')} style={{ width: '100%' }} />
          </span>
        </label>
        {snapCandidates.length > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 80, color: 'var(--text-muted)' }}>Snap to</span>
            <select
              data-testid="hole-snap-select"
              value={selectedSnapId}
              onChange={(e) => {
                const id = e.target.value
                const candidate = snapCandidates.find((c) => c.id === id)
                if (candidate !== undefined) updateSeed(candidate.world, id)
                else updateSeed(seed, '')
              }}
              style={{ flex: 1 }}
            >
              <option value="">-- pick a sketch point --</option>
              {snapCandidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 80, color: 'var(--text-muted)' }}>Style</span>
          <select data-testid="hole-style-select" value={styleKind} onChange={(e) => setStyleKind(e.target.value as HoleStyle['kind'])} style={{ flex: 1 }}>
            <option value="simple">Simple</option>
            <option value="counterbore">Counterbore</option>
            <option value="countersink">Countersink</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 80, color: 'var(--text-muted)' }}>Diameter</span>
          <span data-testid="hole-diameter" style={{ flex: 1 }}>
            <NumericInput value={diameter} onChange={setDiameter} min={0.1} style={{ width: '100%' }} />
          </span>
        </label>
        {styleKind === 'counterbore' && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 80, color: 'var(--text-muted)' }}>CB diameter</span>
              <span data-testid="hole-cb-diameter" style={{ flex: 1 }}>
                <NumericInput value={cbDiameter} onChange={setCbDiameter} min={0.1} style={{ width: '100%' }} />
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 80, color: 'var(--text-muted)' }}>CB depth</span>
              <span data-testid="hole-cb-depth" style={{ flex: 1 }}>
                <NumericInput value={cbDepth} onChange={setCbDepth} min={0.1} style={{ width: '100%' }} />
              </span>
            </label>
          </>
        )}
        {styleKind === 'countersink' && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 80, color: 'var(--text-muted)' }}>CS diameter</span>
              <span data-testid="hole-cs-diameter" style={{ flex: 1 }}>
                <NumericInput value={csDiameter} onChange={setCsDiameter} min={0.1} style={{ width: '100%' }} />
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 80, color: 'var(--text-muted)' }}>CS angle</span>
              <span data-testid="hole-cs-angle" style={{ flex: 1 }}>
                <NumericInput value={csAngleDeg} onChange={setCsAngleDeg} min={1} max={179} style={{ width: '100%' }} />
              </span>
            </label>
          </>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 80, color: 'var(--text-muted)' }}>Depth</span>
          <select data-testid="hole-depth-select" value={depthKind} onChange={(e) => setDepthKind(e.target.value as 'blind' | 'throughAll')} style={{ flex: 1 }}>
            <option value="blind">Blind</option>
            <option value="throughAll">Through all</option>
          </select>
        </label>
        {depthKind === 'blind' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 80, color: 'var(--text-muted)' }}>Depth (mm)</span>
            <span data-testid="hole-blind-distance" style={{ flex: 1 }}>
              <NumericInput value={blindDistance} onChange={setBlindDistance} min={0.1} style={{ width: '100%' }} />
            </span>
          </label>
        )}
        <div style={{ borderTop: '1px solid var(--border-subtle, #2a3540)', paddingTop: 8, color: 'var(--text-muted)' }}>Placement</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 80, color: 'var(--text-muted)' }}>Pattern</span>
          <select
            data-testid="hole-placement-select"
            value={placementKind}
            onChange={(e) => setPlacementKind(e.target.value as HolePlacement['kind'])}
            style={{ flex: 1 }}
          >
            <option value="single">Single</option>
            <option value="linear">Linear</option>
            <option value="circular">Circular</option>
          </select>
        </label>
        {placementKind !== 'single' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 80, color: 'var(--text-muted)' }}>Count</span>
            <span data-testid="hole-pattern-count" style={{ flex: 1 }}>
              <NumericInput value={count} onChange={(v) => setCount(Math.round(v))} min={2} step={1} style={{ width: '100%' }} />
            </span>
          </label>
        )}
        {placementKind === 'linear' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 80, color: 'var(--text-muted)' }}>Spacing</span>
            <span data-testid="hole-pattern-spacing" style={{ flex: 1 }}>
              <NumericInput value={spacing} onChange={setSpacing} min={0.1} style={{ width: '100%' }} />
            </span>
          </label>
        )}
        {placementKind === 'circular' && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 80, color: 'var(--text-muted)' }}>Bolt radius</span>
              <span data-testid="hole-pattern-radius" style={{ flex: 1 }}>
                <NumericInput value={radius} onChange={setRadius} min={0.1} style={{ width: '100%' }} />
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 80, color: 'var(--text-muted)' }}>Start angle</span>
              <span data-testid="hole-pattern-start-angle" style={{ flex: 1 }}>
                <NumericInput value={startAngleDeg} onChange={setStartAngleDeg} style={{ width: '100%' }} />
              </span>
            </label>
          </>
        )}
        {previewControlled && (
          <div
            data-testid="hole-preview-status"
            data-status={props.previewState?.status ?? 'idle'}
            aria-live="polite"
            style={{
              color: props.previewState?.status === 'refused' ? 'var(--text-danger)' : 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            {props.previewState?.status === 'refused'
              ? props.previewState.message
              : props.previewState?.status === 'pending'
                ? 'Updating preview...'
                : props.previewState?.status === 'ready'
                  ? 'Live preview ready'
                  : ''}
          </div>
        )}
        {referenceError !== undefined && (
          <div data-testid="hole-reference-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {referenceError}
          </div>
        )}
        {configurationError !== undefined && (
          <div data-testid="hole-validation-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {configurationError}
          </div>
        )}
        {applyError !== undefined && (
          <div data-testid="hole-apply-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {applyError}
          </div>
        )}
      </div>
    </DialogShell>
  )
}
