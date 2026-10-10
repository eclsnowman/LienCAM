// @vitest-environment jsdom
//
// WO-2042 (machine session 09-26, F12): the program's M6 T19 re-measured the
// reference tool, the table took the new reading (48.263 -> 48.292) and G54 Z
// went back to exactly 43.780 - so every tool's length difference to the Ref
// moved by 0.029 mm while the work zero, set against the OLD Ref reading, did
// not. The rule now: the reference's new reading moves the Z work zero by the
// same difference, every other tool's offset is unchanged, and one console
// line says so.
//
// Driven through the production ProgramPanel on the simulator (the WO-2025
// harness): a program T19 -> M6 T1 -> M6 T19 -> M6 T1, with T19's stored
// reading 0.029 mm below what the setter reads now. "Cut depth" is the
// machine Z each cut reached minus the setter reading of the tool that cut
// it - where the tip was - and it must be the same for every cut.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { findTool } = await import('../../lib/machine/toolTable')
const { CALL_TIMEOUT_MS } = await import('../../lib/machine/uccncController')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')

const SIM_ID = 'wo2042-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 60, y: 70, z: -20 }
const SAFE_Z = -2
const REF = 19
/** The Ref's setter reading drifted this much between its measure and the program's re-measure. */
const DRIFT = 0.029
/** Each cut sits at its own X so the cut's machine Z can be read back per cut. */
const CUT_X = [10, 20, 30, 40]
/** The 09-26 file's shape: T19, M6 T1, M6 T19 - and one more M6 T1 to show T1's
 *  offset survives the Ref's re-measure. `g43` adds the Fusion post's `G43 H<n>`
 *  after each change, which the native route folds into the staged Z. */
function program(g43: boolean): string {
  const change = (tool: number) => [`T${tool} M6`, ...(g43 ? [`G43 H${tool}`] : [])]
  const cut = (x: number) => [`G0 X${x}`, 'G1 Z-1 F6000', 'G4 P0.5', 'G0 Z1']
  return [
    'G21', 'G90', ...change(REF), ...cut(CUT_X[0]),
    ...change(1), ...cut(CUT_X[1]),
    ...change(REF), ...cut(CUT_X[2]),
    ...change(1), ...cut(CUT_X[3]),
    'M30',
  ].join('\n')
}

async function advance(ms: number): Promise<void> {
  const { act } = await import('@testing-library/react')
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

const consoleText = () => useMachineControl.getState().consoleLines.map((l) => l.text)
const reading = (tool: number) => findTool(useMachineToolTable.getState().tableFor(SIM_ID), tool)?.probedMachineZ ?? null

beforeEach(async () => {
  vi.useFakeTimers()
  mem.clear()
  useCamStore.getState().newProject()
  useMachineControl.setState({ consoleLines: [], parserModal: null, toolChange: null })
  useMachineToolTable.setState({ byMachine: {} })
  const { positionMacroBody } = await import('../../types')
  const { useMachineActions } = await import('../../store/machineActionsStore')
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  useCamStore.setState((s) => ({ control: { ...s.control, activeMachineId: null } }))
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: SIM_ID,
    name: 'WO-2042 simulator',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 5 },
    },
    macros: [{
      id: PARK.id,
      name: PARK.label,
      body: positionMacroBody({ x: PARK.x, y: PARK.y, z: PARK.z, zFirst: true }),
      usedForToolChange: true,
    }],
    safeZMachine: SAFE_Z,
  } as never)
  const connected = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await connected
  useMachineControl.getState().clearConsole()
  __resetEstopInterlockForTest()
  getMachineController().home()
  await vi.advanceTimersByTimeAsync(2000)
  useMachineToolTable.getState().setProbeConfig(SIM_ID, { maxTravel: 50 })
})

afterEach(async () => {
  const { cleanup } = await import('@testing-library/react')
  cleanup()
  cancelGuidedToolChange()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
})

type Route = 'native' | 'text'

/** The native route's shape on the simulator (the UC100's): no G-code text
 *  door, so a tool length is folded into the work offset's Z through the
 *  controller's work-offset call - here the simulator's own offset table. */
