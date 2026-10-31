// @vitest-environment jsdom
// The transfer preview may be reused; live readiness and exact staged text may not.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareTransferLoad, setupLoadParserTables } from '../../lib/machine/setupLoadPreparation'
import { SimulatedController } from '../../lib/machine/simulatedController'
import * as simulatorPreparation from '../../lib/machine/simulatedProgramPreparation'
import { freezeSimulatedProgram } from '../../lib/machine/simulatedProgramPreparation'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import * as previewGeometry from '../../lib/machine/previewGeometry'
import {
  __reportWorkOffsetsForTest, __resetEstopInterlockForTest, connectMachine, disconnectMachine, getMachineController,
  setupLoadSimulatorInput, loadGcodeFile, loadMachineProgram, sendMdiLine, transferReview, setupLoadStagedText, freezeSetupTransfer,
} from '../../lib/machine/machineSession'
import { buildMultiSetupProgramContext, buildProgramContext, compareProgramContext, compareProgramContextPerSetup } from '../../lib/machine/programContext'
import * as postInputs from '../../lib/post/buildPostInput'
import { postProject } from '../../lib/post/postProject'
import { resolveDeclaredController } from '../../lib/machine/machineChoice'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { makeMachine } from '../post/helpers'

const parse = vi.spyOn(previewGeometry, 'buildPreviewModel')
const resolvePost = vi.spyOn(postInputs, 'buildPostInput')
const TEXT = 'G21 G90 G54\nG1 X20 F100\nM30'
function target(limit = 100): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  controllerDefinition.axes = controllerDefinition.axes.map(axis => ({ ...axis, softLimitMin: 0, softLimitMax: limit }))
  controllerDefinition.stated = controllerDefinition.axes.flatMap(axis => (['min', 'max'] as const).map(end => ({
    controller: 'grbl' as const, key: axisSoftLimitStatementKey(axis.axis, end),
  })))
  return makeMachine({ id: 'wo3125', name: 'Transfer fixture', controller: 'grbl', controllerDefinition })
}
function changeTarget(machine: MachineConfig) {
  useCamStore.getState().setControlSessionMachine(machine)
}
async function connect() {
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(400)
  await pending
}
async function disconnect() {
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
}
function calls(text: string) { return parse.mock.calls.filter(args => args[0] === text).length }

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T23:00:00Z'))
  const machine = target()
  useCamStore.setState(state => ({ project: { ...state.project, machine }, machineLibrary: [machine], control: { activeMachineId: machine.id } }))
  await connect()
  __reportWorkOffsetsForTest({ G54: { x: 0, y: 0, z: 0 } })
  parse.mockClear()
})
afterEach(async () => { await disconnect(); vi.useRealTimers() })

