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
  fuse: 'Union',
  cut: 'Subtract',
  intersect: 'Intersect',
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
  const [toolShape, setToolShape] = useState<'box' | 'cylinder'>('box')
  const [toolCenter, setToolCenter] = useState<[number, number, number]>(() => mesh?.seedCenter ?? [0, 0, 0])
  const [toolSize, setToolSize] = useState<[number, number, number]>([10, 10, 10])
  const [toolDiameter, setToolDiameter] = useState<number>(10)
  const [toolLength, setToolLength] = useState<number>(() => mesh?.seedLengthMm ?? 10)
  const [toolAxis, setToolAxis] = useState<ShapeAxis>('z')
  const [meshApplying, setMeshApplying] = useState(false)

  const targetIsMesh = mesh !== undefined && targetFeatureId === mesh.id
  const targetOptions = mesh !== undefined ? [{ id: mesh.id, label: mesh.label }, ...bodyOptions] : bodyOptions
  const selectableOps = targetIsMesh ? MESH_TARGET_OPS : SELECTABLE_OPS
  const toolShapeValid = toolShape === 'box'
    ? toolSize.every((n) => Number.isFinite(n) && n > 0)
    : toolDiameter > 0 && toolLength > 0
  const toolShapeParameters: BooleanBodyParameters | null = targetIsMesh && toolShapeValid && MESH_TARGET_OPS.has(boolOp)
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
      return `Boolean edit refused: '${featureId}' is not a Boolean feature`
    }
    const target = existing.payload.targetFeatureId
    const tool = existing.payload.toolFeatureId
    if (typeof target !== 'string' || target.length === 0 || dag.getNode(target) === undefined) {
      return `Boolean edit refused: target body '${String(target)}' is not available`
    }
    if (typeof tool !== 'string' || tool.length === 0 || dag.getNode(tool) === undefined) {
      return `Boolean edit refused: tool body '${String(tool)}' is not available`
    }
    if (!existing.consumes.includes(target) || !existing.consumes.includes(tool)) {
      return 'Boolean edit refused: target or tool is missing from the feature dependencies'
    }
    const order = dag.featureOrder()
    const featureIndex = order.indexOf(featureId)
    if (order.indexOf(target) < 0 || order.indexOf(target) >= featureIndex || order.indexOf(tool) < 0 || order.indexOf(tool) >= featureIndex) {
      return 'Boolean edit refused: target and tool must be upstream body features'
    }
    if (!bodyOptions.some((option) => option.id === target) || !bodyOptions.some((option) => option.id === tool)) {
      return 'Boolean edit refused: target or tool body is unavailable'
    }
    if (!SELECTABLE_OPS.has(existing.payload.boolOp as BooleanOp)) {
      return `Boolean edit refused: operation '${String(existing.payload.boolOp)}' is unavailable`
    }
    return undefined
  })()
  const selectionError =
    targetFeatureId !== '' && !targetOptions.some((option) => option.id === targetFeatureId)
      ? `Target body '${targetFeatureId}' is unavailable.`
      : !targetIsMesh && toolFeatureId !== '' && !bodyOptions.some((option) => option.id === toolFeatureId)
        ? `Tool body '${toolFeatureId}' is unavailable.`
        : undefined
  const invalid = targetIsMesh
    ? selectionError !== undefined || toolShapeParameters === null || meshApplying
    : editReferenceError !== undefined ||
      selectionError !== undefined ||
      targetFeatureId === '' ||
      toolFeatureId === '' ||
      targetFeatureId === toolFeatureId ||
      !SELECTABLE_OPS.has(boolOp)

  useEffect(() => {
    onSelectionChange?.({ targetFeatureId, toolFeatureId: targetIsMesh ? '' : toolFeatureId })
  }, [targetFeatureId, toolFeatureId, targetIsMesh, onSelectionChange])

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
      refusal = await mesh.onApply()
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
    if (targetIsMesh) {
      void handleMeshApply()
      return
    }
    if (editing) {
      const live = dag.getNode(featureId)
      if (live === undefined || live.kind !== 'feature' || live.payload.opType !== 'boolean') {
        setApplyError(`Boolean edit refused: '${featureId}' is no longer available`)
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
    const payload = { opType: 'boolean', targetFeatureId, toolFeatureId, boolOp, name: `Boolean ${id}` }
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
            ariaLabel={`Tool ${label.toLowerCase()} ${name}`}
            tooltip={tooltip}
            style={{ width: '100%' }}
          />
        </span>
      ))}
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>mm</span>
    </div>
  )

  const toolLabel = targetIsMesh
    ? `new ${toolShape}`
    : bodyOptions.find((opt) => opt.id === toolFeatureId)?.label ?? '(none)'

  return (
    <DialogShell
      title={editing ? 'Edit Boolean combine' : 'Boolean combine'}
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
                ? 'TARGET: click the body to keep'
                : activeBodyPickRole === 'tool'
                  ? 'TOOL: click the body to combine'
                  : targetIsMesh
                    ? 'TOOL: set the shape below'
                    : 'Viewport pick ready'}
            </div>
            <button
              type="button"
              className="modal-btn modal-btn-primary"
              data-testid="boolean-pick-sequence"
              onClick={requestViewportSequence}
            >
              {activeBodyPickRole === 'target'
                ? 'Restart target pick'
                : activeBodyPickRole === 'tool'
                  ? 'Restart target/tool pick'
                  : 'Restart viewport pick'}
            </button>
            <div
              data-testid="boolean-pick-status"
              style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}
            >
              Target: {targetOptions.find((opt) => opt.id === targetFeatureId)?.label ?? '(none)'}
              {' | '}
              Tool: {toolLabel}
            </div>
          </>
        )}
        <details open={onRequestBodyPick === undefined}>
          <summary style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>Choose from lists</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 70, color: 'var(--text-muted)' }}>Target</span>
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
                <span style={{ width: 70, color: 'var(--text-muted)' }}>Tool</span>
                <select
                  data-testid="boolean-tool-select"
                  value={toolFeatureId}
                  onChange={(e) => setToolFeatureId(e.target.value)}
                  style={{ flex: 1 }}
                >
                  {bodyOptions.map((opt) => (
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
              <span style={{ width: 70, color: 'var(--text-muted)' }}>Tool</span>
              <select
                data-testid="boolean-tool-shape-select"
                value={toolShape}
                onChange={(e) => setToolShape(e.target.value as 'box' | 'cylinder')}
                style={{ flex: 1 }}
              >
                <option value="box">Box</option>
                <option value="cylinder">Cylinder</option>
              </select>
            </label>
            {triple('Centre', 'boolean-tool-center', toolCenter, setToolCenter,
              "Where the middle of the shape sits, in the part's own coordinates (the STL file's numbers), mm.")}
            {toolShape === 'box'
              ? triple('Size', 'boolean-tool-size', toolSize, setToolSize, "The box's length along X, Y and Z, mm.", 0.001)
              : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 70, color: 'var(--text-muted)' }}>Diameter</span>
                    <span data-testid="boolean-tool-diameter" style={{ flex: 1 }}>
                      <NumericInput
                        value={toolDiameter}
                        onChange={setToolDiameter}
                        min={0.001}
                        step={0.5}
                        ariaLabel="Tool cylinder diameter"
                        tooltip="The cylinder's diameter, mm."
                        style={{ width: '100%' }}
                      />
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>mm</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 70, color: 'var(--text-muted)' }}>Length</span>
                    <span data-testid="boolean-tool-length" style={{ flex: 1 }}>
                      <NumericInput
                        value={toolLength}
                        onChange={setToolLength}
                        min={0.001}
                        step={1}
                        ariaLabel="Tool cylinder length"
                        tooltip="The cylinder's length along its axis, centred on Centre, mm."
                        style={{ width: '100%' }}
                      />
                    </span>
                    <select
                      data-testid="boolean-tool-axis"
                      aria-label="Tool cylinder axis"
                      value={toolAxis}
                      onChange={(e) => setToolAxis(e.target.value as ShapeAxis)}
                    >
                      <option value="x">along X</option>
                      <option value="y">along Y</option>
                      <option value="z">along Z</option>
                    </select>
                  </div>
                </>
              )}
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>Op</span>
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
        {targetIsMesh && mesh !== undefined && (
          <div
            data-testid="boolean-preview-status"
            data-state={mesh.preview.kind}
            style={{ color: mesh.preview.kind === 'failed' ? 'var(--text-danger)' : 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}
          >
            {boolOp === 'intersect'
              ? `Union adds the shape to "${mesh.label}"; Subtract cuts it out.`
              : mesh.preview.message}
          </div>
        )}
        {!targetIsMesh && invalid && targetFeatureId === toolFeatureId && targetFeatureId !== '' && (
          <div style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            Target and tool must be different bodies.
          </div>
        )}
        {editReferenceError !== undefined && (
          <div data-testid="boolean-reference-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {editReferenceError}
          </div>
        )}
        {selectionError !== undefined && (
          <div data-testid="boolean-selection-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {selectionError}
          </div>
        )}
        {applyError !== undefined && (
          <div data-testid="boolean-apply-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {applyError}
          </div>
        )}
      </div>
    </DialogShell>
  )
}
