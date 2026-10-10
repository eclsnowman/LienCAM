import { describe, expect, it } from 'vitest'
import { topics } from '../../help/topics/machine'
import { HELP_INDEX } from '../../help/index-data'
import { toIndexEntry } from '../../help/types'

function prose(id: string) {
  const topic = topics.find(topic => topic.id === id)!
  expect(topic).toBeDefined()
  return topic.sections.flatMap(section => 'text' in section ? [section.text] : section.kind === 'steps' ? section.steps : []).join(' ')
}
describe('WO-2704 simulator and setter Help', () => {
  it.each(['control-simulator', 'control-tool-setter'])('%s has a matching searchable entry and valid links', id => {
    const topic = topics.find(topic => topic.id === id)!
    expect(HELP_INDEX.find(entry => entry.id === id)).toEqual(toIndexEntry(topic))
    expect(topic.contextKeys).toContain('workspace:control')
    for (const related of topic.relatedTopicIds) expect(HELP_INDEX.some(entry => entry.id === related)).toBe(true)
  })
  it('distinguishes Control practice from stock simulation and documents landed drilling', () => {
    const text = prose('control-simulator')
    for (const phrase of ['Choose Simulator', 'click Connect', 'moves no physical machine', 'Press CLEAR', 'Simulated part', 'Place under probe', 'Reset', 'G81, G82 and G83', 'G98/G99', 'Simulate tab is a separate']) expect(text).toContain(phrase)
  })
  it('documents reference measurement, unassigned contacts, and the actual virtual setter height', () => {
    const text = prose('control-tool-setter')
    for (const phrase of ['Definition > Probing', 'Measure Tn', 'available measurement', 'reference tool', 'Apply length', 'does not supply', 'Retry measure', 'below the stated setter Z']) expect(text).toContain(phrase)
    const simulator = prose('control-simulator')
    expect(simulator).toContain('machine with no stated setter has none')
    expect(simulator).toContain('measured reference-tool contact')
  })
})
