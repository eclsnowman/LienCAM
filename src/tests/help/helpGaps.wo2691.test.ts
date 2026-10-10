// WO-2691 (Help gaps of the 10-08 journey audit, .planning/JOURNEY-2026-10-08.md):
// a first user meets "Re-arm from start", Control's Offsets tab with its
// "Push changed" button, and - on every first connect - "The software stop is
// latched. Press CLEAR to reset it." The auditor's grep of src/help/topics
// found none of them. Each is now covered, findable from Help's search box
// (title + summary + keywords, as HelpCenterModal filters), named exactly as
// the product draws it, and carried into the generated wiki page.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { topics as machine } from '../../help/topics/machine'
import { HELP_INDEX } from '../../help/index-data'
import { ESTOP_BLOCKS_MOTION } from '../../lib/machine/operatorAuthority'

const root = resolve(import.meta.dirname, '../../..')
const source = (path: string) => readFileSync(resolve(root, path), 'utf8')

function prose(id: string): string {
  const topic = machine.find(t => t.id === id)
  expect(topic, id).toBeDefined()
  return topic!.sections.flatMap(section =>
    'text' in section ? [section.text] : section.kind === 'steps' ? section.steps : [],
  ).join(' ')
}

/** Help Center's own search: the needle inside title, summary and keywords. */
function search(needle: string): string[] {
  const lower = needle.toLowerCase()
  return HELP_INDEX
    .filter(e => `${e.title} ${e.summary} ${e.keywords}`.toLowerCase().includes(lower))
    .map(e => e.id)
}

describe('WO-2691 the product names the Help now uses', () => {
  it('the labels are the ones the Control tab draws', () => {
    expect(source('src/lib/machine/operatorTransport.ts')).toContain("export const RE_ARM_LABEL = 'Re-arm from start'")
    expect(source('src/components/machine/OffsetsWorkspace.tsx')).toContain('Push changed ({differingRows.length})')
    expect(source('src/components/machine/OffsetsWorkspace.tsx')).toContain('Set from position')
    expect(source('src/components/machine/ControlTransportBar.tsx')).toContain("['offsets', 'Offsets']")
    expect(source('src/components/machine/ControlTransportBar.tsx')).toContain("label: 'CLEAR'")
    expect(ESTOP_BLOCKS_MOTION).toBe('The software stop is latched. Press CLEAR to reset it.')
  })
})

describe('WO-2691 Help covers each gap', () => {
  it('Re-arm from start: what it does, when it appears, when it is greyed', () => {
    const text = prose('control-run-job')
    expect(text).toContain('Re-arm from start appears in the transport bar when a text file is loaded.')
    expect(text).toContain('It arms the program from line 1, exactly as if you had just opened it')
    expect(text).toContain('nothing moves until you press CYCLE START')
    expect(text).toContain('CYCLE START itself arms the program from line 1 and runs it; the Console says "Armed from line 1."')
    expect(text).toContain('You do not need to press Re-arm first.')
    expect(text).toContain('From line and Plan preserve your chosen starting line instead.')
    expect(text).toContain('Re-arm is greyed while the program runs or is held (press Feed Hold, then Stop/Reset first) and during an alarm')
    expect(search('re-arm')).toContain('control-run-job')
    expect(search('Re-arm from start')).toContain('control-run-job')
  })

  it('the Offsets tab and Push changed', () => {
    const text = prose('control-jog-zero')
    expect(text).toContain("Control's Offsets tab shows the quick work offsets beside the Work offset setup table.")
    expect(text).toContain('it reaches the controller only when you press Push on its row')
    expect(text).toContain('Push changed (N) sends every row whose stored values differ from the controller; N is how many rows that is.')
    expect(text).toContain("Set from position makes the machine's current position that row's zero and sends it.")
    expect(search('offsets tab')).toContain('control-jog-zero')
    expect(search('push changed')).toContain('control-jog-zero')
  })

  it('CLEAR on first connect: the exact sentence, why, and what CLEAR does', () => {
    const text = prose('control-connect')
    expect(text).toContain(`the status says "${ESTOP_BLOCKS_MOTION}" This is normal on every connect`)
    expect(text).toContain('Press CLEAR.')
    expect(text).toContain('CLEAR returns it to idle, releases the stop, and the button reads E-STOP again. CLEAR moves nothing.')
    expect(search('software stop')).toContain('control-connect')
    expect(search('latched')).toContain('control-connect')
  })

  it('the GRBL tool-change hold says the line the status now shows (C5)', () => {
    expect(prose('control-run-job')).toContain(
      'A GRBL post has no M6: it writes a tool change as a "( change tool to T2 )" comment and an M0. '
      + 'Held there, the status reads "Held for a tool change - fit T2, then press CYCLE START."',
    )
  })

  it('the generated wiki page carries all of it', () => {
    const wiki = source('docs/wiki/Control.md').replaceAll('\r\n', '\n')
    for (const sentence of [
      'Re-arm from start appears in the transport bar',
      'Push changed (N) sends every row',
      `the status says "${ESTOP_BLOCKS_MOTION}"`,
      'Held for a tool change - fit T2, then press CYCLE START.',
    ]) expect(wiki).toContain(sentence)
  })
})
