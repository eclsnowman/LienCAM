// @vitest-environment jsdom
// WO-2078: an imported STEP blend is selected as a recognized face, opens the
// ordinary Fillet palette on its measured radius, previews through editFeature,
// commits one history feature, and returns to the import with one Undo.

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import { createLocalGeomService } from '../../geom'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { useCamStore } from '../../store'

const { stepCache } = vi.hoisted(() => ({ stepCache: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id, bytes) => { stepCache.set(id, bytes) },
  loadCachedStep: async (id) => stepCache.get(id) ?? null,
  removeCachedStep: async (id) => { stepCache.delete(id) },
}))

afterEach(cleanup)
beforeEach(() => {
  stepCache.clear()
  useCamStore.getState().newProject()
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function fixtureBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(path)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function commitRadius(raw: string): void {
  const input = screen.getByLabelText('Fillet radius') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

describe('WO-2078 imported STEP Fillet tool', () => {
  it('shows R6, changes one pocket corner, re-edits that feature, and Undo restores each prior radius', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
    const file = new File(
      [fixtureBytes('test_fixtures/brep/fix_block_pocket.step')],
      'fix_block_pocket.step',
      { type: 'application/octet-stream' },
    )
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 20_000 })

    const importedBody = hooks().getBodyHandle('IMP1')!
    const beforeVolume = (await hooks().client.measure(importedBody, 'volume')).value
    const verdicts = await hooks().client.recognizeFeatures(importedBody)
    const target = verdicts.find((verdict) =>
      verdict.removable &&
      verdict.featureKey.startsWith('absorbed:cylinder:') &&
      verdict.featureClass === 'filletPlanar' &&
      verdict.params.centerX === 17.1803 &&
      verdict.params.centerY === 17.1803,
    )
    expect(target?.params.radius).toBe(6)

    fireEvent.click(screen.getByTestId('workbench-fillet'))
    // Aim along one of the target face's own production-tessellation normals.
    // This is independent of the fixture's camera pose and cannot accidentally
    // hit either sharp rim edge instead of the blend face.
    const mesh = await hooks().client.tessellate(importedBody, { deflection: 0.1 })
    const faceIndex = mesh.faceIds.indexOf(target!.faceIds[0])
    const triangle = [...mesh.triFace].findIndex((value) => value === faceIndex)
    expect(triangle).toBeGreaterThanOrEqual(0)
    const vertexIndices = [mesh.index[triangle * 3], mesh.index[triangle * 3 + 1], mesh.index[triangle * 3 + 2]]
    const point = {
      x: vertexIndices.reduce((sum, index) => sum + mesh.position[index * 3], 0) / 3,
      y: vertexIndices.reduce((sum, index) => sum + mesh.position[index * 3 + 1], 0) / 3,
      z: vertexIndices.reduce((sum, index) => sum + mesh.position[index * 3 + 2], 0) / 3,
    }
    const rawNormal = {
      x: vertexIndices.reduce((sum, index) => sum + mesh.normal[index * 3], 0) / 3,
      y: vertexIndices.reduce((sum, index) => sum + mesh.normal[index * 3 + 1], 0) / 3,
      z: vertexIndices.reduce((sum, index) => sum + mesh.normal[index * 3 + 2], 0) / 3,
    }
    const normalLength = Math.hypot(rawNormal.x, rawNormal.y, rawNormal.z)
    const normal = { x: rawNormal.x / normalLength, y: rawNormal.y / normalLength, z: rawNormal.z / normalLength }
    runtime.rayOverride = {
      origin: { x: point.x + normal.x * 0.1, y: point.y + normal.y * 0.1, z: point.z + normal.z * 0.1 },
      direction: { x: -normal.x, y: -normal.y, z: -normal.z },
    }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => expect((screen.getByLabelText('Fillet radius') as HTMLInputElement).value).toBe('6'), { timeout: 20_000 })
    commitRadius('6.5')
    await waitFor(() => expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const changedBody = hooks().getBodyHandle('F1')!
    const afterVolume = (await hooks().client.measure(changedBody, 'volume')).value
    const lengthMm = Number(target!.params.area) / (Math.PI * 6 / 2)
    const expectedDelta = lengthMm * (1 - Math.PI / 4) * (6.5 ** 2 - 6 ** 2)
    expect(afterVolume - beforeVolume).toBeCloseTo(expectedDelta, 2)
    expect(hooks().dag.getNode('F1')?.payload.importedFeatureKey).toBe(target!.featureKey)
    expect(hooks().dag.getNode('F1')?.payload.importedOriginalRadius).toBe(6)

    fireEvent.contextMenu(screen.getByTestId('feature-row-F1'), { clientX: 40, clientY: 60 })
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(() => expect((screen.getByLabelText('Fillet radius') as HTMLInputElement).value).toBe('6.5'))
    commitRadius('7')
    await waitFor(() => expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F1')?.payload.radius).toBe(7), { timeout: 20_000 })

    const reeditedBody = hooks().getBodyHandle('F1')!
    const reeditedVolume = (await hooks().client.measure(reeditedBody, 'volume')).value
    const expectedReeditDelta = lengthMm * (1 - Math.PI / 4) * (7 ** 2 - 6 ** 2)
    expect(reeditedVolume - beforeVolume).toBeCloseTo(expectedReeditDelta, 2)
    expect(hooks().dag.getNode('F1')?.payload.importedFeatureKey).toBe(target!.featureKey)
    expect(hooks().dag.getNode('F1')?.payload.importedOriginalRadius).toBe(6)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F1')?.payload.radius).toBe(6.5), { timeout: 20_000 })
    const restoredEditBody = hooks().getBodyHandle('F1')!
    expect((await hooks().client.measure(restoredEditBody, 'volume')).value).toBeCloseTo(afterVolume, 5)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F1')).toBeNull(), { timeout: 20_000 })
    await waitFor(() => expect((screen.getByTestId('body-visible-IMP1') as HTMLInputElement).checked).toBe(true))
  }, 120_000)
})
