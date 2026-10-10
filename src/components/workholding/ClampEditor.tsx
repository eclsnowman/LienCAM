import { textFor, useText } from '../../i18n'
const words = textFor('setup-stock-tools-machine-post')
// WO-2192 (workholding assemblies, slice 5): the Setup-screen workflows for
// hold-down CLAMPS placed along a stock or part edge
// (docs/design/WORKHOLDING-ASSEMBLIES.md, "Clamp workflows").
//
//   - Make clamp (Properties, on a workholding body): that body becomes a
//     clamp definition's shape; placing starts at once.
//   - Place (controls at the top of Properties; the clicks in the viewport):
//     pick the clamp, choose Stock edge or Part edge; each click on an edge of
//     that kind adds a clamp there (store placeClamp: its pose comes from the
//     edge), a marker drag slides a clamp along its edge, a double-click on a
//     marker deletes it. Esc or Done ends it.
//   - A placed clamp (clicked in the viewport or the tree): Properties shows
//     its edge, where it is along the edge, its outward offset and turn, and
//     Duplicate / Delete / Move to setup / Copy to setup / Put on another
//     edge. Dragging it in the viewport slides it along its edge
//     (Viewport.tsx). A clamp whose edge is gone says "edge reference lost"
//     here and in the tree, and nowhere else.
//
// WO-2198: Export (./WorkholdingReuse.tsx) saves the clamp to a file another
// project imports; selectClamp also selects a vise placed again.
//
// Every completed action is one store action, so one undo step. No automatic
// suggestion, no "you need more clamps", no refusal, warning, confirm or
// disabled control (rule 11): a click away from every edge simply adds nothing.

import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { Anchor, Check, Copy, MousePointer2, Plus, Trash2 } from 'lucide-react'
import { useCamStore } from '../../store'
import type { ImportedGeometry, Units, WorkholdingInstance } from '../../types'
import { unitLabel } from '../../lib/ui/unitFormat'
import {
  anchorOnBoundary, clampBodyCandidates, clampBoundaries, clampDefinitions, clampEdgeLost, clampInstance,
  resolveClampBoundary, type ClampBoundary, type ClampTargetKind,
} from '../../lib/workholding/clamps'
import { setupScopeIncludes } from '../../lib/workholding/resolveWorkholding'
import { viseMembershipOfInstance } from '../../lib/workholding/vise'
import { rowDrawnInstanceIds } from '../../lib/workholding/reuse'
import { LengthField } from './ViseEditor'
import { clampDrawId } from './clampViewport'
import { ExportWorkholdingButton } from './WorkholdingReuse'
import { shortcutsAllowed } from '../../hooks/useGlobalShortcuts'

// ── Cross-component UI state (not project data) ─────────────────────────────

interface ClampPlacing {
  definitionId: string
  targetKind: ClampTargetKind
  /** Put this placed clamp on the clicked edge instead of adding a new one. */
  reattachInstanceId?: string
}

interface ClampUiState {
  placing: ClampPlacing | null
  selectedClampId: string | null
  startPlacing: (placing: ClampPlacing) => void
  stopPlacing: () => void
  selectClamp: (instanceId: string | null) => void
}

export const useClampUi = create<ClampUiState>((set) => ({
  placing: null,
  selectedClampId: null,
  startPlacing: (placing) => set({ placing }),
  stopPlacing: () => set({ placing: null }),
  selectClamp: (selectedClampId) => set({ selectedClampId }),
}))

// Any other selection (a body, stock, nest, layer, folder, operation) replaces
// a selected clamp, as selecting one of them replaces the others.
useCamStore.subscribe((s, prev) => {
  if (!useClampUi.getState().selectedClampId) return
  const v = s.viewer
  const w = prev.viewer
  const other =
    (v.selectedGeometryId && v.selectedGeometryId !== w.selectedGeometryId) ||
    (v.selectedStockId && v.selectedStockId !== w.selectedStockId) ||
    (v.selectedNestId && v.selectedNestId !== w.selectedNestId) ||
    (v.selectedLayerId && v.selectedLayerId !== w.selectedLayerId) ||
    (v.selectedFolderId && v.selectedFolderId !== w.selectedFolderId) ||
    (s.project.activeOperationId && s.project.activeOperationId !== prev.project.activeOperationId)
  if (other) useClampUi.getState().selectClamp(null)
})

type VpHandle = {
  worldPointToScreen?: (p: { x: number; y: number; z: number }) => { x: number; y: number }
  setSelectedPart?: (id: string | null) => void
}
const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle) ?? null

