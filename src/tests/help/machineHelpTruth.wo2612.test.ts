import { describe, expect, it } from 'vitest'
import { topics as machine } from '../../help/topics/machine'
import { topics as posting } from '../../help/topics/posting-gcode'

const cases: [string, string][] = [
  ['control-tab-overview', 'or the LinuxCNC gateway'],
  ['control-tab-overview', 'The highlighted line and current move follow the move the controller is executing, rather than the last line it accepted.'],
  ['control-tab-overview', 'The progress count and section header follow that same move and stay at the stopped program position during a kept pause, commands in that pause, and the return.'],
  ['control-tab-overview', 'a tool-change card has its own Continue button.'],
  ['control-tab-overview', 'The E-STOP button in the app depends on a working controller link.'],
  ['connect-linuxcnc', 'At a program tool change, LienCAM shows the tool-change card when LinuxCNC reports the stop.'],
  ['control-connect', 'UCCNC uses its local bridge, and LinuxCNC uses its gateway instead of a serial port.'],
  ['control-run-job', 'To start at a chosen file line, enter its number in From line and press Plan.'],
  ['control-run-job', 'This also works for a setup posted to UCCNC.'],
  ['control-run-job', 'Plan arms the run without moving the machine; line 1 arms it from the top. Cancel restores the whole program.'],
  ['control-run-job', 'Every M0 in a file holds, including one beside or after a tool change or before a macro.'],
  ['control-run-job', 'While held at an M0, MDI stays locked until the hold ends or you press Stop/Reset.'],
  ['control-run-job', 'If LienCAM cannot switch the spindle, the same card tells you to start it by hand, including on a run from a line.'],
  ['control-run-job', 'Stop program ends the program; a manual tool change outside a program still has Cancel.'],
  ['control-run-job', 'Stop/Reset at an M0 or a program tool-change hold ends the program. CYCLE START then starts from the top; From line and Plan let you choose another starting line.'],
  ['control-run-job', 'After a completed run, CYCLE START arms the loaded program from line 1 and runs it again.'],
  ['control-run-job', 'The Console reports the program finished once per run.'],
  ['control-run-job', 'The top-right chip reads amber Held at an M0, during controller Feed Hold, and while waiting at a stationary tool-change card.'],
  ['control-run-job', 'Feed Hold pressed between program parts is a separate case: that chip indication is not yet updated.'],
  ['control-run-job', 'A plain MDI move or a probing routine is not a program.'],
  ['control-run-job', 'Stop/Reset ends the current run. Use Feed Hold when you intend to resume it; restarting from a line is a new run whose plan you must review.'],
  ['probing-tab', 'An approach toward a face to be touched is itself a probe seek at Search speed, followed by a back-off and a slow touch at Probe speed.'],
  ['probing-tab', 'A missed seek stops where it is, without an automatic retract.'],
  ['probing-tab', 'While probing runs, Pause stops the current move and becomes Resume. Resume continues toward the same endpoint.'],
  ['probing-tab', 'Stop ends only probing, from running or paused, and a stopped routine writes no result.'],
  ['probing-tab', 'These buttons preserve a loaded program; probing cannot start while that program is running or held.'],
  ['probing-tab', "When paused with the probing screen's Pause, the status line points to that screen's Resume and Stop."],
  ['probing-tab', 'Other held routines, such as Measure tool, still use CYCLE START and Stop/Reset as their status sentence says.'],
  // WO-2626 corrected the navigation path; the connected-default behavior is unchanged.
  ['probing-tab', 'Save probing settings under Control > Machine > Definition > Probing and the next routine uses them without reconnecting'],
  ['probing-tab', 'Settings that must be written to the controller still need its receipt'],
  ['probing-tab', 'When the reported probe position is within the pictured feature and its margin, Front and Right show its reported depth; its sideways place stays tied to the plan.'],
  ['probing-tab', 'Outside that area, or without a known position, the diagram keeps the planned picture.'],
  ['control-jog-zero', 'A controller that only offers a whole-machine homing cycle says so.'],
  ['control-run-job', 'The listing numbers are the original file line numbers.'],
  ['control-run-job', 'A stop-only section adds no motion row or move count, and a kept pause does not show a program-end row.'],
  ['control-run-job', 'A typed T number selects the tool for a later bare M6; a typed M6 opens the guided tool-change card, even with no loaded program.'],
  ['control-run-job', 'After a connected MDI command is handed to the controller, the input clears.'],
  ['probing-tab', 'PROBE shows the touch input; PROBING shows that a probe cycle is in process.'],
  ['probing-tab', 'A refused probe start keeps the current preview.'],
  ['probing-tab', 'Retry measure repeats the measurement without visiting the park again.'],
  ['probing-tab', 'Cancel on a manual tool change reports the cancellation and keeps the recorded spindle tool.'],
  ['probing-tab', 'the actual work Z offset change sent to the controller.'],
  ['post-options', 'The post adds no extra M0 after an M6 tool change.'],
  ['post-options', 'A UCCNC operator stop uses its M2001 macro without an extra M0; posts without that macro use M0.'],
  ['post-options', 'If your file contains an M0 beside or after either stop, Control still holds at that M0 separately.'],
]

describe('WO-2612 machine Help matches the reviewed operator behavior', () => {
  it.each(cases)('%s: %s', (id, sentence) => {
    const topic = [...machine, ...posting].find(t => t.id === id)
    expect(topic, id).toBeDefined()
    const prose = topic!.sections.flatMap(section =>
      'text' in section ? [section.text] : section.kind === 'steps' ? section.steps : [],
    ).join(' ')
    expect(prose).toContain(sentence)
  })
})