function nativeRoute(): void {
  const sim = getMachineController() as unknown as {
    capabilities: { gcodeText: boolean }
    setWorkOffset?: (wcs: string, offset: Record<string, number>) => Promise<unknown>
    wco: Record<string, Record<string, number>>
  }
  sim.capabilities.gcodeText = false
  sim.setWorkOffset = async (wcs, offset) => {
    sim.wco = { ...sim.wco, [wcs]: { ...sim.wco[wcs], ...offset } }
    return { ok: true, reason: null, offset: { ...sim.wco[wcs] } }
  }
}

/** Where the spindle is in machine Z. Since WO-2037 the simulator's staged moves
 *  carry the G43.1 length (as a text controller's own motion does), so the
 *  reported machine Z is the real spindle Z on both routes; the native route
 *  folds the length into G54 itself. */
function spindleZ(_route: Route): number {
  return getMachineController().status().machinePos!.z
}

/** Run the program through the ProgramPanel, pressing the card's Continue at each M6.
 *  Returns the lowest spindle Z at each cut's X, and the setter reading of the
 *  tool that made each cut. */
async function runProgram(
  route: Route,
  g43 = false,
  hooks: { afterRoute?: () => void; onSwap?: (tool: number | null) => void } = {},
): Promise<{ cutZ: number[]; tipReading: number[] }> {
  const { createElement } = await import('react')
  const { fireEvent, render, screen } = await import('@testing-library/react')
  const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
  const { loadGcodeTextToolpathProgram, setWorkOffsetValue } = await import('../../lib/machine/machineSession')
  for (const axis of ['X', 'Y'] as const) {
    expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
    await advance(50)
  }
  // Work Z0 set with the Ref in the spindle, 30 mm above the setter.
  expect(setWorkOffsetValue('G54', 'Z', -10)).toBe(true)
  await advance(50)
  if (route === 'native') nativeRoute()
  hooks.afterRoute?.()

  render(createElement(ProgramPanel))
  expect(loadGcodeTextToolpathProgram('ref-remeasure.nc', program(g43)).ok).toBe(true)
  expect(getMachineController().startJob()).toBe(true)

  const cutZ = CUT_X.map(() => Number.POSITIVE_INFINITY)
  // The Ref's stored reading cut the first part; each M6 tool then cuts with its fresh reading.
  const tipReading: number[] = [reading(REF)!]
  const cutTools = [1, REF, 1]
  for (let t = 0; t <= 60000 && useMachineControl.getState().job.phase !== 'complete'; t += 10) {
    await advance(10)
    const tc = useMachineControl.getState().toolChange
    if (tc?.step === 'awaiting-swap') {
      hooks.onSwap?.(tc.tool)
      fireEvent.click(screen.getByTestId('control-tc-continue'))
      await advance(10)
      continue
    }
    if (tc !== null) continue
    const at = getMachineController().status().machinePos
    if (!at) continue
    const cut = CUT_X.findIndex((x) => Math.abs(at.x - x) < 1e-6)
    if (cut >= 0) {
      if (cut > 0 && tipReading.length === cut) tipReading.push(reading(cutTools[cut - 1])!)
      cutZ[cut] = Math.min(cutZ[cut], spindleZ(route))
    }
  }
  expect(useMachineControl.getState().job.phase).toBe('complete')
  return { cutZ, tipReading }
}

/** WO-2522: the line names the Ref's shift as the Ref's reading changing, and
 *  reports the change the work offset itself got. The native route holds T1's
 *  +0.029 in G54 Z, so the Ref's write takes it back out as it adds the shift:
 *  G54 Z does not move. The text route holds T1's length in G43.1. */
const refLine = (route: Route) => `T${REF} measured: contact at machine Z -40.00 mm. Tool length offset 0.00 mm applied. `
  + `T${REF} is the reference tool: its reading changed +0.03 mm from the last measure (machine Z -40.03 mm), `
  + "the work zero moves with it and every other tool's offset is unchanged. "
  + (route === 'native'
    ? 'The G54 Z offset changed +0.00 mm (-9.97 -> -9.97 mm), which includes taking out the 0.03 mm length of '
      + 'the tool before it - this controller holds tool length in the work offset.'
    : 'The G54 Z offset changed +0.03 mm (-10.00 -> -9.97 mm).')

