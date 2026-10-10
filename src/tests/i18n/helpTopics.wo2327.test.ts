// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { HelpCenterModal } from '../../components/modals/HelpCenterModal'
import { helpIndex, loadTopic, loadEnglishHelpCatalog } from '../../help/registry'
import { HELP_CATEGORIES } from '../../help/categories'
import { deriveHelpContext, rankTopics } from '../../help/helpContext'
import { openHelpTopic, useHelpOpen } from '../../help/helpOpen'
import { useCamStore } from '../../store'
import { i18n } from '../../i18n'

const baselinePath = 'src/tests/evidence/WO-2593/goldens/main-rendered.wo2327.json'
afterEach(async () => {
  cleanup(); vi.unstubAllGlobals(); await i18n.changeLanguage('en')
  i18n.removeResourceBundle('de', 'help')
})

function openWindow() {
  useCamStore.setState({ activeModal: null, consoleEvents: [], consoleReadThroughId: 0 })
  useHelpOpen.setState({ requested: null, overlay: false })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('video', { status: 200 })))
  URL.createObjectURL = vi.fn(() => 'blob:help-video')
  URL.revokeObjectURL = vi.fn()
  return render(createElement(HelpCenterModal))
}

async function showTopic(id: string) {
  const topic = (await loadTopic(id))!
  act(() => { openHelpTopic(id) })
  const article = await screen.findByTestId('help-topic-content')
  await waitFor(() => {
    expect(article.querySelector('h2')?.textContent).toBe(topic.title)
    for (const section of topic.sections) {
      const words = 'text' in section ? [section.text] : section.kind === 'steps' ? section.steps
        : section.kind === 'table' ? [...section.columns, ...section.rows.flatMap(r => r.cells)] : []
      for (const word of words) expect(article.textContent).toContain(word)
    }
  })
  return article
}

it('renders every topic with English text and figure paths byte-identical to main', async () => {
  openWindow()
  const rendered: Record<string, unknown> = {}
  for (const entry of helpIndex()) {
    const article = await showTopic(entry.id)
    rendered[entry.id] = {
      text: article.textContent,
      figures: [...article.querySelectorAll('img,video')].map(e => ({
        src: e.getAttribute('data-src') ?? e.getAttribute('src'),
        alt: e.getAttribute('alt') ?? e.getAttribute('aria-label'),
      })),
    }
  }
  if (process.env.WO2327_CAPTURE_MAIN === '1') {
    writeFileSync(baselinePath, JSON.stringify({ index: helpIndex(), rendered }, null, 2) + '\n')
  } else {
    expect({ index: helpIndex(), rendered }).toEqual(JSON.parse(readFileSync(baselinePath, 'utf8')))
  }
}, 120000)

it('uses the chosen language for titles, search, categories, paragraphs, steps and captions in the real Help window', async () => {
  i18n.addResourceBundle('de', 'help', {
    categories: { 'getting-started': 'Einstieg' },
    topics: {
      'welcome-overview': {
        title: 'LienCAM kennenlernen', summary: 'Eine CAM Anwendung.', keywords: 'katalogsuche',
        sections: { 0: { text: 'Literal {{words}}: G43 H19, LinuxCNC, .camproject, Ctrl+Z, 0.25.' } },
        images: { 'app-overview': { alt: 'Das Anwendungsfenster' } },
      },
      'first-toolpath': { sections: { 0: { steps: { 0: 'Eine Datei importieren: DXF, SVG, STL, OBJ, STEP.' } } } },
    },
  }, true, true)
  await i18n.changeLanguage('de-DE')
  openWindow()
  const article = await showTopic('welcome-overview')
  expect(article.textContent).toContain('Literal {{words}}: G43 H19, LinuxCNC, .camproject, Ctrl+Z, 0.25.')
  expect(article.querySelector('img')?.getAttribute('alt')).toBe('Das Anwendungsfenster')
  expect(article.querySelector('img')?.getAttribute('src')).toBe('/help/welcome-overview/app-overview.webp')
  fireEvent.click(screen.getByTestId('help-nav-tab-all'))
  expect(screen.getByTestId('help-cat-getting-started').textContent).toContain('Einstieg')
  fireEvent.change(screen.getByTestId('help-search'), { target: { value: 'katalogsuche' } })
  expect(screen.getByTestId('help-topic-welcome-overview').textContent).toBe('LienCAM kennenlernenEine CAM Anwendung.')
  expect(screen.queryByTestId('help-topic-first-toolpath')).toBeNull()
  fireEvent.change(screen.getByTestId('help-search'), { target: { value: '' } })
  const steps = await showTopic('first-toolpath')
  expect(steps.querySelector('li')?.textContent).toBe('Eine Datei importieren: DXF, SVG, STL, OBJ, STEP.')
  expect(steps.textContent).toContain('press N') // untranslated step falls back literally
})

