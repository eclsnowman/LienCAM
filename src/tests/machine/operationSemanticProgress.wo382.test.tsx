// @vitest-environment jsdom
//
// WO-382: operation-semantic progress in Control. While a program with a
// verified ('current') context is armed or running, Control says WHERE in the
// plan the machine is - "Running Face 1 (facing), operation 2 of 3" - derived
// ONLY from the streamer's canonical acked source line mapped through the
// verified spans. Metadata never advances the cursor; transitions happen at
// verified executable source-line boundaries and stay right across comments,
// skipped lines, tool changes, hold/resume, Stop/Reset, run-from-line and Step
// Back. The cycle log and the recovery review name the operation when the
// context is current; stale or no-context programs keep the line-only UI.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

// Operation semantics live in ProgramPanel. Its 3D preview is deliberately
// outside this test's subject and requires a WebGL context jsdom cannot supply.
// Keep the page real while replacing only that rendering leaf, through the
// module's real export contract.
vi.mock('../../components/machine/ProgramPreview', () =>
  typedMock<typeof import('../../components/machine/ProgramPreview')>({
    ProgramPreview: () => <div data-testid="program-preview-stub" />,
  }))

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

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { CycleLogPanel } = await import('../../components/machine/CycleLogPanel')
const {
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  setMachineSingleBlock,
  stepBackOneLine,
  __resetEstopInterlockForTest,
} = await import('../../lib/machine/machineSession')
const {
  buildProgramContext,
  deriveOperationProgress,
  describeOperationAtProgress,
  operationAtSourceLine,
  operationExecutableBounds,
  operationKindLabel,
} = await import('../../lib/machine/programContext')
type ProgramContextV1 = import('../../lib/machine/programContext').ProgramContextV1
const { isSendableGcodeLine, prepareProgram } = await import('../../lib/gcode/text')
const { GRBL_CONFIG, postProject, importProgramContextFromGcode } = await import('../../lib/post')
const { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } = await import('../post/helpers')
import type { Operation, Project, Setup, Stock } from '../../types'
import { useUiPrefs } from '../../store/uiPrefs'

// ---------------------------------------------------------------------------
// Fixture: a REAL posted three-operation program (through postProject), so the
// spans, comments, blank lines and the tool-change pause are the post's own.
// ---------------------------------------------------------------------------

function makeStock(): Stock {
  return { type: 'rectangular', width: 100, depth: 100, height: 20, origin: { x: 0, y: 0, z: 0 }, material: 'aluminum' } as unknown as Stock
}
/** `cuts` feed moves after the approach rapid: 2 for the compact program the
 *  pure table pins; more for the simulator runs so the job outlasts GRBL's
 *  15-slot planner and the acks trickle in with real (fake-timer) motion. */
function makeCutOp(id: string, name: string, type: Operation['type'], toolId: string, cuts: number): Operation {
  const moves = [move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' })]
  for (let i = 0; i < cuts; i++) {
    moves.push(move({ type: 'feed', x: i % 2 === 0 ? 30.5 : 10.5, y: 20 + i * 0.5, z: 5, feed: 2000, role: 'cut' }))
  }
  return makeOp({ id, name, type, toolId, toolpathMoves: moves })
}
/** `twoTools` puts Pocket 2 and Contour 3 on T2 so the post emits a tool
 *  change (M5 / M9 / G0 Z5 / comment / M0 / ...) inside the Pocket span. */
function makeProject(id: string, twoTools: boolean, cuts = 2): Project {
  const t2 = twoTools ? 't2' : 't1'
  const setup: Setup = {
    id: 's1', name: 'Setup One',
    wcs: makeWcs({ id: 'wcs-s1', label: 'G54', fixtureOffset: 54 }),
    stock: makeStock(),
    operations: [
      makeCutOp('opA', 'Face 1', 'face', 't1', cuts),
      makeCutOp('opB', 'Pocket 2', 'pocket_2d', t2, cuts),
      makeCutOp('opC', 'Contour 3', 'contour_2d', t2, cuts),
    ],
    notes: 'as posted',
  }
  const project: Project = {
    id, name: id, version: '1', createdAt: '', updatedAt: '',
    // ProgramPanel compares against the dialect declared by the live machine.
    // This fixture intentionally pins GRBL's manual tool-change layout below,
    // so the machine must make the same declaration as the post it exercises.
    machine: makeMachine({ controller: 'grbl' }),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 }), makeTool({ id: 't2', toolNumber: 2 })],
    geometry: [], setups: [setup], activeSetupId: 's1', activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '',
  }
  for (const op of setup.operations) stampGenerationCurrent(project, setup, op, project.toolLibrary.find((t) => t.id === op.toolId)!)
  return project
}