/** Select a placed clamp: Properties shows it and the viewport highlights it.
 *  WO-2198: a vise placed again from one definition is selected the same way
 *  (Properties shows that vise); the vise its shape rows are drawn at is
 *  selected by its fixed body row, as the tree always has. */
export function selectClamp(instanceId: string): void {
  const store = useCamStore.getState()
  const model = store.project.workholding
  const vise = viseMembershipOfInstance(model, instanceId)
  if (vise && rowDrawnInstanceIds(model).has(instanceId)) {
    useClampUi.getState().selectClamp(null)
    store.setSelectedGeometry(vise.component.geometryId)
    getVp()?.setSelectedPart?.(vise.component.geometryId)
    return
  }
  store.setSelectedGeometry(null)
  store.setSelectedStock(null)
  useClampUi.getState().selectClamp(instanceId)
  const componentId = vise ? vise.component.id : clampInstance(model, instanceId)?.definition.components[0]?.id
  if (componentId) getVp()?.setSelectedPart?.(clampDrawId(instanceId, componentId))
}

function edgeKindLabel(kind: ClampTargetKind): string {
  return kind === 'stock' ? words("ClampEditor.stock_edge") : words("ClampEditor.part_edge")
}

// ── Make clamp (Properties, workholding body) ───────────────────────────────

/** "Make clamp" on a workholding body that is not yet any vise's or clamp's shape. */
export function MakeClampButton({ geo }: { geo: ImportedGeometry }) {
  const words = useText('setup-stock-tools-machine-post')
  const model = useCamStore((s) => s.project.workholding)
  const geometry = useCamStore((s) => s.project.geometry)
  if (!clampBodyCandidates(geometry, model).some((g) => g.id === geo.id)) return null
  return (
    <div className="props-group props-btn-row">
      <button
        type="button"
        className="props-btn"
        data-testid="make-clamp-btn"
        data-tooltip={words("ClampEditor.make_a_clamp_from_this_body_then")}
        onClick={() => {
          const definitionId = useCamStore.getState().makeClamp(geo.id)
          if (definitionId) useClampUi.getState().startPlacing({ definitionId, targetKind: 'stock' })
        }}
      >
        <Anchor size={11} />{words("ClampEditor.make_clamp")}</button>
    </div>
  )
}

// ── Placing ─────────────────────────────────────────────────────────────────
//
// Placing reuses the viewport's own edge-marker mode - the one contour tabs are
// placed with (CNCViewport.setContourTabMarkers / enterContourTabEditMode): the
// edges of the chosen kind are the loops, each clamp on an edge is a marker at
// its fraction. A click on an edge adds a clamp there, dragging a marker slides
// that clamp along its edge (across the loop's start too), a double-click on a
// marker deletes that clamp, Esc ends placing. Nothing new is drawn over the
// viewport; the placer's controls sit at the top of the Properties panel.

/** The viewport edge-marker mode's calls (CNCViewport has them). */
interface EdgeMarkerViewport {
  setContourTabMarkers?: (data: {
    z: number
    loops: Array<{ loopId: string; path: Array<{ x: number; y: number }>; fractions: number[]; minSeparationFraction: number }>
  } | null) => void
  enterContourTabEditMode?: (callbacks: {
    onAdd: (loopId: string, fraction: number) => void
    onMove: (loopId: string, index: number, fraction: number) => void
    onRemove: (loopId: string, index: number) => void
    onExit: () => void
  }) => void
  exitContourTabEditMode?: (notify?: boolean) => void
}

/** One edge as a marker loop id (the marker mode keys loops by one string). */
export function edgeMarkerKey(target: ClampBoundary['target']): string {
  return JSON.stringify([target.kind, target.id, target.loopId])
}

function targetOfMarkerKey(key: string): ClampBoundary['target'] | null {
  try {
    const [kind, id, loopId] = JSON.parse(key) as [ClampTargetKind, string, string]
    return (kind === 'stock' || kind === 'part') && typeof id === 'string' && typeof loopId === 'string'
      ? { kind, id, loopId } : null
  } catch {
    return null
  }
}

type MarkerProject = Parameters<typeof clampBoundaries>[0] & { activeSetupId: string | null }