describe.each(['native', 'text'] as const)('WO-2042 (%s route): re-measuring the reference tool at a guided M6 changes where no tool cuts', (route) => {
  it('the Ref reading 0.029 mm different moves the work zero with it; every cut lands at the same depth', async () => {
    // The Ref's first measure, and the program's re-measure reading DRIFT more:
    // the simulator's pad triggers at machine Z -40.
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(SIM_ID, REF, -40 - DRIFT, 1)
    tools.setReference(SIM_ID, REF)
    const refBefore = reading(REF)!

    const { cutZ, tipReading } = await runProgram(route)

    // The re-measure found the drift the session saw.
    expect(reading(REF)! - refBefore).toBeCloseTo(DRIFT, 6)
    // Every cut ran, and where the tip was at each cut - spindle Z less the
    // cutting tool's setter reading - is the same for all four within 0.001 mm.
    expect(cutZ.every(Number.isFinite)).toBe(true)
    expect(tipReading).toEqual([-40 - DRIFT, -40, -40, -40])
    const tips = cutZ.map((z, i) => z - tipReading[i])
    for (const tip of tips) expect(Math.abs(tip - tips[0])).toBeLessThanOrEqual(0.001)
    // T1 cut where its measured difference to the Ref put it, both times.
    expect(cutZ[1] - cutZ[0]).toBeCloseTo(DRIFT, 6)
    expect(cutZ[3] - cutZ[0]).toBeCloseTo(DRIFT, 6)

    // The Z work zero moved with the Ref, by the drift, and holds no tool length.
    expect(useMachineControl.getState().offsets.G54![2] - -10).toBeCloseTo(DRIFT, 6)

    // One console line for the Ref's re-measure says what changed; T1's do not.
    const lines = consoleText()
    const refLines = lines.filter((l) => l.startsWith(`T${REF} measured: contact`))
    expect(refLines).toHaveLength(1)
    expect(refLines[0]).toBe(refLine(route))
    const t1Lines = lines.filter((l) => l.startsWith('T1 measured: contact'))
    expect(t1Lines).toEqual([
      'T1 measured: contact at machine Z -40.00 mm. Tool length offset 0.03 mm applied.',
      'T1 measured: contact at machine Z -40.00 mm. Tool length offset 0.00 mm applied.',
    ])
  })

  it('a re-measure that reads the Ref exactly as stored moves nothing, and still says so', async () => {
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(SIM_ID, REF, -40, 1)
    tools.setReference(SIM_ID, REF)

    const { cutZ, tipReading } = await runProgram(route)

    const tips = cutZ.map((z, i) => z - tipReading[i])
    for (const tip of tips) expect(Math.abs(tip - tips[0])).toBeLessThanOrEqual(0.001)
    expect(useMachineControl.getState().offsets.G54![2]).toBeCloseTo(-10, 6)
    const refLines = consoleText().filter((l) => l.startsWith(`T${REF} measured: contact`))
    expect(refLines).toHaveLength(1)
    expect(refLines[0]).toContain('its reading changed +0.00 mm from the last measure')
    expect(refLines[0]).toContain(route === 'native'
      ? 'The G54 Z offset changed +0.00 mm (-10.00 -> -10.00 mm).'
      : 'The work offsets are unchanged.')
  })

  it('an offset selected during the hold is not the one moved: the held program frame (G54) is (audit)', async () => {
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(SIM_ID, REF, -40 - DRIFT, 1)
    tools.setReference(SIM_ID, REF)
    const { selectWorkOffset, setWorkOffsetValue } = await import('../../lib/machine/machineSession')
    const { cutZ, tipReading } = await runProgram(route, false, {
      afterRoute: () => { expect(setWorkOffsetValue('G55', 'Z', 5)).toBe(true) },
      onSwap: (tool) => { if (tool === REF) selectWorkOffset('G55') },
    })
    expect(useMachineControl.getState().offsets.G54![2] - -10).toBeCloseTo(DRIFT, 6)
    expect(useMachineControl.getState().offsets.G55![2]).toBeCloseTo(5, 6)
    const tips = cutZ.map((z, i) => z - tipReading[i])
    for (const tip of tips) expect(Math.abs(tip - tips[0])).toBeLessThanOrEqual(0.001)
  })
})

