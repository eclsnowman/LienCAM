// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const executors = vi.hoisted(() => ({
  feedHold: vi.fn(() => true),
  stopReset: vi.fn(() => true),
}))

vi.mock('../../lib/machine/operatorTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/operatorTransport')>()
  return typedMock<typeof import('../../lib/machine/operatorTransport')>({
    ...actual,
    executeOperatorFeedHold: executors.feedHold,
    executeOperatorStopReset: executors.stopReset,
  })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const { ControlStepRow, ControlTransportBar } = await import(
  '../../components/machine/ControlTransportBar'
)

const OFF_MAIN_VIEWS = ['offsets', 'tools', 'probing', 'routines', 'machine'] as const
const appCss = readFileSync('src/styles/app.css', 'utf8')

/* WO-1092 evidence. Produced by `node src/tests/evidence/WO-1092/shoot.mjs`
   against this branch's own dev server; the assertions below read ONLY these
   numbers, never the stylesheet's text. Attempt 1's centering test scanned
   app.css for the rule it had just written, which passes for any correct
   implementation that words the rule differently and - worse - passed while
   the shipped labels were flush right and broken mid-word. */
interface ControlMeasurement {
  testId: string
  label: string
  labelSource: string
  fontSizePx: number
  box: { x: number; y: number; width: number; height: number }
  icon: { x: number; y: number; width: number; height: number } | null
  labelText: { width: number; height: number; lineCount: number; singleLine: boolean }
  centerDelta: { x: number; y: number }
  iconLabelGapPx: number | null
}
const centering = JSON.parse(
  readFileSync('src/tests/evidence/WO-1092/measurements.json', 'utf8'),
) as {
  centerTolerancePx: number
  iconLabelGapPx: number
  iconLabelGapTolerancePx: number
  singleLineHeightRatio: number
  overflowTolerancePx: number
  safetyControls: string[]
  captures: Array<{
    view: string
    viewport: { width: number; height: number }
    transportFit: { contentOverflowPx: number; rightEdgeOverflowPx: number; columnOverflowPx: number }
    controls: ControlMeasurement[]
  }>
}
const compactMain = JSON.parse(
  readFileSync('src/tests/evidence/WO-1099/measurements.json', 'utf8'),
) as {
  centerTolerancePx: number
  compactIconLabelGapPx: number
  iconLabelGapTolerancePx: number
  layoutTolerancePx: number
  lowerRowControls: string[]
  captures: Array<{
    viewport: { width: number; height: number }
    targets: { gcodeStreamingColumnWidth: number; previewViewportWidth: number }
    layout: {
      gcodeStreamingColumnWidth: number
      previewViewportWidth: number
      contentOverflowPx: number
      rightEdgeOverflowPx: number
      columnOverflowPx: number
      lowerRowTopSpreadPx: number
      lowerRowBottomSpreadPx: number
    }
    controls: ControlMeasurement[]
  }>
}
const measuredControls = centering.captures.flatMap((capture) =>
  capture.controls.map((control) => ({
    ...control,
    where: `${capture.viewport.width}x${capture.viewport.height}/${capture.view}/${control.testId}`,
  })),
)

beforeEach(() => {
  executors.feedHold.mockClear()
  executors.stopReset.mockClear()
  session.__resetEstopInterlockForTest()
  useMachineControl.setState((state) => ({
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    machineState: 'run',
    job: { ...state.job, phase: 'streaming' },
  }))
})

afterEach(() => {
  cleanup()
  session.__resetEstopInterlockForTest()
})

