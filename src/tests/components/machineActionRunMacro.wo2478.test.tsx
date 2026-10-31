// @vitest-environment jsdom
// WO-2478: create/edit through the real UI, post through Post Process's entry
// point, and load/run through Control's simulator session. No hardware motion.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MachineAction, Project, Setup } from '../../types'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, String(value)),
  removeItem: (key: string) => memory.delete(key),
  key: (index: number) => [...memory.keys()][index] ?? null,
} })

const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { DesignTree } = await import('../../components/panels/DesignTree')
const { postProject, UCCNC_CONFIG, GENERIC_CONFIG } = await import('../../lib/post')
const { makeMachine, makeTool, makeOp, makeStock, makeWcs, move, stampGenerationCurrent } = await import('../post/helpers')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const session = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { callableMachineMacros, createDefaultControllerDefinition } = await import('../../types')
const { readGcodeProgram } = await import('../../lib/gcode/reader')
const { interpretGcodeProgram } = await import('../../lib/gcode/interpret')
const { fingerprintProgram } = await import('../../lib/machine/zSurfaceMesh')

const state = () => useCamStore.getState()
const actions = () => state().project.setups[0].machineActions ?? []
const tool = makeTool({ feedsAndSpeeds: { default: {
  rpm: 12000, feedRate: 3000, plungeRate: 600, depthOfCut: 1, stepover: 3, coolant: 'none',
} } })

function run(id: string, afterOpId: string | null, macroId = 'first'): MachineAction {
  return { id, kind: 'run_macro', name: `Run ${id}`, enabled: true, afterOpId, macroId }
}

function seed(machineActions: MachineAction[] = []) {
  const machine = makeMachine({
    id: 'wo2478', name: 'Run macro test machine', travel: { x: 1000, y: 1000, z: 400 },
    rapidRate: 60000, safeZMachine: 140,
    homeConvention: { x: { homesToward: 'min', machineZeroAt: 'min' }, y: { homesToward: 'min', machineZeroAt: 'min' }, z: { homesToward: 'max', homePositionMm: 200 } },
    macros: [
      { id: 'first', name: 'Check fixture', mCode: 2101, body: 'say("WO2478 fixture checked")' },
      { id: 'second', name: 'Check finish', mCode: 2102, body: 'say("WO2478 finish checked")' },
      { id: 'no-code', name: 'Panel only', body: 'say("panel")' },
      { id: 'hidden', name: 'Hidden macro', mCode: 2103, body: 'say("hidden")', hidden: true },
      { id: 'duplicate', name: 'Shadowed macro', mCode: 2101, body: 'say("wrong macro")' },
      { id: 'spindle-code', name: 'Spindle code is not a program macro', mCode: 3, body: 'say("wrong spindle macro")' },
    ],
  })
  const setup: Setup = {
    id: 's1', name: 'Setup 1', wcs: makeWcs(), stock: makeStock(), notes: '', machineActions,
    operations: ['a', 'b', 'c'].map((id, index) => makeOp({
      id, name: `Cut ${id}`, toolId: tool.id,
      toolpathMoves: [
        move({ type: 'rapid', x: index * 30, y: 10, z: 5, role: 'rapid' }),
        move({ type: 'feed', x: index * 30 + 10, y: 10, z: 5, feed: 3000 }),
        move({ type: 'rapid', x: index * 30 + 10, y: 10, z: 10, role: 'rapid' }),
      ],
    })),
  }
  act(() => {
    state().setProjectMachine(machine)
    useCamStore.setState((s) => ({ toolLibrary: [tool], project: {
      ...s.project, geometry: [], setups: [setup], activeSetupId: 's1', activeOperationId: null,
    } }))
    useUiPrefs.setState({ treeSetupsExpanded: true, expandedSetupIds: ['s1'], collapsedOperationFolderIds: [] })
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  })
}

function projectForPost(): Project {
  const project = structuredClone({ ...state().project, toolLibrary: state().toolLibrary })
  for (const setup of project.setups) for (const op of setup.operations) stampGenerationCurrent(project, setup, op, project.toolLibrary!.find((candidate) => candidate.id === op.toolId)!)
  return project
}

function posted(mode: 'separate' | 'combined' = 'separate', selectedOpIds?: string[], generic = false) {
  const project = projectForPost()
  const result = postProject(project, project.setups, generic ? GENERIC_CONFIG : UCCNC_CONFIG, {
    mode, pauseBetweenSetups: false, baseName: 'wo2478', ext: 'nc',
    ...(selectedOpIds ? { selectedOpIds: { s1: selectedOpIds } } : {}),
  })
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
  return (result.combined ?? result.files![0].result).gcode.split('\n')
}

function createFromMenu(macroId = 'first') {
  act(() => state().openModal('new-operation'))
  fireEvent.click(screen.getByTestId('op-type-action-run_macro'))
  expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByTestId('run-macro-create-select'), { target: { value: macroId } })
  fireEvent.click(screen.getByTestId('op-create'))
}

beforeEach(() => { memory.clear(); act(() => { state().newProject(); state().closeModal() }) })
afterEach(cleanup)