const OPTS = { mode: 'combined' as const, pauseBetweenSetups: false, baseName: 'part', ext: 'nc' }

interface Posted { project: Project; gcode: string; context: ProgramContextV1; exported: string }
function post(id: string, twoTools: boolean, cuts = 2): Posted {
  const project = makeProject(id, twoTools, cuts)
  const plain = postProject(project, project.setups, GRBL_CONFIG, OPTS).combined!
  const exported = postProject(project, project.setups, GRBL_CONFIG, { ...OPTS, programContext: true }).combined!
  const context = buildProgramContext(project, project.setups[0], GRBL_CONFIG, plain.gcode, plain.operationSpans!)
  return { project, gcode: plain.gcode, context, exported: exported.gcode }
}

const LABEL = {
  op1: 'Face 1 (facing), operation 1 of 3',
  op2: 'Pocket 2 (2D pocket), operation 2 of 3',
  op3: 'Contour 3 (2D contour), operation 3 of 3',
}

// ---------------------------------------------------------------------------
// A. The pure derivation - every executable boundary, table-driven.
// ---------------------------------------------------------------------------

describe('WO-382: deriveOperationProgress over a real posted program (pure)', () => {
  const { gcode, context } = post('pure', true)
  const rawLines = gcode.split(/\r?\n/)

  it('the fixture is the program this table describes (tool change inside the Pocket span)', () => {
    // Pin the emitted layout the table below relies on; a post change must
    // fail HERE with a plain reason, not silently shift every expectation.
    // WO-2023 inserted only `G0 Z5`: line 8 after T1 and line 21 after the T2
    // change. The repinned spans, bounds and cases below still name the same
    // comments, cut moves and phase boundaries as before those two insertions.
    expect(context.operations.map((o) => [o.name, o.startLine, o.endLine])).toEqual([
      ['Face 1', 4, 11],
      ['Pocket 2', 12, 24],
      ['Contour 3', 25, 28],
    ])
    expect(rawLines[3]).toBe('( Face 1 )') // a comment opens every span
    expect(rawLines[16]).toBe('M0') // the tool-change pause sits inside Pocket 2
    expect(operationExecutableBounds(context, gcode)).toEqual([
      { firstExecutableLine: 5, lastExecutableLine: 11 },
      { firstExecutableLine: 13, lastExecutableLine: 24 },
      { firstExecutableLine: 26, lastExecutableLine: 28 },
    ])
  })

  // Expected (current operation index, its status, completed count) for every
  // acked source line while streaming. Header -> op 1 pending; an operation is
  // active from its first executable line and completed AT its last one, at
  // which moment the next is current as pending; footer -> past the last.
  const table: Array<[line: number, current: number | null, status: string | null, completed: number]> = [
    [1, 1, 'pending', 0], [3, 1, 'pending', 0],
    [5, 1, 'active', 0], [6, 1, 'active', 0], [7, 1, 'active', 0], [8, 1, 'active', 0], [9, 1, 'active', 0], [10, 1, 'active', 0],
    [11, 2, 'pending', 1],
    [13, 2, 'active', 1], [14, 2, 'active', 1], [15, 2, 'active', 1], [17, 2, 'active', 1], [18, 2, 'active', 1],
    [19, 2, 'active', 1], [20, 2, 'active', 1], [21, 2, 'active', 1], [22, 2, 'active', 1], [23, 2, 'active', 1],
    [24, 3, 'pending', 2],
    [26, 3, 'active', 2], [27, 3, 'active', 2],
    [28, null, null, 3],
    [29, null, null, 3], [30, null, null, 3], [31, null, null, 3], [32, null, null, 3],
  ]

  it('the table covers every executable line of the program and nothing else', () => {
    const executable = rawLines.map((l, i) => (isSendableGcodeLine(l) ? i + 1 : 0)).filter(Boolean)
    expect(table.map((r) => r[0])).toEqual(executable)
    expect(prepareProgram(gcode).lines.map((l) => l.sourceLine)).toEqual(executable)
  })

  it.each(table)('acked line %i -> operation %s %s (%i complete)', (line, current, status, completed) => {
    const p = deriveOperationProgress(context, gcode, { phase: 'streaming', ackedSourceLine: line })!
    expect(p).not.toBeNull()
    expect(p.cursor).toBe(line)
    expect(p.current?.index ?? null).toBe(current)
    expect(p.current?.status ?? null).toBe(status)
    expect(p.completedCount).toBe(completed)
    expect(p.total).toBe(3)
    expect(p.allComplete).toBe(current === null)
    if (current !== null) {
      const expectedLabel = [LABEL.op1, LABEL.op2, LABEL.op3][current - 1]
      expect(p.operationLabel).toBe(expectedLabel)
      expect(p.headline).toBe(status === 'active' ? `Running ${expectedLabel}` : `Next: ${expectedLabel}`)
    } else {
      expect(p.operationLabel).toBeNull()
      expect(p.headline).toBe('Past the last operation (3 of 3)')
    }
  })

  it('the cursor only ever moves forward through the plan as acks advance', () => {
    let lastIndex = 0
    let lastCompleted = 0
    for (const [line] of table) {
      const p = deriveOperationProgress(context, gcode, { phase: 'streaming', ackedSourceLine: line })!
      const index = p.current?.index ?? 4
      expect(index).toBeGreaterThanOrEqual(lastIndex)
      expect(p.completedCount).toBeGreaterThanOrEqual(lastCompleted)
      lastIndex = index
      lastCompleted = p.completedCount
    }
  })

  it('comment, blank and % lines inside a span cannot complete or activate it (they are never acked)', () => {
    // Line 4 "( Face 1 )" is inside the Face span but before its first
    // executable line: were a comment ever handed in as the cursor, Face is
    // still only pending - a comment cannot advance the plan.
    expect(deriveOperationProgress(context, gcode, { phase: 'streaming', ackedSourceLine: 4 })!.current).toMatchObject({ index: 1, status: 'pending' })
    // Line 25 "( Contour 3 )": Pocket is complete (24 acked is not implied - the
    // derivation is a pure function of the cursor, and 25 > 24), Contour pending.
    expect(deriveOperationProgress(context, gcode, { phase: 'streaming', ackedSourceLine: 25 })!.current).toMatchObject({ index: 3, status: 'pending' })
    expect(operationAtSourceLine(context, 4)).toMatchObject({ index: 1 })
    expect(operationAtSourceLine(context, 17)).toMatchObject({ index: 2 })
    expect(operationAtSourceLine(context, 29)).toBeNull()
    expect(operationAtSourceLine(context, 0)).toBeNull()
  })

  it('armed, nothing acked: the first operation is next; a mid-program arm skips the operations before it', () => {
    const top = deriveOperationProgress(context, gcode, { phase: 'ready', ackedSourceLine: 0 })!
    expect(top.state).toBe('armed')
    expect(top.headline).toBe(`Next: ${LABEL.op1}`)
    expect(top.entries.map((e) => e.status)).toEqual(['pending', 'pending', 'pending'])

    const mid = deriveOperationProgress(context, gcode, { phase: 'ready', ackedSourceLine: 0, armedFromLine: 22 })!
    expect(mid.headline).toBe(`Next: ${LABEL.op2}`)
    expect(mid.entries.map((e) => e.status)).toEqual(['skipped', 'pending', 'pending'])

    const late = deriveOperationProgress(context, gcode, { phase: 'ready', ackedSourceLine: 0, armedFromLine: 26 })!
    expect(late.headline).toBe(`Next: ${LABEL.op3}`)
    expect(late.entries.map((e) => e.status)).toEqual(['skipped', 'skipped', 'pending'])

    // Prelude lines ack with sourceLine 0 - the hint still holds until a
    // PROGRAM line is acked; once it is, the acked line wins over the hint.
    const prelude = deriveOperationProgress(context, gcode, { phase: 'streaming', ackedSourceLine: 0, armedFromLine: 22 })!
    expect(prelude.headline).toBe(`Next: ${LABEL.op2}`)
    const acked = deriveOperationProgress(context, gcode, { phase: 'streaming', ackedSourceLine: 22, armedFromLine: 22 })!
    expect(acked.headline).toBe(`Running ${LABEL.op2}`)
    expect(acked.entries.map((e) => e.status)).toEqual(['skipped', 'active', 'pending'])
  })

  it.each([
    ['ready', 13, 'armed', `Next: ${LABEL.op2}`],
    ['streaming', 13, 'running', `Running ${LABEL.op2}`],
    ['paused', 13, 'held', `Held in ${LABEL.op2}`],
    ['paused', 11, 'held', `Held before ${LABEL.op2}`],
    ['failed', 13, 'failed', `Failed in ${LABEL.op2}`],
    ['failed', 11, 'failed', `Failed before ${LABEL.op2}`],
    ['failed', 32, 'failed', 'Failed after the last operation (3 of 3)'],
    ['complete', 32, 'complete', 'All 3 operations complete'],
  ] as const)('phase %s at line %i reads as %s: "%s"', (phase, line, state, headline) => {
    // 'ready' ignores the acked line when it is 0 only; here a re-armed
    // 'ready' with a stale acked line is not a real streamer state, so the
    // table passes 0 for it and the armedFromLine hint instead.
    const input = phase === 'ready'
      ? { phase, ackedSourceLine: 0, armedFromLine: line }
      : { phase, ackedSourceLine: line }
    const p = deriveOperationProgress(context, gcode, input)!
    expect(p.state).toBe(state)
    expect(p.headline).toBe(headline)
  })

  it('has nothing to say for an empty streamer, a null context, or an operation-free context', () => {
    expect(deriveOperationProgress(context, gcode, { phase: 'empty', ackedSourceLine: 0 })).toBeNull()
    expect(deriveOperationProgress(null, gcode, { phase: 'streaming', ackedSourceLine: 5 })).toBeNull()
    expect(deriveOperationProgress(context, null, { phase: 'streaming', ackedSourceLine: 5 })).toBeNull()
    expect(deriveOperationProgress({ ...context, operations: [] }, gcode, { phase: 'streaming', ackedSourceLine: 5 })).toBeNull()
    expect(describeOperationAtProgress(context, gcode, { phase: 'streaming', ackedSourceLine: 30 })).toBeNull()
    expect(describeOperationAtProgress(context, gcode, { phase: 'streaming', ackedSourceLine: 13 })).toBe(LABEL.op2)
  })

  it('names every operation kind in plain words', () => {
    expect(operationKindLabel('adaptive_clearing_2d')).toBe('2D adaptive')
    expect(operationKindLabel('drill')).toBe('drilling')
    expect(operationKindLabel('parallel_3d')).toBe('3D parallel')
  })

  it('a verified-export (WO-381) context derives the same semantics as the direct one at every line', () => {
    const { gcode: g, context: direct, exported } = post('equiv', true)
    const imported = importProgramContextFromGcode(exported)
    expect(imported.warning).toBeNull()
    const ctx = imported.context!
    expect(ctx.source).toBe('verified-export')
    for (let line = 0; line <= g.split(/\r?\n/).length; line++) {
      for (const phase of ['ready', 'streaming', 'paused', 'failed', 'complete'] as const) {
        const a = deriveOperationProgress(direct, g, { phase, ackedSourceLine: line })
        const b = deriveOperationProgress(ctx, g, { phase, ackedSourceLine: line })
        expect(b?.headline).toBe(a?.headline)
        expect(b?.entries.map((e) => e.status)).toEqual(a?.entries.map((e) => e.status))
      }
    }
  })
})

