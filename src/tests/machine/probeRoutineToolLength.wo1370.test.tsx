// WO-1370 - a probe routine's toolLength output had a proposal, a UI, and a
// sentence apologising that it went nowhere. These tests run the toolLength
// proposal through the REAL Confirm button in ProbeRoutineRunPanel and assert
// on the tool table, not the button: 'active' and an explicit T number both
// record the measured machine Z against a tool the table already knows.
// Naming 'active' with no active tool, or naming a T number the table has
// never seen, are the two genuine refusals (WO-1370 review) - both named
// plainly and disabled ahead of the click rather than clicked-and-refused.
// @vitest-environment jsdom
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ProbeRoutineRunPanel } from '../../components/machine/ProbeRoutineRunPanel'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import { resolveProbeConfig } from '../../lib/machine/toolTable'
import {
  expandProbeRoutine,
  type ExpandedRoutine,
} from '../../lib/machine/probeRoutineExpand'
import type { ProbeRoutine } from '../../lib/machine/probeRoutineFormat'
import * as session from '../../lib/machine/machineSession'
import type { JogAxis, MachineController } from '../../lib/machine/controller'
import { useMachineControl } from '../../store/machineControlStore'
import { useMachineToolTable } from '../../store/machineToolTableStore'
import { useCamStore } from '../../store'

const envelope = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 300, y: 300, z: 100 },
)
const probeCfg = resolveProbeConfig(null, {
  positioningFeed: 1200, fastFeed: 300, slowFeed: 40, retract: 2, maxTravel: 30,
  surfaceClearance: 5, overtravel: 5, crossOverLift: 10, padThickness: 10,
})
const START = { x: 100, y: 100, z: 40 }
const CONTACT_Z = 12.3456
let machinePos = { ...START }

function buildRoutine(tool: 'active' | number): ProbeRoutine {
  return {
    schemaVersion: 1,
    id: `wo1370.tool-length.${tool}`,
    name: 'WO-1370 tool length test',
    version: '1.0.0',
    provenance: { kind: 'user' },
    description: 'Touch a fixed pad and record the tool length.',
    requires: { homed: true, envelope: 'full', probe: 'touch' },
    inputs: [],
    steps: [
      { kind: 'touch', name: 'pad', axis: 'Z', direction: '-', searchMm: 20 },
    ],
    outputs: [
      { kind: 'toolLength', tool, machineZ: 'touch.pad.z', label: 'Record tool length' },
    ],
  }
}

function expand(routine: ProbeRoutine): ExpandedRoutine {
  const result = expandProbeRoutine(routine, {}, {
    start: { ...START },
    envelope,
    probe: probeCfg,
    tipRadiusMm: 1.5,
    activeWcs: 'G54',
  })
  if (!result.ok) throw new Error(`expand failed: ${JSON.stringify(result.errors)}`)
  return result.expanded
}

function mount(expanded: ExpandedRoutine) {
  return render(
    <ProbeRoutineRunPanel
      expanded={expanded}
      stale={false}
      probe={probeCfg}
      envelope={envelope}
      activeWcs="G54"
      units="mm"
    />,
  )
}

function connectedIdleController() {
  const ctrl = session.getMachineController()
  const baseStatus = ctrl.status()
  vi.spyOn(ctrl, 'connectionPhase').mockReturnValue('connected')
  vi.spyOn(ctrl, 'hasActiveJob').mockReturnValue(false)
  vi.spyOn(ctrl, 'machineState').mockReturnValue('idle')
  vi.spyOn(ctrl, 'homedThisSession').mockReturnValue(true)
  vi.spyOn(
    ctrl as MachineController & { homedAxesThisSession(): Partial<Record<JogAxis, boolean>> },
    'homedAxesThisSession',
  ).mockReturnValue({ X: true, Y: true, Z: true })
  vi.spyOn(ctrl, 'refreshState').mockReturnValue(true)
  vi.spyOn(ctrl, 'queryStatus').mockReturnValue(undefined)
  vi.spyOn(ctrl, 'verifiedIdle').mockReturnValue(true)
  vi.spyOn(ctrl, 'status').mockImplementation(() => ({
    ...baseStatus,
    state: 'idle',
    machinePos: { ...machinePos },
    workPos: { ...machinePos },
  }))
  vi.spyOn(ctrl, 'jog').mockImplementation((axis, delta) => {
    const key = axis.toLowerCase() as 'x' | 'y' | 'z'
    machinePos = { ...machinePos, [key]: machinePos[key] + delta }
    return true
  })
  vi.spyOn(ctrl, 'probe').mockImplementation(async () => {
    machinePos = { ...machinePos, z: CONTACT_Z }
    return { ok: true, at: { ...machinePos } }
  })
  return ctrl
}

const machineId = () => useCamStore.getState().project.machine.id
const consoleText = () => useMachineControl.getState().consoleLines.map((l) => l.text)