/** The marker loops for `kind`'s edges: each edge, and the clamps of the active setup on it (by instance). */
export function clampEdgeMarkers(project: MarkerProject, kind: ClampTargetKind) {
  const boundaries = clampBoundaries(project, kind)
  const onEdge = new Map<string, string[]>()
  const loops = boundaries.map((b) => {
    const key = edgeMarkerKey(b.target)
    const here = (project.workholding?.instances ?? []).filter((i) =>
      clampInstance(project.workholding, i.id) !== null && setupScopeIncludes(i.setupScope, project.activeSetupId) &&
      i.placement?.kind === 'boundary' && edgeMarkerKey(i.placement.target) === key)
    onEdge.set(key, here.map((i) => i.id))
    return {
      loopId: key,
      path: b.points.map((p) => ({ x: p.x, y: p.y })),
      fractions: here.map((i) => (i.placement as { fraction: number }).fraction),
      minSeparationFraction: 0,
    }
  })
  const z = boundaries.length ? Math.max(...boundaries.map((b) => b.z)) : 0
  return { data: { z, loops }, onEdge }
}

/** Rendered by Viewport; draws nothing itself - it drives the viewport's edge-marker mode while placing. */
export function ClampPlacer() {
  const placing = useClampUi((s) => s.placing)
  const selectedClampId = useClampUi((s) => s.selectedClampId)
  const workholding = useCamStore((s) => s.project.workholding)
  const geometry = useCamStore((s) => s.project.geometry)
  const stocks = useCamStore((s) => s.project.stocks)
  const modelItemPlacements = useCamStore((s) => s.project.modelItemPlacements)
  const activeSetupId = useCamStore((s) => s.project.activeSetupId)
  const onEdgeRef = useRef(new Map<string, string[]>())

  // Delete (or Backspace) removes the selected clamp directly (one undo step).
  // It owns the key: it runs in the capture phase, under the same guard as the
  // global CAM shortcuts, and stops the event, so the global Delete (selected
  // op, then setup, with its confirm) never also runs for it.
  useEffect(() => {
    if (!selectedClampId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const st = useCamStore.getState()
      const el = document.activeElement as HTMLElement | null
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (!shortcutsAllowed({
        workspace: st.workspace, activeModal: st.activeModal, mode: st.viewer.mode,
        focusedTag: el?.tagName?.toLowerCase() ?? '', isContentEditable: !!el?.isContentEditable,
      })) return
      e.preventDefault()
      e.stopImmediatePropagation()
      st.removeWorkholdingInstance(selectedClampId)
      useClampUi.getState().selectClamp(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selectedClampId])

  // The edges and the clamps on them, kept current while placing.
  const targetKind = placing?.targetKind ?? null
  useEffect(() => {
    const vp = getVp() as EdgeMarkerViewport | null
    if (!targetKind || !vp?.setContourTabMarkers) return
    const { data, onEdge } = clampEdgeMarkers({ workholding, geometry, stocks, modelItemPlacements, activeSetupId }, targetKind)
    onEdgeRef.current = onEdge
    vp.setContourTabMarkers(data)
  }, [targetKind, workholding, geometry, stocks, modelItemPlacements, activeSetupId])

  // The marker mode itself: on while placing.
  useEffect(() => {
    const vp = getVp() as EdgeMarkerViewport | null
    if (!placing || !vp?.enterContourTabEditMode) return
    vp.enterContourTabEditMode({
      onAdd: (key, fraction) => {
        const target = targetOfMarkerKey(key)
        if (target) placeOnEdge(target, fraction)
      },
      onMove: (key, index, fraction) => {
        const id = onEdgeRef.current.get(key)?.[index]
        if (id) useCamStore.getState().moveClampOnEdge(id, { fraction })
      },
      onRemove: (key, index) => {
        const id = onEdgeRef.current.get(key)?.[index]
        if (id) useCamStore.getState().removeWorkholdingInstance(id)
      },
      onExit: () => useClampUi.getState().stopPlacing(),
    })
    return () => {
      vp.exitContourTabEditMode?.(false)
      vp.setContourTabMarkers?.(null)
    }
  }, [placing])

  return null
}

/** The placer's controls, at the top of the Properties panel while placing. */
export function ClampPlacerPanel() {
  const words = useText('setup-stock-tools-machine-post')
  const placing = useClampUi((s) => s.placing)
  const model = useCamStore((s) => s.project.workholding)
  if (!placing) return null
  const definitions = clampDefinitions(model)
  const definition = definitions.find((d) => d.definition.id === placing.definitionId)?.definition
  const set = (patch: Partial<ClampPlacing>) => useClampUi.getState().startPlacing({ ...placing, ...patch })
  return (
    <div className="props-section" data-testid="clamp-placer">
      <div className="props-group">
        <div className="props-label">
          <MousePointer2 size={11} style={{ display: 'inline', marginRight: 5 }} />
          {placing.reattachInstanceId ? words("ClampEditor.put_on_an_edge") : words("ClampEditor.place_clamps")}
        </div>
        <div className="props-value">
          {!placing.reattachInstanceId && (
            <select
              className="props-number-input"
              data-testid="clamp-placer-definition"
              aria-label={words("ClampEditor.clamp")}
              value={placing.definitionId}
              onChange={(e) => set({ definitionId: e.target.value })}
            >
              {definitions.map(({ definition: d }) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </div>
      </div>
      <div className="props-group props-btn-row">
        {(['stock', 'part'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`props-btn ${placing.targetKind === kind ? 'props-btn-active' : ''}`}
            data-testid={`clamp-placer-${kind}`}
            aria-pressed={placing.targetKind === kind}
            onClick={() => set({ targetKind: kind })}
          >
            {edgeKindLabel(kind)}
          </button>
        ))}
        <button type="button" className="props-btn" data-testid="clamp-placer-done" onClick={() => useClampUi.getState().stopPlacing()}>
          <Check size={11} />{words("ClampEditor.done")}</button>
      </div>
      <div className="props-group">
        <div className="props-value" data-testid="clamp-placer-hint" style={{ whiteSpace: 'normal', textAlign: 'left' }}>
          {placing.reattachInstanceId
            ? words("ClampEditor.click_a_edge_to_put_the_clamp", { value1: words(`ClampEditor.targetKinds.${placing.targetKind}`) })
            : words("ClampEditor.click_a_edge_to_add_drag_a", { value1: words(`ClampEditor.targetKinds.${placing.targetKind}`), value2: definition ? `"${definition.name}"` : words('ClampEditor.aClamp') })}
        </div>
      </div>
    </div>
  )
}

/** A click on an edge: add a clamp there, or put the chosen clamp on it. One undo step. */
function placeOnEdge(target: ClampBoundary['target'], fraction: number): void {
  const placing = useClampUi.getState().placing
  if (!placing) return
  const store = useCamStore.getState()
  if (placing.reattachInstanceId) {
    const found = clampInstance(store.project.workholding, placing.reattachInstanceId)
    const edge = resolveClampBoundary(store.project, target)
    if (!found || !edge) return
    const p = found.instance.placement
    const { placement, worldPose } = anchorOnBoundary(
      edge, fraction,
      p?.kind === 'boundary' ? p.normalOffsetMm : 0, p?.kind === 'boundary' ? p.yawOffsetDeg : 0,
    )
    store.updateWorkholdingInstance(found.instance.id, { placement, worldPose })
    useClampUi.getState().stopPlacing()
    selectClamp(found.instance.id)
    return
  }
  store.placeClamp({ definitionId: placing.definitionId, target, fraction })
}

// ── A placed clamp (Properties) ─────────────────────────────────────────────

function fmtNumber(n: number, digits: number): string {
  return parseFloat(n.toFixed(digits)).toString()
}

export function clampEdgeLabel(project: Parameters<typeof clampEdgeLost>[0], instance: WorkholdingInstance): string {
  const p = instance.placement
  if (p?.kind !== 'boundary') return words("ClampEditor.placed_freely")
  const edge = resolveClampBoundary(project, p.target)
  if (!edge) return words("ClampEditor.edge_reference_lost")
  return `${edgeKindLabel(p.target.kind)}: ${edge.name}`
}

export function ClampProperties({ instanceId }: { instanceId: string }) {
  const words = useText('setup-stock-tools-machine-post')
  const project = useCamStore((s) => s.project)
  const units = useCamStore((s) => s.appSettings.displayUnits) as Units
  const found = clampInstance(project.workholding, instanceId)
  if (!found) return null
  const { instance, definition } = found
  const store = useCamStore.getState()
  const p = instance.placement
  const edge = p?.kind === 'boundary' ? resolveClampBoundary(project, p.target) : null
  const lost = clampEdgeLost(project, instance)
  const otherSetups = project.setups.filter((s) => !setupScopeIncludes(instance.setupScope, s.id) || instance.setupScope.kind === 'all')
  const placedIn = instance.setupScope.kind === 'all'
    ? words("ClampEditor.every_setup")
    : instance.setupScope.setupIds.map((id) => project.setups.find((s) => s.id === id)?.name ?? id).join(', ')
  const u = unitLabel(units)
  const kind: ClampTargetKind = p?.kind === 'boundary' ? p.target.kind : 'stock'

  return (
    <div className="props-section" data-testid="clamp-props">
      <div className="props-group">
        <div className="props-label"><Anchor size={11} style={{ display: 'inline', marginRight: 5 }} />{words("ClampEditor.clamp")}</div>
        <div className="props-value">
          <input
            key={`${instance.id}:${definition.name}`}
            className="props-text-input"
            data-testid="clamp-name-input"
            aria-label={words("ClampEditor.clamp_name")}
            defaultValue={definition.name}
            onBlur={(e) => {
              const next = e.currentTarget.value.trim()
              if (next) store.renameWorkholding(instance.id, next)
              else e.currentTarget.value = definition.name
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') { e.currentTarget.value = definition.name; e.currentTarget.blur() }
            }}
          />
        </div>
      </div>
      <div className="props-group">
        <div className="props-label">{words("ClampEditor.edge")}</div>
        <div className="props-value" data-testid={lost ? 'clamp-edge-lost' : 'clamp-edge'}>{clampEdgeLabel(project, instance)}</div>
      </div>
      {p?.kind === 'boundary' && edge && (
        <>
          <div className="props-group">
            <div className="props-label" data-tooltip={words("ClampEditor.how_far_along_the_edge_from_its")}>{words("ClampEditor.along_edge", { value1: u })}</div>
            <div className="props-value">
              <LengthField
                valueMm={p.fraction * edge.length}
                units={units}
                testId="clamp-along-input"
                ariaLabel={words("ClampEditor.distance_along_the_edge")}
                onCommit={(mm) => { store.moveClampOnEdge(instance.id, { fraction: mm / edge.length }) }}
              />
            </div>
          </div>
          <div className="props-group">
            <div className="props-label" data-tooltip={words("ClampEditor.how_far_out_from_the_edge_negative")}>{words("ClampEditor.offset", { value1: u })}</div>
            <div className="props-value">
              <LengthField
                valueMm={p.normalOffsetMm}
                units={units}
                testId="clamp-offset-input"
                ariaLabel={words("ClampEditor.offset_from_the_edge")}
                onCommit={(mm) => { store.moveClampOnEdge(instance.id, { normalOffsetMm: mm }) }}
              />
            </div>
          </div>
          <div className="props-group">
            <div className="props-label" data-tooltip={words("ClampEditor.turn_about_z_on_top_of_the")}>{words("ClampEditor.turn_deg")}</div>
            <div className="props-value">
              <input
                key={`${instance.id}:${p.yawOffsetDeg}`}
                type="text"
                inputMode="decimal"
                className="props-number-input"
                data-testid="clamp-turn-input"
                aria-label={words("ClampEditor.turn")}
                defaultValue={fmtNumber(p.yawOffsetDeg, 3)}
                onBlur={(e) => {
                  const n = parseFloat(e.currentTarget.value)
                  if (Number.isFinite(n)) store.moveClampOnEdge(instance.id, { yawOffsetDeg: n })
                  else e.currentTarget.value = fmtNumber(p.yawOffsetDeg, 3)
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              />
            </div>
          </div>
        </>
      )}
      <div className="props-group">
        <div className="props-label">{words("ClampEditor.placed_in")}</div>
        <div className="props-value" data-testid="clamp-setups">{placedIn}</div>
      </div>
      <div className="props-group props-btn-row">
        <button
          type="button"
          className="props-btn"
          data-testid="clamp-duplicate"
          data-tooltip={words("ClampEditor.a_copy_beside_it_on_the_same")}
          onClick={() => {
            const [copy] = useCamStore.getState().duplicateClamps([instance.id])
            if (copy) selectClamp(copy)
          }}
        ><Copy size={11} />{words("ClampEditor.duplicate")}</button>
        <button
          type="button"
          className="props-btn"
          data-testid="clamp-reattach"
          data-tooltip={words("ClampEditor.click_a_stock_or_part_edge_to")}
          onClick={() => useClampUi.getState().startPlacing({ definitionId: definition.id, targetKind: kind, reattachInstanceId: instance.id })}
        ><MousePointer2 size={11} />{words("ClampEditor.put_on_an_edge_2")}</button>
        <button
          type="button"
          className="props-btn"
          data-testid="clamp-delete"
          onClick={() => {
            useCamStore.getState().removeWorkholdingInstance(instance.id)
            useClampUi.getState().selectClamp(null)
          }}
        ><Trash2 size={11} />{words("ClampEditor.delete")}</button>
        <ExportWorkholdingButton instanceId={instance.id} testId="clamp-export" />
      </div>
      {otherSetups.length > 0 && (
        <div className="props-group">
          <div className="props-label" data-tooltip={words("ClampEditor.move_keeps_it_where_it_is_copy")}>{words("ClampEditor.to_setup")}</div>
          <div className="props-value" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <SetupSend
              testId="clamp-move-to-setup"
              label={words("ClampEditor.move_to")}
              setups={otherSetups}
              onPick={(setupId) => useCamStore.getState().moveClampsToSetup([instance.id], setupId)}
            />
            <SetupSend
              testId="clamp-copy-to-setup"
              label={words("ClampEditor.copy_to")}
              setups={otherSetups}
              onPick={(setupId) => { useCamStore.getState().copyClampsToSetup([instance.id], setupId) }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function SetupSend({ testId, label, setups, onPick }: {
  testId: string
  label: string
  setups: ReadonlyArray<{ id: string; name: string }>
  onPick: (setupId: string) => void
}) {
  const words = useText('setup-stock-tools-machine-post')
  return (
    <select
      className="props-number-input"
      data-testid={testId}
      aria-label={words("ClampEditor.setupLabel", { label })}
      value=""
      onChange={(e) => { if (e.target.value) onPick(e.target.value) }}
    >
      <option value="">{label}{words("ClampEditor.symbol")}</option>
      {setups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  )
}

// ── The tree (inside the Workholding group) ─────────────────────────────────

/** Each clamp definition with its clamps in the active setup; rendered by DesignTree. */
export function ClampTreeGroup() {
  const words = useText('setup-stock-tools-machine-post')
  const project = useCamStore((s) => s.project)
  const selectedClampId = useClampUi((s) => s.selectedClampId)
  const definitions = clampDefinitions(project.workholding)
  if (definitions.length === 0) return null
  return (
    <>
      {definitions.map(({ definition, instances }) => {
        const here = instances.filter((i) => setupScopeIncludes(i.setupScope, project.activeSetupId))
        return (
          <div key={definition.id} className="tree-geo-block" data-testid={`tree-clamp-def-${definition.id}`}>
            <div className="tree-item-geo" data-testid="tree-clamp-def-row">
              <div className="tree-item-geo-header">
                <span className="tree-geo-drag-handle" />
                <Anchor size={11} className="tree-item-geo-icon" />
                <span className="tree-item-label">{definition.name}</span>
                <span className="tree-item-meta" data-testid="tree-clamp-count" data-tooltip={words("ClampEditor.placed_in_this_setup")}>{here.length}</span>
                <button
                  className="tree-icon-btn"
                  data-testid={`place-clamp-btn-${definition.id}`}
                  onClick={(e) => { e.stopPropagation(); useClampUi.getState().startPlacing({ definitionId: definition.id, targetKind: 'stock' }) }}
                  data-tooltip={words("ClampEditor.place_clamps_click_stock_or_part_edges")}
                  aria-label={words("ClampEditor.place_clamps")}
                ><Plus size={10} /></button>
              </div>
            </div>
            {here.length > 0 && (
              <div className="tree-folder-contents" data-testid="tree-clamps">
                {here.map((instance, n) => {
                  const lost = clampEdgeLost(project, instance)
                  return (
                    <div
                      key={instance.id}
                      className={`tree-item-geo ${selectedClampId === instance.id ? 'tree-item-geo-active' : ''}`}
                      data-testid={`tree-clamp-${instance.id}`}
                      onClick={() => selectClamp(instance.id)}
                    >
                      <div className="tree-item-geo-header">
                        <span className="tree-geo-drag-handle" />
                        <span className="tree-item-label">{words("ClampEditor.clamp_2", { value1: n + 1 })}</span>
                        <span className="tree-item-meta" data-testid={lost ? 'tree-clamp-lost' : 'tree-clamp-edge'}>
                          {clampEdgeLabel(project, instance)}
                        </span>
                        <button
                          className="tree-icon-btn"
                          data-testid={`remove-clamp-btn-${instance.id}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            useCamStore.getState().removeWorkholdingInstance(instance.id)
                            if (useClampUi.getState().selectedClampId === instance.id) useClampUi.getState().selectClamp(null)
                          }}
                          data-tooltip={words("ClampEditor.delete_this_clamp")}
                          aria-label={words("ClampEditor.delete_clamp")}
                        ><Trash2 size={10} /></button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
