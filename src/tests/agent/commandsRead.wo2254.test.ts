// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  AGENT_COMMAND_ALLOW_LIST,
  feature_details,
  liencamCommands,
  machine_limits,
  project_summary,
  tool_library,
} from '../../lib/agent/commands'
import { registerSketchDevSeed } from '../../lib/sketch/demoSeed'
import { useCamStore } from '../../store'

const FIXTURE = join(process.cwd(), 'Example Projects/Adaptive Clearing Shapes.camproject')
const COMMAND_SOURCE = join(process.cwd(), 'src/lib/agent/commands.ts')

beforeAll(async () => {
  // This is the product's real File > Open boundary, including migrations,
  // tool-library merging, lifecycle reconciliation, and the opened-project
  // console event. The commands are therefore checked against app state, not a
  // hand-built store payload.
  await useCamStore.getState().loadProjectFromFile(readFileSync(FIXTURE, 'utf8'))
})

describe('WO-2254 read command allow-list', () => {
  it('exports only the four declared read commands and has no prohibited import or mutation seam', () => {
    expect(AGENT_COMMAND_ALLOW_LIST).toEqual([
      'project_summary',
      'feature_details',
      'tool_library',
      'machine_limits',
    ])
    expect(Object.keys(liencamCommands)).toEqual(AGENT_COMMAND_ALLOW_LIST)
    expect(Object.isFrozen(AGENT_COMMAND_ALLOW_LIST)).toBe(true)
    expect(Object.isFrozen(liencamCommands)).toBe(true)

    const source = readFileSync(COMMAND_SOURCE, 'utf8')
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
    expect(imports.some((path) => path.includes('/machine/') || path.includes('store/machine'))).toBe(false)
    expect(imports.some((path) => path.includes('probeRoutineStore') || path.includes('gcode/appCommand'))).toBe(false)
    expect(source).not.toContain('.setState')
    expect(source).not.toMatch(/\bdag\b/i)
  })
})

describe('WO-2254 read commands on an opened real project', () => {
  it('project_summary reports the Design Tree state, live tools, statuses, and app console words', () => {
    const state = useCamStore.getState()
    const summary = project_summary()

    expect(summary.project.name).toBe('GOOD Corpus overnight 2026-08-23')
    expect(summary.tree.features).toHaveLength(state.project.geometry.length)
    expect(summary.tree.features[0]).toMatchObject({
      id: state.project.geometry[0].id,
      name: state.project.geometry[0].name,
      format: state.project.geometry[0].format,
      loaded: true,
    })
    expect(summary.tree.features[0].layers[0]).toMatchObject({
      id: state.project.geometry[0].layers2d?.[0].id,
      name: state.project.geometry[0].layers2d?.[0].name,
      visible: state.project.geometry[0].layers2d?.[0].visible,
    })
    expect(summary.tree.features[0].sketches).toEqual([])
    expect(summary.tree.setups[0].operations).toHaveLength(state.project.setups[0].operations.length)
    expect(summary.tree.setups[0].operations[0]).toMatchObject({
      id: state.project.setups[0].operations[0].id,
      status: state.project.setups[0].operations[0].status,
      enabled: state.project.setups[0].operations[0].enabled,
    })
    expect(summary.toolsInUse.map((tool) => tool.name)).toContain('4mm Flat End Mill')
    expect(summary.consoleEvents.at(-1)?.message).toBe(`Project opened: ${state.project.name}`)
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary)

    summary.project.name = 'detached result'
    expect(useCamStore.getState().project.name).toBe('GOOD Corpus overnight 2026-08-23')
  })

  it('feature_details returns one operation payload with the same status and diagnostics fields as the app', () => {
    const state = useCamStore.getState()
    const setup = state.project.setups[0]
    const operation = setup.operations[0]
    const details = feature_details({ id: operation.id })

    expect(details).toMatchObject({
      kind: 'operation',
      id: operation.id,
      name: operation.name,
      payload: {
        setupId: setup.id,
        status: operation.status,
        generationCurrent: false,
      },
    })
    expect(details?.payload).not.toHaveProperty('errorMessage')
    expect(details?.payload).not.toHaveProperty('diagnostics')
    expect(details?.payload).not.toHaveProperty('estimatedCutTimeMs')
    expect(details && JSON.parse(JSON.stringify(details))).toEqual(details)

    expect(feature_details({ id: state.project.geometry[0].id })).toMatchObject({
      kind: 'geometry',
      id: state.project.geometry[0].id,
      name: state.project.geometry[0].name,
    })
    expect(feature_details({ id: 'not-a-project-node' })).toBeNull()
  })

  it('tool_library returns detached copies of the same live tools, libraries, and holders as the modal', () => {
    const state = useCamStore.getState()
    const result = tool_library()

    expect(result).toEqual({
      libraries: state.toolLibraries,
      tools: state.toolLibrary,
      holders: state.holders,
    })
    expect(result.tools.map((tool) => tool.name)).toContain('4mm Flat End Mill')
    const originalName = state.toolLibrary[0].name
    result.tools[0].name = 'detached tool'
    expect(useCamStore.getState().toolLibrary[0].name).toBe(originalName)
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it('machine_limits returns a detached, deeply frozen copy of project.machine', () => {
    const source = useCamStore.getState().project.machine
    const result = machine_limits()

    expect(result).toEqual(source)
    expect(result).not.toBe(source)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.travel)).toBe(true)
    expect(() => {
      ;(result as { travel: { x: number } }).travel.x = -1
    }).toThrow(TypeError)
    expect(useCamStore.getState().project.machine.travel.x).toBe(738)
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})

describe('WO-2254 development hook', () => {
  it('installs __liencam beside every existing hook without changing unrelated hooks', () => {
    const hooks = window as unknown as Record<string, unknown>
    const debugHook = { existing: true }
    hooks.__camDebug = debugHook

    registerSketchDevSeed()

    expect(hooks.__liencam).toBe(liencamCommands)
    expect(hooks.__camStore).toBe(useCamStore)
    expect(hooks.__seedDemoSketch).toBeTypeOf('function')
    expect(hooks.__seedConflict).toBeTypeOf('function')
    expect(hooks.__camUiPrefs).toBeDefined()
    expect(hooks.__camDebug).toBe(debugHook)
  })
})
