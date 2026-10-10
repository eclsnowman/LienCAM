// WO-1268: drive the app's own themed confirm (ConfirmModal, store-backed) from
// a component test. Components under test never mount the App root, so the
// dialog itself is not rendered here; the store seam is the contract:
// requestConfirm() parks a pending `confirmDialog` and resolveConfirm() settles
// it. A test reads the pending dialog (title, body) to assert what the operator
// would have been asked, then answers it.
import { act, waitFor } from '@testing-library/react'
import { expect } from 'vitest'
import { useCamStore } from '../../store'

export type PendingConfirm = NonNullable<ReturnType<typeof useCamStore.getState>['confirmDialog']>

/** Wait for a themed confirm to be pending and return it. */
export async function pendingConfirm(): Promise<PendingConfirm> {
  await waitFor(() => expect(useCamStore.getState().confirmDialog).not.toBeNull())
  return useCamStore.getState().confirmDialog as PendingConfirm
}

/** Answer the pending themed confirm the way the operator would. */
export async function answerConfirm(ok: boolean): Promise<void> {
  await act(async () => { useCamStore.getState().resolveConfirm(ok) })
}

/** Wait for a pending confirm and answer it; returns what was asked. */
export async function answerPendingConfirm(ok: boolean): Promise<PendingConfirm> {
  const dialog = await pendingConfirm()
  await answerConfirm(ok)
  return dialog
}

/** No themed confirm is pending (the action asked nothing). */
export function expectNoConfirm(): void {
  expect(useCamStore.getState().confirmDialog).toBeNull()
}
