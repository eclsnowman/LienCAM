// WO-1936: one Model-tool edit of an STL part's features, from pick to Apply.
//
// The Model screen's Defeature, Resize Hole, Push/Pull and Fillet tools render
// their OWN dialogs for an STL (the page does that); this hook is the state
// behind them when the thing picked is a feature of the open STL body
// (WO-1935) rather than a face of a kernel body:
//   - which features the operator has picked for the tool, and the field value;
//   - the live preview - the part as the planned edits would leave it, drawn in
//     place of the part (`StlModelBodyPresentation.setPreview`);
//   - Apply - each planned edit handed to the store's `addMeshEdit` (the SAME
//     call Setup's buttons made), then ONE step pushed onto the Model screen's
//     CommandHistory whose undo is `removeMeshEdit`.
// WO-1961: the Model screen's Boolean is one of those tools too - with the STL
// as its target and a box or cylinder as its tool (union adds, subtract cuts),
// the edit Setup's "Add or cut a shape" used to write.
//
// A hook of its own (not state inside SolidsWorkbenchPage) so the page's
// state census is untouched: nothing here is document state - the journal the
// edits land in is the CAM row's, owned by the store.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { CommandHistory } from '../../../doc'
import type { FeatureVerdict } from '../../../geom/geom-service'
import { primeBoringKernel, type BooleanBodyParameters, type MeshEditRecord } from '../../../mesh/edit'
import type { MeshBuffers } from '../../../mesh/types'
import { useCamStore } from '../../../store'
import type { FaceFrame } from '../gizmos'
import { defeatureRemovedLine, defeatureVerdictLabel } from '../dialogs/DefeatureDialog'
import { validateHoleDepth, validateResizeDiameter } from '../dialogs/ResizeHoleDialog'
import {
  planStlFeatureEdits,
  planStlShapeEdit,
  stlDefeatureVerdicts,
  stlEditRefusalLine,
  stlHoleDepth,
  StlMeshEditCommand,
  stlToolAccepts,
  type PlannedStlEdit,
  type StlEditPlan,
  type StlEditTool,
  type StlFeatureEditRequest,
} from './stlFeatureEdits'
import { stlFeatureCentroid, type StlModelBodyPresentation, type StlModelFeature, type StlModelPick } from './stlModelBody'

/** The preview's state, in the Defeature dialog's own four words. */
export interface StlToolPreview {
  kind: 'idle' | 'building' | 'ready' | 'failed'
  message: string
}

export type StlToolSession =
  | { kind: 'none' }
  | {
      kind: 'defeature'
      verdicts: FeatureVerdict[]
      selected: ReadonlySet<string>
      hoverKey: string | null
      preview: StlToolPreview
    }
  | {
      kind: 'resize-hole'
      featureId: string
      currentDiameter: number
      anchor: { x: number; y: number; z: number }
      draft: string
      preview: StlToolPreview
      /** WO-2117: Hole depth - the field is the hole's depth, not its diameter */
      depth?: { currentMm: number; through: boolean }
    }
  | { kind: 'push-pull'; featureId: string; frame: FaceFrame; draft: string; preview: StlToolPreview }
  | { kind: 'fillet'; featureIds: string[]; initialRadius: number; radius: number | null; preview: StlToolPreview }
  /** WO-1961: Boolean with the STL as its target; `shape` is its tool (null
   *  while the dialog's fields do not hold one) */
  | { kind: 'boolean'; shape: BooleanBodyParameters | null; preview: StlToolPreview }

/** A session's plan, either way it goes: the edits and the mesh they make, or
 *  the reason it cannot be done and the console line that says so. */
type SessionPlan =
  | { ok: true; edits: PlannedStlEdit[]; mesh: MeshBuffers }
  | { ok: false; reason: string; line: string }

const IDLE_DEFEATURE: StlToolPreview = { kind: 'idle', message: 'Select a feature to preview its removal.' }

