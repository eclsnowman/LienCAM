import { readableInternalIds } from '../../../lib/operatorLabels'
// WO INT-4A: boolean-combine dialog -- target + tool body features + a
// union/subtract/intersect op, inserted as a new 'feature' DAG node
// (InsertNodeCommand) that consumes both inputs. The page's regen executor
// resolves 'fuse'/'cut'/'intersect' to a real applyBoolean call against the
// two upstream bodies' CURRENT kernel handles (never stored in this dialog
// or the DAG payload -- handles are ephemeral, payload stays plain JSON per
// commands.ts's own contract). Edit mode reuses these same target/tool/op
// controls and rewires the two body dependencies in one history command.
//
// The worker implements all three operations through history-producing OCCT
// booleans. A disjoint union/intersection refuses rather than producing a
// compound or empty pseudo-body.
//
// WO-1961: an imported STL open in the Model screen can be the TARGET. Its
// tool is then a box or a cylinder made right here (the fields below replace
// the tool list), Union adds it and Subtract cuts it, the part previews the
// result, and Apply hands the edit to the page (`meshTarget.onApply`) - which
// writes the STL's own edit journal, not the DAG. Intersect stays for kernel
// bodies: an STL's journal records an added or a cut shape, nothing else.
//
// WO-2823: every body the operator can see is a target or a tool, either way
// round. The STL target's tool list holds the modelled bodies after Box and
// Cylinder, and a modelled target's tool list holds the STL. A pair with the
// STL in it is the page's (`meshTarget.onApplyBody`): the STL goes in as the
// solid its mesh bounds and the Boolean - union, subtract or intersect - runs
// on the kernel like any other, its result a body every later edit picks.