describe('WO-2478 Run macro operation', () => {
  it('creates by macro name, edits in Properties, renames, toggles and moves in the existing tree', () => {
    seed()
    render(<><DesignTree /><NewOperationModal /><PropertiesPanel /></>)
    createFromMenu()
    expect(actions()).toEqual([expect.objectContaining({ kind: 'run_macro', macroId: 'first', afterOpId: 'c' })])
    expect(screen.getByTestId('machine-action-type').textContent).toBe('Run macro')
    const picker = screen.getByTestId('run-macro-select') as HTMLSelectElement
    expect([...picker.options].map((option) => option.text)).toEqual(['Choose a macro', 'Check fixture (M2101)', 'Check finish (M2102)'])
    fireEvent.change(picker, { target: { value: 'second' } })
    const name = screen.getByTestId('machine-action-name-input')
    fireEvent.change(name, { target: { value: 'Inspect finish' } })
    fireEvent.blur(name)
    expect(screen.getByTestId('tree-name-machine-action').textContent).toBe('Inspect finish')
    const row = screen.getByTestId('tree-machine-action')
    const target = screen.getAllByTestId('tree-name-op')[1].closest('.tree-op')!
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => {}, getData: () => '' }
    fireEvent.dragStart(row, { dataTransfer }); fireEvent.dragOver(target, { dataTransfer }); fireEvent.drop(target, { dataTransfer }); fireEvent.dragEnd(row, { dataTransfer })
    expect(actions()[0].afterOpId).toBe('a')
    let lines = posted()
    expect(lines.indexOf('M2102')).toBeGreaterThan(lines.indexOf('( Cut a )'))
    expect(lines.indexOf('M2102')).toBeLessThan(lines.indexOf('( Cut b )'))
    fireEvent.click(screen.getByTestId('tree-machine-action').querySelector('.tree-op-enable-btn')!)
    expect(posted()).not.toContain('M2102')
    fireEvent.click(screen.getByTestId('tree-machine-action').querySelector('.tree-op-enable-btn')!)
    lines = posted()
    expect(lines.filter((line) => line === 'M2102')).toHaveLength(1)
  })

  it('explains empty choices without creating an uncallable operation', () => {
    seed()
    act(() => useCamStore.setState((s) => ({ project: { ...s.project, machine: { ...s.project.machine, macros: [] } } })))
    render(<NewOperationModal />)
    act(() => state().openModal('new-operation'))
    fireEvent.click(screen.getByTestId('op-type-action-run_macro'))
    expect(screen.getByText('This machine has no callable macros.')).toBeTruthy()
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
    expect(actions()).toHaveLength(0)
  })

  it.each(['separate', 'combined'] as const)('posts repeated macros once per action in order, including collapsed boundaries (%s)', (mode) => {
    seed([
      run('tail', 'c', 'second'), run('middle', 'a'), run('head', null, 'second'),
      { id: 'stop', kind: 'operator_stop', name: 'Wait', enabled: true, afterOpId: 'a', message: 'Check part' },
      run('after-stop', 'a', 'second'), run('after-b', 'b'),
    ])
    const lines = posted(mode, ['c'], true)
    const relevant = lines.filter((line) => /^M210[12]$/.test(line) || line === 'M0' || line === '( Cut c )')
    expect(relevant).toEqual(['M2102', 'M2101', 'M0', 'M2102', 'M2101', '( Cut c )', 'M2102'])
    expect(lines).not.toContain('( Cut a )')
    expect(lines).not.toContain('( Cut b )')
  })

  it('uses the active machine current code and refuses missing, hidden, unnumbered, or shadowed selections', () => {
    seed([run('check', 'a')])
    act(() => useCamStore.setState((s) => ({ project: { ...s.project, machine: {
      ...s.project.machine, macros: s.project.machine.macros!.map((macro) => macro.id === 'first' ? { ...macro, mCode: 2201 } : macro),
    } } })))
    expect(posted()).toContain('M2201')
    for (const macroId of ['missing', 'hidden', 'no-code']) {
      act(() => state().updateMachineAction('s1', 'check', { macroId }))
      const project = projectForPost()
      const result = postProject(project, project.setups, UCCNC_CONFIG, { mode: 'separate', pauseBetweenSetups: false, baseName: 'bad', ext: 'nc' })
      expect(result.ok).toBe(false)
      expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RUN_MACRO_UNAVAILABLE' })]))
    }
    seed([run('check', 'a', 'duplicate')])
    const project = projectForPost()
    expect(postProject(project, project.setups, UCCNC_CONFIG, { mode: 'combined', pauseBetweenSetups: false, baseName: 'bad', ext: 'nc' }).ok).toBe(false)
  })

  it('persists macro identity and operation placement through project save/open', async () => {
    let saved = ''
    vi.stubGlobal('liencamHost', { saveFile: async (_name: string, data: string) => { saved = data; return 'C:\\Temp\\WO-2478.camproject' } })
    try {
      seed([run('saved', 'b', 'second')])
      await act(async () => { await state().saveProjectToFile() })
      expect(saved).not.toBe('')
      act(() => state().newProject())
      await act(async () => { await state().loadProjectFromFile(saved) })
      expect(actions()).toEqual([run('saved', 'b', 'second')])
      // Opening a project invalidates its CAM results by design; this assertion
      // covers action persistence, without pretending those cuts were recomputed.
    } finally { vi.unstubAllGlobals() }
  })

  it('excludes standard program commands and follows changes to the machine output definition', () => {
    seed([run('check', 'a')])
    const machine = structuredClone(state().project.machine)
    machine.macros = [0, 1, 2, 3, 4, 5, 7, 8, 9, 30].map((mCode) => ({ id: `reserved-${mCode}`, name: `Reserved ${mCode}`, mCode, body: 'say("not called")' }))
    expect(callableMachineMacros(machine)).toEqual([])
    machine.macros = state().project.machine.macros
    const definition = createDefaultControllerDefinition()
    definition.outputs = [{ name: 'Fixture output', onCode: 'M2101', offCode: null, pin: definition.io.estop }]
    machine.controllerDefinition = definition
    expect(callableMachineMacros(machine).map((macro) => macro.id)).not.toContain('first')
    act(() => useCamStore.setState((s) => ({ project: { ...s.project, machine } })))
    const project = projectForPost()
    const result = postProject(project, project.setups, UCCNC_CONFIG, { mode: 'separate', pauseBetweenSetups: false, baseName: 'reserved', ext: 'nc' })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RUN_MACRO_UNAVAILABLE' })]))
    machine.controllerDefinition = undefined
    machine.coolantCapability = { vacuum: { onCode: 'M2101' } }
    expect(callableMachineMacros(machine).map((macro) => macro.id)).not.toContain('first')
    machine.coolantCapability = undefined
    expect(callableMachineMacros(machine).map((macro) => macro.id)).toContain('first')
  })

  it('retains M6 as a tool-change prelude and selects the first tool when the action precedes cutting', () => {
    seed([run('prelude', null)])
    act(() => useCamStore.setState((s) => ({ project: { ...s.project, machine: {
      ...s.project.machine, macros: [{ id: 'first', name: 'Tool-change prelude', mCode: 6, body: 'say("prepare tool")' }],
    } } })))
    expect(callableMachineMacros(state().project.machine).map((macro) => macro.mCode)).toEqual([6])
    const lines = posted()
    expect(lines.filter((line) => line === 'M6')).toHaveLength(1)
    expect(lines.indexOf('T1')).toBeGreaterThanOrEqual(0)
    expect(lines.indexOf('T1')).toBeLessThan(lines.indexOf('M6'))
    // Posted G53 targets require the fixture's known zero in the shared reader (deeb2ebe0ef).
    const read = readGcodeProgram(lines.join('\n'), { dialect: 'uccnc', initialPosition: { x: 0, y: 0, z: 0 }, sessionWcs: 'G54', workOffsets: { G54: { x: 0, y: 0, z: 0 } }, macroMCodes: 'report', machineDefinition: state().project.machine })
    expect(read.ok, JSON.stringify(read)).toBe(true)
    if (read.ok) expect(read.program.items.filter((item) => item.kind === 'tool-change')).toHaveLength(1)
  })

  it('posts a selected same-tool M6 with clearance, spindle and coolant off, then restores the next cut intent', () => {
    seed([run('m6-middle', 'a')])
    const floodTool = structuredClone(tool)
    floodTool.feedsAndSpeeds.default.coolant = 'flood'
    act(() => useCamStore.setState((s) => ({ toolLibrary: [floodTool], project: {
      ...s.project, machine: { ...s.project.machine, macros: [{ id: 'first', name: 'M6 prelude', mCode: 6, body: 'say("M6 compatibility")' }] },
      setups: s.project.setups.map((setup) => ({ ...setup, operations: setup.operations.map((op) => op.id === 'a'
        ? { ...op, toolpathMoves: [move({ type: 'rapid', x: 0, y: 10, z: 5 }), move({ type: 'feed', x: 10, y: 10, z: 0, feed: 3000 })] }
        : op) })),
    } })))
    const text = posted().join('\n')
    const read = readGcodeProgram(text, { dialect: 'uccnc', sessionWcs: 'G54', workOffsets: { G54: { x: 0, y: 0, z: 0 } }, initialPosition: { x: 0, y: 0, z: 0 }, macroMCodes: 'report', machineDefinition: state().project.machine })
    expect(read.ok, JSON.stringify(read)).toBe(true)
    if (!read.ok) return
    const items = read.program.items
    const m6 = items.findIndex((item) => item.kind === 'tool-change')
    expect(m6).toBeGreaterThan(0)
    const before = items.slice(0, m6)
    const stop = before.findLast((item) => item.kind === 'spindle')
    expect(stop, text).toMatchObject({ kind: 'spindle', on: false })
    expect(before.findLast((item) => item.kind === 'coolant'), text).toMatchObject({ kind: 'coolant', flood: false, mist: false })
    const lift = before.filter((item) => item.kind === 'move' && stop !== undefined && item.line < stop.line).at(-1)
    expect(lift, text).toBeDefined()
    if (lift?.kind === 'move') expect(read.program.moves[lift.moveIndex], text).toMatchObject({ type: 'rapid', z: 10 })
    const nextCut = items.findIndex((item, index) => index > m6 && item.kind === 'move' && read.program.moves[item.moveIndex].type === 'feed')
    const restart = items.slice(m6 + 1, nextCut)
    expect(restart).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'spindle', on: true }), expect.objectContaining({ kind: 'coolant', flood: true })]))
  })

  it.each(['shown', 'hidden', 'absent'] as const)('preserves a same-tool M6 prelude boundary only for a %s binding', (binding) => {
    seed()
    const machine = structuredClone(state().project.machine)
    machine.macros = binding === 'absent' ? [] : [{ id: 'm6', name: 'M6 prelude', mCode: 6, body: 'say("bound M6")', hidden: binding === 'hidden' }]
    const result = interpretGcodeProgram('G21 G90 G17 G94\nG54\nT1\nM6\nG0 X0 Y10 Z5\nG1 X10 F3000\nM30', {
      dialect: 'uccnc', sessionWcs: 'G54', initialPosition: { x: 0, y: 0, z: 0 }, machineDefinition: machine,
    })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    const boundaries = result.program.stages.flatMap((stage) => [
      ...(stage.ends.kind === 'tool-change' ? [stage.ends] : []),
      ...(stage.toolChangeBefore ? [stage.toolChangeBefore] : []),
    ])
    expect(boundaries).toHaveLength(binding === 'shown' ? 1 : 0)
    if (binding === 'shown') expect(boundaries[0]).toMatchObject({ from: 1, to: 1 })
  })

  it.each(['shown', 'hidden', 'absent'] as const)('keeps different-tool M6 and spindle-on refusal intact with a %s binding', (binding) => {
    seed()
    const machine = structuredClone(state().project.machine)
    machine.macros = binding === 'absent' ? [] : [{ id: 'm6', name: 'M6 prelude', mCode: 6, body: 'say("bound M6")', hidden: binding === 'hidden' }]
    const options = { dialect: 'uccnc' as const, sessionWcs: 'G54' as const, initialPosition: { x: 0, y: 0, z: 0 }, machineDefinition: machine }
    const text = 'G21 G90 G17 G94\nG54\nT1\nM3 S12000\nG0 X0 Y10 Z5\nG1 X10 F3000\nM5\nT2 M6\nG0 Z10\nG1 X20 F3000\nM30'
    const result = interpretGcodeProgram(text, options)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (result.ok) {
      const boundaries = result.program.stages.flatMap((stage) => [
        ...(stage.ends.kind === 'tool-change' ? [stage.ends] : []), ...(stage.toolChangeBefore ? [stage.toolChangeBefore] : []),
      ])
      expect(boundaries).toEqual([expect.objectContaining({ from: 1, to: 2 })])
    }
    const unsafe = interpretGcodeProgram(text.replace('M5\n', ''), options)
    expect(unsafe.ok).toBe(false)
    if (!unsafe.ok) expect(unsafe.refusal.reason).toContain('spindle still commanded on')
  })

  it('retains ordinary coolant state changes and distinguishes listed output commands from standard coolant', () => {
    seed()
    const machine = structuredClone(state().project.machine)
    machine.controllerDefinition = createDefaultControllerDefinition()
    machine.controllerDefinition.outputs = [{ name: 'Vacuum', onCode: 'M10', offCode: 'M11', pin: { port: 1, pin: 7, negate: false } }]
    const options = { dialect: 'uccnc' as const, sessionWcs: 'G54' as const, initialPosition: { x: 0, y: 0, z: 0 }, machineDefinition: machine }
    const text = 'G21 G90\nM7\nM7\nG1 X10 F3000\nM8\nG1 X20\nM10\nG1 X30\nM9\nG1 X40\nM30'
    const read = readGcodeProgram(text, options)
    expect(read.ok, JSON.stringify(read)).toBe(true)
    if (read.ok) expect(read.program.items.filter((item) => item.kind === 'coolant').map((item) => item.standardCode)).toEqual([7, 7, 8, undefined, 9])
    const interpreted = interpretGcodeProgram(text, options)
    expect(interpreted.ok, JSON.stringify(interpreted)).toBe(true)
    if (!interpreted.ok) return
    expect(interpreted.program.stages.map((stage) => ({
      x: stage.moves.at(-1)?.x, flood: stage.coolant.flood, mist: stage.coolant.mist, outputs: stage.coolant.outputs,
    }))).toEqual([
      { x: 10, flood: false, mist: true, outputs: [] },
      { x: 20, flood: true, mist: true, outputs: [] },
      { x: 30, flood: true, mist: true, outputs: [10] },
      { x: 40, flood: false, mist: false, outputs: [] },
    ])
    expect(interpreted.program.stages.every((stage) => stage.coolantBefore?.standardCode === undefined)).toBe(true)
  })
})

