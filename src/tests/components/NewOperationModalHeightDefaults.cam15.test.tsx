// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { HeightIntentV1, Setup } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useNewOperationModalState } = await import('../../components/modals/useNewOperationModalState')
const { useCamStore } = await import('../../store')

const setupIntent: HeightIntentV1 = {
  version: 1,
  clearance: { reference: 'retract', offset: 10, provenance: 'default' },
  retract: { reference: 'stock_top', offset: 5, provenance: 'default' },
  feed: { reference: 'top', offset: 5, provenance: 'default' },
  top: { reference: 'stock_top', offset: 0, provenance: 'default' },
  bottom: { reference: 'top', offset: -8, provenance: 'default' },
}

function HeightDraftProbe() {
  const state = useNewOperationModalState()
  return <pre data-testid="height-draft">{JSON.stringify({
    heights: state.heights,
    contour: state.contour,
    pocket: state.pocket,
    adaptive: state.adaptive,
    drill: state.drill,
    bore: state.bore,
    face: state.face,
    engrave: state.engrave,
    chamfer: state.chamfer,
    threadMill: state.threadMill,
    parallel3d: state.parallel3d,
    adaptive3d: state.adaptive3d,
  })}</pre>
}

function draft(): Record<string, Record<string, unknown>> {
  return JSON.parse(screen.getByTestId('height-draft').textContent ?? '{}')
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  const current = useCamStore.getState()
  const setup = {
    id: 'setup-cam15', name: 'Setup CAM-15', stock: null, operations: [], notes: '',
    defaultHeightIntent: setupIntent,
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
  } as unknown as Setup
  act(() => {
    useCamStore.setState({
      project: { ...current.project, setups: [setup], activeSetupId: setup.id },
      activeModal: null,
    })
  })
})

afterEach(() => cleanup())

describe('CAM-15 new-operation wizard height defaults', () => {
  it('opens with Setup -8 synchronized across 2.5D family drafts while special depth contracts stay intact', async () => {
    render(<HeightDraftProbe />)
    act(() => { useCamStore.getState().openModal('new-operation') })

    await waitFor(() => expect(draft().heights.bottomHeight).toBe(-8))
    const value = draft()
    for (const family of ['contour', 'pocket', 'adaptive', 'drill', 'bore']) {
      expect(value[family]).toMatchObject({ heightReference: 'stock_top', planeOffset: -8 })
    }
    expect(value.face).toMatchObject({ heightReference: 'stock_top', planeOffset: 0 })
    expect(value.engrave).toMatchObject({
      heightReference: 'stock_top', planeOffset: 0, useWidthForDepth: false,
    })

    expect(value.chamfer).toMatchObject({
      heightReference: 'geometry_face', planeOffset: 0, chamferWidth: 1, tipOffset: 0,
    })
    expect(value.threadMill).toMatchObject({
      heightReference: 'geometry_face', planeOffset: 0, threadDepth: 9, geometrySource: 'loop',
    })
    expect(value.parallel3d).not.toHaveProperty('heightReference')
    expect(value.adaptive3d).not.toHaveProperty('heightReference')
  })
})
