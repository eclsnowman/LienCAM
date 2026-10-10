import { describe, expect, it } from 'vitest'
import * as M from '../../lib/machine/operatorMessages'

// WO-1916 / COHESION-STANDARD 13.2: a console line is at most two sentences, and
// a refusal says "Not loaded / Not sent / Not computed".
const sentences = (text: string): number =>
  text.split(/(?<=[.!?])\s+/).filter((part) => part.trim().length > 0).length

const REFUSALS: readonly [string, string, RegExp][] = [
  ['arcs, no travel (program)', M.arcsNeedTravelMessage('this program'), /^Not loaded/],
  ['arcs, no travel (setup)', M.arcsNeedTravelMessage('setup "Top"'), /^Not loaded/],
  ['arcs, no travel (file)', M.arcsNeedTravelMessage('"part.nc"'), /^Not loaded/],
  ['arcs, no work zero', M.arcsNeedWorkZeroMessage('G55'), /^Not loaded/],
  ['collapsed boundary', M.collapsedBoundaryMessage('a tool change to T3', 'tool change to T2', 4), /Not loaded/],
  ['second stop', M.secondStopMessage(0, 3), /Not loaded/],
  ['mdi frame between parts', M.mdiFrameBetweenPartsMessage('55'), /^Not sent/],
  ['mdi action between parts', M.MDI_ACTION_BETWEEN_PARTS_MESSAGE, /^Not sent/],
  ['mdi output by number', M.mdiOutputByNumberMessage('M64', 'switches digital output P2 on'), /^Not sent/],
  ['draft neutral plane', M.draftTiltedNeutralPlaneMessage('0, 0, 5', '1, 0, 0', '3', '0, 0, 1'), /^Not computed/],
]

const PLAIN: readonly [string, string][] = [
  ['pro export', M.proExportSummary('router', 41, 12)],
  ['path order', `Path check: ${M.PATH_ORDER_UNCHECKED_REASON}`],
  ['homing Z not first', M.homingZNotFirstMessage('X, Y, Z')],
  ['edge chain', M.edgeChainUnsupportedMessage('profile', 'face')],
  ['dropped values (1)', M.droppedTypedValuesMessage(1)],
  ['dropped values (3)', M.droppedTypedValuesMessage(3)],
]

describe('WO-1916 the twelve longest console messages say it in one line', () => {
  it.each(REFUSALS)('%s: at most two sentences, refusal wording', (_name, text, wording) => {
    expect(sentences(text)).toBeLessThanOrEqual(2)
    expect(text).toMatch(wording)
  })

  it.each(PLAIN)('%s: at most two sentences', (_name, text) => {
    expect(sentences(text)).toBeLessThanOrEqual(2)
  })

  it('carries the values the operator needs', () => {
    expect(M.arcsNeedWorkZeroMessage('G55')).toContain('G55')
    expect(M.proExportSummary('router', 41, 12)).toContain('router.pro')
    expect(M.secondStopMessage(1, 7)).toContain('M1 on line 7')
    expect(M.droppedTypedValuesMessage(1)).toContain('1 typed value ')
    expect(M.droppedTypedValuesMessage(2)).toContain('2 typed values')
  })
})
