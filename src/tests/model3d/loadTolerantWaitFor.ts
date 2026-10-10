import { waitFor as testingLibraryWaitFor } from '@testing-library/react'

// WO-123: full-slice CPU contention can push legitimate React/workbench
// transitions past Testing Library's 1s polling default. Keep that scheduler
// allowance in one test-only helper so Apply adoption, edit requests, and
// workbench boot waits use the same budget without retrying or changing any
// assertion.
export const LOAD_TOLERANT_ASYNC_TIMEOUT_MS = 20_000
export const LOAD_TOLERANT_TEST_TIMEOUT_MS = 20_000

export function waitForLoadedModel3d<T>(
  callback: () => T | Promise<T>,
  options?: Parameters<typeof testingLibraryWaitFor>[1],
): Promise<T> {
  return testingLibraryWaitFor(callback, {
    timeout: LOAD_TOLERANT_ASYNC_TIMEOUT_MS,
    ...options,
  })
}
