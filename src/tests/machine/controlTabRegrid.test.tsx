// @vitest-environment jsdom
//
// WO-068 acceptance (the approved WO-048 regrid, audit holes closed): the
// uix=12 prototype layout (cb639bf, card Q-CONTROL-LAYOUT-RULES) shipped as
// the default. Landmarks pinned two ways, following controlPagePolish:
//   - rendered DOM: panel order per column, the transport cluster + STEP row
//     as center-column items, Back safety-gated until a completed cursor,
//     the single-block explainer NEXT TO its toggle (OPERATOR NOTE 3);
//   - the production CSS grid contract: center-stage template areas placing
//     preview/list/xport/step, E-STOP spanning its cluster's full width.
// Plus the two operator contracts the WO-048 audit demanded proof of:
//   - the stop-and-hold transport authority is visible AND operable off Main;
//   - pressing the shipped STEP button actually executes one program line.
// jsdom does not lay out, so geometry facts live in the CSS contract and the
// WO-068 evidence capture measures them in real Chromium.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { typedMock } from '../support/typedMock'

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

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  setMachineSingleBlock,
} =
  await import('../../lib/machine/machineSession')

const appCss = readFileSync('src/styles/app.css', 'utf8')

// A short real program so readiness, tool scan and the streamer have truth.
const PROGRAM = [
  'G21 G90 G54',
  'M3 S12000',
  'G0 X0 Y0',
  'G0 Z-5',
  'G1 Z-10 F300',
  'G1 X20 Y0 F800',
  'G1 X20 Y20',
  'G0 Z-5',
  'M5',
  'M30',
].join('\n')

// Long enough to stay active while the simulator proves every mounted
// Feed Hold button routes to the live controller pause handler.
const MOTION_PROGRAM = [
  'G21 G90 G54',
  ...Array.from({ length: 200 }, (_, i) => `G1 X${i + 1} F300`),
  'M30',
].join('\n')

const CONTROL_VIEWS = ['main', 'offsets', 'tools', 'diagnostics', 'macros'] as const

/** These operator tests run positive XY with Z below the max-end GRBL switch.
 * State that machine frame instead of inheriting the seeded machine's
 * unrelated travel. */
function selectControlMotionFixture(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo068-control-motion-machine',
    name: 'WO-068 control motion fixture',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 738, y: 724, z: 130 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
  })
}

/** Reach a Control subview by its logical name.
 *
 *  WO-917 moved Diagnostics and Macros OFF the top-level nav row and under the
 *  Machine view as sub-tabs. The five subviews this file guards are unchanged
 *  AS FACTS - the transport authority must be visible and operable in every
 *  one of them - so the list stays and only the ROUTE changes.
 *
 *  Repinning the route rather than deleting the two entries is the whole point:
 *  a nav change must not be able to quietly shrink safety coverage. If these
 *  two had been dropped when they moved, the assertion that an operator can
 *  E-STOP from the Macros surface would have vanished with them, and nothing
 *  would have reported it. */
function gotoSubview(view: (typeof CONTROL_VIEWS)[number]) {
  if (view === 'diagnostics' || view === 'macros') {
    fireEvent.click(screen.getByTestId('control-view-machine'))
    fireEvent.click(screen.getByTestId(`control-machine-tab-${view}`))
    return
  }
  fireEvent.click(screen.getByTestId(`control-view-${view}`))
}

/** Body of the LAST CSS rule for an exact selector (cascade winner). */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = Array.from(appCss.matchAll(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'gm')))
  if (matches.length === 0) throw new Error(`no CSS rule found for "${selector}"`)
  return matches.map((m) => m[1]).join('\n')
}

async function mountControlTab() {
  useCamStore.getState().newProject()
  selectControlMotionFixture()
  useCamStore.setState({ workspace: 'cam', control: { activeMachineId: null } })
  render(<App />)
  fireEvent.click(screen.getByTestId('mode-tab-control'))
  await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })
}

