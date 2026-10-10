// WO-2425: "Export setups" writes stock and setups as documented JSON.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import { useCamStore, exportSetupsText } from '../../store'
import type { PhysicalStock, Setup } from '../../types'

const schema = JSON.parse(readFileSync('docs/formats/setups.schema.json', 'utf-8'))

const v = (x: number, y: number, z: number) => ({ x, y, z })

function setup(id: string, name: string, label: string, fixtureOffset: number, origin: ReturnType<typeof v>): Setup {
  return {
    id, name, notes: `${name} notes`, operations: [],
    stock: {
      type: 'rectangular', width: 100, height: 60, depth: 20,
      offsetX: 1, offsetY: 2, offsetZTop: 3, offsetZBottom: 0, material: '6061 aluminum',
    },
    wcs: {
      id: `wcs-${id}`, label, fixtureOffset, origin,
      xAxis: v(1, 0, 0), yAxis: v(0, 1, 0), zAxis: v(0, 0, 1), stockId: 'stock-1',
    },
  }
}

describe('setups export (WO-2425)', () => {
  it('validates against the published schema and equals the store values', () => {
    const stock: PhysicalStock = {
      id: 'stock-1', name: 'Plate', mode: 'explicit', fixtureOffset: 54,
      bounds: { min: v(0, 0, 0), max: v(100, 60, 20), size: v(100, 60, 20), center: v(50, 30, 10) },
      position: v(0, 0, 0),
    }
    const s1 = setup('s1', 'Top side', 'G54', 54, v(0, 0, 20))
    const s2 = { ...setup('s2', 'Bottom side', 'G55', 55, v(100, 0, 0)), flipOf: { setupId: 's1', axis: 'x' as const } }
    const base = useCamStore.getState().project
    useCamStore.getState().setProject({ ...base, stocks: [stock], setups: [s1, s2] })

    // the same call the "Export setups" button makes
    const parsed = JSON.parse(exportSetupsText(useCamStore.getState().project))

    const validate = new Ajv({ allErrors: true }).compile(schema)
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true)

    const project = useCamStore.getState().project
    expect(parsed.stocks).toEqual(JSON.parse(JSON.stringify(project.stocks)))
    expect(parsed.setups).toHaveLength(2)
    for (const [i, out] of (parsed.setups as Array<Record<string, unknown>>).entries()) {
      const src = project.setups[i]
      expect(out.id).toBe(src.id)
      expect(out.name).toBe(src.name)
      expect(out.stock).toEqual(src.stock)
      expect(out.wcs).toEqual(JSON.parse(JSON.stringify(src.wcs)))
    }
    expect(parsed.setups[0].stock.material).toBe('6061 aluminum')
    expect(parsed.setups[1].wcs.label).toBe('G55')
    expect(parsed.setups[1].wcs.origin).toEqual(v(100, 0, 0))
    expect(parsed.setups[1].flipOf).toEqual({ setupId: 's1', axis: 'x' })
  })
})
