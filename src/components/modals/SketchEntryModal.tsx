// Sketch entry chooser (PLAN.md 3.2, Stage 5).
//
// Opens when the Sketch tab is clicked with no active sketch document.
// WO-069: the modal opens FIRST (not the viewport pick). "New sketch" is the
// top option; "Pick existing in viewport" starts the spatial pick only when
// the user chooses it. A part with one editable layer opens directly; a
// multi-layer part narrows the text fallback to its own layers. Direct
// layer-entry paths (double-click a sketch in the tree, capture harnesses)
// set the document before switching modes and bypass this chooser entirely.
//
// NAV-SKETCH-TAB-SELECTION (GEO-UNIFY Stage 5): the SAME narrowing also
// happens when `enterSketchWorkspace` opens this chooser for an AMBIGUOUS
// tree/CAM selection (a part with 2+ sketch-editable layers) — it seeds
// `sketchEntryFilterGeoId` in the store, which this component reads into the
// same local `pickedGeoId` state the viewport-pick flow already uses, so the
// two entry paths render identically.

import { useEffect, useState } from 'react'
import { X, PenTool, FilePlus, MousePointer2 } from 'lucide-react'
import { useCamStore } from '../../store'
import { listSketchEntryCandidates } from '../../lib/sketch/entryChooser'
import type { VpHandle } from '../panels/DesignTree'
import { useDialogFocus } from '../../hooks/useDialogFocus'

const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle) ?? null

