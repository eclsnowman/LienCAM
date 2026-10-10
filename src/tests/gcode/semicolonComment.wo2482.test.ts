// @vitest-environment jsdom

import { createElement } from 'react'
import { writeFileSync } from 'node:fs'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tokenizeLine, parseGcode } from '../../lib/gcode/parse'
import { lintGcode } from '../../lib/gcode/lint'
import { postProject, LINUXCNC_CONFIG, importProgramContextFromGcode } from '../../lib/post'
import { createDefaultControllerDefinition, type Project, type Setup } from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, move, stampGenerationCurrent } from '../post/helpers'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import {
  __resetEstopInterlockForTest,
  __reportWorkOffsetsForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeFile,
} from '../../lib/machine/machineSession'
import { ControlTransportBar } from '../../components/machine/ControlTransportBar'

describe('WO-2482 semicolon comments', () => {
  it('records a comment-only line without address words', () => {
    expect(tokenizeLine('; G2 X1 M3 (not code) ; rest\r', 7)).toEqual({
      number: 7, raw: '; G2 X1 M3 (not code) ; rest', words: [],
      comment: 'G2 X1 M3 (not code) ; rest',
    })
  })

  it('keeps real words before the semicolon', () => {
    const line = tokenizeLine('G0 X1 ; move G2 X999', 1)
    expect(line.words).toEqual([{ letter: 'G', value: 0 }, { letter: 'X', value: 1 }])
    expect(line.comment).toBe('move G2 X999')
  })

  it('keeps a semicolon inside parentheses and continues reading code', () => {
    const line = tokenizeLine('G0 (move; do not stop) X1 ; tail G2', 1)
    expect(line.words).toEqual([{ letter: 'G', value: 0 }, { letter: 'X', value: 1 }])
    expect(line.comment).toBe('move; do not stop')
  })

  it('preserves the first of several parenthesized comments', () => {
    const line = tokenizeLine('(first) G1 (second) X2 ; third', 1)
    expect(line.comment).toBe('first')
    expect(line.words).toEqual([{ letter: 'G', value: 1 }, { letter: 'X', value: 2 }])
  })

  it('records an empty semicolon comment', () => {
    expect(tokenizeLine('G0 X1;', 1).comment).toBe('')
  })

  it('does not let comment text change motion, position, feed or spindle', () => {
    const program = parseGcode('G0 X1 ; G2 X999 F999 S999\n; G3 X500\nX2')
    expect(program.segments.map((s) => [s.kind, s.to.x])).toEqual([['rapid', 1], ['rapid', 2]])
    expect(program.end).toMatchObject({ motion: 'G0', feed: null, spindle: null })
  })

  it('LinuxCNC structural lint ignores fake arcs and ends inside comments', () => {
    const findings = lintGcode('G0 X1 ; G2 X999\n; M30\n', { commentStyle: 'semicolon' })
    expect(findings.some((f) => f.message.includes('Circular move'))).toBe(false)
    expect(findings.some((f) => f.code === 'NO_PROGRAM_END')).toBe(true)
  })

  it('keeps UCCNC parentheses-only lexical policy separate from tokenization', () => {
    expect(lintGcode('G0 X1 ; move\nM30', { commentStyle: 'paren' })
      .some((f) => f.code === 'WRONG_COMMENT_STYLE')).toBe(true)
    expect(lintGcode('G0 (move; still a comment) X1\nM30', { commentStyle: 'paren' })).toEqual([])
  })
})

describe('WO-2482 production LinuxCNC post -> Load -> CYCLE START', () => {
  const originalCam = useCamStore.getState()

  afterEach(async () => {
    cleanup()
    if (vi.isFakeTimers()) {
      if (getMachineController().connectionPhase() !== 'disconnected') {
        const pending = disconnectMachine()
        await vi.advanceTimersByTimeAsync(300)
        await pending
      }
      vi.useRealTimers()
    }
    useCamStore.setState({ project: originalCam.project, machineLibrary: originalCam.machineLibrary,
      toolLibrary: originalCam.toolLibrary, control: originalCam.control })
  })

  it('enables the actual transport button with the context envelope included', async () => {
    vi.useFakeTimers()
    const definition = createDefaultControllerDefinition()
    for (const [index, axis] of definition.axes.entries()) {
      axis.softLimitMin = -200
      axis.softLimitMax = 200
      axis.homePin = { port: 1, pin: index + 1, negate: false }
    }
    const machine = makeMachine({ id: 'wo-2482', controller: 'linuxcnc',
      travel: { x: 400, y: 400, z: 400 }, noHomingSwitches: false,
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'min', machineZeroAt: 'min' },
      }, controllerDefinition: definition })
    const tool = makeTool()
    const op = makeOp({ toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000 }),
    ] })
    const setup: Setup = { id: 's1', name: 'Setup One', wcs: makeWcs(), stock: makeStock(),
      operations: [op],
      // Valid Unicode notes force a G2-looking base64 chunk, reproducing the
      // rehearsal's phantom arc without hand-writing or altering posted code.
      notes: '\u0476 a\u0476 b\u0476 c'.repeat(3) }
    const project: Project = { ...originalCam.project, id: 'wo-2482', name: 'Semicolon regression',
      machine, toolLibrary: [tool], geometry: [], setups: [setup], activeSetupId: setup.id }
    stampGenerationCurrent(project, setup, op, tool)
    useCamStore.setState({ project, machineLibrary: [machine], toolLibrary: [tool],
      control: { ...originalCam.control, activeMachineId: machine.id, sessionMachine: null,
        appliedMachine: null, sessionActiveMachineId: undefined } })
    const posted = postProject(project, [setup], LINUXCNC_CONFIG, {
      mode: 'combined', pauseBetweenSetups: false, baseName: 'wo-2482', ext: 'ngc', programContext: true,
    })
    expect(posted.ok).toBe(true)
    const file = posted.combined!
    if (process.env.WO2482_EVIDENCE) writeFileSync('src/tests/evidence/WO-2482/posted.ngc', file.gcode)
    expect(file.programContextEnvelope?.included).toBe(true)
    expect(file.gcode.split('\n').some((line) => line.startsWith('; LCX1') && /G2(?!\d)/.test(line))).toBe(true)
    const imported = importProgramContextFromGcode(file.gcode)
    expect(imported.warning).toBeNull()
    expect(imported.context).not.toBeNull()
    if (imported.context === null) throw new Error('posted context did not import')
    const pending = connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(300)
    await pending
    act(() => { __resetEstopInterlockForTest() })
    act(() => { __reportWorkOffsetsForTest({ G54: { x: 0, y: 0, z: 0 } }) })
    expect(getMachineController().home()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    act(() => { loadGcodeFile('wo-2482.ngc', file.gcode, imported.context) })
    const readiness = useMachineControl.getState().programReadiness
    if (process.env.WO2482_EVIDENCE) writeFileSync(`src/tests/evidence/WO-2482/${process.env.WO2482_EVIDENCE}-readiness.json`,
      JSON.stringify({ readiness, job: useMachineControl.getState().job }, null, 2))
    expect(readiness.ready, readiness.reason).toBe(true)
    expect(readiness.reason).toBe('Program checks passed.')
    render(createElement(ControlTransportBar))
    expect((screen.getByTestId('control-cyclestart') as HTMLButtonElement).disabled).toBe(false)
  })
})
