// @vitest-environment jsdom
//
// WO-2861 (sweep G1, G9): the operator 10-15, after his first two clicks failed - "we
// absolutely positively cannot ship with this bug in place". Open -> Examples ->
// Full Suite opened with all nine operations "pending" and no toolpaths, because
// the shipped file carried no results at all (every operation saved 'pending',
// no toolpathMoves). Every other example opened ready. And three examples opened
// as "UNTITLED PROJECT" although the picker card named them.
//
// Each shipped example goes through what the picker does (prepareExampleProject,
// then the store's production loadProjectFromFile) and must open with every
// operation ready and drawn, under the name its card shows. The next engine
// change that stales a shipped file fails here instead of in front of the operator.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => mem.get(k) ?? null,
    key: (i: number) => [...mem.keys()][i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  },
  configurable: true,
})

const { useCamStore } = await import('../../store')
const { DEMO_EXAMPLES, prepareExampleProject } = await import('../../components/modals/DemoExamplePickerModal')

const root = resolve(import.meta.dirname, '../../..')
type Opened = { name: string; operations: { name: string; status: string; moves: number }[] }
const opened = new Map<string, Opened>()

beforeAll(async () => {
  for (const example of DEMO_EXAMPLES) {
    const text = readFileSync(join(root, example.path), 'utf8')
    const store = useCamStore.getState()
    await store.loadProjectFromFile(prepareExampleProject(text, example.label), store.beginProjectOpen())
    const { project } = useCamStore.getState()
    opened.set(example.label, {
      name: project.name,
      operations: project.setups.flatMap((setup) => setup.operations.map((op) => ({
        name: `${setup.name} / ${op.name}`, status: op.status, moves: op.toolpathMoves?.length ?? 0,
      }))),
    })
  }
}, 600_000)

describe('WO-2861: every shipped example opens ready, under its own name', () => {
  it('opens all of them', () => {
    expect([...opened.keys()]).toEqual(DEMO_EXAMPLES.map((example) => example.label))
  })

  it.each(DEMO_EXAMPLES.map((example) => example.label))('%s opens with every operation ready and drawn', (label) => {
    const { operations } = opened.get(label)!
    expect(operations.filter((op) => op.status !== 'ready' || op.moves === 0)).toEqual([])
  })

  it('Full Suite opens with all nineteen toolpaths, not "pending"', () => {
    const { operations } = opened.get('Full Suite')!
    // WO-2935: The operator chose the modeled-bevel Full Suite (19 operations) on 10-18.
    expect(operations).toHaveLength(19)
    expect(operations.every((op) => op.status === 'ready' && op.moves > 0)).toBe(true)
  })

  it.each(['Sketches', 'Grip Handle', 'Lobed Knob'])('%s opens titled as the picker names it', (label) => {
    expect(opened.get(label)!.name).toBe(label)
  })

  it('an example with its own saved name keeps it', () => {
    expect(opened.get('Full Suite')!.name).toBe('Full Suite')
    expect(prepareExampleProject(JSON.stringify({ name: '01 Fixture plate - M6 x 1' }), 'Fixture Plate'))
      .toContain('"name":"01 Fixture plate - M6 x 1"')
  })

  // Sweep G13 needs newProject in src/store/index.ts to clear consoleEvents;
  // that file is not granted to this order (WO-2853/2864 hold it).
  it.todo('New clears the previous project\'s status line')
})
