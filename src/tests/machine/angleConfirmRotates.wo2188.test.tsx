// @vitest-environment jsdom
//
// WO-2188 - ANGLE'S CONFIRM ROTATES THE WORK OFFSET.
//
// Operator, 2026-09-29 1:03 AM CT, card "Angle: rotate the work coordinates? 5
// choices": "Defaults are fine - build it" - after Angle, Confirm offers
// "Rotate G54 by x deg" AND shows the tap-it-square number; the 5 deg limit
// goes. Invariants: docs/design/WCS-ROTATION.md.
//
// Route: the production Probing panel (ProbingPanel), Angle, Start probing,
// its result step and its Confirm. The routine runner is stubbed to report the
// touches a probe makes on a MODELLED FACE (a straight face at a known angle,
// a ball of known radius) exactly as runFeatureProbeCycle does (onTouch, then
// its result); the controller's rotation is the WO-2187 call
// (setWorkRotation / workRotations), stubbed as a controller that holds what
// it is told. The call itself is proven on both controllers by WO-2187.
//
// The sign is pinned by the OUTCOME, not a formula: after Confirm, a work-X
// (or work-Y) move from a point on the face stays on the face (residual under
// 0.001 mm over 100 mm, LinuxCNC's machine = O + Rot(R)(work)), and Angle run
// again on the same face reads 0.000 deg.
//
// Every other routine, every step, and its result step after a run, renders
// byte-identical to main: hashes recorded from main's ProbingPanel.tsx /
// probeRoutines.ts in src/tests/evidence/WO-2592/baselines/WO-2188-others-panel.main.json
// (WRITE_EVIDENCE=1 re-records them - only ever on main's code).

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { typedMock } from '../support/typedMock'
import { removeWo2665Wrappers, wo2665OldSetupWords } from './support/wo2665Layout'

const held = vi.hoisted(() => ({ rotations: {} as Record<string, number> }))

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle: vi.fn(),
    setWorkOffsetValue: vi.fn(() => true),
    // A controller that holds the rotation it is told and reports it back.
    setWorkRotation: vi.fn(async (wcs: string, degrees: number) => {
      held.rotations[wcs] = degrees
      return { ok: true, reason: null, rotationDeg: degrees, offset: null, outcome: 'accepted' as const }
    }),
    workRotations: vi.fn(() => ({ ...held.rotations })),
  })
})

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const machineSession = await import('../../lib/machine/machineSession')
const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

const runFeatureProbeCycle = vi.mocked(machineSession.runFeatureProbeCycle)
const setWorkOffsetValue = vi.mocked(machineSession.setWorkOffsetValue)
// Absent on main's ProbingPanel import list, present in the mocked module either way.
const setWorkRotation = vi.mocked((machineSession as unknown as { setWorkRotation: (w: string, d: number) => Promise<unknown> }).setWorkRotation)

type TouchKey = import('../../lib/machine/probeFeatureCycle').ProbeCycleTouchKey
type Plan = Parameters<typeof machineSession.runFeatureProbeCycle>[0]
type TouchStep = Extract<Plan['steps'][number], { kind: 'touch' }>

const START = { x: -50, y: -50, z: -10 }
const RAD = Math.PI / 180
/** The modelled probe ball. The angle does not depend on it (both touches
 *  shift by the same amount), which is the point of modelling it. */
const BALL_MM = 1.5

beforeEach(() => {
  memory.clear()
  __resetProbingSessionForTest()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: null,
    tlo: null,
    homed: true,
    mpos: { ...START },
    probe: null,
    consoleLines: [],
    connectionKind: 'serial',
    settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
  held.rotations = {}
  runFeatureProbeCycle.mockReset()
  setWorkOffsetValue.mockReset()
  setWorkOffsetValue.mockReturnValue(true)
  setWorkRotation.mockClear()
})

afterEach(() => cleanup())

// ---- the modelled face -------------------------------------------------------

