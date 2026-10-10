// @vitest-environment jsdom
//
// WO-2190 (workholding assemblies, slice 4): Close on part through the RENDERED
// vise screen - make a vise in the Properties panel, pick a part, enter a
// clearance, click Close on part - and the opening it writes: the part's width
// across the jaw plus the clearance, within the travel, one undo step, one
// console line. The lib's mesh projection is checked with an exact shape too.
//
// Same in-memory Storage shim as viseScreens.wo2172.test.tsx (the store
// persists on every set()).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent, within, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Vec3 } from '../../types'

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

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { workholdingOfGeometry } = await import('../../lib/workholding/vise')

afterEach(cleanup)

const ZERO = { x: 0, y: 0, z: 0 }

function box(id: string, name: string, size: Vec3, position: Vec3, workholding: boolean): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -size.x / 2, y: -size.y / 2, z: 0 }, max: { x: size.x / 2, y: size.y / 2, z: size.z },
      size, center: { x: 0, y: 0, z: size.z / 2 },
    },
    position, rotation: ZERO, loaded: true, workholding,
  } as ImportedGeometry
}

function state() { return useCamStore.getState() }
function opening() { return state().project.workholding?.instances[0]?.jointValuesMm.moving }
function lastConsole() { return state().consoleEvents[state().consoleEvents.length - 1] }

function typeInto(input: HTMLElement, text: string) {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input)
}

beforeEach(() => {
  act(() => {
    state().newProject()
    state().setDisplayUnits('mm')
    // Fixed body 100 x 20 at the origin, jaw beside it along +Y: the vise opens along +Y.
    state().addGeometry(box('geo-fixed', 'Fixed body', { x: 100, y: 20, z: 40 }, ZERO, true))
    state().addGeometry(box('geo-jaw', 'Moving jaw', { x: 100, y: 20, z: 40 }, { x: 0, y: 50, z: 0 }, true))
    // The part: 40 x 40 x 20, square on the table between the jaws.
    state().addGeometry(box('geo-part', 'Part', { x: 40, y: 40, z: 20 }, { x: 0, y: 30, z: 0 }, false))
    state().addGeometry(box('geo-wide', 'Wide part', { x: 40, y: 70, z: 20 }, { x: 0, y: 45, z: 0 }, false))
    state().setSelectedGeometry('geo-fixed')
  })
  delete (window as unknown as { __cncViewport?: unknown }).__cncViewport
})

/** Make vise (travel 0-60, opening 10) through the Properties panel; returns the vise section. */
function makeVise(): HTMLElement {
  render(createElement(PropertiesPanel))
  fireEvent.click(screen.getByTestId('geo-make-vise-btn'))
  const form = screen.getByTestId('make-vise-form')
  expect((within(form).getByTestId('make-vise-axis') as HTMLSelectElement).value).toBe('y')
  typeInto(within(form).getByTestId('make-vise-name'), 'Bench vise')
  typeInto(within(form).getByTestId('make-vise-min'), '0')
  typeInto(within(form).getByTestId('make-vise-max'), '60')
  typeInto(within(form).getByTestId('make-vise-opening'), '10')
  fireEvent.click(within(form).getByTestId('make-vise-create'))
  expect(opening()).toBe(10)
  return screen.getByTestId('vise-props')
}

async function closeOn(props: HTMLElement, partId: string, clearance: string, before: number) {
  fireEvent.change(within(props).getByTestId('vise-close-part'), { target: { value: partId } })
  typeInto(within(props).getByTestId('vise-close-clearance'), clearance)
  fireEvent.click(within(props).getByTestId('vise-close-on-part'))
  await waitFor(() => expect(opening()).not.toBe(before))
}

describe('WO-2190: Close on part sets the vise opening from the part, in one step', () => {
  it('a 40 mm square part + 0.5 clearance -> opening 40.5; one undo step restores 10; the field shows it', async () => {
    const props = makeVise()
    // Only bodies that are not workholding are offered.
    const options = Array.from((within(props).getByTestId('vise-close-part') as HTMLSelectElement).options).map((o) => o.value)
    expect(options).toEqual(['geo-part', 'geo-wide'])
    const depth = state().projectHistory.length
    const eventsBefore = state().consoleEvents.length

    await closeOn(props, 'geo-part', '0.5', 10)
    expect(opening()).toBeCloseTo(40.5, 9)
    expect(state().projectHistory.length).toBe(depth + 1) // ONE undo step
    await waitFor(() => expect((screen.getByTestId('vise-opening-input') as HTMLInputElement).value).toBe('40.5'))
    expect(state().consoleEvents.length).toBe(eventsBefore + 1)
    expect(lastConsole().severity).toBe('info')
    expect(lastConsole().message).toBe(
      'Close on part: the vise "Bench vise" is set to 40.5 mm - "Part" is 40 mm across the jaw ' +
      '(its shape could not be read, so its bounding box was measured), plus 0.5 mm clearance.',
    )

    act(() => { state().undo() })
    expect(opening()).toBe(10)
    await waitFor(() => expect((screen.getByTestId('vise-opening-input') as HTMLInputElement).value).toBe('10'))
    act(() => { state().redo() })
    expect(opening()).toBeCloseTo(40.5, 9)
  })

  it('the same part turned 30 deg on the table -> opening = its width across the jaw (40 cos30 + 40 sin30)', async () => {
    act(() => { state().updateGeometryTransform('geo-part', { x: 0, y: 30, z: 0 }, { x: 0, y: 0, z: 30 }) })
    const props = makeVise()
    await closeOn(props, 'geo-part', '0', 10)
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6)
    expect(opening()).toBeCloseTo(40 * c + 40 * s, 6) // 54.641
    expect(lastConsole().message).toContain('is set to 54.641 mm')
  })

  it('a part wider than the travel: the jaw is fully open (60) and the line says how far from touching', async () => {
    const props = makeVise()
    await closeOn(props, 'geo-wide', '1', 10)
    expect(opening()).toBe(60)
    expect(lastConsole().message).toBe(
      'Close on part: the vise "Bench vise" is set to 60 mm (fully open) - "Wide part" is 70 mm across the jaw ' +
      '(its shape could not be read, so its bounding box was measured), plus 1 mm clearance; ' +
      'the jaw is 10 mm from touching: the part is that much wider than the vise opens.',
    )
  })

  it('one-shot: moving or turning the part afterwards leaves the opening alone', async () => {
    const props = makeVise()
    await closeOn(props, 'geo-part', '0', 10)
    expect(opening()).toBeCloseTo(40, 9)
    act(() => { state().updateGeometryTransform('geo-part', { x: 5, y: 35, z: 0 }, { x: 0, y: 0, z: 45 }) })
    expect(opening()).toBeCloseTo(40, 9)
  })
})