export interface StlToolSessionOptions {
  presentationRef: MutableRefObject<StlModelBodyPresentation | null>
  /** the open STL row, or null when none is open */
  geoId: string | null
  partName: string
  history: CommandHistory
  notify(severity: 'info' | 'success' | 'warning' | 'error', message: string): void
  requestRender(): void
  /** called right after a step is pushed onto `history`, so the page keeps its
   *  own per-step bookkeeping in lockstep with the history */
  onStepPushed(): void
  /** WO-2120: Apply writes `geoId`'s journal - 'start' before its first
   *  edit, 'done' after its last, 'none' when it wrote nothing - so the page
   *  knows the redraws it causes are not a reopen */
  onJournalWrite?(geoId: string, phase: 'start' | 'done' | 'none'): void
}

export interface StlToolSessionApi {
  session: StlToolSession
  /** features the open session has picked, as indexes into the body model */
  markedFeatureIndexes: number[]
  /** the picked feature this tool edits, or null when the pick is not one */
  acceptedFeature(tool: StlEditTool, pick: StlModelPick | null): StlModelFeature | null
  /** open `tool` on the STL, optionally with a feature already picked.
   *  WO-2117: Resize Hole with `field` 'depth' is Hole depth. */
  start(tool: StlEditTool, feature: StlModelFeature | null, field?: 'depth'): void
  /** a viewport pick while a session is open; true when it was used */
  pick(pick: StlModelPick | null): boolean
  /** the hover highlight for `tool` - only features the tool edits light up */
  hover(tool: StlEditTool, pick: StlModelPick | null): void
  toggleDefeatureKey(featureKey: string): void
  hoverDefeatureRow(featureKey: string | null): void
  /** Resize Hole / Push/Pull field edit. Resize Hole previews at once; Push/Pull
   *  previews on `adjust` (its entry's two-stage Enter), as its kernel path does. */
  setDraft(draft: string): void
  adjust(draft: string): void
  /** Fillet dialog's radius (null while the field is not a valid radius) */
  setFilletRadius(radius: number | null): void
  /** WO-1961: the Boolean dialog's tool shape, with the STL its target. Opens
   *  the Boolean session and previews it; null ends that session. */
  setBooleanShape(shape: BooleanBodyParameters | null): void
  /** Apply the session: its refusal/error sentence, or undefined when it landed */
  apply(): Promise<string | undefined>
  close(): void
}

/** Where Resize Hole's entry anchors: the hole's upper opening (the centre of
 *  its facets carried up the axis to the highest of them), so the card that
 *  sits above its anchor leaves the hole it is previewing in view. */
function holeOpening(
  body: StlModelBodyPresentation['model'],
  feature: StlModelFeature,
  direction: readonly number[],
): { x: number; y: number; z: number } {
  const c = stlFeatureCentroid(body, feature)
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1
  const up = direction[2] < 0 ? -1 / length : 1 / length
  const axis = [direction[0] * up, direction[1] * up, direction[2] * up]
  let reach = 0
  for (const f of feature.facets) {
    for (let k = 0; k < 3; k++) {
      const o = f * 9 + k * 3
      const along = (body.positions[o] - c.x) * axis[0] + (body.positions[o + 1] - c.y) * axis[1] + (body.positions[o + 2] - c.z) * axis[2]
      if (along > reach) reach = along
    }
  }
  return { x: c.x + axis[0] * reach, y: c.y + axis[1] * reach, z: c.z + axis[2] * reach }
}

const mm = (value: number): string => `${Number(value.toFixed(3))} mm`
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** WO-2120: the line an applied STL edit prints, in the kernel route's own
 *  shape ("Resize hole to 7 mm applied on Part 1: 5 mm -> 7 mm."), so an STL
 *  edit says what it did. Undefined for a session with nothing to apply. */