afterEach(cleanup)

/**
 * THE APP BOOT AND THE SIMULATOR HANDSHAKE ARE SETUP, SO THEY LIVE IN SETUP.
 *
 * WO-068 fix round, half of the answer to the audit's "intermittently red
 * declared slice" (the other half is the per-subview split further down).
 *
 * The two operator-contract describes below each began with `mountControlTab()`
 * + `connectMachine()` INSIDE the test body, spending the test's budget on work
 * that is not the gesture under test: a full `<App/>` render plus a real GRBL
 * handshake (the simulator emits its banner on a 150ms timer, the controller
 * polls at 200ms). Measured on this branch, that boot is ~700ms-1.5s, and
 * "starts motion and fires Feed Hold in every Control subview" was landing at
 * 4305-4740ms of its 5000ms budget while `controlRailFitsAt900.live.test.ts`
 * had Chromium on the box. Moving the boot into `beforeEach` returned that
 * time to the test, measured at 3957ms worst on the same loaded runs.
 *
 * NOTHING IS WEAKENED HERE AND NO BUDGET IS RAISED. Every assertion, the
 * programs, the view list and the teardown order are unchanged; vitest's
 * default 5000ms `testTimeout` and 10000ms `hookTimeout` are both untouched.
 * The only change is WHERE the boot runs. That the two budgets really are
 * separate - so this is a genuine change and not bookkeeping - was measured,
 * not assumed: a probe with a 4000ms `beforeEach` and a 2000ms body reports
 * 6022ms and PASSES under the 5000ms default.
 *
 * MEASURED, NOT ASSUMED - the work order's Fix round carries the run-by-run
 * numbers, including the evidence that a slice carrying MAIN's live gate (zero
 * WO-068 additions) hit 4740ms on this same test, so the flake predates this
 * branch rather than being added by it.
 */
async function mountConnectedControlTab() {
  await mountControlTab()
  await act(async () => { await connectMachine('simulator', 115200) })
  act(() => { __resetEstopInterlockForTest() })
  expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
}

describe('WO-048: approved panel order per column', () => {
  it('keeps pendant inside Machine and stacks LEFT as Machine -> Position -> Work offsets -> Tool', async () => {
    await mountControlTab()
    const left = screen.getByTestId('control-page').querySelector('.control-col-left')!
    const titles = Array.from(left.querySelectorAll('.panel-title')).map((el) =>
      el.textContent?.trim(),
    )
    expect(titles).toEqual(['Machine', 'Position', 'Work offsets', 'Tool'])
    expect(screen.getByTestId('pendant-status-button').closest('.panel')?.querySelector('.panel-title')?.textContent).toBe('Machine')
    // The Tool panel is the at-a-glance readout with its Change tool jump.
    // WO-414 batch 3 (R41): it starts folded to its header line (the pref may
    // persist from an earlier case in this file); the chevron opens it.
    if (screen.queryByTestId('control-tool-glance') === null) fireEvent.click(screen.getByTestId('control-tool-toggle'))
    const toolGlance = await screen.findByTestId('control-tool-glance')
    expect(toolGlance.closest('.control-tool-panel')).toBeTruthy()
  })

  it('stacks RIGHT as Jog -> Overrides -> Spindle / Coolant -> Macros on a scroll path', async () => {
    await mountControlTab()
    const right = screen.getByTestId('control-page').querySelector('.control-col-right')!
    const titles = Array.from(right.querySelectorAll('.panel-title')).map((el) =>
      el.textContent?.trim(),
    )
    expect(titles).toEqual(['Jog', 'Overrides', 'Spindle / Coolant', 'Macros'])
    // WO-068 finding 1: four content-sized panels outgrow a 900px viewport,
    // so the rail's panels live inside the rail's REAL scroller. The CSS
    // contract for that scroller is pinned in controlPagePolish.
    expect(right.querySelector(':scope > .control-col-scroll')).toBeTruthy()
    expect(right.querySelectorAll(':scope > .control-col-scroll > .panel')).toHaveLength(4)
  })

  it('the Change tool button jumps to the Tools / Probe view', async () => {
    await mountControlTab()
    const columns = screen.getByTestId('control-page').querySelector('.control-columns')!
    // WO-414 batch 3 (R41): the Tool panel is folded by default - open it first
    // (the pref persists across cases in this file, so only click when folded).
    if (screen.queryByTestId('control-tool-glance') === null) fireEvent.click(screen.getByTestId('control-tool-toggle'))
    fireEvent.click(screen.getByTestId('control-tool-glance-change'))
    // Disconnected the button is disabled - nothing may move.
    expect(columns.hasAttribute('hidden')).toBe(false)
    await act(async () => { await connectMachine('simulator', 115200) })
    try {
      fireEvent.click(screen.getByTestId('control-tool-glance-change'))
      expect(columns.hasAttribute('hidden')).toBe(true)
      expect(screen.getByTestId('control-view-tools').getAttribute('aria-pressed')).toBe('true')
    } finally {
      await act(async () => { await disconnectMachine() })
    }
  })
})

