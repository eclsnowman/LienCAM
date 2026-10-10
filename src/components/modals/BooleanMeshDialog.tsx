// MSH-4-BOOLEAN-EDIT (Operator Q-70 A + Q-72 A): one-shot boolean of an imported
// mesh against a Model body -> a new STATIC geometry row, honestly labeled
// EXACT (planar/prismatic body) or APPROXIMATE (curved body).
//
// Mirrors the Model workbench's BooleanDialog: viewport CLICK-PICK for both
// operands is the primary path (the dialog is a floating side panel with NO
// backdrop, so the 3D scene stays clickable while it is open), with name
// dropdowns as the collapsed second path. There is NO tolerance control (Q-72 A:
// CAM holds no live kernel handle, so a Model body always arrives pre-tessellated
// at its display fidelity - a tolerance slider would be a dead control).

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Combine, MousePointer2, Loader2 } from 'lucide-react'
import { useCamStore } from '../../store'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import {
  booleanOpLabel,
  classifyModelBodyFidelity,
  fidelityWord,
  fidelityExplanation,
  isMeshBooleanSourceRow,
  isModelBooleanBodyRow,
} from '../../lib/cam/booleanMeshModel'
import type { MeshBooleanOperation } from '../../mesh/types'
import type { VpHandle } from '../panels/DesignTree'

const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle) ?? null