describe('WO-2190: closeOnPart projects the part mesh onto the jaw axis', () => {
  // A 40 mm octagon-ish disc: its width is ~40 whichever way it is turned, while
  // its bounding box turned 30 deg would read 54.6. Proves the MESH is measured.
  function disc(): { positions: number[]; indices: number[] } {
    const positions: number[] = []
    const n = 72
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n
      positions.push(20 * Math.cos(a), 20 * Math.sin(a), 0, 20 * Math.cos(a), 20 * Math.sin(a), 10)
    }
    const indices: number[] = []
    for (let i = 0; i < n; i++) {
      const a = 2 * i, b = 2 * i + 1, c = (2 * i + 2) % (2 * n), d = (2 * i + 3) % (2 * n)
      indices.push(a, c, b, b, c, d)
    }
    return { positions, indices }
  }
  const reader = { stl: async () => disc(), step: async () => null }

  it('an exact round shape turned 30 deg reads its own width, not its turned bounding box; travel limits hold', async () => {
    const { closeOnPart } = await import('../../lib/workholding/closeOnPart')
    const { buildVise } = await import('../../lib/workholding/vise')
    const project = {
      geometry: [
        box('geo-fixed', 'Fixed body', { x: 100, y: 20, z: 40 }, ZERO, true),
        box('geo-jaw', 'Moving jaw', { x: 100, y: 20, z: 40 }, { x: 0, y: 50, z: 0 }, true),
        { ...box('geo-disc', 'Disc', { x: 40, y: 40, z: 10 }, { x: 0, y: 30, z: 0 }, false), rotation: { x: 0, y: 0, z: 30 } },
      ],
      modelItemPlacements: [],
    }
    const built = buildVise(
      { ...project, workholding: undefined },
      { fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw', slide: { kind: 'jaw-axis', axis: 'y' }, minMm: 45, maxMm: 60, setupId: null },
      { definitionId: 'd', instanceId: 'i' },
    )!
    const membership = { instance: built.instance, moving: built.definition.components[1] }
    const exact = await closeOnPart(project, membership, 'geo-disc', 0, reader)
    // Width ~40 (a 72-gon), below the 45 minimum: the jaw is fully closed, 5 mm from touching.
    expect(exact?.shape).toBe('exact')
    expect(exact?.widthMm).toBeGreaterThan(39.9)
    expect(exact?.widthMm).toBeLessThanOrEqual(40 + 1e-6)
    expect(exact?.openingMm).toBe(45)
    expect(exact?.atTravelEnd).toBe(true)
    expect(exact!.gapMm).toBeCloseTo(45 - exact!.widthMm, 9)
    // Clearance 10: 40 + 10 = 50 is inside 45-60 and is the opening.
    const withClearance = await closeOnPart(project, membership, 'geo-disc', 10, reader)
    expect(withClearance!.openingMm).toBeCloseTo(withClearance!.widthMm + 10, 9)
    expect(withClearance!.atTravelEnd).toBe(false)
  })

  it('a vise turned 90 deg: the width is taken across ITS jaw axis (world X), not world Y', async () => {
    const { closeOnPart } = await import('../../lib/workholding/closeOnPart')
    const part = box('geo-part', 'Part', { x: 30, y: 50, z: 10 }, ZERO, false)
    const project = { geometry: [part], modelItemPlacements: [] }
    const membership = workholdingOfGeometry({
      definitions: [{
        id: 'd', revision: 1, name: 'Turned vise', kind: 'vise', components: [
          { id: 'fixed', name: 'Fixed', geometryId: 'geo-fixed', localPose: { position: ZERO, rotation: ZERO } },
          {
            id: 'moving', name: 'Jaw', geometryId: 'geo-jaw', localPose: { position: ZERO, rotation: ZERO },
            joint: { kind: 'linear', axis: { x: 0, y: 1, z: 0 }, minMm: 0, maxMm: 100, closedAtMm: 0 },
          },
        ],
      }],
      // The instance is turned 90 deg about Z: its +Y slide points along world -X.
      instances: [{
        id: 'i', definitionId: 'd', definitionRevision: 1, setupScope: { kind: 'all' },
        worldPose: { position: ZERO, rotation: { x: 0, y: 0, z: 90 } },
        jointValuesMm: { moving: 0 }, placement: { kind: 'free' },
      }],
    }, 'geo-jaw')!
    const result = await closeOnPart(project, membership, 'geo-part', 0, { stl: async () => null, step: async () => null })
    expect(result!.widthMm).toBeCloseTo(30, 9)
    expect(result!.openingMm).toBeCloseTo(30, 9)
  })
})
