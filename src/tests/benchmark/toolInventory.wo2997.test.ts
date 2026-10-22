import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Project, Tool } from '../../types'
import { buildToolProfile } from '../../lib/tool/toolProfile'
import { alpha3Chains, alpha3Tools, inventoryTools } from './alpha3Registry'
import { TOOLS, toolById } from './registry'

// The same four sources alpha3Tools read before WO-2997, read here directly.
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const examples = ['01-fixture-plate', '02-toe-clamps', '03-soft-jaws', '04-tool-storage-bar', '05-name-sign', '06-knob-handwheel', '07-relief-medallion', '08-gear-pair']
  .flatMap(dir => (read(`examples/${dir}/${dir.slice(3)}.camproject`) as Project).toolLibrary)
const direct: Tool[] = [
  ...read('examples/tools/starter-tools-metric.json'), ...read('docs/machine/profiles/tool_library.json'),
  ...read('examples/13-thread-mill-test/Thread Mill Tools - Metric Test Set.json'), ...examples,
]

describe('WO-2997 benchmark tools come from the kernel tool inventory', () => {
  it('returns every source record unchanged, in source order, including repeated ids', () => {
    const through = inventoryTools(direct)
    expect(through).toHaveLength(direct.length)
    through.forEach((tool, i) => expect(tool).toStrictEqual(direct[i]))
    expect(through[0]).not.toBe(direct[0])
  })

  it('alpha3Tools ids, recipes and profiles equal the direct records for every tool', () => {
    const expected = new Map(direct.map(tool => [tool.id, tool]))
    const library = alpha3Tools().filter(spec => !spec.id.startsWith('a3-'))
    expect(library.map(spec => spec.id)).toEqual([...expected.keys()])
    for (const spec of library) {
      const tool = expected.get(spec.id)!
      expect(spec.libraryTool, spec.id).toStrictEqual(tool)
      expect(spec.libraryTool!.feedsAndSpeeds, spec.id).toStrictEqual(tool.feedsAndSpeeds)
      expect(buildToolProfile(spec.libraryTool!), spec.id).toStrictEqual(buildToolProfile(tool))
    }
  })

  it('every tool every chain step names resolves to the same record as before', () => {
    const ids = new Set(alpha3Chains().flatMap(chain => chain.steps.map(step => step.toolId)))
    expect(ids.size).toBeGreaterThan(10)
    for (const id of ids) {
      const spec = toolById(id)
      if (!spec.libraryTool) { expect(TOOLS.some(tool => tool.id === id), id).toBe(true); continue }
      expect(inventoryTools([spec.libraryTool])[0], id).toStrictEqual(spec.libraryTool)
      const source = id.startsWith('a3-') ? direct.find(tool => tool.type === spec.type && tool.diameter === spec.diameter) : direct.find(tool => tool.id === id)
      expect({ ...spec.libraryTool, id: source!.id }, id).toStrictEqual(source)
    }
  })

  it('refuses a record the inventory would leave out instead of dropping the tool', () => {
    expect(() => inventoryTools([{ ...direct[0], owned: false } as Tool])).toThrow(/did not return benchmark tool/)
  })
})