const OPS: MeshBooleanOperation[] = ['difference', 'union', 'intersect']
const MUTED = { color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' } as const

export function BooleanMeshDialog() {
  const activeModal = useCamStore((s) => s.activeModal)
  const geometry = useCamStore((s) => s.project.geometry)
  const preselectMeshId = useCamStore((s) => s.booleanMeshMeshGeoId)
  const editResultId = useCamStore((s) => s.booleanMeshEditResultId)
  const closeModal = useCamStore((s) => s.closeModal)
  const run = useCamStore((s) => s.booleanMeshVsModelBody)

  const open = activeModal === 'boolean-mesh'

  const meshRows = useMemo(() => geometry.filter(isMeshBooleanSourceRow), [geometry])
  const modelRows = useMemo(() => geometry.filter(isModelBooleanBodyRow), [geometry])

  // Edit re-run: pre-fill from the result row's recorded provenance.
  const editRow = editResultId ? geometry.find((g) => g.id === editResultId) : undefined
  const editProv = editRow?.booleanProvenance

  const [meshGeoId, setMeshGeoId] = useState<string | null>(null)
  const [modelGeoId, setModelGeoId] = useState<string | null>(null)
  const [op, setOp] = useState<MeshBooleanOperation>('difference')
  const [pickRole, setPickRole] = useState<'mesh' | 'model' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const armedRef = useRef(false)
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  // Seed selections on open (preselect / edit-provenance / first eligible).
  useEffect(() => {
    if (!open) {
      getVp()?.setPartPickMode?.(null)
      setPickRole(null)
      setBusy(false)
      setError(null)
      armedRef.current = false
      return
    }
    const seedMesh = editProv?.sourceMeshId ?? preselectMeshId ?? meshRows[0]?.id ?? null
    const seedModel = editProv?.modelBodyId ?? modelRows[0]?.id ?? null
    setMeshGeoId(meshRows.some((g) => g.id === seedMesh) ? seedMesh : meshRows[0]?.id ?? null)
    setModelGeoId(modelRows.some((g) => g.id === seedModel) ? seedModel : modelRows[0]?.id ?? null)
    setOp(editProv?.op ?? 'difference')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleClose = () => {
    getVp()?.setPartPickMode?.(null)
    setPickRole(null)
    closeModal()
  }

  // Esc: leave pick mode first, else close.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (pickRole) {
        getVp()?.setPartPickMode?.(null)
        setPickRole(null)
      } else {
        handleClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pickRole])

  const armPick = (role: 'mesh' | 'model') => {
    const vp = getVp()
    if (!vp?.setPartPickMode) return
    const rows = role === 'mesh' ? meshRows : modelRows
    if (rows.length === 0) return
    setPickRole(role)
    const selected = role === 'mesh' ? meshGeoId : modelGeoId
    useCamStore.getState().addConsoleEvent({
      severity: 'info', source: 'boolean',
      message: `Click the ${role === 'mesh' ? 'imported mesh' : 'model body'} in the viewport - eligible parts highlight.`,
    })
    vp.setPartPickMode(
      (id) => {
        getVp()?.setPartPickMode?.(null)
        setPickRole(null)
        if (role === 'mesh') setMeshGeoId(id)
        else setModelGeoId(id)
        const label = geometry.find((g) => g.id === id)?.name ?? id
        useCamStore.getState().addConsoleEvent({
          severity: 'success', source: 'boolean',
          message: `${role === 'mesh' ? 'Mesh operand' : 'Model body'} selected: ${label}.`,
        })
      },
      rows.map((g) => g.id),
      selected ? [selected] : [],
      'standard',
      (id) => {
        if (id === null) return
        const label = geometry.find((g) => g.id === id)?.name ?? id
        useCamStore.getState().addConsoleEvent({
          severity: 'info', source: 'boolean',
          message: `Hovering ${role === 'mesh' ? 'mesh operand' : 'model body'}: ${label}.`,
        })
      },
    )
  }

  // Auto-arm the primary pick on open (mesh if not preselected, else model),
  // the same "arm once per open" shape SketchEntryModal uses. The dialog stays
  // visible (side panel, no backdrop) so the scene is clickable throughout.
  useEffect(() => {
    if (!open || armedRef.current) return
    armedRef.current = true
    const startRole: 'mesh' | 'model' = (preselectMeshId || editProv) ? 'model' : 'mesh'
    if ((startRole === 'mesh' ? meshRows : modelRows).length > 0) armPick(startRole)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const modelGeo = modelGeoId ? geometry.find((g) => g.id === modelGeoId) : undefined
  const fidelity = modelGeo?.modelBody?.display
    ? classifyModelBodyFidelity(modelGeo.modelBody.display)
    : null
  const approximate = fidelity ? !fidelity.exact : true

  const canRun = !!meshGeoId && !!modelGeoId && !busy
  const handleRun = async () => {
    if (!meshGeoId || !modelGeoId) return
    setBusy(true)
    setError(null)
    getVp()?.setPartPickMode?.(null)
    setPickRole(null)
    const outcome = await run(meshGeoId, modelGeoId, op, editResultId ?? null)
    setBusy(false)
    if (outcome.ok) {
      useCamStore.getState().setSelectedGeometry(outcome.newId)
      getVp()?.setSelectedPart?.(outcome.newId)
      handleClose()
    } else {
      setError(outcome.error)
    }
  }

  if (!open) return null

  const meshName = meshGeoId ? geometry.find((g) => g.id === meshGeoId)?.name ?? '(none)' : '(none)'
  const modelName = modelGeoId ? geometry.find((g) => g.id === modelGeoId)?.name ?? '(none)' : '(none)'

  const operand = (
    label: string,
    value: string,
    role: 'mesh' | 'model',
    disabled: boolean,
    testid: string,
  ) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={MUTED}>{label}</span>
        <button
          type="button"
          className="modal-btn modal-btn-ghost"
          data-testid={testid}
          disabled={disabled || busy}
          onClick={() => armPick(role)}
          style={{
            fontSize: 'var(--font-size-sm)', padding: '2px 8px',
            ...(pickRole === role ? { borderColor: 'var(--accent-blue)', color: 'var(--accent-blue)' } : {}),
          }}
        >
          <MousePointer2 size={13} /> {pickRole === role
            ? (role === 'mesh' ? 'Click a mesh...' : 'Click a body...')
            : 'Pick in viewport'}
        </button>
      </div>
      <div
        data-testid={`${testid}-value`}
        style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 'var(--font-size-sm)' }}
      >
        {value}
      </div>
    </div>
  )

  return (
    <div
      style={{ position: 'fixed', top: 72, right: 16, zIndex: 1000, width: 340, maxWidth: 'calc(100vw - 32px)' }}
    >
      <div className="modal-container" style={{ margin: 0, width: '100%', maxWidth: '100%' }} data-testid="boolean-mesh-dialog" ref={dialogFocusRef}>
        <div className="modal-header">
          <Combine size={15} className="modal-header-icon" />
          <span className="modal-title">{editResultId ? 'Edit boolean result' : 'Boolean: mesh vs model body'}</span>
          <button className="modal-close-btn" onClick={handleClose} data-tooltip="Close" aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {operand('Mesh operand', meshName, 'mesh', meshRows.length === 0, 'boolean-mesh-pick-mesh')}
          {operand('Model body', modelName, 'model', modelRows.length === 0, 'boolean-mesh-pick-model')}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...MUTED, width: 90 }}>Operation</span>
            <select
              data-testid="boolean-mesh-op"
              value={op}
              onChange={(e) => setOp(e.target.value as MeshBooleanOperation)}
              disabled={busy}
              style={{ flex: 1 }}
            >
              {OPS.map((o) => <option key={o} value={o}>{booleanOpLabel(o)}</option>)}
            </select>
          </label>

          <details>
            <summary style={{ ...MUTED, cursor: 'pointer' }}>Choose from lists</summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...MUTED, width: 90 }}>Mesh</span>
                <select
                  data-testid="boolean-mesh-mesh-select"
                  value={meshGeoId ?? ''}
                  onChange={(e) => setMeshGeoId(e.target.value || null)}
                  disabled={busy}
                  style={{ flex: 1 }}
                >
                  {meshRows.length === 0 && <option value="">(no imported meshes)</option>}
                  {meshRows.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...MUTED, width: 90 }}>Model body</span>
                <select
                  data-testid="boolean-mesh-model-select"
                  value={modelGeoId ?? ''}
                  onChange={(e) => setModelGeoId(e.target.value || null)}
                  disabled={busy}
                  style={{ flex: 1 }}
                >
                  {modelRows.length === 0 && <option value="">(no model bodies)</option>}
                  {modelRows.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
            </div>
          </details>

          {modelGeo && (
            <div
              data-testid="boolean-mesh-fidelity"
              style={{
                fontSize: 'var(--font-size-sm)',
                color: approximate ? 'var(--accent-amber)' : 'var(--text-primary)',
                borderTop: '1px dashed var(--border)',
                paddingTop: 8,
              }}
            >
              <strong>Result will be {fidelityWord(approximate).toUpperCase()}</strong>
              <span style={{ color: 'var(--text-muted)' }}> - {fidelityExplanation(approximate)}</span>
            </div>
          )}

          {error && (
            <div data-testid="boolean-mesh-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
              {error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn modal-btn-ghost" onClick={handleClose} disabled={busy}>Cancel</button>
          <button
            className="modal-btn modal-btn-primary"
            data-testid="boolean-mesh-run"
            onClick={handleRun}
            disabled={!canRun}
          >
            {busy
              ? <><Loader2 size={13} className="modal-spin" /> Running...</>
              : (editResultId ? 'Re-run' : 'Run boolean')}
          </button>
        </div>
      </div>
    </div>
  )
}
