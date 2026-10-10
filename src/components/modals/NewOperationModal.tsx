// Operation configuration wizard (New / Edit operation).
//
// BK-178-DECOMP: this file is now a THIN wrapper. All hooks live in
// useNewOperationModalState(); the ~4900-line derived-values + JSX render body
// lives in NewOperationModalBody. The wrapper calls the state hook
// unconditionally, resolves the open/setup guard, early-returns when closed, and
// otherwise renders the body with fully resolved (non-null) props. Because the
// body is a separate component that calls no hooks of its own, there is
// structurally nowhere below an early return for a hook to land -- the BK-178
// hooks-order hazard class is eliminated by construction rather than by comment.
// See coordination/reports/BK-178.report.md and BK-178-DECOMP.report.md.
import { useNewOperationModalState } from './useNewOperationModalState'
import { NewOperationModalBody } from './NewOperationModalBody'

export function NewOperationModal() {
  const state = useNewOperationModalState()
  const isEditMode = state.activeModal === 'edit-operation'
  const isOpen     = state.activeModal === 'new-operation' || isEditMode
  const setupId    = isEditMode ? (state.editingOpPayload?.setupId ?? state.project.activeSetupId) : state.project.activeSetupId
  const setup      = state.project.setups.find(s => s.id === setupId)
  if (!isOpen || !setup) return null
  return <NewOperationModalBody state={state} setup={setup} isEditMode={isEditMode} setupId={setupId} />
}
