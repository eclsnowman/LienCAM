// WO-2999: WO-2983 made a shared work offset legal for separate files. The
// store action and Help must say the same thing the post does.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

// jsdom's localStorage is broken under vitest's node launch flags (same shim as the WO-2950 tests).
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

const { useCamStore } = await import('../../store')
const { topics } = await import('../../help/topics/setups-stock-wcs')
const { default: enMessages } = await import('../../i18n/locales/en/console-and-operator-messages')
const { default: deHelp } = await import('../../i18n/locales/de/help')
const { default: esHelp } = await import('../../i18n/locales/es/help')
const { default: frHelp } = await import('../../i18n/locales/fr/help')

import type { BoundingBox, PhysicalStock, Vec3 } from '../../types'

const state = () => useCamStore.getState()

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const stock = (id: string, x: number, fixtureOffset: PhysicalStock['fixtureOffset']): PhysicalStock => ({
  id, name: `Stock ${id}`, mode: 'explicit', fixtureOffset,
  bounds: bbox({ x, y: 0, z: 0 }, { x: x + 100, y: 60, z: 18 }), position: { x: 0, y: 0, z: 0 },
})

beforeEach(() => {
  mem.clear()
  useCamStore.setState((s) => ({
    project: { ...s.project, setups: [], stocks: [stock('a', 0, 54), stock('b', 200, 55)] },
  }))
})

const offsetOf = (id: string) => state().project.stocks?.find((s) => s.id === id)?.fixtureOffset

describe('setStockFixtureOffset with a shared work offset', () => {
  it('gives a second stock the offset another stock holds', () => {
    state().setStockFixtureOffset('b', 54)
    expect(offsetOf('a')).toBe(54)
    expect(offsetOf('b')).toBe(54)
  })

  it('still refuses an invalid slot and a missing stock', () => {
    expect(() => state().setStockFixtureOffset('b', 60 as never)).toThrow()
    expect(() => state().setStockFixtureOffset('nope', 54)).toThrow()
    expect(offsetOf('b')).toBe(55)
  })
})

describe('Help describes the separate-files rule', () => {
  const help = topics.find((t) => t.id === 'work-offsets')!
  const text = (JSON.stringify(help.sections))

  it('English names the Combined refusal and no longer says a shared offset stops the post', () => {
    expect(text).toContain('Combined')
    expect(text).not.toContain('no offset is shared by two different stocks')
  })

  it.each([['de', deHelp], ['es', esHelp], ['fr', frHelp]] as const)('%s names Separate files and Combined', (_l, tree) => {
    const section = JSON.stringify((tree.topics as Record<string, unknown>)['work-offsets'])
    expect(section).toContain('Separate files')
    expect(section).toContain('Combined')
  })

  it('the unreachable "already used" refusal text is gone', () => {
    expect(enMessages).not.toHaveProperty('index440')
    expect(enMessages).not.toHaveProperty('index438')
    expect(enMessages).not.toHaveProperty('index439')
  })
})
