// @vitest-environment jsdom
//
// WO-2007 (COHESION-STANDARD 21, Operator 2026-09-25): the Properties panel shows
// values you can change, in plain collapsible lists. The Heights group used to
// carry a nested-scroll Smart Height diagnostics block (a second copy of every
// height), a formula line plus a "How was this calculated?" disclosure per row
// and a Safety ownership chip. This file pins what replaced them: one scroll,
// each height value once, the derivation and ownership in the value's tooltip,
// every editable control still present, and only a refusal or a plan warning
// earning a row of its own.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, PhysicalStock, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null,
  key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const {
  buildContourSmartHeightIntent,
  deriveContourFeatureBindings,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const { defaultContourParams, defaultHeights, defaultLinking, defaultPasses } = await import(
  '../../components/modals/newOperationModalDefaults'
)

const stock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 },
    size: { x: 100, y: 80, z: 20 }, center: { x: 50, y: 40, z: 10 },
  },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const tool = {
  id: 'tool-1', name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as unknown as Tool

const resolvedSnapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 30, retract: 25, feed: 22, top: 20, bottom: 4.5 },
  machine: { clearance: 30, retract: 25, feed: 22, top: 20, bottom: 4.5 },
  intent: {
    version: 1,
    clearance: { reference: 'wcs_plane', offset: 30, provenance: 'inferred' },
    retract: { reference: 'wcs_plane', offset: 25, provenance: 'inferred' },
    feed: { reference: 'wcs_plane', offset: 22, provenance: 'inferred' },
    top: { reference: 'wcs_plane', offset: 20, provenance: 'inferred' },
    bottom: { reference: 'wcs_plane', offset: 4.5, provenance: 'inferred' },
  },
  dependencyIds: [stock.id, 'part-1'],
}

function geometry(): ImportedGeometry {
  return {
    id: 'part-1', name: 'Feature.step', filename: 'Feature.step',
    type: 'brep', format: 'step',
    loaded: true, stockId: stock.id, loopsVersion: 2,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
      size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
    },
    loops: [{
      id: 'loop-1', layerId: 'layer-1', closed: true, type: 'contour', area: 78.5,
      points: [{ x: 5, y: 0 }, { x: 0, y: 5 }, { x: -5, y: 0 }],
    }],
    layers2d: [{
      id: 'layer-1', name: 'Profile', color: '#fff', visible: true, frame: 'geometry_local',
      cylinders: [{
        center: [0, 0], diameter: 10, topZ: 10, bottomZ: 4,
        through: false, kind: 'boss', loopId: 'loop-1',
      }],
    }],
  } as ImportedGeometry
}

function smartContour(): Operation {
  const source = geometry()
  const derived = deriveContourFeatureBindings([source], ['loop-1'])
  if (!derived.ok) throw new Error(derived.refusals[0].message)
  const safetyIntent = defaultHeightIntent()
  return {
    id: 'smart-contour', name: 'Smart Contour', type: 'contour_2d',
    enabled: true, status: 'ready', toolId: tool.id, geometrySelections: ['loop-1'],
    heights: { ...defaultHeights, bottomHeight: -7.25, heightIntent: safetyIntent },
    passes: { ...defaultPasses }, linking: { ...defaultLinking },
    params: { ...defaultContourParams, geometryId: 'part-1', loopIds: ['loop-1'] },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildContourSmartHeightIntent({
        setupId: 'setup-1',
        safetyIntent,
        mode: 'selected_feature',
        features: derived.bindings.map(binding => binding.feature),
      }),
    },
  } as unknown as Operation
}

function seed(operation: Operation) {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [operation],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
    },
    stock: null,
  } as unknown as Setup
  const preview = vi.fn(async (_setupId: string, op: Operation) => smartHeightPlanFixture(op, resolvedSnapshot))
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool],
    computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: preview,
    previewContourSmartHeights: vi.fn(() => resolvedSnapshot),
    project: {
      ...state.project,
      setups: [setup], activeSetupId: setup.id, activeOperationId: operation.id,
      stocks: [stock], geometry: [geometry()],
    },
  } as never)
  return preview
}

const PLANES = ['clearance', 'retract', 'feed', 'top', 'bottom'] as const

/** The text an operator can see: the panel minus hidden accessible descriptions. */
function visibleText(root: Element): string {
  const clone = root.cloneNode(true) as Element
  clone.querySelectorAll('[hidden]').forEach(node => node.remove())
  return clone.textContent ?? ''
}