describe('WO-048: transport cluster + STEP row in the center column', () => {
  it('places the transport under the list and the STEP row under the transport', async () => {
    await mountControlTab()
    const main = screen.getByTestId('control-page').querySelector('.control-col-main')!
    const cluster = screen.getByTestId('control-safety-bar')
    const stepRow = screen.getByTestId('control-uix-steprow')
    expect(cluster.classList.contains('control-uix-transport')).toBe(true)
    expect(cluster.parentElement).toBe(main)
    expect(stepRow.parentElement).toBe(main)
    // DOM order: cluster immediately precedes the STEP row; the grid template
    // stacks their areas (xport above step) in the list's column.
    expect(cluster.nextElementSibling).toBe(stepRow)
    for (const id of ['control-estop', 'control-cyclestart', 'control-feedhold', 'control-stop-reset']) {
      expect(screen.getByTestId(id).closest('.control-uix-transport')).toBe(cluster)
    }
    const mainTemplate = ruleBody('.control-col-main')
    expect(mainTemplate).toMatch(/"prev split list"/)
    expect(mainTemplate).toMatch(/"prev \. xport"/)
    expect(mainTemplate).toMatch(/"prev \. step"/)
    // Preview keeps the same dominant 3:2 default, now behind persisted
    // custom properties with explicit low pane minimums around the divider.
    expect(mainTemplate).toMatch(
      /minmax\(120px, var\(--control-program-preview-fr, 60fr\)\) 8px minmax\(160px, var\(--control-program-list-fr, 40fr\)\)/,
    )
  })

  it('E-STOP spans the full cluster width above the Start/Hold/Stop row', () => {
    const cluster = ruleBody('.control-uix-transport')
    expect(cluster).toMatch(/"estop estop estop"/)
    expect(cluster).toMatch(/"start hold stop"/)
    expect(ruleBody('.control-uix-transport .control-btn-estop')).toMatch(/grid-area:\s*estop/)
  })

  it('keeps Single Block + Step on the shipped operator contract and Back honestly gated', async () => {
    await mountControlTab()
    const stepRow = screen.getByTestId('control-uix-steprow')
    const toggle = screen.getByTestId('control-singleblock-toggle')
    expect(toggle.closest('[data-testid="control-uix-steprow"]')).toBe(stepRow)

    // Back cannot operate disconnected or before a line has completed.
    const back = screen.getByTestId('control-step-back') as HTMLButtonElement
    expect(back.disabled).toBe(true)
    expect(back.getAttribute('data-tooltip')).toMatch(/Connect to the machine/i)

    await act(async () => { await connectMachine('simulator', 115200) })
    // Operator 2026-09-14 ("A: Flash, all motion off"): this test is about the
    // Single Block/Step gating message, not the fresh-connect E-STOP latch.
    act(() => { __resetEstopInterlockForTest() })
    try {
      expect((screen.getByTestId('control-singleblock-toggle') as HTMLButtonElement).disabled).toBe(false)
      // Connected but with no completed cursor, Back remains honestly gated.
      expect((screen.getByTestId('control-step-back') as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByTestId('control-step-back').getAttribute('data-tooltip')).toMatch(
        /Turn Single Block on/i,
      )
      // Step only means "one line" - with Single Block OFF it stays disabled
      // rather than silently meaning "run continuously".
      expect((screen.getByTestId('control-step-forward') as HTMLButtonElement).disabled).toBe(true)
      act(() => { fireEvent.click(screen.getByTestId('control-singleblock-toggle')) })
      expect(useMachineControl.getState().singleBlock).toBe(true)
      act(() => { fireEvent.click(screen.getByTestId('control-singleblock-toggle')) })
      expect(useMachineControl.getState().singleBlock).toBe(false)
    } finally {
      await act(async () => { await disconnectMachine() })
    }
  })
})

describe('WO-068 finding 3: the STEP button executes, not just renders', () => {
  // The boot moves to the hook; the teardown stays exactly where it was.
  beforeEach(mountConnectedControlTab)

  it('operator contract: pressing Step sends exactly one program line', async () => {
    try {
      act(() => { loadMachineProgram('wo068-step.nc', PROGRAM) })
      act(() => { fireEvent.click(screen.getByTestId('control-singleblock-toggle')) })
      expect(useMachineControl.getState().singleBlock).toBe(true)

      const step = screen.getByTestId('control-step-forward') as HTMLButtonElement
      expect(step.disabled).toBe(false)
      const before = useMachineControl.getState().job.sentLines

      // The actual press. A dead onClick on the shipped STEP button fails
      // HERE - the WO-048 audit found the old test never pressed it.
      act(() => { fireEvent.click(step) })

      const job = useMachineControl.getState().job
      expect(job.sentLines).toBe(before + 1)
      // One line, not a stream: Single Block holds the next line back.
      expect(getMachineController().singleBlockMode()).toBe(true)
    } finally {
      act(() => getMachineController().emergencyStop())
      await act(async () => { await disconnectMachine() })
      act(() => setMachineSingleBlock(false))
    }
  })
})

describe('WO-068 finding 2: transport authority operable in every subview', () => {
  // The boot moves to the hook; every teardown stays exactly where it was -
  // the three tests below do not share one (only two of them E-STOP), so
  // hoisting teardown as well would have changed behaviour rather than moved it.
  beforeEach(mountConnectedControlTab)

  it('keeps only E-STOP / Feed Hold / Stop-Reset in each aux authority row', async () => {
    try {
      act(() => { loadMachineProgram('wo068-authority.nc', PROGRAM) })
      for (const view of ['offsets', 'tools', 'diagnostics', 'macros'] as const) {
        gotoSubview(view)
        // The one visible transport mounts inside the aux workspace's
        // authority row - role queries prove visibility, disabled proves
        // operability. Feed Hold stays gated on motion by design.
        const cluster = screen.getByTestId('control-safety-bar')
        expect(cluster.closest('[data-testid="control-aux-authority"]')).toBeTruthy()
        expect(cluster.closest('.control-aux-workspace')).toBeTruthy()
        expect(
          (screen.getByRole('button', { name: 'E-STOP' }) as HTMLButtonElement).disabled,
        ).toBe(false)
        expect(
          (screen.getByRole('button', { name: 'Stop/Reset' }) as HTMLButtonElement).disabled,
        ).toBe(false)
        expect(screen.getByRole('button', { name: 'Feed Hold' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'CYCLE START' })).toBeNull()
        expect(cluster.classList.contains('control-transport-compact')).toBe(true)
      }
      expect(
        ruleBody('.control-aux-authority .control-transport-compact + .control-uix-steprow'),
      ).toMatch(/display:\s*none/)
      // Back on Main the cluster returns to its center-column grid slot.
      fireEvent.click(screen.getByTestId('control-view-main'))
      expect(
        screen.getByTestId('control-safety-bar').closest('.control-col-main'),
      ).toBeTruthy()
      expect(screen.getAllByRole('button', { name: 'CYCLE START' })).toHaveLength(1)
    } finally {
      act(() => getMachineController().emergencyStop())
      await act(async () => { await disconnectMachine() })
    }
  })

  /**
   * ONE TEST PER SUBVIEW - "applied per subview" is the work order's own
   * wording, and it is now literally true.
   *
   * This was a single test that walked all five subviews in one 5000ms budget,
   * and it is the test the WO-068 audit caught going red. Profiled on this
   * branch, its five iterations cost ~2200ms idle - 881ms of that in the five
   * `getByRole` accessible-name scans alone, which is the price of the
   * role-based query finding 2 demands and is NOT negotiable - and ~4000ms
   * with Chromium on the box, i.e. 79-95% of the budget spent proving five
   * independent facts at once. Per subview each fact gets its own budget and
   * its own clean machine, which is both what the WO asked for and what makes
   * the slice trustworthy under load.
   *
   * NO ASSERTION WAS DROPPED, and one was ADDED:
   *   - every per-view assertion is here verbatim: the role query, the enabled
   *     check, the click, `pauseJob` called exactly once more, phase 'paused';
   *   - the old tail `expect(pauseJob).toHaveBeenCalledTimes(5)` was by
   *     construction the sum of the five per-view "+1" assertions; each test
   *     now holds its own spy and asserts exactly 1, which is the same claim
   *     with tighter per-view attribution;
   *   - the old loop reached the next subview by RESUMING the job it had just
   *     paused, so resume-after-Feed-Hold was exercised four times as a side
   *     effect and never asserted. It is now asserted outright, in all five
   *     subviews. The split therefore adds that contract rather than losing it.
   */
  it.each(CONTROL_VIEWS)(
    'starts motion and fires Feed Hold in the %s subview',
    async (view) => {
      const ctrl = getMachineController()
      const pauseJob = vi.spyOn(ctrl, 'pauseJob')
      try {
        act(() => { loadMachineProgram('wo070-feedhold.nc', MOTION_PROGRAM) })
        gotoSubview(view)

        // Motion setup is deterministic at the controller boundary; the
        // shipped role-based Feed Hold button remains the gesture under test.
        act(() => { expect(ctrl.startJob()).toBe(true) })
        await waitFor(() => expect(useMachineControl.getState().job.phase).toBe('streaming'))

        const feedHold = screen.getByRole('button', { name: 'Feed Hold' }) as HTMLButtonElement
        await waitFor(() => expect(feedHold.disabled).toBe(false))
        act(() => { fireEvent.click(feedHold) })
        expect(pauseJob).toHaveBeenCalledTimes(1)
        expect(ctrl.jobProgress().phase).toBe('paused')

        // The resume the old loop performed silently, now stated: a subview
        // that can hold the job must also be able to hand it back.
        act(() => { expect(ctrl.resumeJob()).toBe(true) })
        await waitFor(() => expect(useMachineControl.getState().job.phase).toBe('streaming'))
      } finally {
        pauseJob.mockRestore()
        act(() => ctrl.emergencyStop())
        await act(async () => { await disconnectMachine() })
      }
    },
  )

  it('pins Feed Hold disabled while connected but idle in every Control subview', async () => {
    const ctrl = getMachineController()
    const feedHoldHandler = vi.spyOn(ctrl, 'feedHold')
    try {
      expect(useMachineControl.getState().machineState).toBe('idle')
      expect(useMachineControl.getState().job.phase).toBe('empty')

      for (const view of CONTROL_VIEWS) {
        gotoSubview(view)
        const feedHold = screen.getByRole('button', { name: 'Feed Hold' }) as HTMLButtonElement
        expect(feedHold.disabled).toBe(true)
        act(() => { fireEvent.click(feedHold) })
      }

      expect(feedHoldHandler).not.toHaveBeenCalled()
    } finally {
      feedHoldHandler.mockRestore()
      await act(async () => { await disconnectMachine() })
    }
  })
})

describe('WO-048 OPERATOR NOTE 3: the explainer sits with its control', () => {
  it('renders the single-block explainer INSIDE the STEP row, under the toggle', async () => {
    await mountControlTab()
    const explainer = screen.getByTestId('control-singleblock-explainer')
    expect(explainer.closest('[data-testid="control-uix-steprow"]')).toBeTruthy()
    expect(explainer.textContent).toMatch(/CYCLE START runs it all/)
    // The CSS places it as the row's own full-width second line (under the
    // leftmost toggle), not floating elsewhere.
    expect(ruleBody('.control-uix-steprow .control-mode-explainer')).toMatch(
      /grid-column:\s*1 \/ -1/,
    )
    // And the progress row it left starts with Park + clamp - items shifted
    // left, no explainer remains there.
    const progress = screen.getByTestId('control-page').querySelector('.control-transport')!
    expect(progress.querySelector('[data-testid="control-singleblock-explainer"]')).toBeNull()
    expect(progress.querySelector('[data-testid="control-clamp-pause"]')).toBeTruthy()
  })
})

describe('compact Machine connection controls', () => {
  it('keeps selection and connect on row one, with status and pendant on row two', async () => {
    await mountControlTab()
    const grblMachine = useCamStore.getState().machineLibrary.find((machine) => machine.controller === 'grbl')!
    fireEvent.change(screen.getByTestId('control-machine-select'), { target: { value: grblMachine.id } })
    await waitFor(() => expect((screen.getByTestId('control-kind-select') as HTMLSelectElement).value).toBe('simulator'))
    const port = screen.getByTestId('control-kind-select')
    fireEvent.change(port, { target: { value: 'serial' } })

    const row = port.closest('.control-connect-row')!
    const actions = row.querySelector('.control-connect-actions')!
    const baud = row.querySelector('#control-baud')
    const connect = screen.getByTestId('control-connect')
    const pendant = screen.getByTestId('pendant-status-button')

    expect(port.parentElement).toBe(row)
    expect(actions.parentElement).toBe(row)
    // WO-998 moved baud to Control > Machine > Definition. Row one keeps only
    // the transport picker and Connect; no hidden second baud editor remains.
    expect(baud).toBeNull()
    expect(connect.parentElement).toBe(actions)
    expect(pendant.closest('.control-machine-status-row')).toBeTruthy()
    expect(pendant.parentElement).not.toBe(actions)
    expect(ruleBody('.control-connect-row')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto/)
    expect(ruleBody('.control-kind-select')).toMatch(/width:\s*100%/)
  })

  it('puts live controller status and pendant on row two without duplicating the homing warning', async () => {
    await mountConnectedControlTab()
    try {
      const statusRow = screen.getByTestId('control-pin-leds').closest('.control-machine-status-row')!
      // WO-433: the simulator identifies itself honestly as the native
      // SimulatedController now, not a GRBL banner ('LienCAM Simulated
      // Controller' - see firmwareVersionStr in simulatedController.ts)
      // - it no longer speaks GRBL at all, so it cannot claim to be one.
      expect(statusRow.textContent).toContain('LienCAM Simulated Controller')
      expect(statusRow.textContent).toContain('HOME')
      expect(screen.getByTestId('pendant-status-button').parentElement).toBe(statusRow)
      expect(screen.queryByText('Not homed yet - positions are unreferenced until $H runs.')).toBeNull()
    } finally {
      await act(async () => { await disconnectMachine() })
    }
  })
})