// ---------------------------------------------------------------------------
// B. Through the real session: simulator, store, ProgramPanel, CycleLogPanel.
// ---------------------------------------------------------------------------

async function connectSimulator(): Promise<void> {
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  await vi.advanceTimersByTimeAsync(300)
  // Operator 2026-09-14 ("A: Flash, all motion off"): this suite is about
  // operation-semantic progress through a real run, not the fresh-connect
  // E-STOP latch.
  __resetEstopInterlockForTest()
  expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
}

async function teardown(): Promise<void> {
  cleanup()
  act(() => { useMachineControl.setState({ operationListExpanded: false }) })
  act(() => { getMachineController().emergencyStop() })
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(200)
  await pending
  vi.useRealTimers()
  act(() => {
    setMachineSingleBlock(false)
    useMachineControl.setState({ cycleEvents: [] })
  })
}

async function settle(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function operationText(): string | null {
  // Operator review 2026-08-20: the row is a compact headline + a disclosure chevron;
  // the per-operation list lives under the row, so the text read here is the
  // headline alone.
  return screen.queryByTestId('control-operation-headline')?.textContent ?? null
}

function listItems(): Array<{ index: string | null; status: string | null; text: string }> {
  return screen.queryAllByTestId('control-operation-item').map((li) => ({
    index: li.getAttribute('data-operation-index'),
    status: li.getAttribute('data-status'),
    text: li.textContent ?? '',
  }))
}

function mount(): void {
  act(() => { useUiPrefs.setState({ machineCycleLogCollapsed: false }) })
  render(
    <>
      <ProgramPanel />
      <CycleLogPanel />
    </>,
  )
}

function logRows(): Array<{ event: string; operation: string | null }> {
  return useMachineControl.getState().cycleEvents.map((e) => ({ event: e.event, operation: e.operation }))
}

/** Advance the simulator in small steps, recording every distinct operation
 *  text, until the predicate holds or the budget runs out. */
async function runUntil(seen: string[], done: () => boolean, budgetMs = 240_000): Promise<void> {
  const sample = () => {
    const text = operationText()
    if (text !== null && seen[seen.length - 1] !== text) seen.push(text)
  }
  sample()
  for (let t = 0; t < budgetMs && !done(); t += 20) {
    await settle(20)
    sample()
  }
}

describe('WO-382: operation-semantic progress through the real simulator session', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    await connectSimulator()
  }, 30_000)
  afterEach(teardown)

  it('direct load: armed shows the first operation; the run walks 1 -> 2 -> 3 -> all complete; the log names operations', async () => {
    const { project, gcode, context } = post('direct', false, 40)
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    act(() => { loadMachineProgram('part.nc', gcode, context) })
    mount()
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('current')
    expect(operationText()).toBe(`Next: ${LABEL.op1}`)
    expect(screen.getByTestId('control-operation').getAttribute('data-state')).toBe('armed')
    expect(useMachineControl.getState().programContextVerdict).toBe('current')

    act(() => { expect(getMachineController().startJob()).toBe(true) })
    const seen: string[] = []
    await runUntil(seen, () => useMachineControl.getState().job.phase === 'complete')
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(operationText()).toBe('All 3 operations complete')

    // Every observed text is one of the legal states, in plan order.
    const order = (s: string) => (s.includes('Face 1') ? 1 : s.includes('Pocket 2') ? 2 : s.includes('Contour 3') ? 3 : 4)
    const indices = seen.map(order)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
    expect(seen.some((s) => s === `Running ${LABEL.op1}`)).toBe(true)
    expect(seen.some((s) => s === `Running ${LABEL.op2}` || s === `Next: ${LABEL.op2}`)).toBe(true)
    expect(seen.some((s) => s === `Running ${LABEL.op3}` || s === `Next: ${LABEL.op3}`)).toBe(true)
    expect(seen[seen.length - 1]).toBe('All 3 operations complete')

    const rows = logRows()
    expect(rows[0]).toEqual({ event: 'started', operation: LABEL.op1 })
    expect(rows[rows.length - 1].event).toBe('completed')
    expect(screen.getAllByTestId('control-cyclelog-operation')[0].textContent).toContain('Face 1 (facing)')
  }, 30_000)

  it('hold and resume keep the same operation and the log names it; Stop/Reset drops back to the line-only row', async () => {
    const { project, gcode, context } = post('hold', false, 40)
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    act(() => { loadMachineProgram('part.nc', gcode, context) })
    mount()
    act(() => { expect(getMachineController().startJob()).toBe(true) })
    await settle(300)
    const before = operationText()!
    expect(before.startsWith('Running ')).toBe(true)

    // A feed hold: the streamer stops filling, the machine reports Hold.
    act(() => { getMachineController().pauseJob() })
    await settle(600)
    expect(useMachineControl.getState().machineState).toBe('hold')
    expect(operationText()).toBe(before.replace(/^Running /, 'Held in '))
    expect(screen.getByTestId('control-operation').getAttribute('data-state')).toBe('held')

    act(() => { expect(getMachineController().resumeJob()).toBe(true) })
    await settle(600)
    expect(useMachineControl.getState().machineState).not.toBe('hold')
    expect(operationText()!.startsWith('Running ')).toBe(true)

    act(() => { getMachineController().stopJob() })
    await settle(1500)
    expect(useMachineControl.getState().job.phase).toBe('empty')
    expect(operationText()).toBeNull()
    expect(screen.getByTestId('control-progress-text').textContent).toBe('no program')

    const rows = logRows()
    expect(rows.map((r) => r.event)).toEqual(['started', 'paused', 'resumed', 'stopped'])
    expect(rows[1].operation).toMatch(/operation \d of 3$/)
    expect(rows[2].operation).toBe(rows[1].operation)
    expect(rows[3].operation).toMatch(/operation \d of 3$/)
  }, 30_000)

  it('run-from-line: the review names the operation, the armed row says Next, the run never claims a skipped operation', async () => {
    const { project, gcode, context } = post('runfrom', false, 40)
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    act(() => { loadMachineProgram('part.nc', gcode, context) })
    mount()
    const bounds = operationExecutableBounds(context, gcode)
    const target = bounds[1].firstExecutableLine + 1 // inside Pocket 2
    await act(async () => {
      fireEvent.change(screen.getByTestId('control-runfrom-input'), { target: { value: String(target) } })
    })
    await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-plan')) })
    await settle(100)
    expect(screen.getByTestId('control-runfrom-planbox')).toBeTruthy()
    expect(screen.getByTestId('control-runfrom-operation').textContent).toBe(`Starts in ${LABEL.op2}.`)
    expect(useMachineControl.getState().armedFromLine).toBe(target)
    expect(operationText()).toBe(`Next: ${LABEL.op2}`)
    // The skipped operation is visible in the expanded list (no tooltip any more).
    act(() => { fireEvent.click(screen.getByTestId('control-operation-toggle')) })
    expect(listItems()[0]).toMatchObject({ index: '1', status: 'skipped' })
    expect(listItems()[0].text).toContain('Face 1')
    act(() => { fireEvent.click(screen.getByTestId('control-operation-toggle')) })
    expect(screen.queryByTestId('control-operation-list')).toBeNull()

    act(() => { expect(getMachineController().startJob()).toBe(true) })
    const seen: string[] = []
    await runUntil(seen, () => useMachineControl.getState().job.phase === 'complete')
    expect(seen.some((s) => s.includes('Face 1'))).toBe(false)
    expect(seen.some((s) => s === `Running ${LABEL.op2}`)).toBe(true)
    expect(operationText()).toBe('Program complete - 2 of 3 operations ran')
    expect(logRows()[0]).toEqual({ event: 'started', operation: LABEL.op2 })

    // Cancel / re-load from the top clears the hint: the first operation is next again.
    act(() => { loadMachineProgram('part.nc', gcode) })
    expect(useMachineControl.getState().armedFromLine).toBeNull()
    expect(operationText()).toBe(`Next: ${LABEL.op1}`)
  }, 30_000)

  it('Step Back re-arms inside the operation the cursor was in and says so', async () => {
    const { project, gcode, context } = post('stepback', false)
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    act(() => { loadMachineProgram('part.nc', gcode, context) })
    mount()
    act(() => { setMachineSingleBlock(true) })
    const ctrl = getMachineController()
    // Step into Face 1 (line 5 is its first executable line): header 1, 3, then 5, 6, 7.
    for (let i = 0; i < 5; i++) {
      act(() => { expect(ctrl.stepJob()).toBe(true) })
      await settle(600)
    }
    expect(useMachineControl.getState().job.ackedSourceLine).toBe(7)
    expect(operationText()).toBe(`Held in ${LABEL.op1}`)
    let result: Awaited<ReturnType<typeof stepBackOneLine>> | null = null
    await act(async () => {
      const pending = stepBackOneLine()
      await vi.advanceTimersByTimeAsync(1500)
      result = await pending
    })
    expect(result).toMatchObject({ ok: true })
    await settle(100)
    expect(ctrl.jobProgress().phase).toBe('ready')
    expect(useMachineControl.getState().armedFromLine).toBe(6)
    expect(screen.getByTestId('control-runfrom-operation').textContent).toBe(`Starts in ${LABEL.op1}.`)
    expect(operationText()).toBe(`Next: ${LABEL.op1}`)
  }, 30_000)

  it('a stale context (project changed after post) and a no-context file keep the line-only UI with no error', async () => {
    const { project, gcode, context } = post('stale', false)
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    act(() => { loadMachineProgram('part.nc', gcode, context) })
    mount()
    expect(operationText()).not.toBeNull()
    act(() => {
      useCamStore.setState((st) => ({
        project: { ...st.project, setups: st.project.setups.map((s) => ({ ...s, notes: 'edited after post' })) },
      }))
    })
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('project-changed')
    expect(operationText()).toBeNull()
    expect(useMachineControl.getState().programContextVerdict).toBe('project-changed')
    expect(screen.queryByTestId('control-load-error')).toBeNull()
    act(() => { expect(getMachineController().startJob()).toBe(true) })
    await settle(300)
    expect(operationText()).toBeNull()
    expect(screen.getByTestId('control-progress-text').textContent).toMatch(/^\d+\/\d+ \(\d+%\)/)
    expect(logRows()[0]).toEqual({ event: 'started', operation: null })
    act(() => { getMachineController().stopJob() })
    await settle(1500)

    act(() => { loadMachineProgram('foreign.nc', 'G21 G90 G54\nG0 X0 Y0\nG1 X5 F500\nM30\n') })
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('no-context')
    expect(operationText()).toBeNull()
    act(() => { expect(getMachineController().startJob()).toBe(true) })
    await settle(300)
    expect(operationText()).toBeNull()
    expect(screen.queryByTestId('control-cyclelog-operation')).toBeNull()
  })

  it('a WO-381 import behaves exactly like a direct load in Control', async () => {
    const { project, exported } = post('import', false, 40)
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    const imported = importProgramContextFromGcode(exported)
    expect(imported.context?.source).toBe('verified-export')
    act(() => { loadMachineProgram('part-exported.nc', exported, imported.context) })
    mount()
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('current')
    expect(operationText()).toBe(`Next: ${LABEL.op1}`)
    act(() => { expect(getMachineController().startJob()).toBe(true) })
    const seen: string[] = []
    await runUntil(seen, () => useMachineControl.getState().job.phase === 'complete')
    expect(seen.some((s) => s === `Running ${LABEL.op1}`)).toBe(true)
    expect(seen.some((s) => s.includes('Contour 3'))).toBe(true)
    expect(operationText()).toBe('All 3 operations complete')
    expect(logRows()[0]).toEqual({ event: 'started', operation: LABEL.op1 })
  }, 30_000)

  it('a failed line names the operation it failed in; the cycle log carries it', () => {
    const { project, gcode, context } = post('failed', true)
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    act(() => { loadMachineProgram('part.nc', gcode, context) })
    mount()
    act(() => {
      useMachineControl.getState().applyJobProgress({
        phase: 'failed', totalLines: 25, sentLines: 12, ackedLines: 12,
        ackedSourceLine: 13, sentSourceLine: 14, bytesInFlight: 0,
      })
      // WO-423: the store carries the contract's JobFault - `line` for a text
      // backend, `moveId` for a geometry one.
      useMachineControl.getState().applyJobEvent('failed', { code: 20, message: 'Unsupported command (M9)', line: 13, moveId: null })
    })
    expect(operationText()).toBe(`Failed in ${LABEL.op2}`)
    expect(screen.getByTestId('control-operation').getAttribute('data-state')).toBe('failed')
    expect(logRows()[0]).toEqual({ event: 'failed', operation: LABEL.op2 })
  })
})

