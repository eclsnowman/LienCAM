// @vitest-environment jsdom
//
// WO-2162: the help explains the Probe tool type (WO-2154). The labels, choices
// and note are read from the production Tool Library with a Probe selected, so
// a field the editor gains or renames fails here BY NAME until the help says it.

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { useCamStore } = await import('../../store')
const { TOOL_TYPE_META, TOOL_TYPE_ORDER } = await import('../../lib/tool/toolMeta')
const { loadCategoryTopics } = await import('../../help/registry')
const { HELP_INDEX } = await import('../../help/index-data')
type HelpTopic = Awaited<ReturnType<typeof loadCategoryTopics>>[number]

function topicText(topic: HelpTopic): string {
  const parts: string[] = [topic.title, topic.summary]
  for (const s of topic.sections) {
    if (s.kind === 'paragraph' || s.kind === 'tip' || s.kind === 'warning' || s.kind === 'heading') parts.push(s.text)
    else if (s.kind === 'steps') parts.push(...s.steps)
    else if (s.kind === 'table') parts.push(...s.columns, ...s.rows.flatMap((r) => r.cells))
  }
  return parts.join('\n')
}

async function topic(id: string): Promise<HelpTopic> {
  const found = (await loadCategoryTopics('tools-holders')).find((t) => t.id === id)
  if (!found) throw new Error(`no tools-holders help topic "${id}"`)
  return found
}

function rowOf(label: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>('.tool-form-section .mform-row'))
    .find((el) => el.querySelector('.mform-label')?.textContent?.trim() === label)
  if (!match) throw new Error(`Missing Tool Library row: ${label}`)
  return match
}

/** What the Cutter tab shows for a new Probe, read from the production editor. */
function probeCutterTab(): { labels: string[]; options: string[]; notes: string[] } {
  render(createElement(ToolLibraryModal))
  act(() => { useCamStore.getState().openModal('tool-library') })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'New' })) })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'General' })) })
  act(() => { fireEvent.change(rowOf('Type').querySelector('select')!, { target: { value: 'probe' } }) })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Cutter' })) })
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.tool-form-section .mform-row'))
  return {
    labels: rows.map((r) => r.querySelector('.mform-label')?.textContent?.trim() ?? '').filter(Boolean),
    options: rows.flatMap((r) => Array.from(r.querySelectorAll('option')).map((o) => o.textContent?.trim() ?? '')),
    notes: Array.from(document.querySelectorAll<HTMLElement>('.tool-form-section .tool-post-tip'))
      .map((n) => n.textContent?.trim() ?? ''),
  }
}

beforeEach(() => {
  mem.clear()
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState({ toolLibrary: [], holders: [] })
  })
})

afterEach(() => {
  cleanup()
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-2162 help explains the Probe tool type', () => {
  it('names every field, choice and note the Probe editor shows', async () => {
    const shown = probeCutterTab()
    // The editor really is the probe's: its own labels are there, Flutes is not.
    expect(shown.labels).toContain('Ball (tip) diameter')
    expect(shown.labels).toContain('Calibrated radius Y')
    expect(shown.labels).not.toContain('Flutes')

    const text = topicText(await topic('probe-tool'))
    const missing = [...shown.labels, ...shown.options, ...shown.notes].filter((words) => !text.includes(words))
    expect(missing, `help topic probe-tool does not name: ${missing.join(' | ')}`).toEqual([])
    expect(text).toContain(TOOL_TYPE_META.probe.label)
  })

  it('is reachable from the Tool Library window and linked from the tool topics', async () => {
    const probeTopic = await topic('probe-tool')
    expect(probeTopic.contextKeys).toContain('modal:tool-library')
    expect(HELP_INDEX.some((e) => e.id === 'probe-tool')).toBe(true)
    expect((await topic('tool-library')).relatedTopicIds).toContain('probe-tool')
    expect((await topic('tool-geometry')).relatedTopicIds).toContain('probe-tool')
  })

  it('Tool shapes counts every tool type the Type dropdown offers', async () => {
    const geometry = await topic('tool-geometry')
    const counts = [...topicText(geometry).matchAll(/(\d+) (?:tool )?types/g)].map((m) => Number(m[1]))
    expect(counts.length).toBeGreaterThan(0)
    for (const n of counts) expect(n).toBe(TOOL_TYPE_ORDER.length)
  })
})
