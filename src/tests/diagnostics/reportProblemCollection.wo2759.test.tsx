// @vitest-environment jsdom
// WO-2759 fix round 2 (astra audit, 2026-10-13): the collection boundary,
// driven through the real dialog with the REAL environment readers (nothing in
// sources.ts is mocked). Design section 3: an optional category's source is
// read only once its box is ticked. Precise environment is the only optional
// category that reads the browser; its precise-only fields are the screen size
// and the logical processor count. Opening the dialog, Read details again,
// choosing an incident and loading a chosen file must read neither; ticking
// Precise environment reads both.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const seed = vi.hoisted(() => ({ olderId: 'earlier-session-0002' }))

// An earlier session holding a failure, so there are two incidents to choose.
vi.mock('../../lib/diagnostics/history', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/diagnostics/history')>()
  class SeededStorage extends real.MemoryHistoryStorage {
    constructor() {
      super()
      const at = Date.now() - 60_000
      this.records.set(seed.olderId, {
        id: seed.olderId, startedAt: at, eventAt: [at], endedCleanly: true, dropped: 0, lastSeq: 1, generation: 0,
        omissions: { unknownCodes: 0, unknownFields: 0, invalidFields: 0, oversizeEvents: 0 },
        events: [{ v: 1, code: 'machine.alarm', seq: 1, t: 0, fields: { code: 2, positionLost: false } }],
      })
    }
  }
  return typedMock<typeof import('../../lib/diagnostics/history')>({ ...real, MemoryHistoryStorage: SeededStorage })
})

import { ReportProblemModal, openReportProblem, useReportProblem } from '../../components/modals/ReportProblemModal'
import { diagnosticHistory } from '../../lib/diagnostics'

const reads = { screen: 0, cpu: 0 }

// Getter spies on the precise-only browser fields (the auditor's reproduction).
beforeEach(() => {
  reads.screen = 0
  reads.cpu = 0
  Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, get() { reads.cpu += 1; return 8 } })
  const screenSpy = { configurable: true, get() { reads.screen += 1; return { width: 1920, height: 1080 } } }
  Object.defineProperty(globalThis, 'screen', screenSpy)
  if (typeof window !== 'undefined' && window !== (globalThis as unknown)) Object.defineProperty(window, 'screen', screenSpy)
})

afterEach(() => {
  cleanup()
  useReportProblem.setState({ open: false })
})

const check = (id: string) => screen.getByTestId(`report-problem-check-${id}`) as HTMLInputElement
const previewOf = (name: string) => screen.queryByTestId(`report-problem-file-preview-${name}`)

async function settled() {
  await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
  await waitFor(() => expect(previewOf('manifest.json')).not.toBeNull())
}

describe('WO-2759 collection boundary (audit fix round 2)', () => {
  it('no precise environment field is read until its box is ticked', async () => {
    await diagnosticHistory().whenReady()
    render(<ReportProblemModal />)
    act(() => openReportProblem())
    await settled()
    // The Basic environment default is in the report, read from the real browser.
    expect(previewOf('environment.json')).not.toBeNull()
    expect(check('preciseEnvironment').checked).toBe(false)
    expect(reads).toEqual({ screen: 0, cpu: 0 })

    fireEvent.click(screen.getByTestId('report-problem-read-again'))
    await settled()
    expect(reads).toEqual({ screen: 0, cpu: 0 })

    const incident = screen.getByTestId('report-problem-incident') as HTMLSelectElement
    expect(incident.value).toBe(seed.olderId)
    fireEvent.change(incident, { target: { value: diagnosticHistory().currentSessionId } })
    await settled()
    expect(reads).toEqual({ screen: 0, cpu: 0 })

    fireEvent.click(check('originalProgram'))
    const file = new File(['G21\nG1 X10 Y20 F500\n'], 'job.nc', { type: 'text/plain' })
    await act(async () => { fireEvent.change(screen.getByTestId('report-problem-file-program'), { target: { files: [file] } }) })
    await waitFor(() => expect(previewOf('program.nc')).not.toBeNull())
    expect(reads).toEqual({ screen: 0, cpu: 0 })

    fireEvent.click(check('preciseEnvironment'))
    await waitFor(() => expect(previewOf('environment-precise.json')).not.toBeNull())
    expect(reads.screen).toBeGreaterThan(0)
    expect(reads.cpu).toBeGreaterThan(0)
    expect(previewOf('environment-precise.json')!.textContent).toContain('1920x1080')
  })
})
