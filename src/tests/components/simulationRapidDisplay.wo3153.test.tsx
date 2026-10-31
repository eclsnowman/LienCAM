// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Project, ToolpathMove } from '../../types'
import { CNCViewport } from '../../lib/viewport/CNCViewport'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key), clear: () => memory.clear(),
} })
const { SimulationPanel } = await import('../../components/simulation/SimulationPanel')
const { useCamStore } = await import('../../store')

type Viewport = Pick<CNCViewport, 'setSimulationToolpathPreview' | 'setSimulationToolpathWindow' | 'setHiddenToolpathRoles'> & {
  toolpathGroup: THREE.Group
  toolpathRoleLines: Map<string, THREE.Object3D>
  simulationToolpathRoleLines: Map<string, THREE.Object3D>
}
let viewport: Viewport
const seek = (value: number) => fireEvent.change(screen.getByRole('slider', { name: 'Simulation position' }), { target: { value: String(value) } })
function lines(role: string) {
  const result: THREE.LineSegments[] = []
  viewport.simulationToolpathRoleLines.get(role)?.traverse(object => {
    if (object instanceof THREE.LineSegments) result.push(object)
  })
  return result
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  viewport = Object.assign(Object.create(CNCViewport.prototype), {
    toolpathGroup: new THREE.Group(), toolpathRoleLines: new Map(),
    setToolMarkerPosition: vi.fn(), showToolMarker: vi.fn(),
    updateToolGeometry: vi.fn(), disposeStockSim: vi.fn(), disposeVoxelSim: vi.fn(),
    setStockSimOpacity: vi.fn(), supportsVoxelSim: vi.fn(() => false), initStockSim: vi.fn(() => null),
  }) as Viewport
  Object.defineProperty(window, '__cncViewport', { configurable: true, value: viewport })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, '__cncViewport')
})

describe('WO-3153 real Full Suite data through SimulationPanel and CNCViewport', () => {
  it.each(['stored', 'regenerated'] as const)('%s: preserves actual rapid classification, feed roles, filters and operation boundaries', dataset => {
    // 'stored' is the pre-refresh Full Suite cache the owner saw (the selected artifact; the shipped demo is regenerated).
    const project = JSON.parse(readFileSync('src/tests/evidence/WO-2935/attempt6/modeled.camproject', 'utf8')) as Project
    const setup = project.setups[0]
    if (dataset === 'regenerated') {
      // Captured by inspect.mjs from the live application's computeOperationToolpath.
      setup.operations[0].toolpathMoves = JSON.parse(gunzipSync(readFileSync('src/tests/evidence/WO-3153/regenerated-adaptive-moves.json.gz')).toString()) as ToolpathMove[]
    }
    project.activeSetupId = setup.id
    project.activeOperationId = null
    const originalMoves = JSON.stringify(setup.operations.map(operation => operation.toolpathMoves))
    const preview = vi.spyOn(viewport, 'setSimulationToolpathPreview')
    const windowPreview = vi.spyOn(viewport, 'setSimulationToolpathWindow')
    act(() => useCamStore.setState(state => ({
      project,
      viewer: { ...state.viewer, mode: 'simulation', stockSimEnabled: false },
      appSettings: { ...state.appSettings, simulationEngine: 'heightmap' },
    })))
    render(<SimulationPanel />)
    expect(lines('rapid').some(line => line.material instanceof THREE.LineDashedMaterial)).toBe(true)
    seek(28000)
    const layer = preview.mock.calls.at(-1)![0]!
    expect(layer.some(move => move.type === 'rapid')).toBe(true)
    expect(layer.some(move => move.role === 'cut')).toBe(true)
    expect(layer.filter(move => move.type === 'rapid').every(move => move.role === 'rapid')).toBe(true)
    expect(lines('cut').every(line => !(line.material instanceof THREE.LineDashedMaterial))).toBe(true)
    expect(lines('fast_traverse').length).toBeGreaterThan(0)
    expect(lines('fast_traverse').every(line => !(line.material instanceof THREE.LineDashedMaterial))).toBe(true)

    viewport.setHiddenToolpathRoles(new Set(['rapid']))
    expect(viewport.simulationToolpathRoleLines.get('rapid')?.visible).toBe(false)
    fireEvent.change(screen.getByRole('combobox', { name: 'Path display' }), { target: { value: 'trail' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Trail (recent seconds)' }), { target: { value: '60' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Lead (upcoming seconds)' }), { target: { value: '60' } })
    seek(1)
    const segments = windowPreview.mock.calls.at(-1)![0]!
    expect(segments.some(segment => segment.phase === 'recent')).toBe(true)
    expect(segments.some(segment => segment.phase === 'upcoming' && segment.frame.sourceMove?.type === 'rapid')).toBe(true)
    for (const segment of segments) {
      if (segment.frame.sourceMove?.type === 'rapid') expect(segment.frame.role).toBe('rapid')
    }
    expect(viewport.simulationToolpathRoleLines.get('rapid')?.visible).toBe(false)
    viewport.setHiddenToolpathRoles(new Set())
    expect(viewport.simulationToolpathRoleLines.get('rapid')?.visible).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Skip to end' }))
    const endSegments = windowPreview.mock.calls.at(-1)![0]!
    expect(endSegments.some(segment => segment.frame.sourceOperationId === setup.operations.at(-1)!.id)).toBe(true)
    expect(endSegments.some(segment => segment.phase === 'upcoming')).toBe(false)
    fireEvent.change(screen.getByRole('combobox', { name: 'Path display' }), { target: { value: 'layer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to start' }))
    expect(lines('rapid').some(line => line.material instanceof THREE.LineDashedMaterial)).toBe(true)
    expect(JSON.stringify(useCamStore.getState().project.setups[0].operations.map(operation => operation.toolpathMoves))).toBe(originalMoves)
  })
})
