// @vitest-environment jsdom
//
// WO CAM-13B acceptance #5 (Lab3DView regression): Operator's own correction (N-28,
// verbatim) proved "the correct name DOES show in ?lab3d=1" -- the failing
// surface is ONLY the workbench (?lab3d=1&workbench=1). Lab3DView.tsx is
// READ-ONLY for this WO (its own import path -- openStepFile, line ~539 --
// already reads body.name straight off session.importStepFile and needs no
// change). This is the regression guard: a REAL committed fixture (tray.step,
// embedded PRODUCT name "Part 1", pinned by stepAttributesReadReal.test.ts)
// driven through the REAL shared reader (createLocalGeomService -- the same
// Node-only Web-Worker-transport substitution every other real-kernel test in
// this WO's suite uses; no attribute-reading logic is mocked), asserting the
// body list still shows "Part 1", never a synthetic id.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { typedMock } from '../support/typedMock'

vi.mock('../../geom', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../geom')>()
  return typedMock<typeof import('../../geom')>({ ...orig, createGeomService: orig.createLocalGeomService })
})

const { Lab3DView } = await import('../../components/model3d/Lab3DView')
const { fakeCreateSceneRuntime } = await import('./fakeSceneRuntime')

afterEach(() => {
  cleanup()
  delete window.__lab3dImportStats
})

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '..', 'geom', 'fixtures')
function fixtureFile(fixtureName: string, uploadName: string): File {
  const buf = readFileSync(join(FIXTURES, fixtureName))
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new File([bytes], uploadName, { type: 'application/octet-stream' })
}

describe('CAM-13B regression: Lab3DView (?lab3d=1) still shows the embedded STEP name', () => {
  it('tray.step -> body list shows "Part 1" through the REAL kernel, unaffected by the workbench fix', async () => {
    render(<Lab3DView createSceneRuntime={fakeCreateSceneRuntime} />)
    await screen.findByTestId('body-visible-demoBody')

    const input = screen.getByTestId('lab3d-open-step') as HTMLInputElement
    fireEvent.change(input, { target: { files: [fixtureFile('tray.step', 'tray.step')] } })

    await waitFor(() => expect(screen.getByText('Part 1')).toBeTruthy(), { timeout: 30_000 })
  }, 60_000)
})