/** A straight face through `at`, `deg` CCW from its nominal axis (X for the
 *  front/back faces, Y for the left/right). */
interface Face { nominal: 'X' | 'Y'; deg: number; at: { x: number; y: number } }

const faceDir = (face: Face) => face.nominal === 'X'
  ? { x: Math.cos(face.deg * RAD), y: Math.sin(face.deg * RAD) }
  : { x: -Math.sin(face.deg * RAD), y: Math.cos(face.deg * RAD) }

/** Where the ball's centre stops moving along `dir` from `start`: one ball
 *  radius off the face, on the side it came from. */
function contact(face: Face, start: { x: number; y: number }, dir: { x: number; y: number }) {
  const u = faceDir(face)
  const n = { x: -u.y, y: u.x }
  const f0 = (start.x - face.at.x) * n.x + (start.y - face.at.y) * n.y
  const side = Math.sign(f0)
  const t = (side * BALL_MM - f0) / (dir.x * n.x + dir.y * n.y)
  return { x: start.x + t * dir.x, y: start.y + t * dir.y }
}

/**
 * Start probing on the screen with the runner touching `face`. The touch
 * moves along machine axes (the AXBB-E, and every controller with no
 * rotation), or - `turnedDeg`, LinuxCNC under a rotation - along the work
 * axes turned by that much, and then the controller's own probe record
 * (LinuxCNC's probed_position) says where the contact landed.
 */
async function runAngleOn(face: Face, turnedDeg = 0) {
  let ranPlan: Plan | null = null
  runFeatureProbeCycle.mockImplementationOnce(async (plan, _config, _clear, onTouch) => {
    ranPlan = plan
    const touches: Partial<Record<TouchKey, number>> = {}
    for (const step of plan.steps) {
      if (step.kind !== 'touch') continue
      const sign = step.direction === '+' ? 1 : -1
      const square = step.axis === 'X' ? { x: sign, y: 0 } : { x: 0, y: sign }
      const c = Math.cos(turnedDeg * RAD)
      const s = Math.sin(turnedDeg * RAD)
      const dir = { x: square.x * c - square.y * s, y: square.x * s + square.y * c }
      const at = contact(face, step.expectedStart, dir)
      const value = step.axis === 'X' ? at.x : at.y
      if (turnedDeg !== 0) useMachineControl.setState({ probe: { values: [at.x, at.y, START.z], success: true } })
      touches[step.key] = value
      onTouch?.(step.key, value)
    }
    return { ok: true, message: 'angle cycle recorded 2 touches.', touches, topMachineZ: null }
  })
  const start = screen.getByTestId('control-probe-run-guided') as HTMLButtonElement
  expect(start.disabled, start.title).toBe(false)
  await act(async () => {
    fireEvent.click(start)
    await Promise.resolve()
  })
  expect(ranPlan).not.toBeNull()
  return ranPlan! as Plan
}

function openAngle(faceValue: 'X+' | 'X-' | 'Y+' | 'Y-' = 'X+') {
  render(React.createElement(ProbingPanel))
  fireEvent.click(screen.getByTestId('control-work-probe-routine-angle'))
  fireEvent.change(screen.getByTestId('control-work-probe-angle-face'), { target: { value: faceValue } })
}

/** The result step's first line - the measured angle (or, on main past 5 deg,
 *  its refusal). */
const measured = () => screen.getByTestId('control-work-probe-result').querySelector('span')?.textContent ?? null
const tap = () => screen.queryByTestId('control-work-probe-angle-tap')?.textContent ?? null
function confirmButton(): HTMLButtonElement {
  const button = screen.queryByTestId('control-work-probe-apply') as HTMLButtonElement | null
  expect(button, 'the Angle result step offers a Confirm').not.toBeNull()
  return button!
}
async function pressConfirm() {
  await act(async () => {
    fireEvent.click(confirmButton())
    await Promise.resolve()
  })
}

