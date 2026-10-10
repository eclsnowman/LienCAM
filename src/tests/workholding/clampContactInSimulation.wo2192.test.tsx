// @vitest-environment jsdom
//
// WO-2192 (workholding assemblies, slice 5): simulation checks contact with a
// clamp placed on a part edge - where the edge puts it, following the part -
// and only in the setup it is placed in, through the slice 3 path.
//
// Production route: the clamp is made and placed by the store's own actions
// (makeClamp, placeClamp), the part is moved by the store's own transform
// action, and contact is read from the console lines the mounted
// SimulationPanel posts on entering Simulate (WO-1578).
//
// SCENE (worked out by hand): a part block 40 x 20 x 10 at the origin - its
// outline X -20..20, Y -10..10, 120 mm round from (-20,-10), top Z 10. A clamp
// body 8 x 40 x 20 (8 along the edge, 40 across). Placed at 50/120 (the right
// side at Y 0, the edge running +Y) it straddles the edge: X 0..40, Y -4..4,
// Z 10..30. The program plunges a 6 mm end mill at X 10 and at X 60. Moving
// the part 30 mm in +X carries the clamp to X 30..70.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import type { ImportedGeometry, Setup, ToolpathMove, Vec3 } from '../../types'
import { SimulationPanel } from '../../components/simulation/SimulationPanel'
import { useCamStore } from '../../store'
import { makeOp, makeTool, makeWcs } from '../post/helpers'

function block(id: string, name: string, size: Vec3, workholding: boolean): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -size.x / 2, y: -size.y / 2, z: 0 }, max: { x: size.x / 2, y: size.y / 2, z: size.z },
      size: { ...size }, center: { x: 0, y: 0, z: size.z / 2 },
    },
    position: { x: workholding ? -200 : 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...(workholding ? { workholding: true } : {}),
  } as ImportedGeometry
}

const MOVES = [
  { type: 'rapid', x: 10, y: 0, z: 40 },
  { type: 'feed', x: 10, y: 0, z: 5, feed: 500 },
  { type: 'rapid', x: 10, y: 0, z: 40 },
  { type: 'rapid', x: 60, y: 0, z: 40 },
  { type: 'feed', x: 60, y: 0, z: 5, feed: 500 },
  { type: 'rapid', x: 60, y: 0, z: 40 },
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

let clampId: string

function seed(): void {
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        machine: { ...s.project.machine, rapidRate: 5000 },
        geometry: [block('clamp-body', 'Strap clamp', { x: 8, y: 40, z: 20 }, true), block('part-1', 'Block', { x: 40, y: 20, z: 10 }, false)],
        setups: [setup('setup-a'), setup('setup-b')],
        activeSetupId: 'setup-a',
        activeOperationId: 'op-setup-a',
      },
      toolLibrary: [makeTool({ id: 't-1', diameter: 6, shankDiameter: 6, fluteLength: 20, overallLength: 60 })],
      viewer: { ...s.viewer, mode: 'toolpath' },
    }))
  })
  let placed: string | null = null
  act(() => {
    const definitionId = useCamStore.getState().makeClamp('clamp-body')!
    placed = useCamStore.getState().placeClamp({
      definitionId, target: { kind: 'part', id: 'part-1', loopId: 'outline' }, fraction: 50 / 120, setupId: 'setup-a',
    })
  })
  expect(placed).not.toBeNull()
  clampId = placed!
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

describe('WO-2192: simulation checks contact with a clamp where its edge puts it', () => {
  it('the plunge at X 10 hits the clamp on the part edge; the part moved +30, the clamp follows and X 60 does instead', () => {
    seed()
    render(createElement(SimulationPanel))
    expect(simulateContacts()).toEqual(['10.00'])

    act(() => { useCamStore.getState().updateGeometryTransform('part-1', { x: 30, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }) })
    const pose = useCamStore.getState().project.workholding!.instances.find((i) => i.id === clampId)!.worldPose
    expect(pose.position).toEqual({ x: 50, y: 0, z: 10 })
    regenerate('setup-a')
    expect(simulateContacts()).toEqual(['60.00'])
  })

  it('a setup the clamp is not placed in sees no clamp', () => {
    seed()
    render(createElement(SimulationPanel))
    act(() => { useCamStore.setState((s) => ({ project: { ...s.project, activeSetupId: 'setup-b', activeOperationId: 'op-setup-b' } })) })
    expect(simulateContacts()).toEqual([])
  })
})