describe("WO-2042 (native route, the Fusion post's G43 H after each M6)", () => {
  it("the file's G43 H19 after the re-measure does not take the Ref's difference back out", async () => {
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(SIM_ID, REF, -40 - DRIFT, 1)
    tools.setReference(SIM_ID, REF)

    const { cutZ, tipReading } = await runProgram('native', true)

    expect(tipReading).toEqual([-40 - DRIFT, -40, -40, -40])
    const tips = cutZ.map((z, i) => z - tipReading[i])
    for (const tip of tips) expect(Math.abs(tip - tips[0])).toBeLessThanOrEqual(0.001)
    expect(consoleText().filter((l) => l === refLine('native'))).toHaveLength(1)
  })
})

// Audit (WO-2042 attempt 1): the work-zero write is asynchronous - queued is not
// taken. A receipt that refuses it must not leave the table on the Ref's new
// reading with the old work zero, and must not let the held program resume.
describe.each(['native', 'text'] as const)('WO-2042 (%s route): the machine refuses the Ref re-measure\'s work-zero write', (route) => {
  it('the program stays held at the M6, the Ref keeps its old reading and no tool cuts anywhere new', async () => {
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(SIM_ID, REF, -40 - DRIFT, 1)
    tools.setReference(SIM_ID, REF)

    const { createElement } = await import('react')
    const { fireEvent, render, screen } = await import('@testing-library/react')
    const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
    const { loadGcodeTextToolpathProgram, setWorkOffsetValue } = await import('../../lib/machine/machineSession')
    for (const axis of ['X', 'Y'] as const) {
      expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
      await advance(50)
    }
    expect(setWorkOffsetValue('G54', 'Z', -10)).toBe(true)
    await advance(50)
    if (route === 'native') nativeRoute()

    // The next work-offset write after the Ref's Continue is refused by its receipt.
    let refuseNext = false
    let refused = 0
    const sim = getMachineController() as unknown as {
      setWorkOffset?: (wcs: string, offset: Record<string, number>) => Promise<unknown>
      sendCommandAwait: (text: string) => Promise<{ ok: boolean; message: string | null }> | null
    }
    if (route === 'native') {
      const accept = sim.setWorkOffset!
      sim.setWorkOffset = async (wcs, offset) => {
        if (!refuseNext) return accept(wcs, offset)
        refuseNext = false
        refused += 1
        return { ok: false, reason: 'the controller rejected the offset', offset: null }
      }
    } else {
      const send = sim.sendCommandAwait.bind(sim)
      sim.sendCommandAwait = (text) => {
        if (!refuseNext || !/G10\s*L2/i.test(text)) return send(text)
        refuseNext = false
        refused += 1
        return Promise.resolve({ ok: false, message: 'error:3' })
      }
    }

    render(createElement(ProgramPanel))
    expect(loadGcodeTextToolpathProgram('ref-remeasure.nc', program(false)).ok).toBe(true)
    expect(getMachineController().startJob()).toBe(true)

    let reachedLaterCut = false
    for (let t = 0; t <= 60000; t += 10) {
      await advance(10)
      const tc = useMachineControl.getState().toolChange
      if (tc?.step === 'failed') break
      if (tc?.step === 'awaiting-swap') {
        if (tc.tool === REF) refuseNext = true
        fireEvent.click(screen.getByTestId('control-tc-continue'))
        await advance(10)
        continue
      }
      const at = getMachineController().status().machinePos
      if (at && tc === null && (Math.abs(at.x - CUT_X[2]) < 1e-6 || Math.abs(at.x - CUT_X[3]) < 1e-6)) {
        reachedLaterCut = true
      }
    }
    // Long enough for any wait on the receipt to have run out.
    await advance(6000)

    expect(refused).toBe(1)
    const tc = useMachineControl.getState().toolChange
    expect(tc?.step).toBe('failed')
    expect(tc?.message).toContain('refused the new tool offset')
    // Held: the part after the Ref's M6 never ran.
    expect(reachedLaterCut).toBe(false)
    expect(useMachineControl.getState().job.phase).not.toBe('complete')
    // The table never holds the Ref's new reading without the work zero that goes with it.
    expect(reading(REF)).toBeCloseTo(-40 - DRIFT, 6)
    // G54 Z is where T1 left it: native folds T1's 0.029 into it, text carries it in G43.1.
    expect(useMachineControl.getState().offsets.G54![2]).toBeCloseTo(route === 'native' ? -10 + DRIFT : -10, 6)
    // No line claims the work zero moved.
    expect(consoleText().some((l) => l.startsWith(`T${REF} measured: contact`))).toBe(false)
  })
})

