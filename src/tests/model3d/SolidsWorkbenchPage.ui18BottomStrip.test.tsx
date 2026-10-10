// @vitest-environment jsdom
//
// WO UI-18 (BK-117(1)): the bottom-strip stacking was inverted vs CAM --
// workbench rendered the status strip ABOVE BottomConsole; CAM stacks
// BottomConsole above its status strip (App.tsx:145 above :146-155). This
// file asserts DOM order (compareDocumentPosition, not just testid
// presence -- order IS the claim) and the 'Ready' capitalization parity.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

describe('SolidsWorkbenchPage bottom-strip DOM order + status capitalization (WO UI-18 BK-117(1))', () => {
  it('BottomConsole precedes the status strip in DOM order', async () => {
    render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    const console = screen.getByTestId('console-strip')
    const statusStrip = screen.getByTestId('workbench-status-strip')
    // DOCUMENT_POSITION_FOLLOWING (4): statusStrip comes AFTER console in the tree.
    // eslint-disable-next-line no-bitwise
    expect(console.compareDocumentPosition(statusStrip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("status reads exactly 'Ready' (capitalized, CAM App.tsx parity)", async () => {
    render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toBe('Ready'))
  })
})
