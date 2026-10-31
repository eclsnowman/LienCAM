// @vitest-environment jsdom
// WO-2939: locale-local parity and real App behavior. No global roster pin.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { Project, Setup } from '../../types'
import { makeTool, makeOp, makeWcs, makeMachine, makeStock, stampGenerationCurrent } from '../post/helpers'
import type { CatalogTree } from '../../i18n/catalogs'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size }, clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => [...mem.keys()][index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
} satisfies Storage })
vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))
const { AVAILABLE_LANGUAGES, ENGLISH_CATALOG, languageName, loadCatalog } = await import('../../i18n/catalogs')
const { applyLanguage, i18n, textFor } = await import('../../i18n')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { openHelpTopic } = await import('../../help/helpOpen')
const { loadEnglishHelpCatalog } = await import('../../help/registry')
const { withoutContextStamp } = await import('../../components/gcode/gcodeEditing')
const fr = await loadCatalog('fr')
const de = await loadCatalog('de')
const englishHelp = await loadEnglishHelpCatalog()

function leaves(tree: CatalogTree, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(leaves(value, `${prefix}${key}.`))))
}
const tokens = (value: string, pattern: RegExp) => [...value.matchAll(pattern)].map(match => match[0]).sort()
const placeholders = (value: string) => tokens(value, /{{[^}]+}}/g)
const tags = (value: string) => tokens(value, /<\/?[\w]+(?:\s[^>]*)?\s*\/?>/g)
const commands = (value: string) => tokens(value.replaceAll(/{{[^}]+}}/g, ''), /\$[A-Z]|\b[GMT]\d+(?:\.\d+)?\b|\b(?:Ctrl\+|Shift\+)[A-Za-z+]+|\b(?:Enter|Escape|Esc|rpm|deg)\b|\.(?:camproject|nc|tap|ngc|step|stp|stl|dxf|svg|tools|md|exe|json|py|tsx|pro|pp|cps|scpost|pst|lienpost|ttf|otf)\b/g)

function seedProject() {
  useCamStore.getState().newProject()
  const tool = makeTool()
  const op = makeOp({ toolId: tool.id })
  const setup = { id: 'setup-1', name: 'Setup 1', wcs: makeWcs(), stock: makeStock(), operations: [op], notes: '' }
  const project = { ...useCamStore.getState().project, name: 'French pilot', machine: makeMachine(), setups: [setup], activeSetupId: setup.id }
  stampGenerationCurrent({ ...project, toolLibrary: [tool] } as unknown as Project, setup as unknown as Setup, op, tool)
  useCamStore.setState({ project, toolLibrary: [tool], workspace: 'cam' } as never)
}

afterEach(async () => {
  cleanup()
  useUiPrefs.getState().setLanguage('en')
  await applyLanguage('en')
})

// WO-3317 repin: WO-3257 (509745d10a) and WO-3280 (81a6d082b3) authored the French text
// beside its English key. French names the physical keys as a French keyboard prints
// them ("Entrée" for Enter, "Échap" for Esc), so exactly these leaves carry a different
// literal-command set -- listed BY NAME, one token at a time. Every other literal token
// (G-code words, dialects, units, file extensions), every placeholder and every tag is
// still compared exactly, and a new unasked deviation still fails.
const LOCALIZED_LITERALS: Readonly<Record<string, Readonly<Record<string, { missing?: readonly string[]; extra?: readonly string[] }>>>> = {
  'cam-shortcuts.wo3257': { hint: { missing: ['Enter', 'Escape'] } },
  'ui2-actions.wo3280': { escKey: { missing: ['Esc'] } },
}
const without = (list: string[], removed?: readonly string[]): string[] =>
  list.filter(token => !(removed ?? []).includes(token))