// Architect re-scope (second audit): the guided re-measure waits for the
// controller's OWN answer to the Ref's work-zero write - no shorter timer of
// ours. The UC100 keeps a setWorkOffset call open for CALL_TIMEOUT_MS (8 s), so
// an accept at 6-7 s is a real accept. Until the answer the table keeps the
// Ref's old reading, so the table and the work zero never disagree. The text
// route has no call timeout of its own: its controller answers every line with
// ok, error, alarm, reset or disconnect.
type Answer = 'accept' | 'refuse' | 'timeout'

/** Hold the answer to the Ref re-measure's work-zero write for `delayMs`, then
 *  give it. 'timeout' is the UC100 controller's own: no bridge reply inside
 *  CALL_TIMEOUT_MS, answered the way its setWorkOffset answers a timed-out call.
 *  `duringWait` is the Ref reading and G54 Z just before the answer. */
function holdRefWrite(route: Route, answer: Answer, delayMs: number) {
  const held = {
    armed: false,
    answered: 0,
    duringWait: null as { ref: number | null; g54: number } | null,
  }
  const sim = getMachineController() as unknown as {
    setWorkOffset?: (wcs: string, offset: Record<string, number>) => Promise<unknown>
    sendCommandAwait: (text: string) => Promise<{ ok: boolean; message: string | null }> | null
  }
  const later = <T,>(ms: number, give: () => T | Promise<T>) => new Promise<T>((resolve) => {
    setTimeout(() => {
      held.answered += 1
      held.duringWait = { ref: reading(REF), g54: useMachineControl.getState().offsets.G54![2] }
      resolve(give())
    }, ms)
  })
  if (route === 'native') {
    const send = sim.setWorkOffset!
    sim.setWorkOffset = (wcs, offset) => {
      if (!held.armed) return send(wcs, offset)
      held.armed = false
      if (answer === 'accept') return later(delayMs, () => send(wcs, offset))
      if (answer === 'refuse') {
        return later(delayMs, () => ({ ok: false, reason: 'the controller rejected the offset', offset: null }))
      }
      return later(CALL_TIMEOUT_MS, () => ({
        ok: false,
        reason: 'the bridge did not answer the setWorkOffset call.',
        offset: null,
      }))
    }
  } else {
    const send = sim.sendCommandAwait.bind(sim)
    sim.sendCommandAwait = (text) => {
      if (!held.armed || !/G10\s*L2/i.test(text)) return send(text)
      held.armed = false
      if (answer === 'accept') return later(delayMs, () => send(text)!)
      return later(delayMs, () => ({ ok: false, message: 'error:3' }))
    }
  }
  return held
}

describe.each(['native', 'text'] as const)('WO-2042 (%s route): the controller accepts the Ref re-measure\'s work-zero write late', (route) => {
  it('an accept at 6.5 s resumes the program, and the Ref reading changes only with the work zero', async () => {
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(SIM_ID, REF, -40 - DRIFT, 1)
    tools.setReference(SIM_ID, REF)

    let held: ReturnType<typeof holdRefWrite> | null = null
    const { cutZ, tipReading } = await runProgram(route, false, {
      afterRoute: () => { held = holdRefWrite(route, 'accept', 6500) },
      onSwap: (tool) => { if (tool === REF) held!.armed = true },
    })

    expect(held!.answered).toBe(1)
    // While the machine had not answered, the table kept the Ref's old reading
    // with the old work zero (where T1 left it).
    expect(held!.duringWait!.ref).toBeCloseTo(-40 - DRIFT, 6)
    expect(held!.duringWait!.g54).toBeCloseTo(route === 'native' ? -10 + DRIFT : -10, 6)
    // The late accept is an accept: the program ran to the end at every tool's depth.
    expect(reading(REF)).toBeCloseTo(-40, 6)
    expect(tipReading).toEqual([-40 - DRIFT, -40, -40, -40])
    const tips = cutZ.map((z, i) => z - tipReading[i])
    for (const tip of tips) expect(Math.abs(tip - tips[0])).toBeLessThanOrEqual(0.001)
    expect(useMachineControl.getState().offsets.G54![2] - -10).toBeCloseTo(DRIFT, 6)
    expect(consoleText().filter((l) => l === refLine(route))).toHaveLength(1)
  })
})