// ---------------------------------------------------------------------------
// C. Store boundary: the verdict gates every semantic claim; setProgram resets.
// ---------------------------------------------------------------------------

describe('WO-382 (Operator review 2026-08-20): the operation list is a collapsed-by-default disclosure', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    await connectSimulator()
  }, 30_000)
  afterEach(teardown)

  it('collapsed by default: one compact line plus a chevron, no list, no tooltip', () => {
    const { project, gcode, context } = post('collapsed', false, 40)
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    act(() => { loadMachineProgram('part.nc', gcode, context) })
    mount()
    const row = screen.getByTestId('control-operation')
    expect(row.getAttribute('data-expanded')).toBe('false')
    expect(row.getAttribute('data-tooltip')).toBeNull()
    expect(operationText()).toBe(`Next: ${LABEL.op1}`)
    const toggle = screen.getByTestId('control-operation-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('control-operation-list')).toBeNull()
    expect(useMachineControl.getState().operationListExpanded).toBe(false)
  })

  it('expand shows every operation in plan order with status and line span, in flow under the row', () => {
    const { project, gcode, context } = post('expanded', false, 40)
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    act(() => { loadMachineProgram('part.nc', gcode, context) })
    mount()
    act(() => { fireEvent.click(screen.getByTestId('control-operation-toggle')) })
    expect(screen.getByTestId('control-operation').getAttribute('data-expanded')).toBe('true')
    expect(screen.getByTestId('control-operation-toggle').getAttribute('aria-expanded')).toBe('true')
    const list = screen.getByTestId('control-operation-list')
    // In flow: the list is a sibling of the progress row inside the transport
    // row, not a child of the headline span and not a floating surface.
    expect(list.parentElement).toBe(screen.getByTestId('control-operation').closest('.control-transport'))
    expect(list.closest('[data-testid="control-operation"]')).toBeNull()
    const items = listItems()
    expect(items.map((i) => i.index)).toEqual(['1', '2', '3'])
    expect(items.map((i) => i.status)).toEqual(['pending', 'pending', 'pending'])
    for (let i = 0; i < 3; i++) {
      const op = context!.operations[i]
      expect(items[i].text).toContain(op.name)
      expect(items[i].text).toContain(operationKindLabel(op.type))
      expect(items[i].text).toContain(`lines ${op.startLine}-${op.endLine}`)
    }
    expect(useMachineControl.getState().operationListExpanded).toBe(true)
  })

  it('collapse hides the list again, and the choice survives a remount for the session', () => {
    const { project, gcode, context } = post('remount', false, 40)
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    act(() => { loadMachineProgram('part.nc', gcode, context) })
    mount()
    act(() => { fireEvent.click(screen.getByTestId('control-operation-toggle')) })
    expect(screen.getByTestId('control-operation-list')).toBeTruthy()
    cleanup()
    mount()
    expect(screen.getByTestId('control-operation-list')).toBeTruthy()
    act(() => { fireEvent.click(screen.getByTestId('control-operation-toggle')) })
    expect(screen.queryByTestId('control-operation-list')).toBeNull()
    expect(screen.getByTestId('control-operation').getAttribute('data-expanded')).toBe('false')
    expect(operationText()).toBe(`Next: ${LABEL.op1}`)
    cleanup()
    mount()
    expect(screen.queryByTestId('control-operation-list')).toBeNull()
  })

  it('the expanded list follows the run: active / completed rows, held on the active row during a feed hold', async () => {
    const { project, gcode, context } = post('follow', false, 40)
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    act(() => { loadMachineProgram('part.nc', gcode, context) })
    mount()
    act(() => { fireEvent.click(screen.getByTestId('control-operation-toggle')) })
    act(() => { expect(getMachineController().startJob()).toBe(true) })
    await settle(300)
    expect(listItems()[0].status).toBe('active')
    act(() => { getMachineController().pauseJob() })
    await settle(600)
    expect(useMachineControl.getState().machineState).toBe('hold')
    expect(listItems().filter((i) => i.status === 'held').length).toBe(1)
    act(() => { expect(getMachineController().resumeJob()).toBe(true) })
    await settle(600)
    const seen: string[] = []
    await runUntil(seen, () => useMachineControl.getState().job.phase === 'complete')
    expect(listItems().map((i) => i.status)).toEqual(['completed', 'completed', 'completed'])
    expect(screen.getByTestId('control-operation-list')).toBeTruthy()
  }, 30_000)

  it('stale and no-context programs render neither the row, the chevron nor the list, expanded or not', async () => {
    act(() => { useMachineControl.setState({ operationListExpanded: true }) })
    const { project, gcode, context } = post('stale2', false)
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    act(() => { loadMachineProgram('part.nc', gcode, context) })
    mount()
    expect(screen.getByTestId('control-operation-list')).toBeTruthy()
    act(() => {
      useCamStore.setState((st) => ({
        project: { ...st.project, setups: st.project.setups.map((s) => ({ ...s, notes: 'edited after post' })) },
      }))
    })
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('project-changed')
    expect(screen.queryByTestId('control-operation')).toBeNull()
    expect(screen.queryByTestId('control-operation-toggle')).toBeNull()
    expect(screen.queryByTestId('control-operation-list')).toBeNull()
    expect(screen.queryByTestId('control-load-error')).toBeNull()

    act(() => { loadMachineProgram('foreign.nc', 'G21 G90 G54\nG0 X0 Y0\nG1 X5 F500\nM30\n') })
    expect(screen.getByTestId('control-program-context').getAttribute('data-staleness')).toBe('no-context')
    expect(screen.queryByTestId('control-operation')).toBeNull()
    expect(screen.queryByTestId('control-operation-toggle')).toBeNull()
    expect(screen.queryByTestId('control-operation-list')).toBeNull()
    act(() => { expect(getMachineController().startJob()).toBe(true) })
    await settle(300)
    expect(screen.queryByTestId('control-operation-list')).toBeNull()
    expect(screen.queryByTestId('control-load-error')).toBeNull()
  })
})