describe('WO-3125 exact active transfer analysis', () => {
  it('prepares once at the real session Load entry and rechecks tool-table machine writes without reparsing', () => {
    loadGcodeFile('load.nc', TEXT, null)
    expect(useMachineControl.getState().programText).toBe(TEXT)
    expect(transferReview().result.refusals).toEqual([])
    for (let n = 0; n < 3; n++) changeTarget({ ...target(), name: `Updated tool table ${n}` })
    expect(transferReview().targetMachineName).toBe('Updated tool table 2')
    expect(calls(TEXT), 'one preview per exact active staged text, including repeated live checks').toBe(1)
  })

  it('rechecks current offsets, limits and resolved motion while preserving notes and readiness', () => {
    loadMachineProgram('live.nc', TEXT, null)
    expect(transferReview().result).toEqual({ refusals: [], warnings: [], notes: [] })
    __reportWorkOffsetsForTest({ G54: { x: 90, y: 0, z: 0 } })
    expect(transferReview().result.refusals).toEqual(['X program range 90..110 mm exceeds soft limits 0..100 mm.'])
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    __reportWorkOffsetsForTest({ G54: { x: 0, y: 0, z: 0 } })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    changeTarget(target(10))
    expect(transferReview().result.refusals).toEqual(['X program range 0..20 mm exceeds soft limits 0..10 mm.'])
    changeTarget(target())
    expect(transferReview().result).toEqual({ refusals: [], warnings: [], notes: [] })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
  })

  it('keys changed text by exact bytes and retains only the active input', () => {
    loadMachineProgram('a.nc', TEXT, null)
    const other = TEXT.replace('X20', 'X21')
    loadMachineProgram('b.nc', other, null)
    expect(useMachineControl.getState().programText).toBe(other)
    changeTarget(target(20))
    expect(transferReview().result.refusals).toEqual(['X program range 0..21 mm exceeds soft limits 0..20 mm.'])
    parse.mockClear()
    loadMachineProgram('a-again.nc', TEXT, null)
    expect(calls(TEXT)).toBe(1)
  })

  it('reuses identical reload text without caching the source context or target identity', () => {
    loadMachineProgram('first.nc', TEXT, null)
    parse.mockClear()
    loadMachineProgram('renamed.nc', TEXT, null)
    expect(useMachineControl.getState().job.name).toBe('renamed.nc')
    expect(useMachineControl.getState().programContext).toBeNull()
    expect(calls(TEXT)).toBe(0)
  })

  it('retains whole-program refusal and does not append duplicate notes on repeated checks', () => {
    const refused = 'G21 G90\nG0 X10\nG1 X20 @-.0025 F100\nM30'
    loadMachineProgram('refused.nc', refused, null)
    const original = structuredClone(transferReview().result)
    expect(original.refusals[0]).toMatch(/expression syntax.*soft-limit checks cannot judge/)
    changeTarget(target())
    expect(transferReview().result).toEqual(original)
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    loadMachineProgram('note.nc', TEXT.replace('G1', 'M42\nG1'), null)
    const noted = structuredClone(transferReview().result)
    expect(noted.notes).toContain('Line 2: M42 is not interpreted by the preview; it does not change the drawn path.')
    changeTarget(target())
    expect(transferReview().result).toEqual(noted)
  })

  it('drops prepared geometry across connection disposal and a fresh session', async () => {
    loadMachineProgram('session.nc', TEXT, null)
    await disconnect()
    parse.mockClear()
    await connect()
    loadMachineProgram('session.nc', TEXT, null)
    expect(calls(TEXT)).toBeGreaterThan(0)
    expect(useMachineControl.getState().programText).toBe(TEXT)
  })

  it('uses the live active WCS for implicit-frame programs without reparsing', () => {
    const text = TEXT.replace(' G54', '')
    loadMachineProgram('implicit.nc', text, null)
    __reportWorkOffsetsForTest({ G55: { x: 90, y: 0, z: 0 } })
    parse.mockClear()
    useMachineControl.setState({ activeWcs: 'G55' })
    expect(transferReview().result.refusals).toEqual(['X program range 90..110 mm exceeds soft limits 0..100 mm.'])
    useMachineControl.setState({ activeWcs: 'G54' })
    expect(transferReview().result.refusals).toEqual([])
    expect(calls(text)).toBe(0)
  })

  it('prepares the exact M6-staged stream and keeps its parser facts immutable', () => {
    const text = 'G21 G90 G54\nG0 X0\nT1 M6\nG1 X20 F100\nM30'
    const staged = vi.spyOn(getMachineController(), 'loadJob')
    loadMachineProgram('tool-change.nc', text, null)
    const sent = staged.mock.calls.at(-1)![0]
    expect(sent).not.toBe(text)
    expect(useMachineControl.getState().programText).toBe(text)
    expect(calls(sent)).toBe(1)
    const index = parse.mock.calls.findIndex(args => args[0] === sent)
    const model = parse.mock.results[index].value as previewGeometry.PreviewModel
    expect(Object.isFrozen(model)).toBe(true)
    expect(Object.isFrozen(model.moves)).toBe(true)
    expect(Object.isFrozen(model.moves[0].to)).toBe(true)
    changeTarget(target(10))
    expect(transferReview().result.refusals).toEqual(['X program range 0..20 mm exceeds soft limits 0..10 mm.'])
    expect(calls(sent)).toBe(1)
    staged.mockRestore()
  })

  it('releases the active analysis when an empty Load clears transfer review', () => {
    loadMachineProgram('first.nc', TEXT, null)
    loadMachineProgram('empty.nc', '', null)
    expect(transferReview().result).toEqual({ refusals: [], warnings: [], notes: [] })
    parse.mockClear()
    loadMachineProgram('again.nc', TEXT, null)
    expect(calls(TEXT)).toBe(1)
  })

  it('does not prepare or adopt a waiting Load that expires during an MDI line', async () => {
    __resetEstopInterlockForTest()
    const ctrl = getMachineController()
    expect(ctrl.setMachinePosition?.({ x: 0, y: 0, z: 0 })).toBe(true)
    // WO-2659 defers the staged-program MDI route, not direct text commands.
    ;(ctrl.capabilities as { gcodeText: boolean }).gcodeText = false
    loadGcodeFile('active.nc', TEXT, null)
    expect(sendMdiLine('G53 G1 X90 F60')).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(ctrl.machineState()).toBe('run')
    const pending = TEXT.replace('X20', 'X21')
    loadGcodeFile('cancelled.nc', pending, null)
    expect(useMachineControl.getState().consoleLines.some(line => line.text === 'Load of "cancelled.nc" waits for the MDI line to finish.')).toBe(true)
    parse.mockClear()
    await vi.advanceTimersByTimeAsync(31000)
    expect(useMachineControl.getState().consoleLines.some(line => line.text.startsWith('Load of "cancelled.nc" canceled:'))).toBe(true)
    expect(calls(pending)).toBe(0)
    expect(useMachineControl.getState().programText).not.toBe(pending)
  })


  it('resolves each combined setup once while preserving independent live per-setup comparisons', () => {
    const project = JSON.parse(readFileSync('Example Projects/Full Suite.camproject', 'utf8')) as Project
    const setups = project.setups.slice(0, 2)
    const resolution = resolveDeclaredController(project.machine)
    if (!resolution.ok) throw new Error(resolution.reason)
    const posted = postProject(project, setups, resolution.dialect, { mode: 'combined', pauseBetweenSetups: false, baseName: 'control', ext: 'nc', modelRefsVerifiedSinceLoad: true })
    if (!posted.ok || !posted.combined?.operationSpans) throw new Error(JSON.stringify(posted.diagnostics))
    resolvePost.mockClear()
    const text = posted.combined.gcode
    const context = buildMultiSetupProgramContext(project, setups, resolution.dialect, text, posted.combined.operationSpans)
    const constructionResolutions = resolvePost.mock.calls.length
    expect(context.setups.map(s => s.setup.id)).toEqual(setups.map(s => s.id))
    expect(Object.isFrozen(context.setups[1].wcs.origin)).toBe(true)
    if (process.env.WO3125_MULTI_SNAPSHOT) writeFileSync(process.env.WO3125_MULTI_SNAPSHOT, JSON.stringify({ text, context }, null, 2) + '\n')
    resolvePost.mockClear()
    expect(compareProgramContextPerSetup(context, project, text, resolution.dialect).map(s => s.verdict)).toEqual(['current', 'current'])
    // A subsequent context build must not borrow earlier resolutions, including
    // a same-reference setup edit. Each setup still owns its own fresh input.
    setups[1].notes += ' changed after post'
    expect(compareProgramContextPerSetup(context, project, text, resolution.dialect).map(s => s.verdict)).toEqual(['current', 'project-changed'])
    expect(resolvePost).toHaveBeenCalledTimes(4)
    resolvePost.mockClear()
    const replacement = buildMultiSetupProgramContext(project, setups, resolution.dialect, text, posted.combined.operationSpans)
    expect(replacement.setups[0].projectFingerprint).toBe(context.setups[0].projectFingerprint)
    expect(replacement.setups[1].projectFingerprint).not.toBe(context.setups[1].projectFingerprint)
    expect(constructionResolutions, 'one post resolution per combined setup').toBe(2)
    expect(resolvePost).toHaveBeenCalledTimes(2)
  })

  it('preserves every posted byte, frozen Full Suite context, frame, staged lines and load outcome', () => {
    const bytes = readFileSync('Example Projects/Full Suite.camproject', 'utf8')
    // WO-3153 refreshed the shipped fixture at 9f52075a7e0bc519951880d5c182934b41b6a4ce.
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('cf5a10f40599d48d429fa40ed74368ea476c32d8bae2ad9e1989f79d47dff625')
    const project = JSON.parse(bytes) as Project
    useCamStore.setState({ project, toolLibrary: project.toolLibrary })
    const resolution = resolveDeclaredController(project.machine)
    if (!resolution.ok) throw new Error(resolution.reason)
    const setup = project.setups[0]
    const posted = postProject(project, [setup], resolution.dialect, { mode: 'combined', pauseBetweenSetups: false, baseName: 'control', ext: 'nc', modelRefsVerifiedSinceLoad: true })
    if (!posted.ok || !posted.combined?.operationSpans) throw new Error(JSON.stringify(posted.diagnostics))
    const text = posted.combined.gcode
    resolvePost.mockClear()
    const context = buildProgramContext(project, setup, resolution.dialect, text, posted.combined.operationSpans)
    const constructionResolutions = resolvePost.mock.calls.length
    const outcome = loadGcodeFile(`Setup: ${setup.name}`, text, context)
    const state = useMachineControl.getState()
    expect(state.programText).toBe(text)
    expect(state.programContext).toEqual(context)
    expect(Object.isFrozen(state.programContext)).toBe(true)
    const facts = { text, context: state.programContext, outcome, job: state.job, stagedProgram: state.stagedProgram, readiness: state.programReadiness, review: transferReview().result, activeWcs: state.activeWcs, offsets: state.offsets }
    if (process.env.WO3125_SNAPSHOT) writeFileSync(process.env.WO3125_SNAPSHOT, JSON.stringify(facts, null, 2) + '\n')
    changeTarget({ ...target(), name: 'Full Suite tool-table write' })
    expect(state.programContext?.motionDigest).toBe(context.motionDigest)
    expect(useMachineControl.getState().programText).toBe(text)
    expect(getMachineController().jobProgress().totalLines).toBe(state.job.totalLines)
    // Comparison is a fresh live walk, even when the caller mutates a fixture
    // in place. Sharing is confined to construction, never retained by identity.
    resolvePost.mockClear()
    expect(compareProgramContext(context, project, text, resolution.dialect)).toBe('current')
    const tool = project.toolLibrary.find(tool => tool.id === context.operations[0].toolId)!
    const diameter = tool.diameter
    try {
      tool.diameter += 0.125
      expect(compareProgramContext(context, project, text, resolution.dialect)).toBe('project-changed')
    } finally { tool.diameter = diameter }
    expect(resolvePost).toHaveBeenCalledTimes(2)
    expect(constructionResolutions, 'one post resolution per setup within real Load context construction').toBe(1)
  })
})


