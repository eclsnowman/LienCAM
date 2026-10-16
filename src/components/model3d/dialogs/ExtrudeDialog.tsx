import { readableInternalIds } from '../../../lib/operatorLabels'
// WO INT-4A: extrude dialog on the BoxSizeDialog pattern -- 'create' mode
// picks a sketch profile + a DRIVING distance and inserts a new 'feature'
// DAG node (InsertNodeCommand, undo removes it); 'edit' mode reuses the
// EditFeaturePayloadCommand seam BoxSizeDialog itself proves. The actual
// makeExtrude kernel call lives in the page's regen executor (never in this
// dialog), mirroring BoxSizeDialog/ChassisDemo's own dialog-vs-page split.
//
// WO INT-4A-R1 (R1.1): distance is DRIVING per the WO mission -- an optional
// bound expression (workbench/featureDimension.ts, the SAME DOC-4 parser/
// evaluator src/sketch3d/dimensionBinding.ts reuses) makes it expression-
// capable, re-evaluated on every regen pass through the page's executor.
// While bound, the numeric field shows the last-good evaluated value and is
// read-only; clearing the expression un-binds it, keeping that last-good
// value as a plain literal (mirrors unbindDimensionExpression).
//
// WO UI-51A: the dialog now surfaces the extrude parameter model wired through
// this stage -- DIRECTION (up / down / symmetric-midplane) and BOOLEAN MODE
// (new body / add / remove / intersect). The direction/boolMode->kernel
// mapping is NOT duplicated here; it lives once in workbench/extrudeParams.ts
// (shared with the page's executor). Edit mode exposes the same profile,
// boolean mode, and target controls as create. Applying those topology edits
// rewrites payload + consumes in the same EditFeaturePayloadCommand step.
// draftAngleDeg / thin are accepted-and-ignored kernel trap fields and are
// deliberately NOT exposed (see extrudeParams.ts header).
//
// WO-035 (UI-107 slice 2): the dialog's live-preview seam, following the
// OffsetPlaneDialog shape. The intent is geometric only; the page owns the
// FeaturePreviewSession and hands preview status back down. Apply routes
// through onApplyGuard BEFORE any history command executes, so a stale or
// mismatched preview refuses the commit rather than committing blind.