/** How far off `face` a move of `lengthMm` along work `axis` ends, starting
 *  ON the face, with the work offset rotated `rotationDeg` - LinuxCNC's
 *  machine = O + Rot(R)(work) (docs/design/WCS-ROTATION.md). */
function offFaceAfterWorkMove(face: Face, rotationDeg: number, axis: 'X' | 'Y', lengthMm: number): number {
  const c = Math.cos(rotationDeg * RAD)
  const s = Math.sin(rotationDeg * RAD)
  const work = axis === 'X' ? { x: lengthMm, y: 0 } : { x: 0, y: lengthMm }
  const moved = { x: face.at.x + work.x * c - work.y * s, y: face.at.y + work.x * s + work.y * c }
  const u = faceDir(face)
  return Math.abs((moved.x - face.at.x) * -u.y + (moved.y - face.at.y) * u.x)
}

const touchSpacing = (plan: Plan, nominal: 'X' | 'Y') => {
  const along = plan.steps.filter((s): s is TouchStep => s.kind === 'touch').map((s) => (nominal === 'X' ? s.expectedStart.x : s.expectedStart.y))
  return Math.abs(along[1] - along[0])
}

describe('WO-2188 Angle: Confirm rotates the work offset by the measured angle', () => {
  it('front face at 1.5 deg: Confirm offers "Rotate G54 by 1.5 deg" and the tap number; only pressing it rotates G54; work X then runs along the face and a re-run reads 0.000', async () => {
    const face: Face = { nominal: 'X', deg: 1.5, at: { x: START.x, y: START.y + 10 } }
    openAngle('X+')
    const plan = await runAngleOn(face)

    expect(measured()).toBe('Measured 1.500 deg from nominal X on the front face (probe Y+).')
    const spacing = touchSpacing(plan, 'X')
    expect(spacing).toBe(25)
    // 25 mm x tan 1.5 deg = 0.655 mm; the right end sits away from you.
    expect(tap()).toBe('The face runs off 0.65 mm over 25.00 mm - tap the right end toward you.')
    expect(confirmButton().textContent).toBe('Rotate G54 by 1.5 deg')
    expect(confirmButton().disabled).toBe(false)
    // Not confirming changes nothing.
    expect(setWorkRotation).not.toHaveBeenCalled()
    expect(setWorkOffsetValue).not.toHaveBeenCalled()

    await pressConfirm()
    expect(setWorkRotation).toHaveBeenCalledTimes(1)
    expect(setWorkRotation.mock.calls[0][0]).toBe('G54')
    const rotation = held.rotations.G54
    expect(rotation).toBeCloseTo(1.5, 9)
    // THE OUTCOME: a work-X move of 100 mm from a point on the face stays on it.
    expect(offFaceAfterWorkMove(face, rotation, 'X', 100)).toBeLessThan(0.001)
    // The wrong sign would double the error, not remove it.
    expect(offFaceAfterWorkMove(face, -rotation, 'X', 100)).toBeGreaterThan(5)
    expect(setWorkOffsetValue).not.toHaveBeenCalled()
    // Pressing it again holds the same rotation - it never adds the angle twice.
    await pressConfirm()
    expect(held.rotations.G54).toBeCloseTo(1.5, 9)

    // Angle again on the same face reads 0 against the rotated G54.
    await runAngleOn(face)
    expect(measured()).toBe('Measured 0.000 deg from nominal X on the front face (probe Y+), with G54 rotated 1.5 deg.')
    expect(tap()).toBe('The face runs square over 25.00 mm - nothing to tap.')
    // Nothing left to rotate: no Rotate button (architect 09-29: 'Rotate G54 by 0 deg' did nothing).
    expect(screen.queryByTestId('control-work-probe-apply')).toBeNull()
    expect(held.rotations.G54).toBeCloseTo(1.5, 9)
  })

  it('a 7 deg face (refused before, past the old 5 deg limit) is reported and can be applied', async () => {
    const face: Face = { nominal: 'X', deg: -7, at: { x: START.x, y: START.y + 10 } }
    openAngle('X+')
    await runAngleOn(face)
    expect(measured()).toBe('Measured -7.000 deg from nominal X on the front face (probe Y+).')
    // 25 x tan 7 deg = 3.070 mm; the right end sits toward you.
    expect(tap()).toBe('The face runs off 3.07 mm over 25.00 mm - tap the right end away from you.')
    expect(confirmButton().textContent).toBe('Rotate G54 by -7 deg')
    await pressConfirm()
    expect(held.rotations.G54).toBeCloseTo(-7, 9)
    expect(offFaceAfterWorkMove(face, held.rotations.G54, 'X', 100)).toBeLessThan(0.001)
    await runAngleOn(face)
    expect(measured()).toMatch(/^Measured 0\.000 deg from nominal X on the front face \(probe Y\+\), with G54 rotated -7 deg\.$/)
  })

  it('LinuxCNC turns the probe move with the rotation: the contact it records gives the re-run 0.000 at 7 deg', async () => {
    const face: Face = { nominal: 'X', deg: 7, at: { x: START.x, y: START.y + 10 } }
    openAngle('X+')
    await runAngleOn(face)
    await pressConfirm()
    expect(held.rotations.G54).toBeCloseTo(7, 9)
    // The second run's Y+ touches travel along work Y, turned 7 deg; each
    // lands off the plan's X by its travel x sin 7 deg.
    await runAngleOn(face, held.rotations.G54)
    expect(measured()).toBe('Measured 0.000 deg from nominal X on the front face (probe Y+), with G54 rotated 7 deg.')
    expect(tap()).toBe('The face runs square over 25.00 mm - nothing to tap.')
  })

  it('right face (nominal Y), point 2 toward -Y: rotates by the angle so work Y runs along the face; tap words for the back end', async () => {
    const face: Face = { nominal: 'Y', deg: -2, at: { x: START.x + 10, y: START.y } }
    openAngle('Y-')
    fireEvent.change(screen.getByTestId('control-work-probe-angle-along-direction'), { target: { value: '-' } })
    await runAngleOn(face)
    expect(measured()).toBe('Measured -2.000 deg from nominal Y on the right face (probe X-).')
    // Going +Y the face leans +X (CW): the back end sits to the right.
    expect(tap()).toBe('The face runs off 0.87 mm over 25.00 mm - tap the back end to the left.')
    await pressConfirm()
    expect(held.rotations.G54).toBeCloseTo(-2, 9)
    expect(offFaceAfterWorkMove(face, held.rotations.G54, 'Y', 100)).toBeLessThan(0.001)
    await runAngleOn(face)
    expect(measured()).toBe('Measured 0.000 deg from nominal Y on the right face (probe X-), with G54 rotated -2 deg.')
  })

  it('rotates the ACTIVE work offset - G55 here - and names it', async () => {
    useMachineControl.setState({ activeWcs: 'G55' })
    const face: Face = { nominal: 'X', deg: 0.73, at: { x: START.x, y: START.y + 10 } }
    openAngle('X+')
    await runAngleOn(face)
    expect(confirmButton().textContent).toBe('Rotate G55 by 0.73 deg')
    await pressConfirm()
    expect(held.rotations).toEqual({ G55: expect.closeTo(0.73, 9) })
  })

  it('before a run there is no result and no Confirm', () => {
    openAngle('X+')
    const chips = screen.getAllByTestId(/^probing-step-chip-/)
    fireEvent.click(chips[chips.length - 1])
    expect(measured()).toBe('No result yet - run the routine first.')
    expect(screen.queryByTestId('control-work-probe-apply')).toBeNull()
  })
})

