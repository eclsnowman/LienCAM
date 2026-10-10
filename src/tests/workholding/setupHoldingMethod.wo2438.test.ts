// WO-2438: each setup records how its stock is held (method + note), through the
// store action the Setup panel calls (updateSetup), saved and reopened through
// the real File Save / File Open path.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { Operation, Setup } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  loadCachedStepDisplay: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { resetDocumentHolder } = await import('../../doc/documentHolder')
const { HOLDING_METHODS, holdingMethodLabel, isHoldingMethodId } = await import('../../lib/workholding/holdingMethods')

const state = () => useCamStore.getState()
let savedBlobs: Blob[] = []

function makeSetup(id: string, ops: Operation[] = []): Setup {
  return {
    id, name: id,
    wcs: {
      id: `wcs-${id}`, label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: { type: 'auto' },
    operations: ops,
    notes: '',
  } as unknown as Setup
}

const byId = (id: string) => state().project.setups.find((s) => s.id === id)!

beforeEach(() => {
  resetDocumentHolder()
  savedBlobs = []
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:wo2438' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  state().newProject()
})

describe('WO-2438 setup holding method', () => {
  it('lists the eight methods by one id and name', () => {
    expect(HOLDING_METHODS.map((m) => m.id)).toEqual([
      'vise', 'clamps', 'screws', 'tape_glue', 'tabs_only', 'fixture_plate', 'vacuum', 'other',
    ])
    expect(holdingMethodLabel('tape_glue')).toBe('Tape and glue')
    expect(holdingMethodLabel(undefined)).toBeUndefined()
    expect(isHoldingMethodId('vise')).toBe(true)
    expect(isHoldingMethodId('')).toBe(false)
  })

  it('a new setup starts with no method and an empty note', () => {
    state().addSetup(makeSetup('s-new'))
    expect(byId('s-new').holdingMethod).toBeUndefined()
    expect(byId('s-new').notes).toBe('')
  })

  it('save -> reopen in a fresh store keeps each setup its own method and note', async () => {
    state().addSetup(makeSetup('s-a'))
    state().addSetup(makeSetup('s-b'))
    state().updateSetup('s-a', { holdingMethod: 'tape_glue' })
    state().updateSetup('s-a', { notes: 'Masking tape on spoilboard, CA glue on the stock.' })
    state().updateSetup('s-b', { holdingMethod: 'clamps' })

    await state().saveProjectToFile()
    expect(savedBlobs).toHaveLength(1)
    const text = await savedBlobs[0].text()

    state().newProject()
    expect(state().project.setups.find((s) => s.id === 's-a')).toBeUndefined()
    await state().loadProjectFromFile(text)

    expect(byId('s-a').holdingMethod).toBe('tape_glue')
    expect(byId('s-a').notes).toBe('Masking tape on spoilboard, CA glue on the stock.')
    expect(byId('s-b').holdingMethod).toBe('clamps')
    expect(byId('s-b').notes).toBe('')
  })

  it('a project saved before the field existed reopens with no method and an empty note', async () => {
    state().addSetup(makeSetup('s-old'))
    await state().saveProjectToFile()
    const parsed = JSON.parse(await savedBlobs[0].text())
    for (const s of parsed.setups) { delete s.holdingMethod; s.notes = '' }
    state().newProject()
    await state().loadProjectFromFile(JSON.stringify(parsed))
    expect(byId('s-old').holdingMethod).toBeUndefined()
    expect(byId('s-old').notes).toBe('')
  })

  it('choosing None clears the method', () => {
    state().addSetup(makeSetup('s-c'))
    state().updateSetup('s-c', { holdingMethod: 'vise' })
    state().updateSetup('s-c', { holdingMethod: undefined })
    expect(byId('s-c').holdingMethod).toBeUndefined()
  })

  it('changing the method or note does not outdate a ready toolpath', () => {
    const op = {
      id: 'op-1', name: 'Op', type: 'contour_2d', status: 'ready',
      toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 5 }],
    } as unknown as Operation
    state().addSetup(makeSetup('s-d', [op]))
    state().updateSetup('s-d', { holdingMethod: 'screws' })
    state().updateSetup('s-d', { notes: 'two screws in the waste' })
    const after = byId('s-d').operations[0]
    expect(after.status).toBe('ready')
    expect(after.toolpathMoves).toHaveLength(1)
  })
})