import { useText, textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { useEffect, useRef, useState } from 'react'
import type { CommandHistory, FeatureDag } from '../../../doc'
import type { BooleanBodyParameters } from '../../../mesh/edit'
import { NumericInput } from '../../ui/NumericInput'
import { DialogShell } from './DialogShell'
import { createFeatureCommand } from './createFeatureCommand'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'
import { nextId } from './nextId'

export type BooleanOp = 'fuse' | 'cut' | 'intersect'

export interface BooleanFeaturePayload {
  opType: 'boolean'
  targetFeatureId: string
  toolFeatureId: string
  boolOp: BooleanOp
  name: string
}

export type BooleanBodyPickRole = 'target' | 'tool'

export interface BooleanBodySelection {
  targetFeatureId: string
  toolFeatureId: string
}

export type RequestBooleanBodyPick = (
  role: BooleanBodyPickRole,
  excludedIds: readonly string[],
  onPicked: (featureId: string) => void,
) => void

/** WO-1961: an STL part offered as the target, and what the page does with it. */
export interface BooleanMeshTarget {
  /** its Bodies-list id (`stl-body:<geo id>`) */
  id: string
  label: string
  /** where a new tool shape starts, in the part's own (STL file) coordinates */
  seedCenter: [number, number, number]
  /** a cylinder length that passes right through the part */
  seedLengthMm: number
  /** the preview's state, in the Defeature dialog's own four words */
  preview: { kind: 'idle' | 'building' | 'ready' | 'failed'; message: string }
  /** the tool shape as the fields stand; null when the STL is not the target */
  onToolShapeChange(shape: BooleanBodyParameters | null): void
  /** record it: the refusal/error sentence, or undefined when it landed */
  onApply(): Promise<string | undefined>
  /** WO-2823: a Boolean between the STL and a modelled body (either may be
   *  the target); the refusal/error sentence, or undefined when it landed */
  onApplyBody(pair: { targetFeatureId: string; toolFeatureId: string; boolOp: BooleanOp }): Promise<string | undefined>
}

type ShapeAxis = 'x' | 'y' | 'z'
const SHAPE_AXES: Record<ShapeAxis, [number, number, number]> = {
  x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
}

interface BooleanDialogCommonProps {
  dag: FeatureDag
  history: CommandHistory
  bodyOptions: Array<{ id: string; label: string }>
  /** WO-1961: create mode only - the STL part open in the Model screen */
  meshTarget?: BooleanMeshTarget
  activeBodyPickRole?: BooleanBodyPickRole | null
  onRequestBodyPick?: RequestBooleanBodyPick
  onSelectionChange?(selection: BooleanBodySelection): void
  onApplied(featureId: string): void
  onClose(): void
}

export type BooleanDialogProps = BooleanDialogCommonProps & (
  | { mode: 'create'; featureId?: never }
  | { mode: 'edit'; featureId: string }
)

const OP_LABELS: Record<BooleanOp, string> = {
  get fuse() { return workbenchText('BooleanDialog.union') },
  get cut() { return workbenchText('BooleanDialog.subtract') },
  get intersect() { return workbenchText('BooleanDialog.intersect') },
}

const SELECTABLE_OPS: ReadonlySet<BooleanOp> = new Set(['fuse', 'cut', 'intersect'])
const MESH_TARGET_OPS: ReadonlySet<BooleanOp> = new Set(['fuse', 'cut'])

export function BooleanDialog({
  dag,
  history,
  mode,
  featureId,
  bodyOptions,
  meshTarget,
  activeBodyPickRole = null,
  onRequestBodyPick,
  onSelectionChange,
  onApplied,
  onClose,
}: BooleanDialogProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const editing = mode === 'edit'
  const existing = editing ? dag.getNode(featureId) : undefined
  // WO-1961: an STL target is offered when creating only (an STL edit is its
  // journal's entry, never a Boolean node to edit later).
  const mesh = editing ? undefined : meshTarget
  const [targetFeatureId, setTargetFeatureId] = useState<string>(
    editing && typeof existing?.payload.targetFeatureId === 'string' ? existing.payload.targetFeatureId : mesh?.id ?? bodyOptions[0]?.id ?? '',
  )
  const [toolFeatureId, setToolFeatureId] = useState<string>(
    editing && typeof existing?.payload.toolFeatureId === 'string' ? existing.payload.toolFeatureId : bodyOptions[1]?.id ?? bodyOptions[0]?.id ?? '',
  )
  const [boolOp, setBoolOp] = useState<BooleanOp>(
    editing && (existing?.payload.boolOp === 'fuse' || existing?.payload.boolOp === 'cut' || existing?.payload.boolOp === 'intersect')
      ? existing.payload.boolOp
      : 'cut',
  )
  const [applyError, setApplyError] = useState<string | undefined>(undefined)
  const viewportPickStartedRef = useRef(false)
  // WO-1961: the tool shape for an STL target, seeded where Setup's control
  // seeded it - centred on the part's top face, a cylinder through the part.
  // WO-2823: 'box', 'cylinder', or the id of the modelled body that is the tool
  const [meshTool, setMeshTool] = useState<string>('box')
  const toolShape: 'box' | 'cylinder' = meshTool === 'cylinder' ? 'cylinder' : 'box'
  const meshToolBodyId = meshTool !== 'box' && meshTool !== 'cylinder' ? meshTool : null
  const [toolCenter, setToolCenter] = useState<[number, number, number]>(() => mesh?.seedCenter ?? [0, 0, 0])
  const [toolSize, setToolSize] = useState<[number, number, number]>([10, 10, 10])
  const [toolDiameter, setToolDiameter] = useState<number>(10)
  const [toolLength, setToolLength] = useState<number>(() => mesh?.seedLengthMm ?? 10)
  const [toolAxis, setToolAxis] = useState<ShapeAxis>('z')
  const [meshApplying, setMeshApplying] = useState(false)

  const targetIsMesh = mesh !== undefined && targetFeatureId === mesh.id
  const targetOptions = mesh !== undefined ? [{ id: mesh.id, label: mesh.label }, ...bodyOptions] : bodyOptions
  // WO-2823: the STL is a tool of a modelled target too.
  const toolOptions = mesh !== undefined ? [...bodyOptions, { id: mesh.id, label: mesh.label }] : bodyOptions
  /** the STL target's tool is a typed shape (not a body) */
  const shapeTool = targetIsMesh && meshToolBodyId === null
  /** the STL and a modelled body, either way round */
  const meshPair = mesh !== undefined && (targetIsMesh ? meshToolBodyId !== null : toolFeatureId === mesh.id)
  /** the tool body the dialog shows and Apply uses: an STL target's tool is
   *  its body pick (the hidden tool list keeps whatever the other direction
   *  last held); a shape tool is no body */
  const effectiveToolId = targetIsMesh ? meshToolBodyId ?? '' : toolFeatureId
  const selectableOps = shapeTool ? MESH_TARGET_OPS : SELECTABLE_OPS
  const toolShapeValid = toolShape === 'box'
    ? toolSize.every((n) => Number.isFinite(n) && n > 0)
    : toolDiameter > 0 && toolLength > 0
  const toolShapeParameters: BooleanBodyParameters | null = shapeTool && toolShapeValid && MESH_TARGET_OPS.has(boolOp)
    ? toolShape === 'box'
      ? { operation: boolOp === 'fuse' ? 'add' : 'subtract', shape: 'box', center: [...toolCenter], size: [...toolSize] }
      : {
          operation: boolOp === 'fuse' ? 'add' : 'subtract',
          shape: 'cylinder',
          center: [...toolCenter],
          diameterMm: toolDiameter,
          lengthMm: toolLength,
          axisDirection: [...SHAPE_AXES[toolAxis]],
        }
    : null
  const toolShapeKey = toolShapeParameters === null ? '' : JSON.stringify(toolShapeParameters)

  const editReferenceError = (() => {
    if (!editing) return undefined
    if (existing === undefined || existing.kind !== 'feature' || existing.payload.opType !== 'boolean') {
      return workbenchText('BooleanDialog.booleanEditRefusedIsNotABooleanFeature', { featureId: String(featureId) })
    }
    const target = existing.payload.targetFeatureId
    const tool = existing.payload.toolFeatureId
    if (typeof target !== 'string' || target.length === 0 || dag.getNode(target) === undefined) {
      return workbenchText('BooleanDialog.booleanEditRefusedTargetBodyIsNotAvailable', { value1: String(String(target)) })
    }
    if (typeof tool !== 'string' || tool.length === 0 || dag.getNode(tool) === undefined) {
      return workbenchText('BooleanDialog.booleanEditRefusedToolBodyIsNotAvailable', { value1: String(String(tool)) })
    }
    if (!existing.consumes.includes(target) || !existing.consumes.includes(tool)) {
      return workbenchText('BooleanDialog.booleanEditRefusedTargetOrToolIsMissingFrom')
    }
    const order = dag.featureOrder()
    const featureIndex = order.indexOf(featureId)
    if (order.indexOf(target) < 0 || order.indexOf(target) >= featureIndex || order.indexOf(tool) < 0 || order.indexOf(tool) >= featureIndex) {
      return workbenchText('BooleanDialog.booleanEditRefusedTargetAndToolMustBeUpstream')
    }
    if (!bodyOptions.some((option) => option.id === target) || !bodyOptions.some((option) => option.id === tool)) {
      return workbenchText('BooleanDialog.booleanEditRefusedTargetOrToolBodyIsUnavailable')
    }
    if (!SELECTABLE_OPS.has(existing.payload.boolOp as BooleanOp)) {
      return workbenchText('BooleanDialog.booleanEditRefusedOperationIsUnavailable', { value1: String(String(existing.payload.boolOp)) })
    }
    return undefined
  })()
  const selectionError =
    targetFeatureId !== '' && !targetOptions.some((option) => option.id === targetFeatureId)
      ? workbenchText('BooleanDialog.targetBodyIsUnavailable', { targetFeatureId: String(targetFeatureId) })
      : !targetIsMesh && toolFeatureId !== '' && !toolOptions.some((option) => option.id === toolFeatureId)
        ? workbenchText('BooleanDialog.toolBodyIsUnavailable', { toolFeatureId: String(toolFeatureId) })
        : meshToolBodyId !== null && targetIsMesh && !bodyOptions.some((option) => option.id === meshToolBodyId)
          ? workbenchText('BooleanDialog.toolBodyIsUnavailable', { toolFeatureId: String(meshToolBodyId) })
          : undefined
  const invalid = shapeTool
    ? selectionError !== undefined || toolShapeParameters === null || meshApplying
    : (meshPair && meshApplying) ||
      editReferenceError !== undefined ||
      selectionError !== undefined ||
      targetFeatureId === '' ||
      effectiveToolId === '' ||
      targetFeatureId === effectiveToolId ||
      !SELECTABLE_OPS.has(boolOp)

  useEffect(() => {
    onSelectionChange?.({ targetFeatureId, toolFeatureId: effectiveToolId })
  }, [targetFeatureId, effectiveToolId, onSelectionChange])

  // WO-1961: the page previews the tool shape on the part as the fields change.
  const onToolShapeChangeRef = useRef(mesh?.onToolShapeChange)
  onToolShapeChangeRef.current = mesh?.onToolShapeChange
  useEffect(() => {
    onToolShapeChangeRef.current?.(toolShapeParameters)
  // toolShapeKey stands for toolShapeParameters (a fresh object per render).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolShapeKey])
  useEffect(() => () => { onToolShapeChangeRef.current?.(null) }, [])

  const requestViewportSequence = (): void => {
    if (onRequestBodyPick === undefined) return
    onRequestBodyPick('target', [], (pickedTargetId) => {
      setTargetFeatureId(pickedTargetId)
      // An STL target's tool is the shape typed below, not a second body.
      if (mesh !== undefined && pickedTargetId === mesh.id) return
      onRequestBodyPick('tool', [pickedTargetId], (pickedToolId) => {
        setToolFeatureId(pickedToolId)
      })
    })
  }

  useEffect(() => {
    if (onRequestBodyPick === undefined || viewportPickStartedRef.current) return
    viewportPickStartedRef.current = true
    // Opened on an STL target, the dialog is already waiting on the shape.
    if (targetIsMesh) return
    requestViewportSequence()
  }, [onRequestBodyPick])

  const handleMeshApply = async (): Promise<void> => {
    if (mesh === undefined) return
    setMeshApplying(true)
    let refusal: string | undefined
    try {
      refusal = meshPair
        ? await mesh.onApplyBody({
            targetFeatureId,
            toolFeatureId: effectiveToolId,
            boolOp,
          })
        : await mesh.onApply()
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err)
    }
    setMeshApplying(false)
    if (refusal !== undefined) {
      setApplyError(refusal)
      return
    }
    onClose()
  }

  const handleApply = (): void => {
    if (invalid) return
    setApplyError(undefined)
    if (targetIsMesh || meshPair) {
      void handleMeshApply()
      return
    }
    if (editing) {
      const live = dag.getNode(featureId)
      if (live === undefined || live.kind !== 'feature' || live.payload.opType !== 'boolean') {
        setApplyError(workbenchText('BooleanDialog.booleanEditRefusedIsNoLongerAvailable', { featureId: String(featureId) }))
        return
      }
      try {
        history.execute(new EditFeaturePayloadCommand(
          featureId,
          { ...live.payload, targetFeatureId, toolFeatureId, boolOp },
          [targetFeatureId, toolFeatureId],
        ))
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : String(err))
        return
      }
      onApplied(featureId)
      onClose()
      return
    }

    const id = nextId(dag, 'F')
    const payload = { opType: 'boolean', targetFeatureId, toolFeatureId, boolOp, name: workbenchText('BooleanDialog.boolean', { id: String(id) }) }
    try {
      history.execute(createFeatureCommand(dag, { id, kind: 'feature', consumes: [targetFeatureId, toolFeatureId], payload }))
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
      return
    }
    onApplied(id)
    onClose()
  }

  const triple = (
    label: string,
    testId: string,
    value: [number, number, number],
    set: (next: [number, number, number]) => void,
    tooltip: string,
    min?: number,
  ) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 70, color: 'var(--text-muted)' }}>{label}</span>
      {(['X', 'Y', 'Z'] as const).map((name, i) => (
        <span key={name} data-testid={`${testId}-${name.toLowerCase()}`} style={{ flex: 1, minWidth: 0 }}>
          <NumericInput
            value={value[i]}
            onChange={(n) => { const next: [number, number, number] = [...value]; next[i] = n; set(next) }}
            min={min}
            step={1}
            ariaLabel={workbenchText('BooleanDialog.tool', { value1: String(label.toLowerCase()), name: String(name) })}
            tooltip={tooltip}
            style={{ width: '100%' }}
          />
        </span>
      ))}
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('BooleanDialog.mm')}</span>
    </div>
  )

  const toolLabel = shapeTool
    ? workbenchText('BooleanDialog.new', { value1: String(toolShape) })
    : toolOptions.find((opt) => opt.id === effectiveToolId)?.label ?? workbenchText('BooleanDialog.none')

  return (
    <DialogShell
      title={editing ? workbenchText('BooleanDialog.editBooleanCombine') : workbenchText('BooleanDialog.booleanCombine')}
      onApply={handleApply}
      onCancel={onClose}
      applyDisabled={invalid}
      allowViewportInteraction={onRequestBodyPick !== undefined}
      // WO-1497: the same UI-107 presentation its six sibling viewport-picking
      // dialogs already use -- a centered dimming modal would sit fixed over
      // the target/tool bodies the pick flow asks the operator to click.
      floatingPalette
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {onRequestBodyPick !== undefined && (
          <>
            <div
              data-testid="boolean-pick-role"
              style={{ color: 'var(--text-primary)', fontSize: 'var(--font-size-sm)', fontWeight: 600 }}
            >
              {activeBodyPickRole === 'target'
                ? workbenchText('BooleanDialog.targetClickTheBodyToKeep')
                : activeBodyPickRole === 'tool'
                  ? workbenchText('BooleanDialog.toolClickTheBodyToCombine')
                  : targetIsMesh
                    ? workbenchText('BooleanDialog.toolSetTheShapeBelow')
                    : workbenchText('BooleanDialog.viewportPickReady')}
            </div>
            <button
              type="button"
              className="modal-btn modal-btn-primary"
              data-testid="boolean-pick-sequence"
              onClick={requestViewportSequence}
            >
              {activeBodyPickRole === 'target'
                ? workbenchText('BooleanDialog.restartTargetPick')
                : activeBodyPickRole === 'tool'
                  ? workbenchText('BooleanDialog.restartTargetToolPick')
                  : workbenchText('BooleanDialog.restartViewportPick')}
            </button>
            <div
              data-testid="boolean-pick-status"
              style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}
            >
              {workbenchText('BooleanDialog.targetTool', { value1: String(targetOptions.find((opt) => opt.id === targetFeatureId)?.label ?? workbenchText('BooleanDialog.none')), toolLabel: String(toolLabel) })}
            </div>
          </>
        )}
        <details open={onRequestBodyPick === undefined}>
          <summary style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>{workbenchText('BooleanDialog.chooseFromLists')}</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('BooleanDialog.target')}</span>
              <select
                data-testid="boolean-target-select"
                value={targetFeatureId}
                onChange={(e) => setTargetFeatureId(e.target.value)}
                style={{ flex: 1 }}
              >
                {targetOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            {!targetIsMesh && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('BooleanDialog.tool2')}</span>
                <select
                  data-testid="boolean-tool-select"
                  value={toolFeatureId}
                  onChange={(e) => setToolFeatureId(e.target.value)}
                  style={{ flex: 1 }}
                >
                  {toolOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </details>
        {targetIsMesh && (
          <div data-testid="boolean-tool-shape" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('BooleanDialog.tool2')}</span>
              <select
                data-testid="boolean-tool-shape-select"
                value={meshTool}
                onChange={(e) => setMeshTool(e.target.value)}
                style={{ flex: 1 }}
              >
                <option value="box">{workbenchText('BooleanDialog.box')}</option>
                <option value="cylinder">{workbenchText('BooleanDialog.cylinder')}</option>
                {bodyOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            {shapeTool && triple(workbenchText('BooleanDialog.centre'), 'boolean-tool-center', toolCenter, setToolCenter,
              workbenchText('BooleanDialog.whereTheMiddleOfTheShapeSitsInThe'))}
            {!shapeTool ? null : toolShape === 'box'
              ? triple(workbenchText('BooleanDialog.size'), 'boolean-tool-size', toolSize, setToolSize, workbenchText('BooleanDialog.theBoxSLengthAlongXYAndZ'), 0.001)
              : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('BooleanDialog.diameter')}</span>
                    <span data-testid="boolean-tool-diameter" style={{ flex: 1 }}>
                      <NumericInput
                        value={toolDiameter}
                        onChange={setToolDiameter}
                        min={0.001}
                        step={0.5}
                        ariaLabel={workbenchText('BooleanDialog.toolCylinderDiameter')}
                        tooltip={workbenchText('BooleanDialog.theCylinderSDiameterMm')}
                        style={{ width: '100%' }}
                      />
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('BooleanDialog.mm')}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('BooleanDialog.length')}</span>
                    <span data-testid="boolean-tool-length" style={{ flex: 1 }}>
                      <NumericInput
                        value={toolLength}
                        onChange={setToolLength}
                        min={0.001}
                        step={1}
                        ariaLabel={workbenchText('BooleanDialog.toolCylinderLength')}
                        tooltip={workbenchText('BooleanDialog.theCylinderSLengthAlongItsAxisCentredOn')}
                        style={{ width: '100%' }}
                      />
                    </span>
                    <select
                      data-testid="boolean-tool-axis"
                      aria-label={workbenchText('BooleanDialog.toolCylinderAxis')}
                      value={toolAxis}
                      onChange={(e) => setToolAxis(e.target.value as ShapeAxis)}
                    >
                      <option value="x">{workbenchText('BooleanDialog.alongX')}</option>
                      <option value="y">{workbenchText('BooleanDialog.alongY')}</option>
                      <option value="z">{workbenchText('BooleanDialog.alongZ')}</option>
                    </select>
                  </div>
                </>
              )}
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('BooleanDialog.op')}</span>
          <select
            data-testid="boolean-op-select"
            value={boolOp}
            onChange={(e) => setBoolOp(e.target.value as BooleanOp)}
            style={{ flex: 1 }}
          >
            {(Object.keys(OP_LABELS) as BooleanOp[]).map((op) => (
              <option key={op} value={op} disabled={!selectableOps.has(op)} data-testid={`boolean-op-option-${op}`}>
                {OP_LABELS[op]}
              </option>
            ))}
          </select>
        </label>
        {shapeTool && mesh !== undefined && (
          <div
            data-testid="boolean-preview-status"
            data-state={mesh.preview.kind}
            style={{ color: mesh.preview.kind === 'failed' ? 'var(--text-danger)' : 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}
          >
            {boolOp === 'intersect'
              ? workbenchText('BooleanDialog.unionAddsTheShapeToSubtractCutsItOut', { label: String(mesh.label) })
              : mesh.preview.message}
          </div>
        )}
        {!shapeTool && targetFeatureId === effectiveToolId && targetFeatureId !== '' && (
          <div data-testid="boolean-same-body-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {workbenchText('BooleanDialog.targetAndToolMustBeDifferentBodies')}</div>
        )}
        {editReferenceError !== undefined && (
          <div data-testid="boolean-reference-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {readableInternalIds(editReferenceError)}
          </div>
        )}
        {selectionError !== undefined && (
          <div data-testid="boolean-selection-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {readableInternalIds(selectionError)}
          </div>
        )}
        {applyError !== undefined && (
          <div data-testid="boolean-apply-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {readableInternalIds(applyError)}
          </div>
        )}
      </div>
    </DialogShell>
  )
}