const HELD_CASES: Array<{ route: Route; answer: Answer; delayMs: number }> = [
  { route: 'native', answer: 'refuse', delayMs: 6000 },
  { route: 'text', answer: 'refuse', delayMs: 6000 },
  { route: 'native', answer: 'timeout', delayMs: CALL_TIMEOUT_MS },
]

describe.each(HELD_CASES)('WO-2042 ($route route): the controller answers the Ref re-measure\'s work-zero write with $answer after $delayMs ms', ({ route, answer, delayMs }) => {
  it('the program stays held, the Ref keeps its old reading, and one console line says the offset was not set', async () => {
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(SIM_ID, REF, -40 - DRIFT, 1)
    tools.setReference(SIM_ID, REF)

    const { createElement } = await import('react')
    const { fireEvent, render, screen } = await import('@testing-library/react')
    const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
    const { loadGcodeTextToolpathProgram, setWorkOffsetValue } = await import('../../lib/machine/machineSession')
    for (const axis of ['X', 'Y'] as const) {
      expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
      await advance(50)
    }
    expect(setWorkOffsetValue('G54', 'Z', -10)).toBe(true)
    await advance(50)
    if (route === 'native') nativeRoute()
    const held = holdRefWrite(route, answer, delayMs)
    useMachineControl.getState().clearConsole()

    render(createElement(ProgramPanel))
    expect(loadGcodeTextToolpathProgram('ref-remeasure.nc', program(false)).ok).toBe(true)
    expect(getMachineController().startJob()).toBe(true)

    let reachedLaterCut = false
    let failedBeforeAnswer = false
    for (let t = 0; t <= 60000; t += 10) {
      await advance(10)
      const tc = useMachineControl.getState().toolChange
      if (tc?.step === 'failed') {
        failedBeforeAnswer = held.answered === 0
        break
      }
      if (tc?.step === 'awaiting-swap') {
        if (tc.tool === REF) held.armed = true
        fireEvent.click(screen.getByTestId('control-tc-continue'))
        await advance(10)
        continue
      }
      const at = getMachineController().status().machinePos
      if (at && tc === null && (Math.abs(at.x - CUT_X[2]) < 1e-6 || Math.abs(at.x - CUT_X[3]) < 1e-6)) {
        reachedLaterCut = true
      }
    }
    await advance(1000)

    // The flow acted on the controller's answer, not on a timer of its own.
    expect(held.answered).toBe(1)
    expect(failedBeforeAnswer).toBe(false)
    // While waiting, and after, the table kept the Ref's old reading.
    expect(held.duringWait!.ref).toBeCloseTo(-40 - DRIFT, 6)
    expect(reading(REF)).toBeCloseTo(-40 - DRIFT, 6)
    const tc = useMachineControl.getState().toolChange
    expect(tc?.step).toBe('failed')
    expect(tc?.message).toContain('refused the new tool offset')
    // Held: the part after the Ref's M6 never ran.
    expect(reachedLaterCut).toBe(false)
    expect(useMachineControl.getState().job.phase).not.toBe('complete')
    // G54 Z is where T1 left it.
    expect(useMachineControl.getState().offsets.G54![2]).toBeCloseTo(route === 'native' ? -10 + DRIFT : -10, 6)
    // One console line says the offset was not set; none claims the work zero moved.
    const lines = consoleText()
    expect(lines.filter((l) => l.startsWith('The machine would not set the G54 work offset'))).toHaveLength(1)
    expect(lines.some((l) => l.startsWith(`T${REF} measured: contact`))).toBe(false)
  })
})