import { useText, textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { useEffect, useMemo, useRef, useState } from 'react'
import { NumericInput } from '../../ui/NumericInput'
import type { CommandHistory, FeatureDag } from '../../../doc'
import type { ExtrudeEndTargetIdentity, ProfileRegion } from '../../../geom/geom-service'
import { DialogShell } from './DialogShell'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'
import { createFeatureCommand } from './createFeatureCommand'
import { nextId } from './nextId'
import { featureExpressionParamConsumes, validateFeatureExpression } from '../workbench/featureDimension'
import {
  DEFAULT_EXTRUDE_BOOL_MODE,
  DEFAULT_EXTRUDE_DIRECTION,
  DEFAULT_EXTRUDE_END_CONDITION,
  EXTRUDE_BOOL_MODES,
  EXTRUDE_BOOL_MODE_LABELS,
  EXTRUDE_DIRECTIONS,
  EXTRUDE_DIRECTION_LABELS,
  EXTRUDE_END_CONDITIONS,
  EXTRUDE_END_CONDITION_LABELS,
  isExtrudeBoolMode,
  isExtrudeDirection,
  isExtrudeEndCondition,
  type ExtrudeBoolMode,
  type ExtrudeDirection,
  type ExtrudeEndCondition,
} from '../workbench/extrudeParams'
import {
  profilePickCandidatesForSketch,
  profilePickKey,
  type ProfilePickResult,
  type ProfilePickStopper,
  type StartProfilePick,
} from '../workbench/profileRegionPicker'
import type { ProfileSelector, RegionSignature } from '../workbench/regionSelector'

export interface ExtrudeFeaturePayload {
  opType: 'extrude'
  sketchId: string
  /** Missing means legacy first closed region; explicit picks remain stable across region reorder. */
  profileSelector?: ProfileSelector
  /** POSITIVE magnitude -- direction (not sign) says up/down (extrudeParams.ts). */
  distance: number
  direction: ExtrudeDirection
  endCondition: ExtrudeEndCondition
  /** Signed distance from the picked/automatic terminal back toward or past it. */
  terminalOffset?: number
  /** Durable same-item target for selected face/plane, body, or vertex modes. */
  endTarget?: ExtrudeEndTargetIdentity
  /** Exact kernel-resolved target set retained for automatic terminal modes. */
  resolvedEndTargets?: ExtrudeEndTargetIdentity[]
  boolMode: ExtrudeBoolMode
  /** required iff boolMode !== 'newBody': the target body feature id. */
  targetFeatureId?: string
  /** Optional driving expression (e.g. "2*base+5") -- see featureDimension.ts. */
  expression?: string
  name: string
}

// WO-035 (UI-107 slice 2): one preview request. Geometric fields only (the
// feature name never rides here, so renaming can't kill the ghost). This shape
// is deliberately the PROFILE-CONSUMING template revolve/sweep/loft will
// extend: a sketch profile reference + a newBody/add-or-cut target.
export interface ExtrudePreviewIntent {
  mode: 'create' | 'edit'
  /** edit mode only */
  featureId?: string
  sketchId: string
  profileSelector?: ProfileSelector
  /** POSITIVE magnitude, already clamped by the dialog's numeric field. */
  distance: number
  direction: ExtrudeDirection
  endCondition: ExtrudeEndCondition
  terminalOffset?: number
  endTarget?: ExtrudeEndTargetIdentity
  boolMode: ExtrudeBoolMode
  /** present iff boolMode !== 'newBody' */
  targetFeatureId?: string
  /** Optional driving expression; the scratch replay re-evaluates it. */
  expression?: string
}

export type ExtrudePreviewState =
  | { status: 'idle' | 'pending' | 'ready' }
  | { status: 'refused'; message: string }

export interface ExtrudeApplyAcceptance {
  resolvedEndTargets?: ExtrudeEndTargetIdentity[]
}

/** MW-PICKS-1 (Q-68): the boolean-target body pick, ported straight from
 *  BooleanDialog's RequestBooleanBodyPick -- a single role (Extrude has one
 *  target, not a target+tool sequence), so no role parameter. The caller
 *  (SolidsWorkbenchPage) arms a viewport body-click session, drives hover
 *  highlight + console feedback, and resolves excludedIds/onPicked exactly
 *  like Boolean's own callback. */
export type RequestExtrudeTargetPick = (
  excludedIds: readonly string[],
  onPicked: (featureId: string) => void,
) => void

export type ExtrudeEndTargetPickKind = 'face' | 'part' | 'vertex'

export interface ExtrudeEndTargetSelection {
  identity: ExtrudeEndTargetIdentity
  label: string
}

export type RequestExtrudeEndTargetPick = (
  kind: ExtrudeEndTargetPickKind,
  onPicked: (selection: ExtrudeEndTargetSelection) => void,
) => void

export interface ExtrudeDialogProps {
  dag: FeatureDag
  history: CommandHistory
  mode: 'create' | 'edit'
  /** required in edit mode */
  featureId?: string
  /** required in create mode */
  sketchOptions?: Array<{ id: string; label: string }>
  treeSketchPick?: { sketchId: string; nonce: number }
  onTreePickConsumed?: (nonce: number) => void
  /** body features selectable as an add/remove/intersect target */
  bodyOptions?: Array<{ id: string; label: string }>
  /** Starts the shared workbench viewport profile picker. */
  onStartProfilePick?: StartProfilePick
  /** Keeps the chosen-region outline synchronized with secondary selection controls. */
  onProfileSelectionChange?: (selection: ProfilePickResult | null) => void
  /** MW-PICKS-1: starts the shared workbench viewport target-body picker.
   *  The name dropdown (below) stays as the second path either way. */
  onRequestTargetPick?: RequestExtrudeTargetPick
  /** Starts the viewport/tree picker for a target-driven terminal condition. */
  onRequestEndTargetPick?: RequestExtrudeEndTargetPick
  /** Clears the page-owned terminal picker when the condition changes/closes. */
  onCancelEndTargetPick?: () => void
  /** Stable display name for a restored target identity. */
  endTargetLabel?: (identity: ExtrudeEndTargetIdentity) => string
  onApplied(featureId: string): void
  onClose(): void
  /** WO-035: page-owned preview session status (idle/pending/ready/refused). */
  previewState?: ExtrudePreviewState
  /** WO-035: emitted on every geometric change; null when the current values
   *  cannot form a valid preview (missing profile/target, bad expression). */
  onPreviewIntent?: (intent: ExtrudePreviewIntent | null) => void
  /** WO-035: commit-time guard, REQUIRED semantics from day one (WO-030's
   *  audit lesson): runs BEFORE history.execute and refuses Apply unless the
   *  dialog intent IS the accepted ready intent and the session baseline
   *  fingerprint still matches the authored model. */
  onApplyGuard?: (intent: ExtrudePreviewIntent) => Promise<string | ExtrudeApplyAcceptance | undefined>
}

const DEFAULT_DISTANCE = 15

function explicitRegionSignatures(selector: ProfileSelector | undefined): RegionSignature[] | null {
  if (selector?.kind === 'region') {
    return [{ signature: selector.signature, ...(selector.ordinal === undefined ? {} : { ordinal: selector.ordinal }) }]
  }
  return selector?.kind === 'regions' ? selector.regions : null
}

function selectorFromProfilePicks(results: readonly ProfilePickResult[]): ProfileSelector | undefined {
  if (results.length === 0) return undefined
  if (results.length === 1) return results[0].profileSelector
  const regions: RegionSignature[] = []
  for (const result of results) {
    if (result.profileSelector.kind !== 'region') return result.profileSelector
    regions.push({
      signature: result.profileSelector.signature,
      ...(result.profileSelector.ordinal === undefined ? {} : { ordinal: result.profileSelector.ordinal }),
    })
  }
  return { kind: 'regions', regions }
}

function extrudeRegionSummary(selectedCount: number, totalCount: number): string {
  return workbenchText('ExtrudeDialog.ofRegions', { selectedCount: String(selectedCount), totalCount: String(totalCount) })
}

function extrudeNameWithRegionSummary(name: string, summary?: string): string {
  const baseName = name.replace(/ - \d+ of \d+ regions$/, '')
  return summary === undefined ? baseName : `${baseName} - ${summary}`
}

export function isUpstreamProducer(dag: FeatureDag, featureId: string | undefined, producerId: string): boolean {
  if (featureId === undefined || producerId === featureId) return false
  const order = dag.featureOrder()
  const featureIndex = order.indexOf(featureId)
  const producerIndex = order.indexOf(producerId)
  if (featureIndex === -1 || producerIndex === -1 || producerIndex >= featureIndex) return false

  const pending = [producerId]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const id = pending.pop()!
    if (id === featureId) return false
    if (visited.has(id)) continue
    visited.add(id)
    pending.push(...(dag.getNode(id)?.consumes ?? []))
  }
  return true
}

