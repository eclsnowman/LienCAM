import { useCamStore } from '../../store'
import type { VpHandle } from '../panels/DesignTree'

type MachiningBoundaryPickPresentation = {
  token: symbol
  viewport: VpHandle
  restorePartId: string | null
  unsubscribe: (() => void) | null
}

// The CAM viewport paints a selected body orange. A machining-boundary face
// pick uses the same interaction color, so leaving the owning body selected
// makes face hover/click feedback disappear into the body fill. Keep logical
// selection in the store, but temporarily clear only the viewport presentation
// while this one picker owns the canvas. The token rejects callbacks delivered
// after cancel/close or after a replacement pick session has started.
let machiningBoundaryPickPresentation: MachiningBoundaryPickPresentation | null = null

export function finishMachiningBoundaryPickPresentation(token?: symbol): boolean {
  const session = machiningBoundaryPickPresentation
  if (!session || (token && session.token !== token)) return false

  machiningBoundaryPickPresentation = null
  session.unsubscribe?.()

  // Do not repaint a stale selection if another UI action changed the logical
  // target while this picker was closing. The store remains authoritative.
  if (
    session.restorePartId !== null
    && useCamStore.getState().viewer.selectedGeometryId === session.restorePartId
  ) {
    session.viewport.setSelectedPart?.(session.restorePartId)
  }
  return true
}

export function startMachiningBoundaryPickPresentation(
  viewport: VpHandle,
  owningGeoId: string,
): symbol {
  finishMachiningBoundaryPickPresentation()

  const originState = useCamStore.getState()
  const restorePartId = originState.viewer.selectedGeometryId === owningGeoId
    ? originState.viewer.selectedGeometryId
    : null
  if (restorePartId !== null) viewport.setSelectedPart?.(null)

  // A modal name alone is not a session identity: new-operation can be
  // replaced directly by edit-operation, and one edited operation can replace
  // another without first closing the modal. Project replacement is another
  // teardown boundary because newProject intentionally resets viewer state.
  const originActiveModal = originState.activeModal
  const originEditSetupId = originState.editingOpPayload?.setupId ?? null
  const originEditOpId = originState.editingOpPayload?.opId ?? null
  const originProjectId = originState.project.id

  const token = Symbol('machining-boundary-pick')
  const session: MachiningBoundaryPickPresentation = {
    token,
    viewport,
    restorePartId,
    unsubscribe: null,
  }
  machiningBoundaryPickPresentation = session
  session.unsubscribe = useCamStore.subscribe((nextState) => {
    if (
      nextState.activeModal !== originActiveModal
      || (nextState.editingOpPayload?.setupId ?? null) !== originEditSetupId
      || (nextState.editingOpPayload?.opId ?? null) !== originEditOpId
      || nextState.project.id !== originProjectId
    ) {
      finishMachiningBoundaryPickPresentation(token)
    }
  })
  return token
}

export function isCurrentMachiningBoundaryPick(token: symbol): boolean {
  return machiningBoundaryPickPresentation?.token === token
}