describe('WO-2939 French catalog', () => {
  it.each(Object.keys(de))('%s matches German coverage and current English keys, placeholders, tags and literal command tokens', async area => {
    const english = leaves(area === 'help' ? await loadEnglishHelpCatalog() : ENGLISH_CATALOG[area])
    const french = leaves(fr[area])
    expect(Object.keys(french).sort()).toEqual(Object.keys(leaves(de[area])).sort())
    for (const [key, value] of Object.entries(french)) {
      expect(english[key], `${area}.${key}: English key`).toBeTypeOf('string')
      expect(value.trim(), `${area}.${key}: nonempty`).not.toBe('')
      expect(placeholders(value), `${area}.${key}: placeholders`).toEqual(placeholders(english[key]))
      expect(tags(value), `${area}.${key}: tags`).toEqual(tags(english[key]))
      const localized = LOCALIZED_LITERALS[area]?.[key] ?? {}
      expect(without(commands(value), localized.extra), `${area}.${key}: literal tokens`)
        .toEqual(without(commands(english[key]), localized.missing))
    }
  })
  it('every named localization still describes a real difference in the shipped catalogs', () => {
    // Non-vacuity: an allowance that no longer matches a real difference is stale and
    // must be deleted, so the table cannot quietly excuse anything later.
    for (const [area, allowances] of Object.entries(LOCALIZED_LITERALS)) {
      for (const [key, allow] of Object.entries(allowances)) {
        const label = `${area}.${key}`
        const value = leaves(fr[area])[key]
        expect(value, label).toBeTypeOf('string')
        const englishValue = leaves(area === 'help' ? englishHelp : ENGLISH_CATALOG[area])[key]
        for (const token of allow.missing ?? []) {
          expect(commands(englishValue), label).toContain(token)
          expect(commands(value), label).not.toContain(token)
        }
        for (const token of allow.extra ?? []) {
          expect(commands(value), label).toContain(token)
          expect(commands(englishValue), label).not.toContain(token)
        }
      }
    }
  })

  it('discovers and lazily loads French without pinning the global language roster', async () => {
    expect(AVAILABLE_LANGUAGES).toContain('fr')
    expect(languageName('fr')).toBe('Français')
    expect(Object.keys(fr).sort()).toEqual(Object.keys(de).sort())
    await applyLanguage('fr')
    expect(i18n.language).toBe('fr')
    expect(document.documentElement.lang).toBe('fr')
    expect(textFor('language')('label')).toBe('Langue de l’interface')
    await applyLanguage('absent-wo2939')
    expect(i18n.language).toBe('en')
  })

  it('keeps roughing, finishing, feed, retract, clearance and stock meanings distinct', async () => {
    await applyLanguage('fr')
    const cam = textFor('cam-operations-new-operation')
    expect(cam('NewOperationModalBody.Clearance_Height')).toBe('H. de dégagement')
    expect(cam('NewOperationModalBody.Retract_Height')).toBe('H. de retrait')
    expect(cam('NewOperationModalBody.Feed_Height')).toBe('H. d’avance')
    expect(cam('NewOperationModalBody.Stock_top')).toBe('Dessus du brut')
    const help = leaves(fr.help)
    expect(help['topics.adaptive-clearing.summary']).toContain('ébauche')
    expect(help['topics.pocket.summary']).toContain('plongée')
    expect(textFor('app-shell-settings-menus')('OperationTypes.adaptive_clearing_2d')).toBe('Ébauche adaptative 2D')
    // Not in the pilot: use the exact English source, never a key or blank.
    expect(cam('NewOperationModalBody.Summary_tangent_arc')).toBe('arc tangent')
    expect(cam('NewOperationModalBody.Roughing')).toBe(leaves(ENGLISH_CATALOG['cam-operations-new-operation'])['NewOperationModalBody.Roughing'])
  })

  it('switches actual Settings, operation heights and Help, preserves numbers and shortcuts, then restores English', async () => {
    act(() => {
      seedProject()
      useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
      useCamStore.getState().setWorkspace('cam')
    })
    const app = render(<App />)
    const byId = (id: string) => app.getByTestId(id)
    const open = (id: Parameters<ReturnType<typeof useCamStore.getState>['openModal']>[0]) => act(() => {
      useCamStore.getState().closeModal(); useCamStore.getState().openModal(id)
    })
    const values = () => [...document.querySelectorAll('input')].map(input => input.value)
    const choose = (language: string) => {
      fireEvent.click(byId('settings-language'))
      fireEvent.click(byId(`settings-language-option-${language}`))
    }
    open('settings')
    await waitFor(() => expect(document.body.textContent).not.toContain('Inspecting durable shop data...'))
    const englishValues = values()
    const englishSettings = document.querySelector('.modal-container')?.textContent
    choose('fr')
    await waitFor(() => expect(byId('settings-language-header').textContent).toBe('Langue'))
    expect(document.body.textContent).toContain('Unités d’affichage')
    expect(values()).toEqual(englishValues)
    expect(values().some(value => /\d\.\d/.test(value))).toBe(true)
    // Existing English fallback is intentionally visible for untranslated backup UI.
    expect(document.body.textContent).toContain('Download backup')
    act(() => useCamStore.getState().closeModal())
    expect(document.body.textContent).toContain('Parcours')
    expect(document.querySelector('[data-tooltip="Annuler (Ctrl+Z)"]')).not.toBeNull()
    open('new-operation')
    const words: string[] = []
    for (const tab of document.querySelectorAll<HTMLButtonElement>('.op-modal-tabs button')) {
      fireEvent.click(tab); words.push(document.body.textContent ?? '')
    }
    expect(words.join('\n')).toContain('H. de dégagement')
    expect(words.join('\n')).toContain('H. de retrait')
    act(() => { useCamStore.getState().closeModal(); openHelpTopic('welcome-overview') })
    await waitFor(() => expect(byId('help-topic-content').querySelector('h2')?.textContent).toBe('Présentation de LienCAM'))
    expect(byId('help-topic-content').textContent).toContain('.camproject')
    expect(document.body.textContent).toContain('Signaler un problème')
    act(() => openHelpTopic('work-offsets'))
    await waitFor(() => expect(byId('help-topic-content').textContent).toContain('part-G54.nc, part-G55.nc'))
    act(() => openHelpTopic('import-dxf-svg'))
    await waitFor(() => expect(byId('help-topic-content').querySelector('h2')?.textContent).toBe('Importing DXF and SVG'))
    expect(byId('help-topic-content').textContent).toContain('DXF and SVG files import as 2D layers')
    open('settings'); choose('en')
    await waitFor(() => expect(byId('settings-language-header').textContent).toBe('Language'))
    expect(values()).toEqual(englishValues)
    expect(document.querySelector('.modal-container')?.textContent).toBe(englishSettings)
  }, 60_000)

  it('keeps the actual App post preview byte-identical outside its volatile context stamp', async () => {
    act(seedProject)
    const app = render(<App />)
    act(() => useCamStore.getState().openModal('post-process'))
    const english = app.getByTestId('post-gcode-preview').textContent!
    expect(english).toContain('G54')
    expect(english).toContain('M30')
    await act(async () => { await applyLanguage('fr') })
    const french = app.getByTestId('post-gcode-preview').textContent!
    expect(document.querySelector('.modal-title')?.textContent).toContain('Post-traitement')
    expect(withoutContextStamp(french)).toBe(withoutContextStamp(english))
    fireEvent.click(app.getByTestId('post-preview-edit'))
    expect(app.getByTestId('post-gcode-editor-text')).toHaveProperty('value', french)
    expect(document.body.textContent).toContain('Envoyer à la commande')
  }, 60_000)
})