describe('WO-382: store boundary', () => {
  afterEach(() => {
    useMachineControl.setState({ cycleEvents: [], programContextVerdict: null, armedFromLine: null })
  })

  it('names an operation in the log only while the verdict is current, and never for a no-context load', () => {
    const { gcode, context } = post('store', false)
    const s = useMachineControl.getState()
    s.setProgram('part.nc', gcode, [], context)
    expect(useMachineControl.getState().programContextVerdict).toBeNull()
    s.applyJobProgress({ phase: 'streaming', totalLines: 20, sentLines: 6, ackedLines: 5, ackedSourceLine: 6, sentSourceLine: 7, bytesInFlight: 0 })
    s.applyJobEvent('paused', null)
    expect(useMachineControl.getState().cycleEvents.at(-1)!.operation).toBeNull()

    s.setProgramContextVerdict('current')
    s.applyJobEvent('resumed', null)
    expect(useMachineControl.getState().cycleEvents.at(-1)!.operation).toBe(LABEL.op1)

    s.setProgramContextVerdict('project-changed')
    s.applyJobEvent('paused', null)
    expect(useMachineControl.getState().cycleEvents.at(-1)!.operation).toBeNull()

    // A new program clears verdict and hint; same-text re-arm keeps the verdict.
    s.setProgramContextVerdict('current')
    s.setArmedFromLine(20)
    s.setProgram('part.nc', gcode)
    expect(useMachineControl.getState().programContextVerdict).toBe('current')
    expect(useMachineControl.getState().armedFromLine).toBeNull()
    s.setProgram('other.nc', 'G21\nG0 X1\nM30', [], null)
    expect(useMachineControl.getState().programContextVerdict).toBeNull()
    s.applyJobProgress({ phase: 'streaming', totalLines: 2, sentLines: 1, ackedLines: 1, ackedSourceLine: 2, sentSourceLine: 2, bytesInFlight: 0 })
    s.applyJobEvent('started', null)
    expect(useMachineControl.getState().cycleEvents.at(-1)!.operation).toBeNull()
  })

  it('the started row of a mid-program arm names the armed operation, not the first', () => {
    const { gcode, context } = post('store2', false)
    const s = useMachineControl.getState()
    s.setProgram('part.nc', gcode, [], context)
    s.setProgramContextVerdict('current')
    s.setArmedFromLine(operationExecutableBounds(useMachineControl.getState().programContext!, gcode)[2].firstExecutableLine)
    s.applyJobProgress({ phase: 'ready', totalLines: 5, sentLines: 0, ackedLines: 0, ackedSourceLine: 0, sentSourceLine: 0, bytesInFlight: 0 })
    s.applyJobEvent('started', null)
    expect(useMachineControl.getState().cycleEvents.at(-1)!.operation).toBe(LABEL.op3)
  })
})