beforeEach(() => {
  session.__resetEstopInterlockForTest()
  // WO-1676: the tool table now lives on the machine record rather than only
  // in `useMachineToolTable`'s cache, and this file never calls `newProject`,
  // so a fresh id per test (matching no library entry) keeps one test's added
  // tools off the next test's "never seen" assumptions.
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: `wo1370-test-${crypto.randomUUID()}`,
    toolTable: undefined,
    probeOverrides: undefined,
  })
  useMachineControl.setState({
    probe: null,
    activeWcs: 'G54',
    offsets: { G54: [0, 0, 0] },
    activeTool: null,
    consoleLines: [],
  })
  useMachineToolTable.setState({ byMachine: {} })
  machinePos = { ...START }
  connectedIdleController()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function runIt() {
  fireEvent.click(screen.getByTestId('probe-routine-path-clear-tick'))
  await act(async () => { fireEvent.click(screen.getByTestId('probe-routine-run')) })
  await waitFor(() => expect(screen.getByTestId('probe-routine-run-result')).toBeTruthy(), { timeout: 5_000 })
}

describe('WO-1370: a probe routine tool-length proposal records through the run panel', () => {
  it('the apology sentence is gone from the component source', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'components', 'machine', 'ProbeRoutineRunPanel.tsx'),
      'utf8',
    )
    expect(source).not.toContain('not wired yet')
    expect(source).toContain('confirmProbeRoutineToolLength')
  })

  it("'active' tool: Confirm records the measured Z against the controller's active tool", async () => {
    useMachineControl.setState({ activeTool: 7 })
    // T7 is already a known tool (added on the Tools tab, per the guided
    // tool-change flow) - this Confirm updates its measured Z, it does not
    // create the row.
    useMachineToolTable.getState().addTool(machineId(), 7)
    const before = useMachineToolTable.getState().tableFor(machineId())
    mount(expand(buildRoutine('active')))
    await runIt()

    const proposal = screen.getByTestId('probe-routine-run-proposal')
    expect(proposal.getAttribute('data-kind')).toBe('toolLength')
    expect(proposal.textContent).not.toContain('not wired yet')

    fireEvent.click(screen.getByTestId('probe-routine-confirm-tool-length'))

    const after = useMachineToolTable.getState().tableFor(machineId())
    const t7 = after.tools.find((t) => t.tool === 7)
    expect(t7?.probedMachineZ).toBeCloseTo(CONTACT_Z, 4)
    expect(screen.getByTestId('probe-routine-run-written').textContent).toContain('T7')
    expect(consoleText().some((line) => line.includes('T7') && line.includes('recorded'))).toBe(true)

    if (process.env.WRITE_EVIDENCE === '1') {
      const directory = join(process.cwd(), 'src/tests/evidence/WO-1370')
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, 'tool-table-active.json'),
        `${JSON.stringify({ before, after, console: consoleText() }, null, 2)}\n`,
      )
    }
  })

  it('an explicit T number that is already in the table works', async () => {
    useMachineToolTable.getState().addTool(machineId(), 3)
    const before = useMachineToolTable.getState().tableFor(machineId())
    mount(expand(buildRoutine(3)))
    await runIt()

    fireEvent.click(screen.getByTestId('probe-routine-confirm-tool-length'))

    const after = useMachineToolTable.getState().tableFor(machineId())
    const t3 = after.tools.find((t) => t.tool === 3)
    expect(t3?.probedMachineZ).toBeCloseTo(CONTACT_Z, 4)
    expect(screen.getByTestId('probe-routine-run-written').textContent).toContain('T3')

    if (process.env.WRITE_EVIDENCE === '1') {
      const directory = join(process.cwd(), 'src/tests/evidence/WO-1370')
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, 'tool-table-explicit-t-number.json'),
        `${JSON.stringify({ before, after }, null, 2)}\n`,
      )
    }
  })

  it('an explicit T number the table has never seen: Confirm is disabled, and the writer names the real cannot', async () => {
    expect(useMachineToolTable.getState().tableFor(machineId()).tools.find((t) => t.tool === 3)).toBeUndefined()
    mount(expand(buildRoutine(3)))
    await runIt()

    const btn = screen.getByTestId('probe-routine-confirm-tool-length') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toContain('T3')
    expect(btn.title).toContain('not in the tool table')

    const outcome = session.confirmProbeRoutineToolLength({
      kind: 'toolLength',
      tool: 3,
      machineZ: CONTACT_Z,
      label: 'Record tool length',
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain('T3')
      expect(outcome.reason).toContain('not in the tool table')
    }
    expect(useMachineToolTable.getState().tableFor(machineId()).tools.find((t) => t.tool === 3)).toBeUndefined()
  })

  it("'active' with no active tool on the controller: Confirm is disabled, and the writer names the real cannot", async () => {
    mount(expand(buildRoutine('active')))
    await runIt()

    const btn = screen.getByTestId('probe-routine-confirm-tool-length') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toContain('No tool is active')

    const proposal = screen.getByTestId('probe-routine-run-proposal')
    const outcome = session.confirmProbeRoutineToolLength({
      kind: 'toolLength',
      tool: 'active',
      machineZ: CONTACT_Z,
      label: 'Record tool length',
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain('No tool is active')
      expect(outcome.reason).toContain('active')
    }
    expect(useMachineToolTable.getState().tableFor(machineId()).tools).toEqual([])
    expect(proposal.getAttribute('data-kind')).toBe('toolLength')
  })
})
