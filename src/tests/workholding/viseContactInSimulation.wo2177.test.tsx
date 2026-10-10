// @vitest-environment jsdom
//
// WO-2177 (workholding assemblies, slice 3): simulation checks contact with a
// vise's jaw where the vise is drawn - at its CURRENT opening - and only in the
// setups the vise is placed in.
//
// Production route: the vise is made and opened by the store's own actions
// (makeVise, setWorkholdingJointValue), and contact is read from the console
// lines the mounted SimulationPanel posts on entering Simulate (WO-1578).
//
// SCENE (plain boxes, expected places worked out by hand): a fixed body
// 8 x 40 x 20 standing at X -40 and a jaw of the same size standing at X 18,
// both marked workholding. The vise is made from them where they sit, opening
// along +X, travel 0..100, made at opening 20. So at opening 20 the jaw covers
// X 14..22; at opening 50 it has slid 30 mm to X 44..52. The program plunges a
// 6 mm end mill at X 18 (inside the jaw at 20) and at X 48 (inside it at 50).
// On main, simulation boxed the jaw row where it was imported, at X 14..22,
// whatever the opening said.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import type { ImportedGeometry, Setup, ToolpathMove } from '../../types'
import { SimulationPanel } from '../../components/simulation/SimulationPanel'
import { useCamStore } from '../../store'
import { makeOp, makeTool, makeWcs } from '../post/helpers'

function body(id: string, name: string, x: number): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -4, y: -20, z: 0 }, max: { x: 4, y: 20, z: 20 },
      size: { x: 8, y: 40, z: 20 }, center: { x: 0, y: 0, z: 10 },
    },
    position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, workholding: true,
  } as ImportedGeometry
}

const MOVES = [
  { type: 'rapid', x: 18, y: 0, z: 30 },
  { type: 'feed', x: 18, y: 0, z: 5, feed: 500 },
  { type: 'rapid', x: 18, y: 0, z: 30 },
  { type: 'rapid', x: 48, y: 0, z: 30 },
  { type: 'feed', x: 48, y: 0, z: 5, feed: 500 },
  { type: 'rapid', x: 48, y: 0, z: 30 },
] as ToolpathMove[]

function setup(id: string): Setup {
  return {
    id, name: id, wcs: makeWcs(),
    stock: {
      type: 'rectangular', width: 200, height: 80, depth: 20,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations: [makeOp({ id: `op-${id}`, toolId: 't-1', status: 'ready', toolpathMoves: MOVES })],
    notes: '',
  } as unknown as Setup
}

let viseId: string

function seed(): void {
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        machine: { ...s.project.machine, rapidRate: 5000 },
        geometry: [body('vise-fixed', 'Fixed body', -40), body('vise-jaw', 'Jaw', 18)],
        setups: [setup('setup-a'), setup('setup-b')],
        activeSetupId: 'setup-a',
        activeOperationId: 'op-setup-a',
      },
      toolLibrary: [makeTool({ id: 't-1', diameter: 6, shankDiameter: 6, fluteLength: 20, overallLength: 60 })],
      viewer: { ...s.viewer, mode: 'toolpath' },
    }))
  })
  let made: string | null = null
  act(() => {
    made = useCamStore.getState().makeVise({
      name: 'Test vise', fixedGeometryId: 'vise-fixed', jawGeometryId: 'vise-jaw',
      slide: { kind: 'jaw-axis', axis: 'x' }, minMm: 0, maxMm: 100, openingNowMm: 20, setupId: 'setup-a',
    })
  })
  expect(made).not.toBeNull()
  viseId = made!
  // Making a vise changes what every setup must keep clear of: regenerate both.
  regenerate('setup-a')
  regenerate('setup-b')
}

/** Simulate the active setup's program as a fresh run: returns the X of every contact line. */
function simulateContacts(): string[] {
  act(() => { useCamStore.setState((s) => ({ consoleEvents: [], viewer: { ...s.viewer, mode: 'toolpath' } })) })
  act(() => { useCamStore.setState((s) => ({ viewer: { ...s.viewer, mode: 'simulation' } })) })
  return useCamStore.getState().consoleEvents
    .filter((e) => e.source === 'simulation' && e.message.includes('contacts workholding'))
    .map((e) => /at X (-?[\d.]+)/.exec(e.message)?.[1] ?? e.message)
}

/** Regenerating after the opening changed: the same program, ready again. */
function regenerate(setupId: string): void {
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        setups: s.project.setups.map((st) => (st.id === setupId
          ? { ...st, operations: st.operations.map((op) => ({ ...op, status: 'ready' as const, toolpathMoves: MOVES })) }
          : st)),
      },
    }))
  })
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
})

afterEach(() => {
  cleanup()
})

describe('WO-2177: simulation checks contact with the jaw where the vise is drawn', () => {
  it('at opening 20 the plunge at X 18 hits the jaw; opened to 50, the plunge at X 48 does and X 18 no longer does', () => {
    seed()
    render(createElement(SimulationPanel))

    expect(simulateContacts()).toEqual(['18.00'])

    let used: number | null = null
    act(() => { used = useCamStore.getState().setWorkholdingJointValue(viseId, 'moving', 50) })
    expect(used).toBe(50)
    regenerate('setup-a')
    expect(simulateContacts()).toEqual(['48.00'])
  })

  it('a setup the vise is not placed in sees no jaw at either place', () => {
    seed()
    render(createElement(SimulationPanel))
    act(() => { useCamStore.setState((s) => ({ project: { ...s.project, activeSetupId: 'setup-b', activeOperationId: 'op-setup-b' } })) })
    expect(simulateContacts()).toEqual([])
  })

  it('a marked body that is not in a vise is still checked where it stands, as before', () => {
    seed()
    act(() => { useCamStore.getState().removeWorkholding(viseId) })
    regenerate('setup-b')
    render(createElement(SimulationPanel))
    // Both rows are plain marked workholding again: the jaw row stands at X 14..22.
    act(() => { useCamStore.setState((s) => ({ project: { ...s.project, activeSetupId: 'setup-b', activeOperationId: 'op-setup-b' } })) })
    expect(simulateContacts()).toEqual(['18.00'])
  })
})
