// @vitest-environment jsdom
// WO-2284: real ProbingPanel, all four faces and both Top choices.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProbingPanel, __resetProbingSessionForTest } from '../../components/machine/ProbingPanel'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { useMachineToolTable } from '../../store/machineToolTableStore'

beforeEach(() => {
  localStorage.clear()
  __resetProbingSessionForTest()
  useCamStore.getState().newProject()
  useCamStore.getState().setDisplayUnits('mm')
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected', machineState: 'idle', activeWcs: 'G54', activeTool: null,
    tlo: null, homed: true, mpos: { x: -50, y: -50, z: -10 },
    settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})
afterEach(() => {
  // machineSession holds per-routine sensing separately from the tool table.
  const sensing = screen.queryByTestId('control-work-probe-sensing')
  if (sensing) fireEvent.change(sensing, { target: { value: 'probe' } })
  cleanup()
})

const sentence = () => screen.getByTestId('probing-step-sentence').textContent ?? ''
const chips = () => screen.getAllByTestId(/^probing-step-chip-\d+$/)
const setDim = (id: string, value: string) => {
  fireEvent.change(screen.getByTestId(id), { target: { value } })
  fireEvent.blur(screen.getByTestId(id))
}
const faces = () => {
  const out: string[] = []
  for (const chip of chips()) {
    fireEvent.click(chip)
    if (/^(Right|Left|Back|Front) face:/.test(sentence())) out.push(sentence())
  }
  expect(out).toHaveLength(4)
  return out
}

describe('WO-2284 Boss says how far outside each face it descends', () => {
  for (const routine of ['boss', 'rectBoss'] as const) {
    for (const top of ['touch', 'workZero'] as const) {
      it(`${routine}, ${top}: all faces follow Clearance, Tip radius and the nominal size`, () => {
        render(<ProbingPanel />)
        fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
        fireEvent.change(screen.getByTestId('control-work-probe-top'), { target: { value: top } })
        setDim(routine === 'boss' ? 'control-work-probe-nominal-diameter' : 'control-work-probe-nominal-x', '12.5')
        if (routine === 'rectBoss') setDim('control-work-probe-nominal-y', '20')
        for (const text of faces()) {
          expect(text).toContain('probe centre 6.5 mm outside the face')
          expect(text).toContain('Tip radius 1.5 mm + Clearance 5 mm; Clearance sets it')
        }
        expect(faces()[0]).toContain('steps out X+ 12.8 mm')
        setDim('control-work-probe-face-distance', '8')
        for (const text of faces()) {
          expect(text).toContain('probe centre 9.5 mm outside the face')
          expect(text).toContain('Tip radius 1.5 mm + Clearance 8 mm; Clearance sets it')
        }
        setDim('control-work-probe-tip-radius', '2')
        for (const text of faces()) {
          expect(text).toContain('probe centre 10 mm outside the face')
          expect(text).toContain('Tip radius 2 mm + Clearance 8 mm; Clearance sets it')
        }
        const before = faces()
        setDim(routine === 'boss' ? 'control-work-probe-nominal-diameter' : 'control-work-probe-nominal-x', '40')
        const after = faces()
        expect(after[0]).toContain('steps out X+ 30 mm')
        expect(after[0]).not.toBe(before[0])
        for (const text of after) expect(text).toContain('probe centre 10 mm outside the face')
        if (routine === 'rectBoss') {
          setDim('control-work-probe-nominal-y', '30')
          expect(faces()[2]).not.toBe(after[2])
          for (const text of faces()) expect(text).toContain('probe centre 10 mm outside the face')
        }
      })
    }
  }

  it('uses the displayed inch units for both the total and its components', () => {
    useCamStore.getState().setDisplayUnits('inch')
    render(<ProbingPanel />)
    fireEvent.click(screen.getByTestId('control-work-probe-routine-boss'))
    for (const text of faces()) {
      expect(text).toContain('probe centre 0.256 in outside the face')
      expect(text).toContain('Tip radius 0.059 in + Clearance 0.197 in; Clearance sets it')
    }
  })

  it('names the plate contribution separately from the typed Tip radius', () => {
    render(<ProbingPanel />)
    fireEvent.click(screen.getByTestId('control-work-probe-routine-boss'))
    fireEvent.change(screen.getByTestId('control-work-probe-sensing'), { target: { value: 'plate' } })
    setDim('control-work-probe-plate-thickness', '2')
    for (const text of faces()) {
      expect(text).toContain('probe centre 8.5 mm outside the face')
      expect(text).toContain('Tip radius 1.5 mm + Plate 2 mm + Clearance 5 mm; Clearance sets it')
    }
  })

  it('preserves every other sentence, including Calibrate outside, and every picture byte', () => {
    render(<ProbingPanel />)
    const now: Record<string, { sentence: string; picture: string }> = {}
    for (const routine of ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'toolZ', 'calibrate']) {
      fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
      if (routine === 'calibrate') fireEvent.change(screen.getByTestId('control-calibrate-reference-kind'), { target: { value: 'outside' } })
      for (const chip of chips()) {
        fireEvent.click(chip)
        now[`${routine} ${chip.getAttribute('data-testid')}`] = {
          sentence: sentence(),
          picture: createHash('sha256').update(screen.getByTestId('probe-picture').outerHTML).digest('hex'),
        }
      }
    }
    // WO-2592: the historical baseline predates this order's final Boss sentences (WO-2284).
    // Approved WO-2554 changes only the Bore/Rect pocket wall pictures and sentences.
    const baseline = join(process.cwd(), 'src/tests/evidence/WO-2592/baselines/WO-2284-panel-main.json')
    if (process.env.WRITE_WO2284_MAIN === '1') writeFileSync(baseline, `${JSON.stringify(now, null, 2)}\n`)
    const main = JSON.parse(readFileSync(baseline, 'utf8')) as typeof now
    expect(Object.keys(now)).toEqual(Object.keys(main))
    expect(Object.keys(now).some((key) => key.startsWith('calibrate '))).toBe(true)
    for (const [key, value] of Object.entries(now)) {
      expect(value.picture, key).toBe(main[key].picture)
      if (/^(boss|rectBoss) /.test(key) && /^(Right|Left|Back|Front) face:/.test(value.sentence)) continue
      expect(value.sentence, key).toBe(main[key].sentence)
    }
  })
})
