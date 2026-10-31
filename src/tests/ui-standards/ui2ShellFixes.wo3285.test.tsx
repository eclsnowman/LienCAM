// @vitest-environment jsdom
//
// WO-3285 fix round (audit findings F1 to F3): the New UI tabs keep the Model-to-CAM selection
// handoff of the shipped tab strip, the real window hosts open the Guided setup, and no two
// shell files differ only by letter case (a Windows checkout cannot hold both).
import fs from 'node:fs'
import path from 'node:path'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useCamStore } from '../../store'
import { useModelSelectionBridge } from '../../store/modelSelectionBridge'
import { enterWorkspace } from '../../ui2/shell/workspaces'
import { WindowHosts } from '../../ui2/shell/hosts'
import { useGuidedSetup } from '../../components/modals/GuidedSetupModal'
import type { ImportedGeometry } from '../../types'

const BODY_ROW = {
  id: 'body-row', name: 'Body', filename: 'Body', type: 'brep', format: 'model',
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 } },
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  modelItemId: 'item-1',
  modelBody: { ref: { bodyId: 'body-1', stableIds: [], version: 1 },
    display: { positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [], bbox: { min: [0, 0, 0], max: [1, 1, 1] } } },
} as unknown as ImportedGeometry

function selected(): string | null { return useCamStore.getState().viewer.selectedGeometryId ?? null }

beforeEach(() => {
  act(() => {
    useCamStore.setState(s => ({
      workspace: 'part', activeModal: null,
      project: { ...s.project, geometry: [BODY_ROW] },
      viewer: { ...s.viewer, mode: 'setup', selectedGeometryId: null },
    }))
    useModelSelectionBridge.getState().setModelSelection('body-1', 'item-1')
  })
})
afterEach(() => {
  cleanup()
  act(() => {
    useModelSelectionBridge.getState().setModelSelection(null, undefined)
    useCamStore.setState({ workspace: 'cam', activeModal: null })
  })
})

describe('WO-3285 audit fixes', () => {
  it('F1: leaving Model for a CAM tab carries the selected body to its CAM row, and no-ops without one', () => {
    for (const id of ['toolpath', 'setup', 'sketch', 'simulate'] as const) {
      act(() => {
        useCamStore.setState(s => ({ workspace: 'part', viewer: { ...s.viewer, selectedGeometryId: null } }))
        enterWorkspace(id)
      })
      expect(selected(), id).toBe('body-row')
    }
    act(() => {
      useCamStore.setState(s => ({ workspace: 'part', viewer: { ...s.viewer, selectedGeometryId: 'keep' } }))
      useModelSelectionBridge.getState().setModelSelection('no-such-body', 'item-1')
      enterWorkspace('toolpath')
    })
    expect(selected()).toBe('keep')
    act(() => {
      useCamStore.setState(s => ({ workspace: 'part', viewer: { ...s.viewer, selectedGeometryId: 'keep' } }))
      useModelSelectionBridge.getState().setModelSelection(null, undefined)
      enterWorkspace('setup')
    })
    expect(selected()).toBe('keep')
  })

  it('F2: the real window hosts open the Guided setup', async () => {
    render(<WindowHosts aboutOpen={false} onAbout={() => {}} onAboutClose={() => {}} />)
    expect(screen.queryByTestId('guided-setup-settings')).toBeNull()
    act(() => { useGuidedSetup.getState().show() })
    expect(await screen.findByTestId('guided-setup-settings')).toBeTruthy()
  }, 120_000)

  it('F3: no two files in src/ui2 differ only by letter case', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        const key = full.toLowerCase().replace(/\.(tsx?|css)$/, '')
        const twin = seen.get(key)
        if (twin !== undefined) clashes.push(`${twin} and ${full}`)
        seen.set(key, full)
        if (entry.isDirectory()) walk(full)
      }
    }
    walk(path.resolve('src/ui2'))
    expect(clashes).toEqual([])
  })
})