export function ExtrudeDialog({ dag, history, mode, featureId, sketchOptions, treeSketchPick, onTreePickConsumed, bodyOptions, onStartProfilePick, onProfileSelectionChange, onRequestTargetPick, onRequestEndTargetPick, onCancelEndTargetPick, endTargetLabel, onApplied, onClose, previewState, onPreviewIntent, onApplyGuard }: ExtrudeDialogProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const editing = mode === 'edit'
  const existing = editing && featureId !== undefined ? (dag.getNode(featureId)?.payload as Record<string, unknown> | undefined) : undefined
  const suppliedSketches = sketchOptions ?? dag.nodeIds()
    .filter((id) => dag.getNode(id)?.kind === 'sketch')
    .map((id) => ({ id, label: String(dag.getNode(id)?.payload.name ?? id) }))
  const suppliedBodies = bodyOptions ?? []
  const sketches = suppliedSketches.filter((option) => !editing || isUpstreamProducer(dag, featureId, option.id))
  const bodies = suppliedBodies.filter((option) => !editing || isUpstreamProducer(dag, featureId, option.id))
  const [sketchId, setSketchId] = useState<string>((existing?.sketchId as string | undefined) ?? sketchOptions?.[0]?.id ?? '')
  const [profileSelector, setProfileSelector] = useState<ProfileSelector | undefined>(
    existing?.profileSelector as ProfileSelector | undefined,
  )
  const [treeSelectionActive, setTreeSelectionActive] = useState(false)
  const [isPickingProfile, setIsPickingProfile] = useState(false)
  const [profilePickDraft, setProfilePickDraft] = useState<readonly ProfilePickResult[]>([])
  const stopProfilePickRef = useRef<ProfilePickStopper | undefined>(undefined)
  const handledTreeSketchPickNonceRef = useRef(0)
  const [distance, setDistance] = useState<number>((existing?.distance as number | undefined) ?? DEFAULT_DISTANCE)
  const [expression, setExpression] = useState<string>((existing?.expression as string | undefined) ?? '')
  const [direction, setDirection] = useState<ExtrudeDirection>(isExtrudeDirection(existing?.direction) ? existing.direction : DEFAULT_EXTRUDE_DIRECTION)
  const [endCondition, setEndCondition] = useState<ExtrudeEndCondition>(
    isExtrudeEndCondition(existing?.endCondition)
      ? existing.endCondition
      : existing?.direction === 'midplane'
        ? 'symmetric'
        : DEFAULT_EXTRUDE_END_CONDITION,
  )
  const [terminalOffset, setTerminalOffset] = useState<number>(
    typeof existing?.terminalOffset === 'number' && Number.isFinite(existing.terminalOffset) ? existing.terminalOffset : 0,
  )
  const [endTarget, setEndTarget] = useState<ExtrudeEndTargetIdentity | undefined>(
    existing?.endTarget !== null && typeof existing?.endTarget === 'object'
      ? existing.endTarget as ExtrudeEndTargetIdentity
      : undefined,
  )
  const [pickedEndTargetLabel, setPickedEndTargetLabel] = useState<string | undefined>(undefined)
  const [boolMode, setBoolMode] = useState<ExtrudeBoolMode>(isExtrudeBoolMode(existing?.boolMode) ? existing.boolMode : DEFAULT_EXTRUDE_BOOL_MODE)
  const [targetFeatureId, setTargetFeatureId] = useState<string>(
    typeof existing?.targetFeatureId === 'string' ? (existing.targetFeatureId as string) : bodies[0]?.id ?? '',
  )
  const [expressionError, setExpressionError] = useState<string | undefined>(undefined)
  const [applyError, setApplyError] = useState<string | undefined>(undefined)

  const profileAvailable = sketches.some((option) => option.id === sketchId)
  const treeSketchPickAvailable = treeSketchPick !== undefined && sketches.some((option) => option.id === treeSketchPick.sketchId)
  const sketchNode = dag.getNode(sketchId)
  const profileCandidates = profilePickCandidatesForSketch(
    sketchId,
    sketchNode?.payload.profile as ProfileRegion | undefined,
    sketchNode?.payload.regions as ProfileRegion[] | undefined,
  )
  const explicitRegions = explicitRegionSignatures(profileSelector)
  const selectedRegionCount = isPickingProfile
    ? profilePickDraft.length
    : explicitRegions?.length ?? profileCandidates.length
  const profileRegionSummary = extrudeRegionSummary(selectedRegionCount, profileCandidates.length)
  const featureRegionSummary = profileSelector?.kind === 'regions' ? profileRegionSummary : undefined
  const explicitlySelectedKeys = new Set((explicitRegions ?? []).map((region) =>
    profilePickKey(sketchId, { kind: 'region', ...region }),
  ))

  useEffect(() => {
    if (treeSketchPick === undefined || treeSketchPick.nonce <= handledTreeSketchPickNonceRef.current) return
    handledTreeSketchPickNonceRef.current = treeSketchPick.nonce
    if (isPickingProfile || !treeSketchPickAvailable) {
      console.info(workbenchText('ExtrudeDialog.treePickIgnored', { value1: String(isPickingProfile ? workbenchText('ExtrudeDialog.profilePickSessionIsActive') : workbenchText('ExtrudeDialog.sketchIsNotAvailable')) }))
      onTreePickConsumed?.(treeSketchPick.nonce)
      return
    }
    setSketchId(treeSketchPick.sketchId)
    setProfileSelector({ kind: 'whole-sketch' })
    setTreeSelectionActive(true)
    onTreePickConsumed?.(treeSketchPick.nonce)
  }, [treeSketchPick, treeSketchPickAvailable, isPickingProfile, onTreePickConsumed])

  useEffect(() => {
    // WO-035: edit mode restores + visibly highlights the SAVED profile even
    // when it is a whole-sketch/legacy selector (the region case already
    // highlighted); create keeps its prior region-only behavior.
    onProfileSelectionChange?.(
      profileSelector?.kind === 'region' || profileSelector?.kind === 'regions'
        ? { sketchId, profileSelector }
        : editing && profileAvailable
          ? { sketchId, profileSelector: { kind: 'whole-sketch' } }
          : null,
    )
    return () => onProfileSelectionChange?.(null)
  }, [sketchId, profileSelector, onProfileSelectionChange, editing, profileAvailable])

  const needsTarget = boolMode !== 'newBody'
  const needsEndTarget = endCondition === 'toFace' || endCondition === 'toPart' || endCondition === 'toVertex'
  const supportsTerminalOffset = endCondition === 'upToNext' || needsEndTarget
  const targetAvailable = !needsTarget || bodies.some((option) => option.id === targetFeatureId)
  const noTargetAvailable = needsTarget && bodies.length === 0
  const missingTarget = needsTarget && (targetFeatureId === '' || !targetAvailable)
  const previewControlled = onPreviewIntent !== undefined
  // A pending preview does NOT disable Apply: the page's onApplyGuard awaits
  // the in-flight evaluation and commits only its accepted candidate. Only an
  // explicit refusal (bad geometry, drifted model) blocks the button.
  const applyDisabled = !profileAvailable || noTargetAvailable || missingTarget || (needsEndTarget && endTarget === undefined) ||
    (previewControlled && previewState?.status === 'refused')

  // WO-035: the live preview request. Null (which cancels any session) when
  // the current values cannot evaluate: no resolvable profile, a missing
  // add/remove/intersect target, a non-positive distance, or an expression
  // that fails validation. The numeric field clamps at its own min, so
  // distance <= 0 is only reachable through a stale initial payload.
  const boundExpression = expression.trim()
  const previewIntent = useMemo<ExtrudePreviewIntent | null>(() => {
    if (!profileAvailable || noTargetAvailable || missingTarget) return null
    if ((endCondition === 'blind' || endCondition === 'symmetric') && (!Number.isFinite(distance) || distance <= 0)) return null
    if ((endCondition === 'blind' || endCondition === 'symmetric') && boundExpression !== '' && !validateFeatureExpression(boundExpression).ok) return null
    if (supportsTerminalOffset && !Number.isFinite(terminalOffset)) return null
    if (needsEndTarget && endTarget === undefined) return null
    return {
      mode,
      ...(editing && featureId !== undefined ? { featureId } : {}),
      sketchId,
      ...(profileSelector !== undefined ? { profileSelector } : {}),
      distance,
      direction,
      endCondition,
      ...(supportsTerminalOffset ? { terminalOffset } : {}),
      ...(needsEndTarget && endTarget !== undefined ? { endTarget } : {}),
      boolMode,
      ...(needsTarget ? { targetFeatureId } : {}),
      ...((endCondition === 'blind' || endCondition === 'symmetric') && boundExpression !== '' ? { expression: boundExpression } : {}),
    }
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- advisory: no React Compiler runs in this build; the manual memo is intentional
  }, [profileAvailable, noTargetAvailable, missingTarget, distance, boundExpression, mode, editing, featureId, sketchId, profileSelector, direction, endCondition, supportsTerminalOffset, terminalOffset, needsEndTarget, endTarget, boolMode, needsTarget, targetFeatureId])

  useEffect(() => {
    onPreviewIntent?.(previewIntent)
  }, [onPreviewIntent, previewIntent])

  // MW-PICKS-1: arms the shared workbench viewport target-body pick (ports
  // BooleanDialog's requestViewportSequence pattern -- single role here, no
  // sequence). The dropdown fallback below is untouched by this call; it
  // stays live at all times as the second path.
  const beginTargetPick = (): void => {
    if (onRequestTargetPick === undefined) return
    onCancelEndTargetPick?.()
    onRequestTargetPick(
      editing && featureId !== undefined ? [featureId] : [],
      (pickedId) => setTargetFeatureId(pickedId),
    )
  }

  const beginEndTargetPick = (): void => {
    if (onRequestEndTargetPick === undefined || !needsEndTarget) return
    const kind: ExtrudeEndTargetPickKind = endCondition === 'toFace' ? 'face' : endCondition === 'toPart' ? 'part' : 'vertex'
    onRequestEndTargetPick(kind, (selection) => {
      setEndTarget(selection.identity)
      setPickedEndTargetLabel(selection.label)
    })
  }

  useEffect(() => () => onCancelEndTargetPick?.(), [onCancelEndTargetPick])

  const beginProfilePick = (): void => {
    if (onStartProfilePick === undefined) return
    setIsPickingProfile(true)
    setProfilePickDraft([])
    const stop = onStartProfilePick({
      allowedIds: sketches.map((option) => option.id),
      prompt: workbenchText('ExtrudeDialog.clickRegionsToToggleThemThenPressEnterOr'),
      maxPicks: 'many',
      onSelectionChange: setProfilePickDraft,
      onDone: (results) => {
        const result = results[0]
        if (result !== undefined) {
          setSketchId(result.sketchId)
          setProfileSelector(selectorFromProfilePicks(results))
          setTreeSelectionActive(false)
        }
        stopProfilePickRef.current = undefined
        setProfilePickDraft([])
        setIsPickingProfile(false)
      },
      onCancel: () => {
        stopProfilePickRef.current = undefined
        setProfilePickDraft([])
        setIsPickingProfile(false)
      },
    })
    stopProfilePickRef.current = typeof stop === 'function' ? stop : undefined
  }

  const finishProfilePick = (): void => {
    stopProfilePickRef.current?.done?.(profilePickDraft)
  }

  const cancelProfilePick = (): void => {
    const stop = stopProfilePickRef.current
    stopProfilePickRef.current = undefined
    setProfilePickDraft([])
    if (stop !== undefined) stop()
    else setIsPickingProfile(false)
  }

  const setFallbackRegionChecked = (candidateKey: string, checked: boolean): void => {
    const available = profileCandidates.flatMap((candidate) =>
      candidate.profileSelector.kind === 'region'
        ? [{
            key: candidate.key,
            region: {
              signature: candidate.profileSelector.signature,
              ...(candidate.profileSelector.ordinal === undefined ? {} : { ordinal: candidate.profileSelector.ordinal }),
            } satisfies RegionSignature,
          }]
        : [],
    )
    const current = explicitRegions === null
      ? available.map(({ region }) => region)
      : [...explicitRegions]
    const next = checked
      ? current.some((region) => profilePickKey(sketchId, { kind: 'region', ...region }) === candidateKey)
        ? current
        : [...current, available.find(({ key }) => key === candidateKey)!.region]
      : current.filter((region) => profilePickKey(sketchId, { kind: 'region', ...region }) !== candidateKey)
    if (next.length === 0) return
    setProfileSelector(next.length === 1 ? { kind: 'region', ...next[0] } : { kind: 'regions', regions: next })
  }

  const handleApply = async (): Promise<void> => {
    const distanceDriven = endCondition === 'blind' || endCondition === 'symmetric'
    const bound = distanceDriven ? expression.trim() : ''
    if (bound !== '') {
      const validation = validateFeatureExpression(bound)
      if (!validation.ok) {
        setExpressionError(`${validation.diag?.code}: ${JSON.stringify(validation.diag?.params)}`)
        return
      }
    }
    setExpressionError(undefined)
    setApplyError(undefined)
    // WO-035: commit-time guard BEFORE any history command. The page verifies
    // the current dialog intent IS the accepted ready intent and the session
    // baseline fingerprint still matches; a refusal never reaches execute.
    let acceptance: ExtrudeApplyAcceptance | undefined
    if (onApplyGuard !== undefined) {
      if (previewIntent === null) {
        setApplyError(workbenchText('ExtrudeDialog.extrudeApplyRefusedTheAcceptedPreviewIsNoLonger'))
        return
      }
      const refusal = await onApplyGuard(previewIntent)
      if (typeof refusal === 'string') {
        setApplyError(refusal)
        return
      }
      acceptance = refusal
    }
    const paramConsumes = featureExpressionParamConsumes(bound === '' ? undefined : bound)

    if (editing && featureId !== undefined) {
      const node = dag.getNode(featureId)
      const {
        expression: _priorExpression,
        targetFeatureId: _priorTargetFeatureId,
        profileSelector: _priorProfileSelector,
        endCondition: _priorEndCondition,
        terminalOffset: _priorTerminalOffset,
        endTarget: _priorEndTarget,
        resolvedEndTargets: _priorResolvedEndTargets,
        ...restPayload
      } = node?.payload ?? {}
      const payload = {
        ...restPayload,
        name: extrudeNameWithRegionSummary(
          typeof restPayload.name === 'string' ? restPayload.name : workbenchText('ExtrudeDialog.extrude', { featureId: String(featureId) }),
          featureRegionSummary,
        ),
        sketchId,
        ...(profileSelector !== undefined ? { profileSelector } : {}),
        distance,
        direction,
        endCondition,
        ...(supportsTerminalOffset ? { terminalOffset } : {}),
        ...(needsEndTarget && endTarget !== undefined ? { endTarget } : {}),
        ...(acceptance?.resolvedEndTargets !== undefined ? { resolvedEndTargets: acceptance.resolvedEndTargets } : {}),
        boolMode,
        ...(needsTarget ? { targetFeatureId } : {}),
        ...((endCondition === 'blind' || endCondition === 'symmetric') && bound !== '' ? { expression: bound } : {}),
      }
      const targetConsumes = needsTarget ? [targetFeatureId] : []
      const endTargetConsumes = endTarget !== undefined && 'planeFeatureId' in endTarget ? [endTarget.planeFeatureId] : []
      try {
        history.execute(
          new EditFeaturePayloadCommand(
            featureId,
            payload,
            [...new Set([sketchId, ...targetConsumes, ...endTargetConsumes, ...paramConsumes])],
          ),
        )
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : String(err))
        return
      }
      onApplied(featureId)
    } else {
      const id = nextId(dag, 'F')
      const targetConsumes = boolMode !== 'newBody' && targetFeatureId !== '' ? [targetFeatureId] : []
      const endTargetConsumes = endTarget !== undefined && 'planeFeatureId' in endTarget ? [endTarget.planeFeatureId] : []
      const payload = {
        opType: 'extrude',
        sketchId,
        ...(profileSelector !== undefined ? { profileSelector } : {}),
        distance,
        direction,
        endCondition,
        ...(supportsTerminalOffset ? { terminalOffset } : {}),
        ...(needsEndTarget && endTarget !== undefined ? { endTarget } : {}),
        ...(acceptance?.resolvedEndTargets !== undefined ? { resolvedEndTargets: acceptance.resolvedEndTargets } : {}),
        boolMode,
        ...(boolMode !== 'newBody' ? { targetFeatureId } : {}),
        ...((endCondition === 'blind' || endCondition === 'symmetric') && bound !== '' ? { expression: bound } : {}),
        name: extrudeNameWithRegionSummary(workbenchText('ExtrudeDialog.extrude2', { id: String(id) }), featureRegionSummary),
      }
      try {
        history.execute(createFeatureCommand(dag, { id, kind: 'feature', consumes: [...new Set([sketchId, ...targetConsumes, ...endTargetConsumes, ...paramConsumes])], payload }))
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : String(err))
        return
      }
      onApplied(id)
    }
    onClose()
  }

  return (
    <DialogShell
      title={editing ? workbenchText('ExtrudeDialog.editExtrude') : workbenchText('ExtrudeDialog.extrude3')}
      onApply={() => { void handleApply() }}
      onCancel={isPickingProfile ? cancelProfilePick : onClose}
      cancelLabel={isPickingProfile ? workbenchText('ExtrudeDialog.stopPicking') : workbenchText('ExtrudeDialog.cancel')}
      applyDisabled={applyDisabled || isPickingProfile}
      floatingPalette
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          type="button"
          className="op-pick-btn"
          data-testid="extrude-pick-profile"
          disabled={onStartProfilePick === undefined}
          aria-pressed={isPickingProfile}
          onClick={isPickingProfile ? finishProfilePick : beginProfilePick}
        >
          {isPickingProfile ? workbenchText('ExtrudeDialog.donePicking') : workbenchText('ExtrudeDialog.pickProfileInViewport')}
          <span className="op-pick-count">
            {(sketches.find((option) => option.id === sketchId)?.label ?? sketchId) || workbenchText('ExtrudeDialog.none')}
            {profileCandidates.length > 0 ? ` - ${profileRegionSummary}` : ''}
          </span>
        </button>
        {treeSelectionActive && (
          <div data-testid="extrude-tree-sketch-status" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
            {workbenchText('ExtrudeDialog.sketch')}{sketches.find((option) => option.id === sketchId)?.label ?? sketchId}{workbenchText('ExtrudeDialog.fromTheDesignTreeWholeSketch')}</div>
        )}
        {isPickingProfile && (
          <div data-testid="extrude-profile-pick-guidance" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
            {workbenchText('ExtrudeDialog.clickRegionsToToggleThemPressEnterOrDone')}</div>
        )}
        {(profileSelector?.kind === 'region' || profileSelector?.kind === 'regions') && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span data-testid="extrude-selected-profile-region" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
              {workbenchText('ExtrudeDialog.chosen')}{profileRegionSummary}
            </span>
            <button
              type="button"
              className="modal-btn"
              data-testid="extrude-use-whole-sketch"
              onClick={() => {
                setProfileSelector({ kind: 'whole-sketch' })
                setTreeSelectionActive(false)
              }}
            >
              {workbenchText('ExtrudeDialog.useWholeSketch')}</button>
          </div>
        )}
        <details>
          <summary style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>{workbenchText('ExtrudeDialog.chooseProfileByNameFallback')}</summary>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('ExtrudeDialog.profile')}</span>
            <select
              data-testid="extrude-profile-select"
              value={sketchId}
              onChange={(e) => {
                setSketchId(e.target.value)
                setProfileSelector({ kind: 'whole-sketch' })
                setTreeSelectionActive(false)
              }}
              style={{ flex: 1 }}
            >
              {!profileAvailable && sketchId !== '' && <option value={sketchId}>{workbenchText('ExtrudeDialog.unavailable')}{sketchId}{workbenchText('ExtrudeDialog.value')}</option>}
              {sketches.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          {profileCandidates.length > 0 && (
            <div data-testid="extrude-profile-region-fallback" style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8, paddingLeft: 78 }}>
              {profileCandidates.map((candidate, index) => {
                const checked = explicitRegions === null || explicitlySelectedKeys.has(candidate.key)
                const onlyExplicitChoice = explicitRegions?.length === 1 && checked
                return (
                  <label key={candidate.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="checkbox"
                      data-testid={`extrude-profile-region-${index + 1}`}
                      checked={checked}
                      disabled={candidate.profileSelector.kind !== 'region' || onlyExplicitChoice}
                      onChange={(event) => setFallbackRegionChecked(candidate.key, event.target.checked)}
                    />
                    {workbenchText('ExtrudeDialog.region')}{index + 1}
                  </label>
                )
              })}
            </div>
          )}
        </details>
        {!profileAvailable && (
          <div data-testid="extrude-profile-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {workbenchText('ExtrudeDialog.selectAnAvailableUpstreamSketchProfile')}</div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('ExtrudeDialog.end')}</span>
          <select
            data-testid="extrude-end-condition-select"
            value={endCondition}
            onChange={(e) => {
              const next = e.target.value as ExtrudeEndCondition
              onCancelEndTargetPick?.()
              setEndCondition(next)
              setEndTarget(undefined)
              setPickedEndTargetLabel(undefined)
              if (next === 'symmetric') setDirection('midplane')
              else if (direction === 'midplane' && next !== 'throughAll') setDirection('up')
            }}
            style={{ flex: 1 }}
          >
            {EXTRUDE_END_CONDITIONS.map((condition) => (
              <option key={condition} value={condition} data-testid={`extrude-end-condition-option-${condition}`}>
                {EXTRUDE_END_CONDITION_LABELS[condition]}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('ExtrudeDialog.direction')}</span>
          <select
            data-testid="extrude-direction-select"
            value={direction}
            onChange={(e) => setDirection(e.target.value as ExtrudeDirection)}
            disabled={endCondition === 'symmetric'}
            style={{ flex: 1 }}
          >
            {EXTRUDE_DIRECTIONS.filter((d) => endCondition === 'symmetric' ? d === 'midplane' : endCondition === 'throughAll' || d !== 'midplane').map((d) => (
              <option key={d} value={d} data-testid={`extrude-direction-option-${d}`}>
                {EXTRUDE_DIRECTION_LABELS[d]}
              </option>
            ))}
          </select>
        </label>
        {(endCondition === 'blind' || endCondition === 'symmetric') && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('ExtrudeDialog.distance')}</span>
              <span data-testid="extrude-distance" style={{ flex: 1 }}>
                <NumericInput value={distance} onChange={setDistance} min={0.1} disabled={expression.trim() !== ''} style={{ width: '100%' }} />
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('ExtrudeDialog.mm')}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('ExtrudeDialog.fx')}</span>
              <input
                data-testid="extrude-distance-expression"
                type="text"
                placeholder={workbenchText('ExtrudeDialog.optionalDrivingExpressionEG2Base5')}
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                style={{ flex: 1 }}
              />
            </label>
          </>
        )}
        {supportsTerminalOffset && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('ExtrudeDialog.offset')}</span>
            <span data-testid="extrude-terminal-offset" style={{ flex: 1 }}>
              <NumericInput value={terminalOffset} onChange={setTerminalOffset} style={{ width: '100%' }} />
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('ExtrudeDialog.mm')}</span>
          </label>
        )}
        {needsEndTarget && (
          <button
            type="button"
            className="op-pick-btn"
            data-testid="extrude-pick-end-target"
            disabled={onRequestEndTargetPick === undefined}
            onClick={beginEndTargetPick}
          >
            {endCondition === 'toFace' ? workbenchText('ExtrudeDialog.pickFaceOrPlane') : endCondition === 'toPart' ? workbenchText('ExtrudeDialog.pickPartOrBody') : workbenchText('ExtrudeDialog.pickVertexOrPoint')}
            <span
              className="op-pick-count"
              data-testid="extrude-end-target-name"
              style={{ minWidth: 0, maxWidth: '65%', whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.2, textAlign: 'right' }}
            >
              {endTarget === undefined ? workbenchText('ExtrudeDialog.none') : pickedEndTargetLabel ?? endTargetLabel?.(endTarget) ?? ('planeFeatureId' in endTarget ? endTarget.planeFeatureId : endTarget.bodyFeatureId)}
            </span>
          </button>
        )}
        {needsEndTarget && endTarget === undefined && (
          <div data-testid="extrude-end-target-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {EXTRUDE_END_CONDITION_LABELS[endCondition]}{workbenchText('ExtrudeDialog.needsAnEligibleTargetFromTheViewportOrModel')}</div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('ExtrudeDialog.result')}</span>
          <select
            data-testid="extrude-boolmode-select"
            value={boolMode}
            onChange={(e) => setBoolMode(e.target.value as ExtrudeBoolMode)}
            style={{ flex: 1 }}
          >
            {EXTRUDE_BOOL_MODES.map((m) => (
              <option key={m} value={m} data-testid={`extrude-boolmode-option-${m}`}>
                {EXTRUDE_BOOL_MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        {needsTarget && (
          <>
            <button
              type="button"
              className="op-pick-btn"
              data-testid="extrude-pick-target"
              disabled={onRequestTargetPick === undefined}
              onClick={beginTargetPick}
            >
              {workbenchText('ExtrudeDialog.pickBodyInViewport')}<span className="op-pick-count">{(bodies.find((option) => option.id === targetFeatureId)?.label ?? targetFeatureId) || workbenchText('ExtrudeDialog.none')}</span>
            </button>
            <details>
              <summary style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>{workbenchText('ExtrudeDialog.chooseTargetByNameFallback')}</summary>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('ExtrudeDialog.target')}</span>
                <select
                  data-testid="extrude-target-select"
                  value={targetFeatureId}
                  onChange={(e) => setTargetFeatureId(e.target.value)}
                  style={{ flex: 1 }}
                >
                  {!targetAvailable && targetFeatureId !== '' && <option value={targetFeatureId}>{workbenchText('ExtrudeDialog.unavailable')}{targetFeatureId}{workbenchText('ExtrudeDialog.value')}</option>}
                  {bodies.length === 0 && <option value="">{workbenchText('ExtrudeDialog.noBodyAvailable')}</option>}
                  {bodies.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </details>
          </>
        )}
        {noTargetAvailable && (
          <div data-testid="extrude-target-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {EXTRUDE_BOOL_MODE_LABELS[boolMode]}{workbenchText('ExtrudeDialog.needsAnExistingBodyToTargetCreateOneFirst')}</div>
        )}
        {needsTarget && !noTargetAvailable && !targetAvailable && (
          <div data-testid="extrude-target-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {workbenchText('ExtrudeDialog.selectAnAvailableUpstreamTargetBody')}</div>
        )}
        {expressionError !== undefined && (
          <div data-testid="extrude-distance-expression-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {readableInternalIds(expressionError)}
          </div>
        )}
        {previewControlled && (
          <div
            data-testid="extrude-preview-status"
            data-status={previewState?.status ?? 'idle'}
            aria-live="polite"
            style={{
              color: previewState?.status === 'refused' ? 'var(--text-danger)' : 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            {previewState?.status === 'refused'
              ? previewState.message
              : previewState?.status === 'pending'
                ? workbenchText('ExtrudeDialog.updatingPreview')
                : previewState?.status === 'ready'
                  ? workbenchText('ExtrudeDialog.livePreviewReady')
                  : ''}
          </div>
        )}
        {applyError !== undefined && (
          <div data-testid="extrude-apply-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {readableInternalIds(applyError)}
          </div>
        )}
      </div>
    </DialogShell>
  )
}