describe('WO-3125 staged transfer adoption', () => {
  it('adopts exact M6-staged preparation without reparsing and preserves the complete unprepared outcome', () => {
    const text = 'G21 G90 G54\nG1 X10 F100\nT2 M6\nG1 X20\nM30'
    const snapshot = () => {
      const s = useMachineControl.getState()
      return { text: s.programText, context: s.programContext, job: s.job,
        readiness: s.programReadiness, staged: s.stagedProgram, review: transferReview().result,
        activeWcs: s.activeWcs, offsets: s.offsets }
    }
    const unprepared = loadGcodeFile('same.nc', text, null)
    const before = snapshot()
    const stagedText = setupLoadStagedText(text)
    expect(stagedText).not.toBe(text)
    expect(stagedText).toContain('T2 M0')
    const prepared = structuredClone(prepareTransferLoad({ sourceText: text, stagedText,
      tables: setupLoadParserTables(), commentStyle: 'paren' }))
    freezeSetupTransfer(prepared)
    expect(Object.isFrozen(prepared.preview.moves[0])).toBe(true)
    parse.mockClear()
    const adopted = loadGcodeFile('same.nc', text, null, { preparedTransfer: prepared })
    expect(adopted).toEqual(unprepared)
    expect(snapshot()).toEqual(before)
    // Clear active retention first: this assertion must measure prepared adoption,
    // rather than accidentally getting a same-stream session cache hit.
    loadGcodeFile('empty.nc', '', null)
    parse.mockClear()
    loadGcodeFile('same.nc', text, null, { preparedTransfer: prepared })
    expect(calls(stagedText), 'prepared exact staged transfer is adopted without renderer parsing').toBe(0)
    expect(snapshot()).toEqual(before)
  })

  it('preserves the full posted program, all staged lines, context digests and live frame with prepared Full Suite adoption', () => {
    const bytes = readFileSync('Example Projects/Full Suite.camproject', 'utf8')
    // WO-3153 refreshed the shipped fixture at 9f52075a7e0bc519951880d5c182934b41b6a4ce.
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('cf5a10f40599d48d429fa40ed74368ea476c32d8bae2ad9e1989f79d47dff625')
    const project = JSON.parse(bytes) as Project
    useCamStore.setState({ project, toolLibrary: project.toolLibrary })
    const post = resolveDeclaredController(project.machine)
    if (!post.ok) throw new Error(post.reason)
    const posted = postProject(project, [project.setups[0]], post.dialect, { mode: 'combined', pauseBetweenSetups: false, baseName: 'control', ext: 'nc', modelRefsVerifiedSinceLoad: true })
    if (!posted.ok || !posted.combined?.operationSpans) throw new Error('Missing fixture post')
    const text = posted.combined.gcode
    const context = buildProgramContext(project, project.setups[0], post.dialect, text, posted.combined.operationSpans)
    const snapshot = (outcome: ReturnType<typeof loadGcodeFile>) => {
      const s = useMachineControl.getState()
      return { outcome, text: s.programText, context: s.programContext, job: s.job,
        staged: s.stagedProgram, readiness: s.programReadiness, review: transferReview().result,
        activeWcs: s.activeWcs, offsets: s.offsets }
    }
    const old = snapshot(loadGcodeFile('Full Suite.nc', text, context))
    loadGcodeFile('empty.nc', '', null)
    const prepared = prepareTransferLoad({ sourceText: text, stagedText: setupLoadStagedText(text),
      tables: setupLoadParserTables(), commentStyle: 'paren', simulator: setupLoadSimulatorInput() })
    freezeSetupTransfer(prepared)
    const ownParser = vi.spyOn(simulatorPreparation, 'prepareSimulatedProgram')
    ownParser.mockClear()
    parse.mockClear()
    const next = snapshot(loadGcodeFile('Full Suite.nc', text, context, { preparedTransfer: prepared }))
    expect(calls(prepared.stagedText), 'Full Suite staged preview is prepared outside adoption').toBe(0)
    expect(next).toEqual(old)
    expect(ownParser, 'Full Suite simulator facts are prepared outside adoption').not.toHaveBeenCalled()
    ownParser.mockRestore()
    if (process.env.WO3125_STAGED_SNAPSHOT) writeFileSync(process.env.WO3125_STAGED_SNAPSHOT, JSON.stringify({ old, next }, null, 2))
  })

  it('ignores a source-only preview for a different staged stream and rejudges live limits', () => {
    const text = 'G21 G90 G54\nG1 X10 F100\nT2 M6\nG1 X20\nM30'
    loadGcodeFile('empty.nc', '', null)
    const prepared = prepareTransferLoad({ sourceText: text, stagedText: text,
      tables: setupLoadParserTables(), commentStyle: 'paren' })
    freezeSetupTransfer(prepared)
    parse.mockClear()
    loadGcodeFile('m6.nc', text, null, { preparedTransfer: prepared })
    expect(calls(setupLoadStagedText(text))).toBe(1)
    changeTarget(target(10))
    expect(transferReview().result.refusals).toContain('X program range 0..20 mm exceeds soft limits 0..10 mm.')
  })
})

