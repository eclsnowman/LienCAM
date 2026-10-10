// WO-361: the fixture stack (Setup modal "Fixture Stack and CAM Grid" section)
// had no help topic. This asserts the new topic exists, is indexed, carries
// its declared image slots, and states the planning-only limit verbatim -
// the safety-relevant sentence must not be silently dropped later.

import { describe, expect, it } from 'vitest'
import { topics } from '../../help/topics/setups-stock-wcs'
import { HELP_INDEX } from '../../help/index-data'
import { toIndexEntry } from '../../help/types'

const TOPIC_ID = 'fixture-stack-cam-grid'
const PLANNING_ONLY_LIMIT =
  'Planning/reference only. Visibility and support-plane display do not change toolpaths or provide collision avoidance.'

describe('WO-361 fixture stack help topic', () => {
  const topic = topics.find((t) => t.id === TOPIC_ID)

  it('exists in the setups-stock-wcs category', () => {
    expect(topic).toBeTruthy()
    expect(topic?.category).toBe('setups-stock-wcs')
  })

  it('is indexed field-for-field in HELP_INDEX', () => {
    const entry = HELP_INDEX.find((e) => e.id === TOPIC_ID)
    expect(entry).toBeTruthy()
    expect(entry).toEqual(toIndexEntry(topic!))
  })

  it('is reachable from the Setup modal context', () => {
    expect(topic!.contextKeys).toContain('modal:new-setup')
    expect(topic!.contextKeys).toContain('modal:edit-setup')
  })

  it('carries its declared image slots, one per example setup Operator asked for', () => {
    const declaredSlots = topic!.images.map((image) => image.slot).sort()
    expect(declaredSlots).toEqual(['spoilboard-stack', 'vise-stack'])

    const renderedSlots = topic!.sections
      .filter((section) => section.kind === 'image')
      .map((section) => section.slot)
      .sort()
    expect(renderedSlots).toEqual(declaredSlots)

    for (const image of topic!.images) {
      expect(image.captureNotes.trim(), `${image.slot} has no capture instructions`).not.toBe('')
    }
  })

  it('states the planning-only limit verbatim, matching SetupModal.tsx', () => {
    const warnings = topic!.sections
      .filter((section) => section.kind === 'warning')
      .map((section) => section.text)
    expect(warnings).toContain(PLANNING_ONLY_LIMIT)
  })

  it('answers Operator\'s question - no imported fixture model - plainly and without a roadmap promise', () => {
    const allText = JSON.stringify(topic!.sections)
    expect(allText).toMatch(/No - the fixture stack does not accept an imported 3D model/)
    // WO-2133: the app does take an imported vise as a Workholding body, so
    // the answer points there instead of stopping at "no".
    expect(allText).toMatch(/turn on Workholding/)
    expect(allText.toLowerCase()).not.toMatch(/coming soon|future release|roadmap|will support|planned for/)
  })

  it('documents every fixture layer type and grid support plane mode found in SetupModal.tsx', () => {
    const allText = JSON.stringify(topic!.sections)
    for (const layerType of ['Spoilboard', 'Vise', 'Fixed jaw', 'Soft jaw', 'Custom riser']) {
      expect(allText, `missing fixture layer type "${layerType}"`).toContain(layerType)
    }
    for (const planeMode of ['Machine table', 'Spoilboard top', 'Vise bed', 'Fixed-jaw shelf', 'Soft-jaw step', 'Stock bottom', 'Custom plane']) {
      expect(allText, `missing grid support plane mode "${planeMode}"`).toContain(planeMode)
    }
  })

  it('declares a sinceVersion and every relatedTopicId resolves in the index', () => {
    expect(/^\d+\.\d+\.\d+$/.test(topic!.sinceVersion)).toBe(true)
    const ids = new Set(HELP_INDEX.map((e) => e.id))
    for (const rel of topic!.relatedTopicIds) {
      expect(ids.has(rel), `related topic "${rel}" is not indexed`).toBe(true)
    }
  })
})