it('translates headings and all table cells, while keeping anchors and structural data unchanged', async () => {
  const catalog = await loadEnglishHelpCatalog()
  expect(Object.keys(catalog.topics)).toHaveLength(helpIndex().length)
  const topics = await Promise.all(helpIndex().map(entry => loadTopic(entry.id)))
  const topic = topics.find(t => t!.sections.some(s => s.kind === 'heading') && t!.sections.some(s => s.kind === 'table'))!
  const headingIndex = topic!.sections.findIndex(s => s.kind === 'heading')
  const tableIndex = topic!.sections.findIndex(s => s.kind === 'table')
  const heading = topic!.sections[headingIndex]
  const table = topic!.sections[tableIndex]
  if (heading.kind !== 'heading' || table.kind !== 'table') throw new Error('fixture requires a heading and table')
  const original = JSON.parse(JSON.stringify(topic))
  i18n.addResourceBundle('de', 'help', { topics: { [topic!.id]: { sections: {
    [headingIndex]: { text: 'Ueberschrift' },
    [tableIndex]: { columns: { 0: 'Spalte' }, rows: { 0: { cells: { 0: 'Zelle', 1: 'Beschreibung' } } } },
  } } } }, true, true)
  await i18n.changeLanguage('de')
  openWindow()
  const article = await showTopic(topic!.id)
  expect(article.querySelector(`[data-help-anchor="${heading.anchor}"]`)?.textContent).toBe('Ueberschrift')
  for (const word of ['Spalte', 'Zelle', 'Beschreibung']) expect(article.textContent).toContain(word)
  const localized = (await loadTopic(topic!.id))!
  for (const key of ['id', 'category', 'contextKeys', 'relatedTopicIds', 'sinceVersion'] as const) {
    expect(localized[key]).toEqual(original[key])
  }
  expect((localized.sections[headingIndex] as typeof heading).anchor).toBe(heading.anchor)
})

it('keeps English search and the F1 context suggestions identical, and falls back for missing or empty translations', async () => {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const keys = ['workspace:cam', 'mode:sketch', 'modal:postprocess', 'error:recent']
  const before = rankTopics(baseline.index, keys).suggested.map(t => t.id)
  i18n.addResourceBundle('de', 'help', { topics: { 'welcome-overview': { title: '' } } }, true, true)
  await i18n.changeLanguage('de')
  expect(rankTopics(helpIndex(), keys).suggested.map(t => t.id)).toEqual(before)
  expect(HELP_CATEGORIES[0].label).toBe('Getting started')
  openWindow()
  const article = await showTopic('welcome-overview')
  expect(article.textContent).toBe(baseline.rendered['welcome-overview'].text)
  fireEvent.change(screen.getByTestId('help-search'), { target: { value: 'G-code' } })
  const ids = [...document.querySelectorAll('.help-topic-button')].map(e => e.getAttribute('data-testid')!.slice('help-topic-'.length))
  expect(ids).toEqual((baseline.index as Array<{ id: string; title: string; summary: string; keywords: string }>).filter(e => `${e.title} ${e.summary} ${e.keywords}`.toLowerCase().includes('g-code')).map(e => e.id))
  act(() => {
    useCamStore.getState().closeModal()
    useHelpOpen.getState().clearRequest()
  })
  act(() => {
    useCamStore.setState({ workspace: 'cam', viewer: { ...useCamStore.getState().viewer, mode: 'sketch' } })
    useCamStore.getState().openModal('help')
  })
  const suggested = rankTopics(baseline.index, deriveHelpContext(useCamStore.getState())).suggested[0]
  await waitFor(() => expect(screen.getByTestId('help-topic-content').querySelector('h2')?.textContent).toBe(suggested.title))
})

it('keeps the offline wiki loader English and independent of the active app language', async () => {
  await i18n.changeLanguage('de')
  const wikiModulePath = '../../../tools/release/help-to-wiki.mjs'
  const { loadHelp } = await import(wikiModulePath) as {
    loadHelp: () => Promise<{ index: unknown; topics: unknown[]; categories: Array<{ label: string }> }>
  }
  const offline = await loadHelp()
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  expect(JSON.parse(JSON.stringify(offline.index))).toEqual(baseline.index)
  // WO-2648: WO-2628 (landed 10-06) added a machine Help topic.
  // WO-2707: WO-2704 3248a88c7 added control-simulator and control-tool-setter;
  // WO-2707 added modal:new-model for WO-2700's New Model window.
  expect(offline.topics).toHaveLength(145)
  expect(offline.categories[0].label).toBe('Getting started')
}, 30000)
