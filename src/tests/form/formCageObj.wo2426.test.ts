// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { FormPanel } from '../../components/model3d/form/FormPanel'
import { ExportModal } from '../../components/modals/ExportModal'
import { openExportWindow } from '../../lib/exportCenter'
import { useFormStore } from '../../form/formStore'
import type { Cage, Vec3 } from '../../form/cage'
import type { StarterKind } from '../../form/starters'

// Independent polygon reader: do not call the exporter's helpers. Unlike a
// render loader, retain OBJ's polygons so triangulation cannot hide face loss.
function readObj(text: string): { positions: number[][]; faces: number[][] } {
  const positions: number[][] = []
  const faces: number[][] = []
  for (const line of text.split(/\r?\n/)) {
    const [kind, ...fields] = line.trim().split(/\s+/)
    if (kind === 'v') positions.push(fields.map(Number))
    if (kind === 'f') {
      const refs = fields.map((field) => Number(field.split('/')[0]))
      expect(refs.every((ref) => Number.isInteger(ref) && ref > 0 && ref <= positions.length)).toBe(true)
      faces.push(refs.map((ref) => ref - 1))
    }
  }
  return { positions, faces }
}

function expectCage(text: string, cage: Cage) {
  const parsed = readObj(text)
  expect(parsed.positions).toHaveLength(cage.positions.length)
  expect(parsed.faces).toHaveLength(cage.faces.length)
  expect(parsed.faces).toEqual(cage.faces)
  for (let i = 0; i < cage.positions.length; i++) {
    expect(parsed.positions[i]).toHaveLength(3)
    for (let axis = 0; axis < 3; axis++) {
      expect(Math.abs(parsed.positions[i][axis] - cage.positions[i][axis])).toBeLessThanOrEqual(1e-6)
    }
  }
  // A subdivision/render application's standard OBJ loader also accepts it.
  expect(new OBJLoader().parse(text).children.length).toBeGreaterThan(0)
}

const session = {
  active: true, open: () => {}, finish: vi.fn(), cancel: vi.fn(), undo: () => {}, redo: () => {},
  canUndo: false, canRedo: false, railSections: [],
}
const saved: Array<{ filename: string; text: string }> = []
const hostSave = vi.fn(async (filename: string, contents: string | Uint8Array): Promise<string | null> => {
  saved.push({ filename, text: String(contents) })
  return filename
})

describe('WO-2426 Form control cage OBJ export', () => {
  beforeEach(() => {
    saved.length = 0
    vi.clearAllMocks()
    vi.stubGlobal('liencamHost', { saveFile: hostSave })
    localStorage.clear()
    useFormStore.getState().openSession({ featureId: null, name: 'Form 1' })
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it.each<StarterKind>(['box', 'cylinder', 'sphere', 'torus', 'plane'])('exports the complete %s starter through the button action', async (kind) => {
    const store = useFormStore.getState()
    store.newFromStarter(kind)
    store.setName(`${kind} cage`)
    const source = useFormStore.getState()
    expect(await source.exportCageObj()).toBe(`${kind} cage.obj`)
    expect(saved).toHaveLength(1)
    expectCage(saved[0].text, source.cage)
    expect(useFormStore.getState()).toBe(source)
  })

  it('exports current edited coordinates and mixed triangle/quad/n-gon topology, including loose points', async () => {
    const store = useFormStore.getState()
    store.newFromStarter('box', { segments: { x: 1, y: 1, z: 1 } })
    store.setSelection({ points: [], edges: [], faces: [0] })
    store.extrudeSelection()
    store.insertPointOnSelection()
    const edited = useFormStore.getState().cage
    const moved = {
      ...edited,
      positions: edited.positions.map(([x, y, z]) => [x + 0.123456789, y - 0.987654321, z + 0.000000123] as Vec3),
    }
    expect(store.applyCage(moved, { topology: false, record: true })).toBe(true)
    await store.exportCageObj()
    expectCage(saved[0].text, useFormStore.getState().cage)

    // Re-edit a cage with all legal polygon sizes and an unreferenced point.
    const mixed: Cage = {
      positions: [[0, 0, 0], [2, 0, 0], [3, 1, 0], [2, 2, 0], [0, 2, 0], [-1, 1, 0], [9, 8, 7]],
      faces: [[0, 1, 2], [0, 2, 3, 4], [0, 4, 5, 3, 2]], creases: [],
    }
    store.openSession({ featureId: 'form-existing', name: 'Reopened', cage: mixed })
    await store.exportCageObj()
    expectCage(saved[1].text, mixed)
  })

  it('clicking Export saves the cage beside Finish/Cancel without ending the session', async () => {
    render(createElement(FormPanel, { session }))
    const source = useFormStore.getState()
    render(createElement(ExportModal))
    act(() => { openExportWindow('form') })
    const button = screen.getByTestId('export-save-form')
    // The central Save leaves Finish/Cancel available on the active Form panel.
    expect(button.closest('[role="dialog"]')).toBe(screen.getByTestId('export-modal'))
    expect(screen.getByTestId('form-finish').closest('.docked-panel-footer')).not.toBeNull()
    fireEvent.click(button)
    await waitFor(() => expect(saved).toHaveLength(1))
    expectCage(saved[0].text, source.cage)
    expect(session.finish).not.toHaveBeenCalled()
    expect(session.cancel).not.toHaveBeenCalled()
    expect(useFormStore.getState()).toBe(source)
  })

  it('uses a safe filename and falls back to Form for an empty name', async () => {
    useFormStore.getState().setName('A/B: cage. ')
    await useFormStore.getState().exportCageObj()
    expect(saved[0].filename).toBe('A_B_ cage.obj')
    useFormStore.getState().setName('   ')
    await useFormStore.getState().exportCageObj()
    expect(saved[1].filename).toBe('Form.obj')
  })

  it('replaces every ASCII control and reserved filename character while preserving other characters', async () => {
    const controls = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join('')
    const reserved = '<>:"/\\|?*'
    const preserved = 'space \u007f\u0080\ud83d\ude00'
    useFormStore.getState().setName(`A${controls}${reserved}${preserved}. `)
    await useFormStore.getState().exportCageObj()
    expect(saved[0].filename).toBe(`A${'_'.repeat(32 + reserved.length)}${preserved}.obj`)
  })

  it('leaves the form unchanged if the desktop save dialog is cancelled', async () => {
    hostSave.mockResolvedValueOnce(null)
    const source = useFormStore.getState()
    expect(await source.exportCageObj()).toBeNull()
    expect(useFormStore.getState()).toBe(source)
  })
})
