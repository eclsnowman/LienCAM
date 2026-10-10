import { describe, expect, it } from 'vitest'
import { topics as machine } from '../../help/topics/machine'
import { topics as cam } from '../../help/topics/cam-operations'
import { topics as viewport } from '../../help/topics/workspaces-viewport'

const topics = [...machine, ...cam, ...viewport]
function prose(id: string): string {
  const topic = topics.find(t => t.id === id)
  expect(topic, id).toBeDefined()
  return topic!.sections.flatMap(s => 'text' in s ? [s.text] : s.kind === 'steps' ? s.steps : []).join(' ')
}

describe('WO-2688 landed behavior in the real Help topics', () => {
  it('explains outdated operations on both existing surfaces', () => {
    expect(prose('generation-failures')).toContain('reason on the amber badge hover and in Summary Status')
    expect(prose('design-tree')).toContain('hover for why, then regenerate it')
    expect(prose('properties-panel')).toContain('reason in its Summary Status row')
  })

  it('distinguishes blind floors, through holes and explicit ends', () => {
    const text = prose('drill')
    expect(text).toContain('With Break through off, the drill tip stops at a detected blind flat floor')
    expect(text).toContain('a through hole keeps point compensation and Breakthrough past floor')
    expect(text).toContain('If the hole cannot be identified as blind or through, the existing point compensation is kept')
    expect(text).toContain('An explicit Target End remains the tip height')
    expect(text).not.toContain('floor found in the model, plus Breakthrough past floor')
  })

  it('replaces probe stop reasons without inferring causes', () => {
    const text = prose('probing-tab')
    expect(text).toContain('full reason in red on the probing screen')
    expect(text).toContain('a refused start shows Did not start and its reason')
    expect(text).toContain('A new stop or refused start replaces the previous reason')
    expect(text).toContain('without guessing a cause')
  })

  it('names the start controls and the single-press stop result', () => {
    const text = prose('control-run-job')
    expect(text).toContain('press CYCLE START to run from the chosen line, or Cancel to go back')
    expect(text).toContain('Single Block ON means each CYCLE START or Step runs one line')
    expect(text).toContain('Single Block OFF means CYCLE START runs the whole program')
    expect(text).toContain('MDI, jog and macros are available after that one press')
    expect(prose('control-tab-overview')).toContain('fit side by side at the default panel width')
  })

  it('documents exact UCCNC overrides and limits output indicators to Vacuum', () => {
    const text = prose('control-run-job')
    expect(text).toContain('UCCNC sends the exact percentage in one command; GRBL uses its reset and steps')
    expect(text).toContain('print no clamp warning; a confirmed different value still gets a clamp message')
    expect(text).toContain("The Vacuum button lights from the controller's reported output state")
    expect(text).toContain('Macro buttons do not yet share this indicator behavior')
    expect(text).toContain('Line 5: Vacuum on (M7, port 3 pin 16)')
  })

  it('describes the source listing, M0 highlight and camera preservation', () => {
    const text = prose('control-run-job')
    expect(text).toContain('every source line exactly as written, including comments and output words')
    expect(text).toContain('At an M0 hold, the highlight sits on the M0 line')
    expect(text).toContain('A plain file header leads with the file name')
    expect(text).toContain('keeps your zoom and pan through MDI moves, work offset changes (including probing Confirm) and WCS changes')
    expect(text).toContain('Load re-fits the program, even for the same file')
  })

  it('separates brief path warnings, sustained departures and unchecked travel', () => {
    const text = prose('control-run-job')
    expect(text).toContain('plain X/Y/Z file on the shipped sample GRBL router')
    expect(text).toContain('A brief jump over the threshold gets a warning with its size, position and duration')
    expect(text).toContain('a sustained departure gets the red left-the-path message')
    expect(text).toContain('If too few positions can be matched, the check says it cannot assess the run')
    expect(text).toContain('the load note says travel was not checked')
    expect(text).toContain('Set its zero on the Offsets tab, then press CYCLE START')
  })
})