// ---- HARD LIMIT (Operator 09-28): every other routine byte-identical ---------------

const OTHERS = ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'toolZ', 'calibrate'] as const
const RUNNABLE = new Set<string>(['edge', 'outsideCorner', 'insideCorner', 'bore', 'boss', 'rectPocket', 'rectBoss'])
// WO-2592: approved landed WO-2553 adds the shared lamp; WO-2554 changes internal wall seeks.
// WO-2474 keeps current length precision and WO-2557 delays running display until motion.
const BASELINE = join(process.cwd(), 'src/tests/evidence/WO-2592/baselines/WO-2188-others-panel.main.json')
// Operator ruling WO-2600: "We should have a stop or pause that only effects probing,
// not the entire program." Exclude ONLY its added Pause control and the
// Start button's new grid span; every other byte keeps the approved baseline.
const hash = (text: string) => {
  const unchanged = document.createElement('div')
  unchanged.innerHTML = text
  // WO-2764: WO-2665's center column, identity picture-scale wrapper and four shortened
  // setup sentences are excused, nothing else.
  removeWo2665Wrappers(unchanged)
  unchanged.innerHTML = wo2665OldSetupWords(unchanged.innerHTML)
  unchanged.querySelector('[data-testid="control-probe-pause"]')?.remove()
  const start = unchanged.querySelector<HTMLElement>('[data-testid="control-probe-run-guided"]')
  // Only the grid span is excused; any other inline style still changes the hash.
  if (start) { start.style.removeProperty('grid-column'); if (!start.getAttribute('style')?.trim()) start.removeAttribute('style') }
  return createHash('sha256').update(unchanged.innerHTML).digest('hex')
}