export function SketchEntryModal() {
  const activeModal = useCamStore((s) => s.activeModal)
  const closeModal = useCamStore((s) => s.closeModal)
  const geometry = useCamStore((s) => s.project.geometry)
  const startNewSketch = useCamStore((s) => s.startNewSketch)
  const openSketchForLayer = useCamStore((s) => s.openSketchForLayer)
  // NAV-SKETCH-TAB-SELECTION (Stage 5): set by enterSketchWorkspace when the
  // tab click's own selection was ambiguous — null for every other open
  // (today's plain, unfiltered chooser).
  const filterGeoId = useCamStore((s) => s.sketchEntryFilterGeoId)
  const [isPickingExisting, setIsPickingExisting] = useState(false)
  const [pickedGeoId, setPickedGeoId] = useState<string | null>(null)
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  const open = activeModal === 'sketch-entry'

  // Esc returns from viewport picking to the chooser before it closes the
  // chooser itself.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (isPickingExisting) {
        getVp()?.setPartPickMode?.(null)
        setIsPickingExisting(false)
      } else {
        closeModal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, isPickingExisting, closeModal])

  // An outside modal transition must never leave the viewport picker armed.
  // On OPEN, seed the same narrowing state the viewport-pick flow uses from
  // the store's pre-filter (Stage 5) — null on every non-Stage-5 open, which
  // reproduces today's unfiltered list exactly.
  useEffect(() => {
    if (!open) {
      getVp()?.setPartPickMode?.(null)
      setIsPickingExisting(false)
      setPickedGeoId(null)
      return
    }
    setPickedGeoId(filterGeoId)
  }, [open, filterGeoId])

  const candidates = listSketchEntryCandidates(geometry)
  const groups: {
    geoId: string
    containerName: string
    items: typeof candidates
  }[] = []
  for (const candidate of candidates) {
    let group = groups.find((item) => item.geoId === candidate.geoId)
    if (!group) {
      group = {
        geoId: candidate.geoId,
        containerName: candidate.containerName,
        items: [],
      }
      groups.push(group)
    }
    group.items.push(candidate)
  }

  const pickableGroups = groups.filter((group) =>
    group.items.some((candidate) => candidate.disabledReason === null))
  const displayedGroups = pickedGeoId
    ? groups.filter((group) => group.geoId === pickedGeoId)
    : groups

  const stopViewportPicking = () => {
    getVp()?.setPartPickMode?.(null)
    setIsPickingExisting(false)
  }

  const closeChooser = () => {
    stopViewportPicking()
    setPickedGeoId(null)
    closeModal()
  }

  const handleNewSketch = () => {
    closeChooser()
    startNewSketch()
  }

  const handleEditLayer = (geoId: string, layerId: string) => {
    closeChooser()
    // Refusals from raced lock/projection changes surface via the store's
    // sketch notice. geoId disambiguates duplicated imported layer ids.
    openSketchForLayer(layerId, geoId)
  }

  // Contextual-feedback rule (Operator 2026-07-25): posts a console line on arm
  // and on every hover-target CHANGE (via the setPartPickMode onHover param,
  // change-dedup'd at the viewport level -- see CNCViewport.setPartPickHover's
  // own comment); the hover HIGHLIGHT itself is the existing "Eligible parts
  // highlight" machinery, reused as-is. WO-069: this fires ONLY from the
  // "Pick existing in viewport" button click -- the modal opens first.
  const startViewportPicking = (): boolean => {
    const viewport = getVp()
    if (!viewport?.setPartPickMode || pickableGroups.length === 0) return false

    setIsPickingExisting(true)
    useCamStore.getState().addConsoleEvent({
      severity: 'info', source: 'sketch',
      message: 'Pick the part to edit in the viewport - eligible parts highlight.',
    })
    viewport.setPartPickMode(
      (geoId) => {
        viewport.setPartPickMode?.(null)
        setIsPickingExisting(false)

        const group = pickableGroups.find((candidateGroup) =>
          candidateGroup.geoId === geoId)
        const editableLayers = group?.items.filter((candidate) =>
          candidate.disabledReason === null) ?? []
        if (!group || editableLayers.length === 0) return

        useCamStore.getState().setSelectedGeometry(geoId)
        viewport.setSelectedPart?.(geoId)

        if (editableLayers.length === 1) {
          const layer = editableLayers[0]
          useCamStore.getState().addConsoleEvent({
            severity: 'success', source: 'sketch',
            message: `Editing sketch: ${layer.layerName} (${group.containerName}).`,
          })
          handleEditLayer(layer.geoId, layer.layerId)
          return
        }

        // A whole-part hit cannot safely guess among multiple editable layers.
        // Keep the spatial selection and narrow the fallback to that part.
        useCamStore.getState().addConsoleEvent({
          severity: 'info', source: 'sketch',
          message: `${group.containerName} has multiple editable layers - choose one below.`,
        })
        setPickedGeoId(geoId)
      },
      pickableGroups.map((group) => group.geoId),
      [],
      'standard',
      (geoId) => {
        if (geoId === null) return
        const label = pickableGroups.find((candidateGroup) => candidateGroup.geoId === geoId)?.containerName ?? geoId
        useCamStore.getState().addConsoleEvent({
          severity: 'info', source: 'sketch',
          message: `Pick the part to edit - hovering: ${label}.`,
        })
      },
    )
    return true
  }

  if (!open) return null

  if (isPickingExisting) {
    return (
      <div className="loop-pick-banner" data-testid="sketch-entry-part-pick-banner">
        <MousePointer2 size={16} className="loop-pick-icon" />
        <span className="loop-pick-text">
          Click the sketch part in the viewport. Eligible parts highlight.
        </span>
        <button
          className="loop-pick-done-btn"
          data-testid="sketch-entry-part-pick-cancel"
          onClick={stopViewportPicking}
        >
          <X size={14} /> Cancel
        </button>
      </div>
    )
  }

  const pickedGroup = pickedGeoId
    ? groups.find((group) => group.geoId === pickedGeoId)
    : null

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- MODAL-
    // GOVERNED scrim in the UI-70 census.
    <div className="modal-backdrop" data-ui78-sanctioned="" onMouseDown={closeChooser}>
      <div
        className="modal-container sketch-entry-modal"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogFocusRef}
      >
        <div className="modal-header">
          <PenTool size={15} className="modal-header-icon" />
          <span className="modal-title">Enter Sketch Mode</span>
          <button className="modal-close-btn" onClick={closeChooser}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          <button className="op-type-card sketch-entry-new" onClick={handleNewSketch}>
            <FilePlus size={18} />
            <span className="op-type-name">New sketch</span>
          </button>

          <button
            className="op-type-card sketch-entry-action"
            data-testid="sketch-entry-pick-existing"
            disabled={pickableGroups.length === 0}
            onClick={startViewportPicking}
          >
            <MousePointer2 size={18} />
            <span className="op-type-name">
              {pickedGeoId ? 'Pick a different part' : 'Pick existing in viewport'}
            </span>
          </button>

          <div className="sketch-entry-list-title">
            {pickedGroup
              ? `Choose a layer in ${pickedGroup.containerName}`
              : 'Or choose an existing layer'}
          </div>
          {pickedGroup && (
            <div
              className="sketch-entry-pick-note"
              data-testid="sketch-entry-picked-part-note"
            >
              This part has multiple editable layers. Choose one below.
            </div>
          )}
          {candidates.length === 0 ? (
            <div className="sketch-entry-empty">
              No 2D layers in this project yet - import a DXF/SVG or start
              with a new sketch.
            </div>
          ) : (
            <div className="sketch-entry-list">
              {displayedGroups.map((group) => (
                <div key={group.geoId} className="sketch-entry-group">
                  <div
                    className="sketch-entry-group-name"
                    data-tooltip={group.containerName}
                  >
                    {group.containerName}
                  </div>
                  {group.items.map((candidate) => (
                    <button
                      key={`${candidate.geoId}:${candidate.layerId}`}
                      className={`sketch-entry-row ${
                        candidate.disabledReason ? 'sketch-entry-row-disabled' : ''
                      }`}
                      disabled={candidate.disabledReason !== null}
                      onClick={() => handleEditLayer(
                        candidate.geoId,
                        candidate.layerId,
                      )}
                      data-tooltip={candidate.disabledReason ?? (
                        candidate.hasStoredSketch
                          ? 'Re-open the stored parametric sketch'
                          : 'Lift this layer into a new sketch'
                      )}
                    >
                      <span className="sketch-entry-row-name">
                        {candidate.layerName}
                      </span>
                      <span className="sketch-entry-row-meta">
                        {candidate.loopCount} loop
                        {candidate.loopCount === 1 ? '' : 's'}
                        {candidate.hasStoredSketch ? ' - parametric' : ''}
                      </span>
                      {candidate.disabledReason && (
                        <span className="sketch-entry-row-reason">
                          {candidate.disabledReason}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn modal-btn-ghost" onClick={closeChooser}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
