import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { topics } from '../../help/topics/posting-gcode'

const PUBLIC_HELP_ROOT = fileURLToPath(new URL('../../../public/help/', import.meta.url))

describe('WO-240 posting and G-code help structure', () => {
  it('keeps every topic discoverable and every declared image rendered from a real file', () => {
    expect(topics.length).toBeGreaterThan(0)

    for (const topic of topics) {
      expect(topic.summary.trim(), `${topic.id} has no summary`).not.toBe('')
      expect(topic.keywords.trim(), `${topic.id} has no keywords`).not.toBe('')

      const declaredSlots = topic.images.map((image) => image.slot)
      expect(
        new Set(declaredSlots).size,
        `${topic.id} has duplicate image slots`,
      ).toBe(declaredSlots.length)

      const renderedSlots = topic.sections
        .filter((section) => section.kind === 'image')
        .map((section) => section.slot)

      expect(
        [...renderedSlots].sort(),
        `${topic.id} must render every declared image exactly once`,
      ).toEqual([...declaredSlots].sort())

      for (const image of topic.images) {
        expect(
          existsSync(`${PUBLIC_HELP_ROOT}${topic.id}/${image.file}`),
          `${topic.id} image slot "${image.slot}" is missing public/help/${topic.id}/${image.file}`,
        ).toBe(true)
      }
    }
  })

  it('documents the posting controls found during the live-app sweep', () => {
    const sectionText = JSON.stringify(topics.map((topic) => topic.sections))

    expect(sectionText).toContain('About this post')
    expect(sectionText).toContain('Delete Post')
    expect(sectionText).toContain('Open full preview')
  })
})