export function stlAppliedLine(
  session: StlToolSession,
  partName: string,
  featureById: (id: string) => StlModelFeature | undefined,
): string | undefined {
  const part = `"${partName}"`
  switch (session.kind) {
    case 'none':
      return undefined
    case 'defeature':
      return defeatureRemovedLine(session.verdicts.filter((v) => session.selected.has(v.featureKey)), part)
    case 'resize-hole': {
      if (session.depth !== undefined) {
        const depth = validateHoleDepth(session.draft, session.depth.currentMm, session.depth.through)
        if (!depth.ok) return undefined
        const was = session.depth.through ? 'through' : `${mm(session.depth.currentMm)} deep`
        const now = depth.newDepth === 'through' ? 'through' : `${mm(depth.newDepth)} deep`
        return `Hole depth ${depth.newDepth === 'through' ? 'through' : mm(depth.newDepth)} applied on ${part}: ${was} -> ${now}.`
      }
      const valid = validateResizeDiameter(session.draft, session.currentDiameter)
      if (!valid.ok) return undefined
      return `Resize hole to ${mm(valid.newDiameter)} applied on ${part}: ${mm(session.currentDiameter)} -> ${mm(valid.newDiameter)}.`
    }
    case 'push-pull': {
      const distance = Number(session.draft)
      const face = featureById(session.featureId)
      return `Push/Pull ${distance > 0 ? '+' : ''}${mm(distance)} applied on ${part}${face === undefined ? '' : `: the ${face.label}`}.`
    }
    case 'fillet':
      return session.radius === null ? undefined
        : `Fillet ${mm(session.radius)} applied on ${part}: ${plural(session.featureIds.length, 'fillet')}, ${mm(session.initialRadius)} -> ${mm(session.radius)}.`
    case 'boolean': {
      const shape = session.shape
      if (shape === null) return undefined
      switch (shape.shape) {
        case 'chamfer':
          return `Chamfer ${mm(shape.distanceMm ?? 0)} applied on ${part}: ${plural(shape.edges?.length ?? 0, 'edge')}.`
        case 'hole': {
          const size = shape.diameterMm === undefined ? '' : `, ${mm(shape.diameterMm)}`
          const deep = shape.through === true ? ' through' : shape.lengthMm === undefined ? '' : `, ${mm(shape.lengthMm)} deep`
          return `Hole applied on ${part}: ${plural(shape.points?.length ?? 1, 'hole')}${size}${deep}.`
        }
        case 'shell':
          return `Shell ${mm(shape.thicknessMm ?? 0)} applied on ${part}: ${plural(shape.faces?.length ?? 0, 'face')} opened.`
        case 'draft':
          return `Draft ${Number((shape.angleDeg ?? 0).toFixed(3))} deg applied on ${part}: ${plural(shape.faces?.length ?? 0, 'face')}.`
        default:
          return `Boolean ${shape.operation === 'add' ? 'add' : 'cut'} applied on ${part}: a ${shape.shape}.`
      }
    }
  }
}