async function renderEveryStep(kind: string): Promise<string[]> {
  const { container } = render(React.createElement(ProbingPanel))
  fireEvent.click(screen.getByTestId(`control-work-probe-routine-${kind}`))
  const hashes: string[] = []
  const chipCount = () => document.querySelectorAll('[data-testid^="probing-step-chip-"]').length
  for (let i = 0; i < chipCount(); i++) {
    fireEvent.click(screen.getAllByTestId(/^probing-step-chip-/)[i])
    hashes.push(hash(container.innerHTML))
  }
  if (RUNNABLE.has(kind)) {
    // A run: every touch 2 mm on from where it starts, then the result step
    // with its Confirm, then that Confirm pressed.
    runFeatureProbeCycle.mockImplementationOnce(async (plan, _config, _clear, onTouch) => {
      const touches: Partial<Record<TouchKey, number>> = {}
      for (const step of plan.steps) {
        if (step.kind !== 'touch') continue
        const value = (step.axis === 'X' ? step.expectedStart.x : step.expectedStart.y) + (step.direction === '+' ? 2 : -2)
        touches[step.key] = value
        onTouch?.(step.key, value)
      }
      return { ok: true, message: `${kind} cycle recorded.`, touches, topMachineZ: null }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-probe-run-guided'))
      await Promise.resolve()
    })
    hashes.push(hash(container.innerHTML))
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-work-probe-apply'))
      await Promise.resolve()
    })
    hashes.push(hash(container.innerHTML))
  }
  return hashes
}

describe('WO-2188 every other routine renders byte-identical to main', () => {
  it('every other routine, every step, and its result step and Confirm after a run', async () => {
    const recorded: Record<string, string[]> = {}
    for (const kind of OTHERS) {
      __resetProbingSessionForTest()
      recorded[kind] = await renderEveryStep(kind)
      cleanup()
    }
    // Nothing the other routines do reaches the rotation.
    expect(setWorkRotation).not.toHaveBeenCalled()
    if (process.env.WRITE_EVIDENCE === '1') writeFileSync(BASELINE, `${JSON.stringify(recorded, null, 2)}\n`)
    expect(existsSync(BASELINE), 'record the baseline on main first (WRITE_EVIDENCE=1)').toBe(true)
    const main = JSON.parse(readFileSync(BASELINE, 'utf-8')) as Record<string, string[]>
    for (const kind of OTHERS) expect(recorded[kind], kind).toEqual(main[kind])
  })
})