async function renderResolved() {
  render(<PropertiesPanel />)
  await waitFor(() => {
    expect(screen.queryByTestId('props-live-height-plan-loading')).toBeNull()
    expect(screen.getByTestId('props-height-value-bottom').textContent).toMatch(/^4\.50* mm WCS/)
  })
  return document.querySelector('.props-section') as HTMLElement
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

describe('WO-2007: Properties Heights show values, not explanations', () => {
  it('has one scroll: no element inside the properties section scrolls on its own', async () => {
    seed(smartContour())
    const section = await renderResolved()
    const scrollers = Array.from(section.querySelectorAll<HTMLElement>('*')).filter(element => {
      const style = getComputedStyle(element)
      return ['auto', 'scroll'].includes(style.overflowY) || ['auto', 'scroll'].includes(style.overflow)
    })
    expect(scrollers.map(element => element.dataset.testid ?? element.className)).toEqual([])
    expect(screen.queryByTestId('props-height-diagnostics')).toBeNull()
    expect(screen.queryByTestId('resolved-height-inspector')).toBeNull()
  })

  it('shows each resolved height value once, with no derivation prose beside it', async () => {
    seed(smartContour())
    const section = await renderResolved()
    const text = visibleText(section)
    for (const value of ['20.000 mm WCS', '4.500 mm WCS']) {
      expect(text.split(value).length - 1, value).toBe(1)
    }
    expect(text).not.toContain('How was this calculated?')
    expect(text).not.toContain('Safety ownership')
    expect(text).not.toContain('Smart Height diagnostics')
    expect(text).not.toContain('Setup owned')
    for (const plane of PLANES) {
      const formula = screen.getByTestId(`props-height-formula-${plane}`)
      expect(formula.hidden).toBe(true)
      expect(text).not.toContain(formula.textContent!)
    }
  })

  it('puts the derivation in each value tooltip and the safety ownership in the safety tooltips', async () => {
    seed(smartContour())
    await renderResolved()
    for (const plane of PLANES) {
      const value = screen.getByTestId(`props-height-value-${plane}`)
      const formula = screen.getByTestId(`props-height-formula-${plane}`)
      expect(value.getAttribute('data-tooltip')).toContain(formula.textContent!)
      expect(value.getAttribute('aria-describedby')).toBe(formula.id)
      expect(value.getAttribute('data-tooltip')?.includes('Setup owned'))
        .toBe(plane === 'clearance' || plane === 'retract' || plane === 'feed')
    }
    // The Smart / User Override tag stays: one per row.
    for (const plane of PLANES) {
      expect(screen.getByTestId(`props-height-authority-${plane}`).textContent).toBe('Smart')
    }
  })

  it('keeps every editable height control, and offers Reset safety to setup once an override exists', async () => {
    seed(smartContour())
    await renderResolved()
    for (const plane of ['clearance', 'retract', 'feed'] as const) {
      const input = screen.getByRole('textbox', { name: `${plane[0].toUpperCase()}${plane.slice(1)} Height resolved WCS height` })
      expect(screen.getByTestId(`props-height-row-${plane}`).contains(input)).toBe(true)
    }
    expect(screen.queryByTestId('op-reset-heights-to-setup')).toBeNull()

    const clearance = screen.getByTestId('props-height-row-clearance').querySelector('input') as HTMLInputElement
    fireEvent.focus(clearance)
    fireEvent.change(clearance, { target: { value: '42' } })
    fireEvent.blur(clearance)

    expect(screen.getByTestId('props-height-value-retract').getAttribute('data-tooltip')).toContain('Mixed ownership')
    fireEvent.click(screen.getByTestId('op-reset-heights-to-setup'))
    const reset = validatePersistedSmartHeightState(useCamStore.getState().project.setups[0].operations[0].smartHeight)
    if (!reset.ok || reset.state.kind !== 'smart_v2') throw new Error('Expected valid V2 authority after reset.')
    expect(reset.state.intent.safety.clearance.owner.kind).toBe('setup')
    expect(screen.queryByTestId('op-reset-heights-to-setup')).toBeNull()
  })

  // WO-2007 fix round: Operator crossed out the Warning row (09-25 4:14 PM CT) - no warning rows at all.
  it('shows no row for a plan warning, and a refusal as one plain row', async () => {
    seed(smartContour())
    useCamStore.setState({
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, op: Operation) => ({
        ...smartHeightPlanFixture(op, resolvedSnapshot),
        warnings: ['Fixture/clamp clearance is unverified.'],
      })),
    } as never)
    await renderResolved()
    expect(screen.queryByTestId('props-height-warning')).toBeNull()
    expect(screen.queryByText(/Fixture\/clamp clearance/)).toBeNull()
    expect(screen.queryByText('Warning')).toBeNull()
    cleanup()

    seed(smartContour())
    useCamStore.setState({
      previewOperationSmartHeightPlan: vi.fn(async () => { throw new Error('Stock binding changed.') }),
    } as never)
    render(<PropertiesPanel />)
    await waitFor(() => expect(screen.getByTestId('props-height-refusal').textContent).toBe('Cannot resolveStock binding changed.'))
    expect(screen.queryByTestId('props-height-warning')).toBeNull()
  })

  // WO-2007 round 3 (CS 21): no amber tool-reach row; the reach shortfall is the console's job.
  it('shows no tool-reach warning row when the cut runs deeper than the flutes', async () => {
    const operation = smartContour()
    // Top of cut 0 mm (stored heights), deepest cut move -40 mm -> 40 mm immersion, past the 20 mm flutes.
    seed({ ...operation, toolpathMoves: [
      { type: 'rapid', x: 0, y: 0, z: 30 },
      { type: 'linear', x: 0, y: 0, z: -40 },
    ] } as unknown as Operation)
    const section = await renderResolved()
    expect(screen.queryByTestId('tool-reach-warning')).toBeNull()
    expect(visibleText(section)).not.toMatch(/flute length|stickout below holder/)
  })
})