// Adversarial checks of the shared simulator preparation seam. These inspect
// the real staged graph as well as public Load outcomes, rather than treating
// the display parser or an rc=0 as an interpreter oracle.
describe('WO-3125 simulator prepared adoption', () => {
  const staged = (sim: SimulatedController) => {
    const state = sim as unknown as Record<string, unknown>
    return structuredClone({ moves: state.pendingProgram, effects: state.lineEffects,
      length: state.pendingLength, start: state.pendingStart, read: state.pendingRead,
      progress: sim.jobProgress() })
  }
  it('adopts cloneable immutable simulator facts without parsing and matches every move/effect/source reference', () => {
    const messages: unknown[] = []
    const sim = new SimulatedController({ onConsole: event => messages.push(event) }, {
      controlAxes: ['X', 'Y', 'Z', 'A'], workOffsets: { G54: { x: 10, y: 20, z: -5 }, G56: { x: 30, y: 40, z: -10 } },
      spindle: { spindleDirection: 'cw', minSpindleRpm: 100, maxSpindleRpm: 1000 },
    })
    const programs = [
      'G21 G90 G54\nT7 M3 S2000\nG0 Z5\nG1 X2 A15 F100\nG91 X1 Z-1\nG90 G56\nG53 G0 X0 Z0\nG4 P10\nM8\nM0\nM30',
      'G20 G90 G54\nG0 X1 Y1 Z1\nG1 X2 F10\nG3 X1 Y2 I-1 J0\nG28\nM30',
      'G21 G90 G54\nG0 X1 Y2 Z5\nG99 G83 X3 Y4 Z-3 R1 Q1 F100\nX5\nG80\nG98 G82 X7 Z-2 R1 P100\nG80\nM30',
      '(outer (nested) comment)\nG21 G90\nG0 X2\nG1 Y3 F200\nM30',
      'G21 G90\nM4 S2000\nG0 X2', // refusal still preserves the incumbent
      'G21 G90\nM3 S2000\nG1 X2', // notices before later refusal are retained
    ]
    const parseOwn = vi.spyOn(simulatorPreparation, 'prepareSimulatedProgram')
    try {
      for (const text of programs) {
        messages.length = 0
        const normal = sim.loadJob(text)
        const before = staged(sim), notices = structuredClone(messages)
        const facts = structuredClone(simulatorPreparation.prepareSimulatedProgram(text, sim.setupLoadPreparationInput()))
        freezeSimulatedProgram(facts)
        if (facts.parsed.ok) {
          expect(Object.isFrozen(facts.parsed.moves)).toBe(true)
          expect(Object.isFrozen(facts.parsed.moves[0])).toBe(true)
          expect([...facts.parsed.lengthMoves].every(move => facts.parsed.ok && facts.parsed.moves.includes(move))).toBe(true)
        }
        const pristine = structuredClone(facts)
        messages.length = 0
        parseOwn.mockClear()
        expect(sim.loadJob(text, facts)).toEqual(normal)
        expect(staged(sim)).toEqual(before)
        expect(messages).toEqual(notices)
        expect(facts).toEqual(pristine)
        expect(parseOwn, 'prepared simulator adoption never reruns its own interpreter').not.toHaveBeenCalled()
      }
    } finally { parseOwn.mockRestore() }
  })

  it('rejects every stale input receipt and different text through the same synchronous parser', () => {
    const sim = getMachineController() as SimulatedController
    const text = 'G21 G90 G54\nG0 Z1\nG1 X2 F100\nM30'
    const input = sim.setupLoadPreparationInput()
    const parseOwn = vi.spyOn(simulatorPreparation, 'prepareSimulatedProgram')
    const variants = [
      { ...input, session: input.session + 1 }, { ...input, activeWcs: 'G56' as const },
      { ...input, lastEnqueuedTarget: { ...input.lastEnqueuedTarget, z: 15 } },
      { ...input, wco: { ...input.wco, G54: { x: 100, y: 0, z: 0 } } },
      { ...input, tlo: 15 }, { ...input, controlAxes: ['X', 'Y'] as const },
      { ...input, homePosition: { x: 1, y: 2, z: 3 } }, { ...input, rapidMmMin: 1234 },
      { ...input, refusedAxes: ['x'] as const }, { ...input, outputCodes: [42] },
      { ...input, spindle: { spindleDirection: 'ccw' as const } },
      { ...input, dialect: { ...UCCNC_CONFIG, label: 'changed' } },
      { ...input, table: { ...input.table, id: 'changed-table' } },
      { ...input, parser: { ...input.parser, tool: 7 } },
    ]
    try {
      const normal = sim.loadJob(text), expected = staged(sim)
      for (const inputVariant of variants) {
        const facts = simulatorPreparation.prepareSimulatedProgram(text, inputVariant as typeof input)
        parseOwn.mockClear()
        expect(sim.loadJob(text, facts)).toEqual(normal)
        expect(staged(sim)).toEqual(expected)
        expect(parseOwn).toHaveBeenCalledTimes(1)
      }
      const facts = simulatorPreparation.prepareSimulatedProgram(text, input)
      parseOwn.mockClear()
      expect(sim.loadJob(text.replace('X2', 'X3'), facts).ok).toBe(true)
      expect(parseOwn).toHaveBeenCalledTimes(1)
    } finally { parseOwn.mockRestore() }
  })

  it('keeps from-line, mesh-line and work-zero reread on the same interpreter', async () => {
    const sim = new SimulatedController({}, { programHomeRequiredAxes: [] })
    const connecting = sim.connect({ kind: 'none' })
    await vi.advanceTimersByTimeAsync(400)
    await connecting
    const text = 'G21 G90 G54\nG0 Z1\nG1 X2 F100\nM30'
    const input = sim.setupLoadPreparationInput()
    const own = simulatorPreparation.prepareSimulatedProgram(text, input)
    expect(own.parsed.ok).toBe(true)
    const normal = sim.loadJob(text), expected = staged(sim)
    expect(sim.loadPreparedJob(own.prepared.lines)).toEqual(normal)
    expect(staged(sim)).toEqual(expected)
    const prelude = ['G21 G90 G54', 'G0 Z1']
    const from = sim.loadJobFrom(text, 3, prelude)
    if (!from.ok) throw new Error(from.reason)
    const direct = sim.loadPreparedJob(from.result.lines)
    expect(direct).toEqual(from)
    const facts = simulatorPreparation.prepareSimulatedProgram(text, sim.setupLoadPreparationInput())
    expect(sim.loadJob(text, facts)).toEqual(normal)
    const oldFacts = structuredClone(facts)
    await sim.sendCommand('G10 L2 P1 X10')
    const parseLines = vi.spyOn(simulatorPreparation, 'parseSimulatedProgramLines')
    try {
      // The explicitly switchless simulator reaches its actual Cycle Start reread.
      // A machine requiring a home correctly refuses before this boundary.
      sim.startJob()
      expect(parseLines).toHaveBeenCalled()
      expect(facts).toEqual(oldFacts)
    } finally { parseLines.mockRestore(); await sim.disconnect() }
  })
  it('retains prepared effects while the real simulator executes and consumes its own effects', async () => {
    const accessories: unknown[] = []
    const sim = new SimulatedController({ onAccessories: event => accessories.push(event) }, { programHomeRequiredAxes: [] })
    await sim.connect({ kind: 'none' })
    try {
      const text = 'G21 G90 G54\nM3 S500\nG1 X2 F1000\nM8\nM5\nM30'
      const facts = structuredClone(simulatorPreparation.prepareSimulatedProgram(text, sim.setupLoadPreparationInput()))
      freezeSimulatedProgram(facts)
      const original = structuredClone(facts)
      expect(sim.loadJob(text, facts).ok).toBe(true)
      expect(sim.startJob()).toBe(true)
      await vi.advanceTimersByTimeAsync(4000)
      expect(sim.jobProgress().phase).toBe('complete')
      expect(accessories).toContainEqual(expect.objectContaining({ spindle: 'cw' }))
      expect(accessories).toContainEqual(expect.objectContaining({ spindle: 'off' }))
      expect(facts, 'execution must not consume the retained prepared effects map').toEqual(original)
    } finally { await sim.disconnect() }
  })

})
