// WO-1508 (BUG-372 family K10b): embedded help must describe the controls and
// controller paths the product actually has today. Two content claims went
// stale: the Display topic still offered 'High contrast' (dropped from
// UiThemeId by WO-324; the picker is Default | Amber), and the machine topics
// presented GRBL-over-USB as the only route to a machine while the product also
// drives a native UCCNC/UC100 bridge (src/lib/machine/controller.ts).
//
// This is a content correction asserted against the live topic modules, so it
// fails on the pre-fix text and can never silently drift back.

import { describe, expect, it } from 'vitest'
import { topics as settingsTopics } from '../../help/topics/settings'
import { topics as machineTopics } from '../../help/topics/machine'
import type { HelpTopic } from '../../help/types'
import shellEnglish from '../../i18n/locales/en/app-shell-settings-menus'

function topicText(topic: HelpTopic): string {
  const parts: string[] = [topic.title, topic.summary, topic.keywords]
  for (const section of topic.sections) {
    switch (section.kind) {
      case 'paragraph':
      case 'tip':
      case 'warning':
      case 'heading':
        parts.push(section.text)
        break
      case 'steps':
        parts.push(...section.steps)
        break
      case 'table':
        parts.push(...section.columns, ...section.rows.flatMap((row) => row.cells))
        break
      case 'image':
        break
    }
  }
  return parts.join('\n')
}

function findTopic(topics: HelpTopic[], id: string): HelpTopic {
  const topic = topics.find((candidate) => candidate.id === id)
  expect(topic, `missing help topic ${id}`).toBeTruthy()
  return topic as HelpTopic
}

describe('WO-1508 help content matches current controls and controller paths', () => {
  it('the Display topic offers Default and Amber, never the retired High contrast', () => {
    const display = findTopic(settingsTopics, 'settings-display')
    const text = topicText(display)

    expect(text).toContain('Amber')
    expect(text, 'Display topic still claims High contrast is a current UI theme').not.toMatch(/high\s*contrast/i)
  })

  it('the machine help covers the native UCCNC/UC100 bridge alongside USB-serial GRBL', () => {
    const connection = [
      findTopic(machineTopics, 'control-tab-overview'),
      findTopic(machineTopics, 'control-connect'),
    ].map(topicText).join('\n')

    expect(connection).toMatch(/UCCNC/i)
    expect(connection).toMatch(/UC100/i)
    expect(connection).toMatch(/bridge/i)
    expect(connection).toMatch(/GRBL/i)
  })

  it('posting to the sender follows the active machine dialect, not GRBL only', () => {
    const runJob = findTopic(machineTopics, 'control-run-job')
    const text = topicText(runJob)

    expect(text, 'run-job still claims posting is always the GRBL dialect').not.toMatch(/\(GRBL dialect\)/i)
    expect(text).toMatch(/dialect/i)
  })
})

// WO-2129 (help sweep wave 1): the Settings help must name every section the
// Settings window renders, harvested from the window's own section headers so
// a new section turns this red until the help says where it is; and no topic
// in the swept categories may offer controls the app no longer has.
describe('WO-2129 help sweep: Settings sections and retired controls', () => {
  it('settings-tour names every section header the Settings window renders', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/components/modals/SettingsModal.tsx', 'utf8')
    // WO-2320 moved these exact headers into the English catalog. Resolve the
    // source's keys so the help still has to name the actual displayed words.
    const headers = [...source.matchAll(/className="mform-section-header">(?:([^<{]+)|\{shellText\('SettingsModal\.([^']+)'\)\})</g)]
      .map((m) => m[1]?.trim() ?? shellEnglish.SettingsModal[m[2] as keyof typeof shellEnglish.SettingsModal])
    expect(headers.length, `section-header harvest collapsed: ${headers.join(', ')}`).toBeGreaterThanOrEqual(10)
    const tour = topicText(findTopic(settingsTopics, 'settings-tour')).toLowerCase()
    for (const header of headers) {
      expect(tour, `settings-tour does not name the "${header}" section`).toContain(header.toLowerCase())
    }
  })

  it('no swept topic offers the retired Viewport theme, Selection glow, or Iso/Top/Front/Right buttons', async () => {
    const { topics: gettingStarted } = await import('../../help/topics/getting-started')
    const { topics: workspaces } = await import('../../help/topics/workspaces-viewport')
    const text = [...gettingStarted, ...workspaces, ...settingsTopics].map(topicText).join('\n')
    expect(text).not.toMatch(/viewport theme/i)
    expect(text).not.toMatch(/selection glow/i)
    expect(text).not.toMatch(/Iso, Top, Front,? and Right buttons/i)
    expect(workspaces.some((topic) => topic.id === 'viewport-themes')).toBe(false)
  })
})