export function useStlToolSession(options: StlToolSessionOptions): StlToolSessionApi {
  const [session, setSessionState] = useState<StlToolSession>({ kind: 'none' })
  const sessionRef = useRef<StlToolSession>(session)
  const generationRef = useRef(0)
  const hoverKeyRef = useRef<string | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const setSession = useCallback((next: StlToolSession): void => {
    sessionRef.current = next
    setSessionState(next)
  }, [])

  const model = (): StlModelBodyPresentation['model'] | null => optionsRef.current.presentationRef.current?.model ?? null
  const featureById = (id: string): StlModelFeature | undefined => model()?.features.find((f) => f.id === id)

  /** The requests the open session stands for right now, or null when its
   *  field does not hold a value that can be previewed. */
  const requestsOf = (current: StlToolSession): StlFeatureEditRequest[] | null => {
    switch (current.kind) {
      case 'none':
      case 'boolean':
        return null
      case 'defeature': {
        const picked = current.verdicts
          .filter((v) => current.selected.has(v.featureKey))
          .map((v) => featureById(v.featureKey))
          .filter((f): f is StlModelFeature => f !== undefined)
        return picked.length > 0 ? picked.map((feature) => ({ tool: 'defeature' as const, feature })) : null
      }
      case 'resize-hole': {
        const feature = featureById(current.featureId)
        if (current.depth !== undefined) {
          const depth = validateHoleDepth(current.draft, current.depth.currentMm, current.depth.through)
          return feature !== undefined && depth.ok
            ? [{ tool: 'resize-hole', feature, diameterMm: current.currentDiameter, depth: depth.newDepth }]
            : null
        }
        const valid = validateResizeDiameter(current.draft, current.currentDiameter)
        return feature !== undefined && valid.ok ? [{ tool: 'resize-hole', feature, diameterMm: valid.newDiameter }] : null
      }
      case 'push-pull': {
        const feature = featureById(current.featureId)
        const distance = Number(current.draft)
        return feature !== undefined && Number.isFinite(distance) && Math.abs(distance) > 1e-6
          ? [{ tool: 'push-pull', feature, distanceMm: distance }]
          : null
      }
      case 'fillet': {
        const picked = current.featureIds.map(featureById).filter((f): f is StlModelFeature => f !== undefined)
        // The radius the blend already has is no edit (the dialog opens on it).
        return picked.length > 0 && current.radius !== null && current.radius > 0 &&
          Math.abs(current.radius - current.initialRadius) > 1e-9
          ? picked.map((feature) => ({ tool: 'fillet' as const, feature, radiusMm: current.radius as number }))
          : null
      }
    }
  }

  /** Plan against the part as it stands. The boring kernel is loaded first
   *  when a bore is asked for (it loads asynchronously; replay does not). */
  const plan = async (requests: readonly StlFeatureEditRequest[]): Promise<StlEditPlan | null> => {
    const body = model()
    if (body === null) return null
    if (requests.some((r) => r.tool === 'resize-hole')) await primeBoringKernel()
    try {
      return planStlFeatureEdits(body, requests)
    } catch (err) {
      return { ok: false, feature: requests[0].feature, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  /** The plan for `current`, or null when its fields hold nothing to plan
   *  (known at once, so the preview can say so without waiting). */
  const planSession = (current: StlToolSession): (() => Promise<SessionPlan | null>) | null => {
    const partName = optionsRef.current.partName
    if (current.kind === 'boolean') {
      const shape = current.shape
      if (shape === null) return null
      return async () => {
        const body = model()
        if (body === null) return null
        // The union/cut runs in the kernel the bores use; load it first.
        await primeBoringKernel()
        const planned = planStlShapeEdit(body.mesh, shape)
        return planned.ok ? planned : { ok: false, reason: planned.reason, line: `"${partName}": ${planned.reason}` }
      }
    }
    const requests = requestsOf(current)
    if (requests === null) return null
    return async () => {
      const planned = await plan(requests)
      if (planned === null) return null
      return planned.ok
        ? planned
        : { ok: false, reason: planned.reason, line: stlEditRefusalLine(partName, planned.feature, planned.reason) }
    }
  }

  const withPreview = (current: StlToolSession, preview: StlToolPreview): StlToolSession =>
    current.kind === 'none' ? current : { ...current, preview }

  const showPreview = useCallback((next: StlToolSession): void => {
    const generation = ++generationRef.current
    const presentation = optionsRef.current.presentationRef.current
    const planner = planSession(next)
    if (planner === null) {
      presentation?.setPreview(null)
      optionsRef.current.requestRender()
      setSession(withPreview(next, next.kind === 'defeature' ? IDLE_DEFEATURE : { kind: 'idle', message: 'Enter a value to preview it.' }))
      return
    }
    setSession(withPreview(next, { kind: 'building', message: 'Building the preview...' }))
    void (async () => {
      let result: SessionPlan | null
      try {
        result = await planner()
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        result = { ok: false, reason, line: `"${optionsRef.current.partName}": ${reason}` }
      }
      if (generation !== generationRef.current || result === null) return
      const live = optionsRef.current.presentationRef.current
      if (result.ok) {
        live?.setPreview(result.mesh)
        setSession(withPreview(sessionRef.current, {
          kind: 'ready',
          message: `Preview: ${result.edits.length} edit${result.edits.length === 1 ? '' : 's'} on "${optionsRef.current.partName}".`,
        }))
      } else {
        live?.setPreview(null)
        setSession(withPreview(sessionRef.current, { kind: 'failed', message: result.reason }))
        optionsRef.current.notify('warning', result.line)
      }
      optionsRef.current.requestRender()
    })()
  // requestsOf/plan read only refs; the generation guard retires stale runs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSession])

  const close = useCallback((): void => {
    generationRef.current++
    hoverKeyRef.current = null
    const presentation = optionsRef.current.presentationRef.current
    presentation?.setPreview(null)
    presentation?.setHover(null)
    optionsRef.current.requestRender()
    setSession({ kind: 'none' })
  }, [setSession])

  // The part closing (or a different part opening) ends any session on it.
  useEffect(() => {
    if (sessionRef.current.kind !== 'none') close()
  }, [options.geoId, close])

  const acceptedFeature = useCallback((tool: StlEditTool, pick: StlModelPick | null): StlModelFeature | null => {
    if (pick === null || pick.kind !== 'feature') return null
    const feature = optionsRef.current.presentationRef.current?.model.features[pick.featureIndex]
    return feature !== undefined && stlToolAccepts(tool, feature) ? feature : null
  }, [])

  const start = useCallback((tool: StlEditTool, feature: StlModelFeature | null, field?: 'depth'): void => {
    const body = optionsRef.current.presentationRef.current?.model
    if (body === undefined) return
    generationRef.current++
    optionsRef.current.presentationRef.current?.setPreview(null)
    const picked = feature !== null && stlToolAccepts(tool, feature) ? feature : null
    if (tool === 'defeature') {
      const verdicts = stlDefeatureVerdicts(body.features)
      optionsRef.current.notify('info', `Pick features to remove on "${optionsRef.current.partName}" - ${verdicts.length} can be removed. Clicking a feature selects it whole.`)
      showPreview({
        kind: 'defeature',
        verdicts,
        selected: new Set(picked !== null ? [picked.id] : []),
        hoverKey: null,
        preview: IDLE_DEFEATURE,
      })
      return
    }
    if (picked === null) return
    const target = picked.target
    if (tool === 'resize-hole' && target.family === 'round' && field === 'depth') {
      // WO-2117: the depth from the hole's opening, as the kernel route's card
      // shows it. A hole neither end of which opens still opens the card; its
      // preview then says why the depth cannot change.
      const facts = stlHoleDepth(body, picked)
      const currentMm = Number((facts?.depthMm ?? target.feature.depthMm).toFixed(3))
      setSession({
        kind: 'resize-hole',
        featureId: picked.id,
        currentDiameter: Number(target.feature.diameterMm.toFixed(3)),
        anchor: holeOpening(body, picked, target.feature.axis.direction),
        draft: String(currentMm),
        preview: { kind: 'idle', message: 'Type the new depth, or "through".' },
        depth: { currentMm, through: facts?.through ?? target.feature.kind === 'through-hole' },
      })
    } else if (tool === 'resize-hole' && target.family === 'round') {
      const draft = String(Number(target.feature.diameterMm.toFixed(3)))
      setSession({
        kind: 'resize-hole',
        featureId: picked.id,
        currentDiameter: Number(target.feature.diameterMm.toFixed(3)),
        anchor: holeOpening(body, picked, target.feature.axis.direction),
        draft,
        preview: { kind: 'idle', message: 'Type the new diameter.' },
      })
    } else if (tool === 'push-pull' && target.family === 'flat') {
      const [nx, ny, nz] = target.face.plane.normal
      setSession({
        kind: 'push-pull',
        featureId: picked.id,
        frame: { origin: stlFeatureCentroid(body, picked), normal: { x: nx, y: ny, z: nz } },
        draft: '0',
        preview: { kind: 'idle', message: 'Drag or type how far.' },
      })
    } else if (tool === 'fillet' && target.family === 'blend') {
      const radius = Number((target.blend.radiusMm ?? 0).toFixed(3))
      setSession({
        kind: 'fillet',
        featureIds: [picked.id],
        initialRadius: radius,
        radius: null,
        preview: { kind: 'idle', message: 'Type the new radius.' },
      })
    }
    optionsRef.current.notify('info', `Selected ${picked.label} on "${optionsRef.current.partName}".`)
  }, [setSession, showPreview])

  const toggleDefeatureKey = useCallback((featureKey: string): void => {
    const current = sessionRef.current
    if (current.kind !== 'defeature') return
    const verdict = current.verdicts.find((v) => v.featureKey === featureKey)
    if (verdict === undefined || !verdict.removable) return
    const selected = new Set(current.selected)
    const included = !selected.has(featureKey)
    if (included) selected.add(featureKey)
    else selected.delete(featureKey)
    optionsRef.current.notify('info', `${included ? 'Included' : 'Excluded'} ${defeatureVerdictLabel(verdict)} ${included ? 'in' : 'from'} the removal (${selected.size} selected).`)
    showPreview({ ...current, selected })
  }, [showPreview])

  const pick = useCallback((hit: StlModelPick | null): boolean => {
    const current = sessionRef.current
    // Boolean's tool shape is typed into its dialog; a click on the part picks nothing.
    if (current.kind === 'none' || current.kind === 'boolean') return false
    const tool: StlEditTool = current.kind
    const feature = acceptedFeature(tool, hit)
    if (feature === null) return false
    if (current.kind === 'defeature') {
      toggleDefeatureKey(feature.id)
    } else if (current.kind === 'fillet') {
      const featureIds = current.featureIds.includes(feature.id)
        ? current.featureIds.filter((id) => id !== feature.id)
        : [...current.featureIds, feature.id]
      optionsRef.current.notify('info', `${featureIds.includes(feature.id) ? 'Added' : 'Removed'} ${feature.label} (${featureIds.length} selected).`)
      showPreview({ ...current, featureIds })
    } else if (feature.id !== current.featureId) {
      start(tool, feature, current.kind === 'resize-hole' && current.depth !== undefined ? 'depth' : undefined)
    }
    return true
  }, [acceptedFeature, showPreview, start, toggleDefeatureKey])

  const hover = useCallback((tool: StlEditTool, hit: StlModelPick | null): void => {
    const presentation = optionsRef.current.presentationRef.current
    if (presentation === null) return
    const feature = acceptedFeature(tool, hit)
    const key = feature?.id ?? null
    if (key === hoverKeyRef.current) return
    hoverKeyRef.current = key
    presentation.setHover(feature !== null && hit !== null ? hit : null)
    const current = sessionRef.current
    if (current.kind === 'defeature') {
      setSession({ ...current, hoverKey: key })
      const verdict = current.verdicts.find((v) => v.featureKey === key)
      if (verdict !== undefined) {
        optionsRef.current.notify('info', `${defeatureVerdictLabel(verdict)} - click to ${current.selected.has(verdict.featureKey) ? 'exclude from' : 'include in'} removal.`)
      }
    }
    optionsRef.current.requestRender()
  }, [acceptedFeature, setSession])

  const hoverDefeatureRow = useCallback((featureKey: string | null): void => {
    const current = sessionRef.current
    const presentation = optionsRef.current.presentationRef.current
    if (current.kind !== 'defeature' || presentation === null) return
    const index = featureKey === null ? -1 : presentation.model.features.findIndex((f) => f.id === featureKey)
    hoverKeyRef.current = index >= 0 ? featureKey : null
    presentation.setHover(index >= 0 ? { kind: 'feature', featureIndex: index, distance: 0 } : null)
    setSession({ ...current, hoverKey: index >= 0 ? featureKey : null })
    optionsRef.current.requestRender()
  }, [setSession])

  const setDraft = useCallback((draft: string): void => {
    const current = sessionRef.current
    if (current.kind === 'resize-hole') {
      const valid = current.depth !== undefined
        ? validateHoleDepth(draft, current.depth.currentMm, current.depth.through)
        : validateResizeDiameter(draft, current.currentDiameter)
      if (!valid.ok) {
        generationRef.current++
        optionsRef.current.presentationRef.current?.setPreview(null)
        optionsRef.current.requestRender()
        setSession({ ...current, draft, preview: { kind: 'failed', message: valid.reason } })
        return
      }
      showPreview({ ...current, draft })
    } else if (current.kind === 'push-pull') {
      setSession({ ...current, draft })
    }
  }, [setSession, showPreview])

  const adjust = useCallback((draft: string): void => {
    const current = sessionRef.current
    if (current.kind === 'push-pull') showPreview({ ...current, draft })
  }, [showPreview])

  const setFilletRadius = useCallback((radius: number | null): void => {
    const current = sessionRef.current
    if (current.kind !== 'fillet' || current.radius === radius) return
    showPreview({ ...current, radius })
  }, [showPreview])

  const setBooleanShape = useCallback((shape: BooleanBodyParameters | null): void => {
    const current = sessionRef.current
    if (shape === null) {
      if (current.kind === 'boolean') close()
      return
    }
    if (optionsRef.current.presentationRef.current === null) return
    showPreview({
      kind: 'boolean',
      shape,
      preview: current.kind === 'boolean' ? current.preview : { kind: 'idle', message: 'Enter a shape to preview it.' },
    })
  }, [close, showPreview])

  const apply = useCallback(async (): Promise<string | undefined> => {
    const current = sessionRef.current
    const { geoId, partName, notify, history } = optionsRef.current
    const planner = planSession(current)
    if (geoId === null || planner === null) return 'Nothing to apply yet.'
    const appliedLine = stlAppliedLine(current, partName, featureById)
    generationRef.current++
    const planned = await planner()
    if (planned === null) return 'The part is not open.'
    if (!planned.ok) {
      notify('warning', planned.line)
      return planned.reason
    }
    const store = useCamStore.getState()
    const recorded: MeshEditRecord[] = []
    let failure: string | undefined
    optionsRef.current.onJournalWrite?.(geoId, 'start')
    for (const step of planned.edits) {
      try {
        recorded.push(await store.addMeshEdit(geoId, step.edit))
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
        break
      }
    }
    optionsRef.current.onJournalWrite?.(geoId, recorded.length === 0 ? 'none' : 'done')
    if (recorded.length > 0) {
      history.execute(new StlMeshEditCommand(
        {
          addMeshEdit: (id, edit) => useCamStore.getState().addMeshEdit(id, edit),
          removeMeshEdit: (id, editId) => useCamStore.getState().removeMeshEdit(id, editId),
          fail: (message) => optionsRef.current.notify('error', message),
        },
        geoId,
        planned.edits.slice(0, recorded.length).map((step) => step.edit),
        recorded,
      ))
      optionsRef.current.onStepPushed()
      if (failure === undefined && appliedLine !== undefined) notify('success', appliedLine)
      for (const step of planned.edits.slice(0, recorded.length)) {
        if (step.note !== undefined) notify('info', `"${partName}": ${step.note}`)
      }
    }
    if (failure !== undefined) {
      notify('error', `"${partName}": ${failure}`)
      return failure
    }
    hoverKeyRef.current = null
    setSession({ kind: 'none' })
    // The preview stays on screen until the part redraws from the edited
    // journal, so the shape does not flick back to the old one in between.
    return undefined
  // requestsOf/plan read only refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSession])

  const markedFeatureIndexes = (() => {
    const body = options.presentationRef.current?.model
    if (body === undefined) return []
    const ids = session.kind === 'defeature'
      ? [...session.selected]
      : session.kind === 'fillet'
        ? session.featureIds
        : session.kind === 'resize-hole' || session.kind === 'push-pull'
          ? [session.featureId]
          : []
    return ids.map((id) => body.features.findIndex((f) => f.id === id)).filter((i) => i >= 0)
  })()

  return {
    session,
    markedFeatureIndexes,
    acceptedFeature,
    start,
    pick,
    hover,
    toggleDefeatureKey,
    hoverDefeatureRow,
    setDraft,
    adjust,
    setFilletRadius,
    setBooleanShape,
    apply,
    close,
  }
}