describe('WO-1086 off-Main transport strip', () => {
  it.each(OFF_MAIN_VIEWS)('shows only stop-and-hold program controls in %s', (activeView) => {
    render(<ControlTransportBar sections="row" activeView={activeView} />)

    expect(screen.getByTestId('control-state-chip').textContent).toBe('Running')
    expect((screen.getByRole('button', { name: 'Feed Hold' }) as HTMLButtonElement).disabled)
      .toBe(false)
    expect((screen.getByRole('button', { name: 'Stop/Reset' }) as HTMLButtonElement).disabled)
      .toBe(false)
    expect(screen.getByRole('button', { name: 'E-STOP' })).toBeTruthy()

    for (const name of ['CYCLE START', 'Single Block', 'Back', 'Step']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByText(/CYCLE START runs it all/)).toBeNull()
  })

  it('keeps the complete Main transport and STEP controls', () => {
    render(
      <>
        <ControlTransportBar sections="transport" activeView="main" />
        <ControlStepRow />
      </>,
    )

    for (const name of ['E-STOP', 'CYCLE START', 'Feed Hold', 'Stop/Reset', 'Single Block', 'Back', 'Step']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.getByText(/CYCLE START runs it all/)).toBeTruthy()
  })

  it('uses the same Feed Hold and Stop/Reset executors on Main and off Main', () => {
    const offMain = render(<ControlTransportBar sections="row" activeView="machine" />)
    fireEvent.click(screen.getByRole('button', { name: 'Feed Hold' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop/Reset' }))
    expect(executors.feedHold).toHaveBeenCalledTimes(1)
    expect(executors.stopReset).toHaveBeenCalledTimes(1)

    offMain.unmount()
    render(<ControlTransportBar sections="row" activeView="main" />)
    fireEvent.click(screen.getByRole('button', { name: 'Feed Hold' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop/Reset' }))
    expect(executors.feedHold).toHaveBeenCalledTimes(2)
    expect(executors.stopReset).toHaveBeenCalledTimes(2)
  })

  it('pins the compact row to the shared header height and hides the STEP sibling', () => {
    expect(appCss).toMatch(/--control-strip-control-height:\s*34px/)
    expect(appCss).toMatch(
      /\.control-aux-authority \.control-transport-compact \+ \.control-uix-steprow\s*\{[^}]*display:\s*none/s,
    )
    expect(appCss).toMatch(
      /\.control-aux-authority \.control-transport-compact \.control-btn-estop,[\s\S]*?height:\s*var\(--control-strip-control-height\)/,
    )
    expect(appCss).toMatch(/\.control-uix-subnav \.control-view-tab\s*\{[^}]*height:\s*var\(--control-strip-control-height\)/s)
    expect(appCss).toMatch(/\.control-aux-authority \.control-transport-compact[\s\S]*?white-space:\s*nowrap/)
  })
})

describe('WO-1092 the transport centers its icon-plus-label groups', () => {
  it('measured both views at both supported widths', () => {
    expect(centering.captures.map((capture) =>
      `${capture.viewport.width}x${capture.viewport.height}/${capture.view}`,
    )).toEqual([
      '1680x900/machine',
      '1680x900/main',
      '1440x900/machine',
      '1440x900/main',
    ])
    // Every capture measured the three safety actions; Main adds CYCLE START.
    for (const capture of centering.captures) {
      const ids = capture.controls.map((control) => control.testId)
      for (const id of centering.safetyControls) expect(ids).toContain(id)
    }
    expect(measuredControls.length).toBe(14)
  })

  it('keeps every label on one line - never wrapped, never broken mid-word', () => {
    for (const control of measuredControls) {
      expect(control.labelText.lineCount, `${control.where} line count`).toBe(1)
      expect(control.labelText.height, `${control.where} text box height`)
        .toBeLessThanOrEqual(control.fontSizePx * centering.singleLineHeightRatio)
      expect(control.labelText.singleLine, `${control.where} single line`).toBe(true)
    }
  })

  it('centers the icon-plus-label group within 1px of the box center on both axes', () => {
    for (const control of measuredControls) {
      expect(Math.abs(control.centerDelta.x), `${control.where} horizontal`)
        .toBeLessThanOrEqual(centering.centerTolerancePx)
      expect(Math.abs(control.centerDelta.y), `${control.where} vertical`)
        .toBeLessThanOrEqual(centering.centerTolerancePx)
    }
  })

  it('keeps each icon at full size, 6px from its word', () => {
    for (const control of measuredControls) {
      // A crushed icon is what read as "not centered": before this change the
      // Machine strip's Stop/Reset icon measured 0px wide and Feed Hold's 1.3px.
      expect(control.icon, `${control.where} icon`).not.toBeNull()
      expect(control.icon!.width, `${control.where} icon width`).toBeGreaterThanOrEqual(12)
      expect(Math.abs((control.iconLabelGapPx ?? NaN) - centering.iconLabelGapPx), `${control.where} gap`)
        .toBeLessThanOrEqual(centering.iconLabelGapTolerancePx)
    }
  })

  it('keeps every transport inside its own column', () => {
    for (const capture of centering.captures) {
      const where = `${capture.viewport.width}x${capture.viewport.height}/${capture.view}`
      expect(capture.transportFit.contentOverflowPx, `${where} content`)
        .toBeLessThanOrEqual(centering.overflowTolerancePx)
      expect(capture.transportFit.rightEdgeOverflowPx, `${where} right edge`)
        .toBeLessThanOrEqual(centering.overflowTolerancePx)
      expect(capture.transportFit.columnOverflowPx, `${where} column`)
        .toBeLessThanOrEqual(centering.overflowTolerancePx)
    }
  })

  it('never shortens a control because the row re-flowed', () => {
    for (const capture of centering.captures) {
      const where = `${capture.viewport.width}x${capture.viewport.height}/${capture.view}`
      const byId = new Map(capture.controls.map((control) => [control.testId, control]))
      const hold = byId.get('control-feedhold')!
      const stop = byId.get('control-stop-reset')!
      // The two that always share a row share one height, everywhere.
      expect(hold.box.height, `${where} Feed Hold vs Stop/Reset height`).toBe(stop.box.height)
      // 34px is the shared header-row height; Main's row stands at CYCLE
      // START's 38px whether or not it still shares that button's row.
      const floor = capture.view === 'main' ? 38 : 34
      for (const control of capture.controls) {
        expect(control.box.height, `${where}/${control.testId} height`).toBeGreaterThanOrEqual(floor)
      }
    }
  })

  it('renders the icon-plus-word shape the harness measures', () => {
    // The fix is CSS only - this pins the markup the measurement is taken
    // against, so a later seat cannot silently drop an icon or split a label
    // into pieces and leave the numbers above describing something else.
    render(<ControlTransportBar sections="transport" activeView="main" />)
    for (const [testId, word] of [
      ['control-estop', 'E-STOP'],
      ['control-cyclestart', 'CYCLE START'],
      ['control-feedhold', 'Feed Hold'],
      ['control-stop-reset', 'Stop/Reset'],
    ] as const) {
      const button = screen.getByTestId(testId)
      expect(button.querySelectorAll('svg'), `${testId} icons`).toHaveLength(1)
      const words = Array.from(button.childNodes).filter(
        (node) => node.nodeType === 3 && (node.textContent ?? '').trim(),
      )
      expect(words, `${testId} label text nodes`).toHaveLength(1)
      expect(words[0].textContent?.trim()).toBe(word)
    }
  })
})

describe('WO-1099 Main keeps the compact transport inside its original column', () => {
  it('measured both supported Main viewports against the pre-change widths', () => {
    expect(compactMain.captures.map((capture) =>
      `${capture.viewport.width}x${capture.viewport.height}`,
    )).toEqual(['1680x900', '1440x900'])
    for (const capture of compactMain.captures) {
      expect(Math.abs(
        capture.layout.gcodeStreamingColumnWidth - capture.targets.gcodeStreamingColumnWidth,
      )).toBeLessThanOrEqual(compactMain.layoutTolerancePx)
      expect(Math.abs(
        capture.layout.previewViewportWidth - capture.targets.previewViewportWidth,
      )).toBeLessThanOrEqual(compactMain.layoutTolerancePx)
    }
  })

  it('keeps CYCLE START, Feed Hold and Stop/Reset on one centered, unwrapped row', () => {
    for (const capture of compactMain.captures) {
      expect(capture.layout.lowerRowTopSpreadPx).toBeLessThanOrEqual(compactMain.layoutTolerancePx)
      expect(capture.layout.lowerRowBottomSpreadPx).toBeLessThanOrEqual(compactMain.layoutTolerancePx)
      const controls = capture.controls.filter((control) => compactMain.lowerRowControls.includes(control.testId))
      expect(controls.map((control) => control.testId)).toEqual(compactMain.lowerRowControls)
      for (const control of controls) {
        expect(control.labelText.lineCount).toBe(1)
        expect(control.labelText.singleLine).toBe(true)
        expect(Math.abs(control.centerDelta.x)).toBeLessThanOrEqual(compactMain.centerTolerancePx)
        expect(Math.abs(control.centerDelta.y)).toBeLessThanOrEqual(compactMain.centerTolerancePx)
        expect(control.icon?.width).toBeGreaterThanOrEqual(12)
        expect(Math.abs((control.iconLabelGapPx ?? NaN) - compactMain.compactIconLabelGapPx))
          .toBeLessThanOrEqual(compactMain.iconLabelGapTolerancePx)
      }
    }
  })

  it('has no content, right-edge, or column overflow', () => {
    for (const capture of compactMain.captures) {
      expect(capture.layout.contentOverflowPx).toBeLessThanOrEqual(compactMain.layoutTolerancePx)
      expect(capture.layout.rightEdgeOverflowPx).toBeLessThanOrEqual(compactMain.layoutTolerancePx)
      expect(capture.layout.columnOverflowPx).toBeLessThanOrEqual(compactMain.layoutTolerancePx)
    }
  })
})