describe('WO-2478 existing Control macro route on the simulator', () => {
  it.each([
    { name: 'listed on before flood', initial: '', commands: 'M10\nM8', on: true, flood: true, mist: false },
    { name: 'listed off before mist', initial: 'M10', commands: 'M11\nM7', on: false, flood: false, mist: true },
    { name: 'flood before listed on', initial: '', commands: 'M8\nM10', on: true, flood: true, mist: false },
    { name: 'mist before listed off', initial: 'M10', commands: 'M7\nM11', on: false, flood: false, mist: true },
    { name: 'listed on before flood EOF', initial: '', commands: 'M10\nM8', on: true, flood: true, mist: false },
    { name: 'flood before listed on EOF', initial: '', commands: 'M8\nM10', on: true, flood: true, mist: false },
    { name: 'leading macro listed on before flood', initial: '', commands: 'M10\nM8', on: true, flood: true, mist: false },
    { name: 'listed on before flood then macro fence', initial: '', commands: 'M10\nM8\nM2102', on: true, flood: true, mist: false },
    { name: 'generic-only text M9', initial: '', commands: 'M9', on: false, flood: false, mist: false },
    { name: 'repeat listed on after macro off', initial: 'M10', commands: 'M10\nM8', on: true, flood: true, mist: false },
    { name: 'repeat listed off after macro on', initial: '', commands: 'M11\nM7', on: false, flood: false, mist: true },
    { name: 'shared off command once', initial: 'M10\nM12', commands: 'M11\nM8', on: false, flood: true, mist: false },
    { name: 'shared on and off command once', initial: 'M12', commands: 'M10\nM8', on: true, flood: true, mist: false },
    { name: 'normalized listed aliases', initial: 'M10', commands: 'M11\nM7', on: false, flood: false, mist: true },
    { name: 'listed off preserves other macro output', initial: 'M10', commands: 'M11\nM8', on: false, flood: true, mist: false },
    { name: 'listed on preserves other macro output', initial: '', commands: 'M10\nM8', on: true, flood: true, mist: false },
    { name: 'ordinary no-macro listed on before flood', initial: '', commands: 'M10\nM8', on: true, flood: true, mist: false },
    { name: 'ordinary no-macro listed off before mist', initial: 'M10', commands: 'M11\nM7', on: false, flood: false, mist: true },
  ])('preserves mixed output command ownership: $name', async ({ name, initial, commands, on, flood, mist }) => {
    vi.useFakeTimers()
    const advance = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 50) await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    }
    try {
      seed()
      const genericOnly = name === 'generic-only text M9'
      const macroStartsOutput = genericOnly || name === 'repeat listed off after macro on'
      const macroStopsOutput = name === 'repeat listed on after macro off'
      const macroOtherOutput = name.includes('preserves other macro output')
      const noMacro = name.startsWith('ordinary no-macro')
      const terminal = name.endsWith('EOF')
      const definition = createDefaultControllerDefinition()
      definition.outputs = [{ name: 'Fixture vacuum', onCode: 'M10', offCode: 'M11', pin: { port: 1, pin: 7, negate: false } }]
      if (name.startsWith('shared') || macroOtherOutput) definition.outputs.push({
        name: 'Fixture air', onCode: 'M12', offCode: name === 'shared off command once' ? 'M11' : name.startsWith('shared on') ? 'M10' : 'M13',
        pin: { port: 1, pin: 8, negate: false },
      })
      if (name === 'normalized listed aliases') {
        // Imported/legacy JSON can precede the typed editor's canonical form.
        // Keep the raw aliases so this exercises reader normalization at that boundary.
        definition.outputs[0].onCode = 'm010' as `M${number}`
        definition.outputs[0].offCode = 'm011' as `M${number}`
      }
      act(() => useCamStore.setState((s) => ({ project: { ...s.project, machine: {
        ...s.project.machine, controllerDefinition: definition, coolantCapability: { flood: !genericOnly, mist: !genericOnly },
        macros: [
          { id: 'first', name: 'Output boundary', mCode: 2101, body: `${macroStartsOutput ? 'line("M10");' : macroStopsOutput ? 'line("M11");' : macroOtherOutput ? 'line("M12");' : ''} say("WO2478 mixed boundary")` },
          { id: 'second', name: 'Following boundary', mCode: 2102, body: 'say("WO2478 following boundary")' },
        ],
      } } })))
      const connecting = session.connectMachine('simulator', 115200)
      await advance(300); await connecting
      session.__resetEstopInterlockForTest()
      const controller = session.getMachineController() as ReturnType<typeof session.getMachineController> & {
        listedOutputsOnWords(): string[]
      }
      expect(controller.capabilities.gcodeText).toBe(true)
      controller.home(); await advance(3000)
      for (const [axis, offset] of [['X', 100], ['Y', 100], ['Z', 50]] as const) {
        expect(session.setWorkOffsetValue('G54', axis, offset)).toBe(true)
        await advance(50)
      }
      const snapshot = () => ({ on: controller.listedOutputsOnWords().includes('M10'),
        flood: useMachineControl.getState().reportedAccessories.flood, mist: useMachineControl.getState().reportedAccessories.mist })
      const sent: string[] = []
      const sendCommand = controller.sendCommand.bind(controller)
      const sendCommandAwait = controller.sendCommandAwait.bind(controller)
      vi.spyOn(controller, 'sendCommand').mockImplementation((text) => { sent.push(text.trim().toUpperCase()); return sendCommand(text) })
      vi.spyOn(controller, 'sendCommandAwait').mockImplementation((text) => { sent.push(text.trim().toUpperCase()); return sendCommandAwait(text) })
      const loads: ReturnType<typeof snapshot>[] = []
      const pc = controller as typeof controller & Required<Pick<typeof controller, 'loadProgram'>>
      const original = pc.loadProgram.bind(controller)
      vi.spyOn(pc, 'loadProgram').mockImplementation((program) => {
        if (program.steps.some((step) => step.kind === 'line' && !step.rapid && step.to.x === 40)) loads.push(snapshot())
        return original(program)
      })
      useMachineControl.setState({ consoleLines: [] })
      const consoleText = () => useMachineControl.getState().consoleLines.map((entry) => entry.text)
      const text = ['G21 G90 G17 G94', 'G54', initial,
        ...(name.startsWith('leading macro') ? [] : ['G0 X0 Y10 Z5', 'G1 X10 F3000']),
        ...(noMacro ? [] : ['M2101']), commands, ...(terminal ? [] : ['G1 X40 F3000']), 'M30'].join('\n')
      expect(session.loadGcodeTextToolpathProgram('WO2478 mixed outputs', text), consoleText().join('\n')).toEqual({ ok: true, reason: null })
      expect(await executeOperatorCycleStart(), consoleText().join('\n')).toBe(true)
      await advance(30000)
      if (!noMacro) {
        expect(consoleText().filter((line) => line === 'WO2478 mixed boundary')).toHaveLength(1)
        if (macroStartsOutput) expect(snapshot().on).toBe(true)
        if (macroStopsOutput) expect(snapshot().on).toBe(false)
        expect(loads).toEqual([])
        expect(await executeOperatorCycleStart(), consoleText().join('\n')).toBe(true)
        await advance(30000)
      }
      console.log('WO2478 mixed output observation', name, JSON.stringify({ snapshot: snapshot(), loads }))
      expect(snapshot(), consoleText().join('\n')).toEqual({ on, flood, mist })
      if (name.endsWith('macro fence')) {
        expect(consoleText().filter((line) => line === 'WO2478 following boundary')).toHaveLength(1)
        expect(loads).toEqual([])
        expect(await executeOperatorCycleStart(), consoleText().join('\n')).toBe(true)
        await advance(30000)
      }
      expect(loads, consoleText().join('\n')).toEqual(terminal ? [] : [{ on, flood, mist }])
      expect(sent.filter((line) => line === 'M10')).toHaveLength(
        Number(initial.split('\n').includes('M10')) + Number(commands.split('\n').includes('M10')) + Number(macroStartsOutput),
      )
      expect(sent.filter((line) => line === 'M11')).toHaveLength(Number(commands.split('\n').includes('M11')) + Number(macroStopsOutput))
      if (name.startsWith('shared') || macroOtherOutput) expect(controller.listedOutputsOnWords().includes('M12')).toBe(macroOtherOutput)
    } finally {
      vi.restoreAllMocks()
      session.getMachineController().emergencyStop()
      const disconnecting = session.disconnectMachine()
      await advance(100); await disconnecting
      vi.useRealTimers()
    }
  })

  it.each([
    { name: 'explicit flood only', initial: 'M7\nM8', restart: 'M8', flood: true, mist: false, genericAfter: true },
    { name: 'explicit mist only', initial: 'M7\nM8', restart: 'M7', flood: false, mist: true, genericAfter: true },
    { name: 'explicit flood and mist', initial: 'M7\nM8', restart: 'M7\nM8', flood: true, mist: true, genericAfter: true },
    { name: 'off-to-on flood', initial: '', restart: 'M8', flood: true, mist: false, genericAfter: true },
    { name: 'no explicit reassertion', initial: 'M7\nM8', restart: '(M7 M8 are comments)', flood: false, mist: false, genericAfter: true },
    { name: 'generic output remains off', initial: 'M8', restart: 'M8', flood: true, mist: false, genericAfter: false },
    { name: 'generic word does not assert inherited coolant', initial: 'M7\nM8', restart: 'M10', flood: false, mist: false, genericAfter: true },
    { name: 'remapped file numbering', initial: 'M8', restart: 'M8', flood: true, mist: false, genericAfter: true },
    { name: 'nested comment only', initial: 'M8', restart: '(outer (inner) M8)', flood: false, mist: false, genericAfter: true },
    { name: 'mesh-compensated source', initial: 'M8', restart: 'M8', flood: true, mist: false, genericAfter: true },
    { name: 'M9 clears unknown outputs', initial: '', restart: 'M9', flood: false, mist: false, genericAfter: false },
    { name: 'M9 clears unknown outputs text fallback', initial: '', restart: 'M9', flood: false, mist: false, genericAfter: false },
    { name: 'M8 then M9 at EOF', initial: 'M8', restart: 'M8\nM9', flood: false, mist: false, genericAfter: false },
    { name: 'M9 then M8 at EOF', initial: 'M8', restart: 'M9\nM8', flood: true, mist: false, genericAfter: false },
    { name: 'M7 dwell M8 at EOF', initial: 'M7\nM8', restart: 'M7\nG4 P2000\nM8', flood: true, mist: true, genericAfter: false },
  ])('honors $name without replaying generic outputs', async ({ name, initial, restart, flood, mist, genericAfter }) => {
    vi.useFakeTimers()
    const advance = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 50) await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    }
    const outputTransitions: { flood: boolean; mist: boolean }[] = []
    const unsubscribe = useMachineControl.subscribe((next, previous) => {
      if (next.reportedAccessories.flood !== previous.reportedAccessories.flood || next.reportedAccessories.mist !== previous.reportedAccessories.mist) {
        outputTransitions.push({ flood: next.reportedAccessories.flood, mist: next.reportedAccessories.mist })
      }
    })
    try {
      seed()
      const macroOn = name.startsWith('M9 clears unknown outputs')
      const terminal = name.includes('EOF')
      const textFallback = name.includes('text fallback')
      const definition = createDefaultControllerDefinition()
      definition.outputs = [
        { name: 'Flood', role: 'flood', onCode: 'M8', offCode: null, pin: { port: 1, pin: 5, negate: false } },
        { name: 'Mist', role: 'mist', onCode: 'M7', offCode: null, pin: { port: 1, pin: 6, negate: false } },
        { name: 'Fixture vacuum', onCode: 'M10', offCode: 'M11', pin: { port: 1, pin: 7, negate: false } },
      ]
      act(() => useCamStore.setState((s) => ({ project: { ...s.project, machine: {
        ...s.project.machine, controllerDefinition: textFallback ? undefined : definition, coolantCapability: { flood: true, mist: true },
        macros: [{ id: 'first', name: 'Change outputs', mCode: 2101,
          body: `${macroOn ? 'line("M7"); line("M8");' : 'line("M9");'} ${(genericAfter || macroOn) && !textFallback ? 'line("M10");' : ''} say("WO2478 outputs changed")` }],
      } } })))
      const connecting = session.connectMachine('simulator', 115200)
      await advance(300); await connecting
      session.__resetEstopInterlockForTest()
      const controller = session.getMachineController()
      controller.home()
      await advance(3000)
      for (const [axis, offset] of [['X', 100], ['Y', 100], ['Z', 50]] as const) {
        expect(session.setWorkOffsetValue('G54', axis, offset)).toBe(true)
        await advance(50)
      }
      const consoleText = () => useMachineControl.getState().consoleLines.map((line) => line.text)
      const loaded: { flood: boolean; mist: boolean; generic: boolean }[] = []
      const outputController = controller as typeof controller & { listedOutputsOnWords(): string[] }
      const sent: string[] = []
      const sendCommand = controller.sendCommand.bind(controller)
      const sendCommandAwait = controller.sendCommandAwait.bind(controller)
      vi.spyOn(controller, 'sendCommand').mockImplementation((text) => { sent.push(text.trim().toUpperCase()); return sendCommand(text) })
      vi.spyOn(controller, 'sendCommandAwait').mockImplementation((text) => { sent.push(text.trim().toUpperCase()); return sendCommandAwait(text) })
      const programController = controller as typeof controller & Required<Pick<typeof controller, 'loadProgram'>>
      const originalLoad = programController.loadProgram.bind(controller)
      vi.spyOn(programController, 'loadProgram').mockImplementation((program) => {
        if (program.steps.some((step) => step.kind === 'line' && !step.rapid && step.to.x === 40)) {
          loaded.push({ flood: useMachineControl.getState().reportedAccessories.flood,
            mist: useMachineControl.getState().reportedAccessories.mist, generic: outputController.listedOutputsOnWords().includes('M10') })
        }
        return originalLoad(program)
      })
      useMachineControl.setState({ consoleLines: [] })
      const text = ['G21 G90 G17 G94', 'G54', initial, macroOn ? '' : 'M10', 'G0 X0 Y10 Z5', 'G1 X10 F3000',
        'M2101', restart, ...(terminal ? [] : ['G0 X30 Y10 Z5', 'G1 X40 F3000', 'M9']), 'M30'].join('\n')
      if (name === 'mesh-compensated source') {
        const xs = [-5, 25, 55]
        const ys = [-5, 10, 25]
        useMachineControl.getState().setSurfaceMesh({
          bounds: { minX: -5, minY: -5, maxX: 55, maxY: 25 },
          cutBounds: { minX: -5, minY: -5, maxX: 55, maxY: 25 },
          pointsX: 3, pointsY: 3, fadeMm: 10, referenceMachineZ: 50,
          samples: ys.flatMap((y, row) => xs.map((x, column) => ({ row, column, x, y, machineZ: 50 + 0.01 * x }))),
          sourceFingerprint: fingerprintProgram(text), sourceName: 'WO2478 explicit coolant',
          workOffset: 'G54', workOffsetValues: null, probedAt: 0, active: true,
        })
      }
      const options = name === 'remapped file numbering' ? {
        fileNumbering: { lineOf: (line: number) => line + 100, startLine: 101, sectionOf: null, numberingOf: () => null },
      } : name === 'mesh-compensated source' ? { publishListing: true } : {}
      expect(session.loadGcodeTextToolpathProgram('WO2478 explicit coolant', text, options), consoleText().join('\n')).toEqual({ ok: true, reason: null })
      if (name === 'mesh-compensated source') expect(consoleText().join('\n')).toContain('Surface mesh compensation is ACTIVE')
      expect(await executeOperatorCycleStart(), consoleText().join('\n')).toBe(true)
      await advance(30000)
      expect(consoleText()).toContain('WO2478 outputs changed')
      expect(useMachineControl.getState().reportedAccessories).toMatchObject({ flood: macroOn, mist: macroOn })
      // Initial file command plus the macro's authored command. The following
      // explicit M10 is independently owned and must run once after this hold.
      expect(sent.filter((line) => line === 'M10')).toHaveLength(textFallback ? 0 : genericAfter ? 2 : 1)
      const sentAtHold = sent.length
      const heldMark = outputTransitions.length
      expect(await executeOperatorCycleStart(), consoleText().join('\n')).toBe(true)
      await advance(30000)
      if (terminal) {
        expect(loaded).toEqual([])
        expect(useMachineControl.getState().reportedAccessories, consoleText().join('\n')).toMatchObject({ flood, mist })
        if (name === 'M8 then M9 at EOF') expect(outputTransitions.slice(heldMark)).toEqual([
          { flood: true, mist: false }, { flood: false, mist: false },
        ])
        if (name === 'M7 dwell M8 at EOF') expect(outputTransitions.slice(heldMark)).toEqual([
          { flood: false, mist: true }, { flood: true, mist: true },
        ])
      } else expect(loaded, consoleText().join('\n')).toEqual([{ flood, mist, generic: genericAfter }])
      expect(sent.slice(sentAtHold).filter((line) => line === 'M10')).toHaveLength(restart === 'M10' ? 1 : 0)
    } finally {
      unsubscribe()
      useMachineControl.getState().setSurfaceMesh(null)
      vi.restoreAllMocks()
      session.getMachineController().emergencyStop()
      const disconnecting = session.disconnectMachine()
      await advance(100); await disconnecting
      vi.useRealTimers()
    }
  })

  it.each(['before cuts', 'between cuts', 'after cuts', 'selected-operation collapse',
    'Stop at first head hold', 'Reset at first head hold', 'mixed Operator stop',
    'coolant between adjacent macros', 'toolChange metadata', 'M6 before cuts', 'M6 same tool', 'M6 after cuts',
    'M6 then custom', 'custom then M6', 'Stop at M6 hold', 'Reset at M6 hold'] as const)(
    'loads adjacent Run macro actions %s and executes each once through existing holds', async (placement) => {
      vi.useFakeTimers()
      const advance = async (ms: number) => {
        for (let elapsed = 0; elapsed < ms; elapsed += 50) await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      }
      try {
        const singleM6 = ['M6 before cuts', 'M6 same tool', 'M6 after cuts'].includes(placement)
        const firstM6 = singleM6 || ['M6 then custom', 'Stop at M6 hold', 'Reset at M6 hold'].includes(placement)
        const secondM6 = placement === 'custom then M6'
        const isM6 = firstM6 || secondM6
        const after = ['after cuts', 'M6 after cuts'].includes(placement) ? 'c' : ['between cuts', 'selected-operation collapse', 'M6 same tool'].includes(placement) ? 'a' : null
        const fixtureActions: MachineAction[] = [run('adjacent-first', after)]
        if (placement === 'mixed Operator stop') fixtureActions.push({ id: 'middle-stop', kind: 'operator_stop', name: 'Inspect', enabled: true, afterOpId: after, message: 'Inspect before second macro' })
        if (!singleM6) fixtureActions.push(run('adjacent-second', placement === 'selected-operation collapse' ? 'b' : after, 'second'))
        seed(fixtureActions)
        if (isM6 || placement === 'toolChange metadata' || placement === 'coolant between adjacent macros') {
          const definition = createDefaultControllerDefinition()
          definition.outputs = [{ name: 'Flood', role: 'flood', onCode: 'M8', offCode: null, pin: { port: 1, pin: 5, negate: false } }]
          const floodTool = structuredClone(tool)
          floodTool.feedsAndSpeeds.default.coolant = 'flood'
          act(() => useCamStore.setState((s) => ({
            ...(placement === 'coolant between adjacent macros' || isM6 ? { toolLibrary: [floodTool] } : {}),
            project: { ...s.project, machine: { ...s.project.machine,
              controllerDefinition: definition, coolantCapability: { flood: true },
              macros: s.project.machine.macros!.map((macro) => {
                if ((firstM6 && macro.id === 'first') || (secondM6 && macro.id === 'second')) return { ...macro, mCode: 6 }
                if (placement === 'toolChange metadata' && macro.id === 'second') return { ...macro, body: 'say("WO2478 finish checked"); toolChange(3)' }
                if (placement === 'coolant between adjacent macros' && macro.id === 'first') return { ...macro, body: 'line("M9"); say("WO2478 fixture checked")' }
                return macro
              }),
            } },
          })))
        }
        const selectedText = placement === 'selected-operation collapse' ? posted('separate', ['c']).join('\n')
          : placement === 'coolant between adjacent macros' ? posted().join('\n').replace('M2101', 'M8\nM2101').replace('M2102', 'M8\nM2102') : null
        act(() => useCamStore.setState({ project: projectForPost() }))
        const connecting = session.connectMachine('simulator', 115200)
        await advance(300); await connecting
        session.__resetEstopInterlockForTest()
        session.getMachineController().home()
        await advance(3000)
        for (const [axis, offset] of [['X', 100], ['Y', 100], ['Z', 50]] as const) {
          expect(session.setWorkOffsetValue('G54', axis, offset)).toBe(true)
          await advance(50)
        }
        useMachineControl.setState({ consoleLines: [] })
        const consoleText = () => useMachineControl.getState().consoleLines.map((line) => line.text)
        const controller = session.getMachineController()
        const programController = controller as typeof controller & Required<Pick<typeof controller, 'loadProgram'>>
        const originalLoad = programController.loadProgram.bind(controller)
        let cuttingLoads = 0
        vi.spyOn(programController, 'loadProgram').mockImplementation((program) => {
          if (program.steps.some((step) => step.kind === 'line' && !step.rapid)) cuttingLoads++
          return originalLoad(program)
        })
        const loaded = selectedText === null ? await session.loadSetupToolpathProgram('s1')
          : session.loadGcodeTextToolpathProgram('WO2478 selected post', selectedText, { publishListing: true })
        expect(loaded, consoleText().join('\n')).toEqual({ ok: true, reason: null })
        expect(await executeOperatorCycleStart(), consoleText().join('\n')).toBe(true)
        await advance(30000)
        expect(consoleText().filter((line) => line === 'WO2478 fixture checked')).toHaveLength(1)
        if (after === null) expect(cuttingLoads, 'No cutting part may load before head actions are answered').toBe(0)
        if (firstM6) {
          expect(useMachineControl.getState().reportedAccessories, 'The M6 prelude must run with spindle and coolant stopped').toMatchObject({ spindle: 'off', flood: false, mist: false })
          expect(consoleText().join('\n')).toContain('the tool change on line')
          if (singleM6) return // Existing M6 prelude/tool-change continuation is a separate contract.
        }
        expect(consoleText().filter((line) => line === 'WO2478 finish checked')).toHaveLength(0)
        expect(consoleText().join('\n')).toContain('press CYCLE START')
        if (placement.startsWith('Stop at') || placement.startsWith('Reset at')) {
          if (placement.startsWith('Stop')) controller.stopJob()
          else controller.reset()
          await advance(30000)
          expect(consoleText().filter((line) => line === 'WO2478 finish checked')).toHaveLength(0)
          expect(cuttingLoads).toBe(0)
          return
        }
        expect(await executeOperatorCycleStart(), consoleText().join('\n')).toBe(true)
        await advance(30000)
        if (placement === 'mixed Operator stop') {
          expect(consoleText().filter((line) => line === 'WO2478 finish checked')).toHaveLength(0)
          expect(cuttingLoads).toBe(0)
          expect(await executeOperatorCycleStart(), consoleText().join('\n')).toBe(true)
          await advance(30000)
        }
        expect(consoleText().filter((line) => line === 'WO2478 finish checked')).toHaveLength(1)
        if (secondM6) expect(useMachineControl.getState().reportedAccessories).toMatchObject({ spindle: 'off', flood: false, mist: false })
        if (after === null) expect(cuttingLoads, 'The second macro must hold before the first cut').toBe(0)
        if (placement === 'coolant between adjacent macros') expect(useMachineControl.getState().reportedAccessories.flood).toBe(true)
        if (placement === 'toolChange metadata') {
          expect(consoleText().join('\n')).toContain('fit T3, set its Z zero, then press CYCLE START')
          expect(cuttingLoads, 'The plain tool-change hold must precede cutting').toBe(0)
          return
        }
        expect(await executeOperatorCycleStart(), consoleText().join('\n')).toBe(true)
        await advance(30000)
        expect(consoleText().filter((line) => line === 'WO2478 fixture checked')).toHaveLength(1)
        expect(consoleText().filter((line) => line === 'WO2478 finish checked')).toHaveLength(1)
      } finally {
        vi.restoreAllMocks()
        session.getMachineController().emergencyStop()
        const disconnecting = session.disconnectMachine()
        await advance(100); await disconnecting
        vi.useRealTimers()
      }
    },
  )

  it.each([0, 2000])('reasserts flood before the second same-tool cut after a macro switches M9 off (dwell %i ms)', async (dwellMs) => {
    vi.useFakeTimers()
    const advance = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 50) await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    }
    const observations: { event: string; flood: boolean }[] = []
    const unsubscribe = useMachineControl.subscribe((next, previous) => {
      if (next.reportedAccessories.flood !== previous.reportedAccessories.flood) {
        observations.push({ event: 'reported coolant', flood: next.reportedAccessories.flood })
      }
    })
    try {
      seed([run('coolant-off', 'a')])
      const definition = createDefaultControllerDefinition()
      definition.outputs = [{ name: 'Flood coolant', role: 'flood', onCode: 'M8', offCode: null, pin: { port: 1, pin: 5, negate: false } }]
      const floodTool = structuredClone(tool)
      floodTool.feedsAndSpeeds.default.coolant = 'flood'
      act(() => useCamStore.setState((s) => ({ toolLibrary: [floodTool], project: {
        ...s.project, machine: { ...s.project.machine, controllerDefinition: definition, coolantCapability: { flood: true },
          macros: [{ id: 'first', name: 'Coolant off', mCode: 2101, body: 'line("M9"); say("WO2478 coolant off")' }] },
        setups: s.project.setups.map((setup) => ({ ...setup, operations: setup.operations.slice(0, 2) })),
      } })))
      const project = projectForPost()
      const post = postProject(project, project.setups, { ...UCCNC_CONFIG, options: { ...UCCNC_CONFIG.options, dwellMs } }, {
        mode: 'separate', pauseBetweenSetups: false, baseName: 'wo2478-dwell', ext: 'nc',
      })
      expect(post.ok, JSON.stringify(post.diagnostics)).toBe(true)
      const text = post.files![0].result.gcode
      const lines = text.split('\n')
      expect(lines.slice(lines.indexOf('M2101') + 1)).toContain('M8')
      if (dwellMs > 0) {
        const afterMacro = lines.slice(lines.indexOf('M2101') + 1)
        expect(afterMacro.indexOf('G4 P2000')).toBeGreaterThanOrEqual(0)
        expect(afterMacro.indexOf('G4 P2000')).toBeLessThan(afterMacro.indexOf('M8'))
      }
      act(() => useCamStore.setState({ project: projectForPost() }))
      const connecting = session.connectMachine('simulator', 115200)
      await advance(300); await connecting
      session.__resetEstopInterlockForTest()
      const controller = session.getMachineController()
      controller.home()
      await advance(3000)
      for (const [axis, offset] of [['X', 100], ['Y', 100], ['Z', 50]] as const) {
        expect(session.setWorkOffsetValue('G54', axis, offset)).toBe(true)
        await advance(50)
      }
      const programController = controller as typeof controller & Required<Pick<typeof controller, 'loadProgram'>>
      const originalLoad = programController.loadProgram.bind(controller)
      vi.spyOn(programController, 'loadProgram').mockImplementation((program) => {
        if (program.steps.some((step) => step.kind === 'dwell' && step.seconds === 2)) {
          observations.push({ event: 'settle dwell loaded', flood: useMachineControl.getState().reportedAccessories.flood })
        }
        if (program.steps.some((step) => step.kind === 'line' && !step.rapid && step.to.x === 40)) {
          observations.push({ event: 'second cut loaded', flood: useMachineControl.getState().reportedAccessories.flood })
        }
        return originalLoad(program)
      })
      useMachineControl.setState({ consoleLines: [] })
      const consoleText = () => useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
      const loaded = dwellMs === 0 ? await session.loadSetupToolpathProgram('s1')
        : session.loadGcodeTextToolpathProgram('WO2478 posted spindle settle', text, { publishListing: true })
      expect(loaded, consoleText()).toEqual({ ok: true, reason: null })
      expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
      await advance(30000)
      expect(consoleText()).toContain('WO2478 coolant off')
      expect(consoleText()).toContain('press CYCLE START to run the rest of the program')
      expect(observations).toContainEqual({ event: 'reported coolant', flood: true })
      expect(useMachineControl.getState().reportedAccessories.flood).toBe(false)
      const heldMark = observations.length
      expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
      await advance(30000)
      console.log('WO-2478 flood restart observations:', JSON.stringify(observations))
      if (dwellMs > 0) expect(observations.slice(heldMark), consoleText()).toContainEqual({ event: 'settle dwell loaded', flood: false })
      expect(observations.slice(heldMark), consoleText()).toContainEqual({ event: 'reported coolant', flood: true })
      expect(observations, consoleText()).toContainEqual({ event: 'second cut loaded', flood: true })
      expect(observations).not.toContainEqual({ event: 'second cut loaded', flood: false })
    } finally {
      unsubscribe()
      vi.restoreAllMocks()
      session.getMachineController().emergencyStop()
      const disconnecting = session.disconnectMachine()
      await advance(100); await disconnecting
      vi.useRealTimers()
    }
  })

  it('direct setup Load posts its Run macro operations and Cycle Start executes each once', async () => {
    vi.useFakeTimers()
    const advance = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 50) await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    }
    try {
      seed([run('fixture', 'a'), run('finish', 'b', 'second')])
      const project = projectForPost()
      act(() => useCamStore.setState({ project }))
      const connecting = session.connectMachine('simulator', 115200)
      await advance(300); await connecting
      session.__resetEstopInterlockForTest()
      session.getMachineController().home()
      await advance(3000)
      for (const [axis, offset] of [['X', 100], ['Y', 100], ['Z', 50]] as const) {
        expect(session.setWorkOffsetValue('G54', axis, offset)).toBe(true)
        await advance(50)
      }
      useMachineControl.setState({ consoleLines: [] })
      const consoleText = () => useMachineControl.getState().consoleLines.map((line) => line.text)
      expect(await session.loadSetupToolpathProgram('s1'), consoleText().join('\n')).toEqual({ ok: true, reason: null })
      expect(await executeOperatorCycleStart(), consoleText().join('\n')).toBe(true)
      await advance(30000)
      expect(consoleText().filter((line) => line === 'WO2478 fixture checked')).toHaveLength(1)
      // The established M-code runtime holds after a macro; Cycle Start is
      // the existing operator continuation, not a new automatic resume path.
      expect(consoleText().join('\n')).toContain('press CYCLE START to run the rest of the program')
      expect(consoleText().filter((line) => line === 'WO2478 finish checked')).toHaveLength(0)
      expect(await executeOperatorCycleStart(), consoleText().join('\n')).toBe(true)
      await advance(30000)
      expect(consoleText().filter((line) => line === 'WO2478 finish checked'), consoleText().join('\n')).toHaveLength(1)
      expect(await executeOperatorCycleStart(), consoleText().join('\n')).toBe(true)
      await advance(30000)
      expect(consoleText().filter((line) => line === 'WO2478 fixture checked')).toHaveLength(1)
      expect(consoleText().filter((line) => line === 'WO2478 finish checked')).toHaveLength(1)
      expect(consoleText().some((line) => line === 'wrong macro')).toBe(false)
    } finally {
      session.getMachineController().emergencyStop()
      const disconnecting = session.disconnectMachine()
      await advance(100); await disconnecting
      vi.useRealTimers()
    }
  })
})
