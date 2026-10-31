// @vitest-environment jsdom
// Spanish catalog contract + actual production App language selection.
// Only WebGL is stubbed; no controller is connected or commanded.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { Project, Setup } from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'
import type { CatalogTree } from '../../i18n/catalogs'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size }, clear: () => mem.clear(),
  getItem: (k: string) => mem.get(k) ?? null,
  key: (i: number) => [...mem.keys()][i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
} satisfies Storage })
vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))
const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { applyLanguage, i18n, textFor } = await import('../../i18n')
const { AVAILABLE_LANGUAGES, ENGLISH_CATALOG, isAvailableLanguage, languageName, loadCatalog } = await import('../../i18n/catalogs')
const { loadEnglishHelpCatalog } = await import('../../help/registry')
const { openHelpTopic } = await import('../../help/helpOpen')
const { withoutContextStamp } = await import('../../components/gcode/gcodeEditing')
const spanish = await loadCatalog('es')
const english: Record<string, CatalogTree> = { ...ENGLISH_CATALOG, help: await loadEnglishHelpCatalog() }
const german = import.meta.glob<{ default: CatalogTree }>('../../i18n/locales/de/*.ts', { eager: true })

function flatten(tree: CatalogTree, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === 'string' ? [[path, value]] : Object.entries(flatten(value, path))
  }))
}
function tokens(text: string, regex: RegExp): string[] { return [...text.matchAll(regex)].map(m => m[0]).sort() }
// Numeric command words, command interpolations, dialects, shortcut keys,
// extensions and literal units/decimals are immutable parts of operator text.
const protectedTokens = /\b(?:G\d+(?:\.\d+)?|M\d+|GRBL|LinuxCNC|UCCNC|FluidNC|Ctrl(?:\+[A-Za-z]+)+|Shift\+[A-Za-z]+|Enter|Escape|Esc|WCS|X|Y|Z|mm\/min|rpm|mm|deg)\b|\$[HX]|[GM]\{\{\w+\}\}|\$\{\{\w+\}\}|\.(?:camproject|nc|tap|ngc|step|stl|dxf|svg|tools)\b|\b\d+\.\d+\b/g

afterEach(async () => {
  cleanup()
  useUiPrefs.getState().setLanguage('en')
  await applyLanguage('en')
})

// WO-3317 repin: WO-3257 (509745d10a) and WO-3307 (81eb1c8333) authored the Spanish
// text beside its English key. Spanish names the physical keys as a Spanish keyboard
// prints them ("Intro" for Enter) and describes the waterline finish by its Z levels,
// so exactly these leaves carry a different literal-token set -- listed BY NAME, one
// token at a time. Every other protected token (G-code words, dialects, key names,
// units, file extensions) is still compared exactly, and a new unasked deviation
// still fails.
const LOCALIZED_LITERALS: Readonly<Record<string, Readonly<Record<string, { missing?: readonly string[]; extra?: readonly string[] }>>>> = {
  'cam-shortcuts.wo3257': { hint: { missing: ['Enter'] } },
  'ui2-operation-card-3d.wo3307': {
    'type.waterline_3d': { extra: ['Z'] },
    'help.steepStepdown': { extra: ['Z'] },
  },
}
const without = (list: string[], removed?: readonly string[]): string[] =>
  list.filter(token => !(removed ?? []).includes(token))

describe('WO-2938 Spanish catalog', () => {
  it('discovers and loads Spanish without assuming the complete global roster', async () => {
    expect(AVAILABLE_LANGUAGES).toContain('es')
    expect(isAvailableLanguage('es')).toBe(true)
    expect(languageName('es')).toBe('Español')
    expect(Object.keys(spanish).sort()).toEqual(Object.keys(german).map(p => p.split('/').at(-1)!.replace('.ts', '')).sort())
    expect((await loadCatalog('es')).language).toEqual({ section: 'Idioma', label: 'Idioma de la interfaz' })
  })
  for (const [path, module] of Object.entries(german)) {
    const area = path.split('/').at(-1)!.replace('.ts', '')
    it(`covers the German pilot keys in ${area}, with current English placeholders, tags and protected tokens`, () => {
      const source = flatten(english[area])
      const translated = flatten(spanish[area])
      for (const key of Object.keys(flatten(module.default))) expect(translated, `${area}.${key}`).toHaveProperty(key)
      for (const [key, value] of Object.entries(translated)) {
        const label = `${area}.${key}`
        expect(source, label).toHaveProperty(key)
        expect(value.trim(), label).not.toBe('')
        expect(tokens(value, /\{\{[^}]+\}\}/g), label).toEqual(tokens(source[key], /\{\{[^}]+\}\}/g))
        expect(tokens(value, /<\/?[A-Za-z][^>]*>/g), label).toEqual(tokens(source[key], /<\/?[A-Za-z][^>]*>/g))
        const localized = LOCALIZED_LITERALS[area]?.[key] ?? {}
        expect(without(tokens(value, protectedTokens), localized.extra), label)
          .toEqual(without(tokens(source[key], protectedTokens), localized.missing))
      }
    })
  }
  it('every named localization still describes a real difference in the shipped catalogs', () => {
    // Non-vacuity: an allowance that no longer matches a real difference is stale and
    // must be deleted, so the table cannot quietly excuse anything later.
    for (const [area, allowances] of Object.entries(LOCALIZED_LITERALS)) {
      for (const [key, allow] of Object.entries(allowances)) {
        const label = `${area}.${key}`
        const value = flatten(spanish[area])[key]
        expect(value, label).toBeTypeOf('string')
        const englishValue = flatten(english[area] ?? {})[key]
        for (const token of allow.missing ?? []) {
          expect(tokens(englishValue, protectedTokens), label).toContain(token)
          expect(tokens(value, protectedTokens), label).not.toContain(token)
        }
        for (const token of allow.extra ?? []) {
          expect(tokens(value, protectedTokens), label).toContain(token)
          expect(tokens(englishValue, protectedTokens), label).not.toContain(token)
        }
      }
    }
  })
  it('distinguishes machining meanings and interpolates actual values without decimal or command changes', async () => {
    await applyLanguage('es')
    const t = textFor('cam-operations-new-operation')
    expect(t('NewOperationModalBody.Clearance_Height')).toBe('Alt. de seguridad')
    expect(t('NewOperationModalBody.Retract_Height')).toBe('Alt. de retracción')
    expect(t('NewOperationModalBody.Feed_Height')).toBe('Alt. de avance')
    expect(t('NewOperationModalBody.Summary_direction_climb')).toBe('En concordancia')
    expect(t('NewOperationModalBody.Summary_direction_conventional')).toBe('En oposición')
    expect(textFor('setup-stock-tools-machine-post')('SetupModal.work_offset_changed_from_g_to_g', { value1: 54, value2: 55 }))
      .toBe('Desfase de trabajo cambiado de G54 a G55')
    expect(textFor('control-screens-not-probing')('SpindlePanel.text039', { value1: '12000.5' })).toBe('12000.5 rpm')
    expect(textFor('app-shell-settings-menus')('App.loaded', { count: 1 })).toBe('1 pieza cargada')
    expect(textFor('app-shell-settings-menus')('App.loaded', { count: 2 })).toBe('2 piezas cargadas')
    // Present in English but deliberately outside the pilot, rather than a fabricated missing key.
    expect(t('SimulationPanel.WCS_X_Y_Z')).toBe('WCS X - Y - Z -')
  })
  it('falls back to English for an unavailable language and restores Spanish when selected again', async () => {
    await applyLanguage('es')
    await applyLanguage('unavailable-wo2938')
    expect(i18n.language).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(textFor('language')('section')).toBe('Language')
    await applyLanguage('es')
    expect(textFor('language')('section')).toBe('Idioma')
  })
})

function seedProject() {
  useCamStore.getState().newProject()
  const tool = makeTool(), op = makeOp({ toolId: tool.id })
  const setup = { id: 'setup-1', name: 'Setup 1', wcs: makeWcs(), stock: makeStock(), operations: [op], notes: '' }
  const project = { ...useCamStore.getState().project, name: 'Spanish pilot', machine: makeMachine(), setups: [setup], activeSetupId: setup.id }
  stampGenerationCurrent({ ...project, toolLibrary: [tool] } as unknown as Project, setup as unknown as Setup, op, tool)
  useCamStore.setState({ project, toolLibrary: [tool], consoleEvents: [], workspace: 'cam' } as never)
}
function modal(name: string | null) {
  act(() => { useCamStore.getState().closeModal(); if (name) useCamStore.getState().openModal(name) })
}
async function choose(code: string) {
  modal('settings')
  fireEvent.click(screen.getByTestId('settings-language'))
  fireEvent.click(screen.getByTestId(`settings-language-option-${code}`))
  await waitFor(() => expect(document.documentElement.lang).toBe(code))
}
async function help(id: string, title: string) {
  modal(null)
  act(() => { openHelpTopic(id) })
  await waitFor(() => expect(screen.getByTestId('help-topic-content').querySelector('h2')?.textContent).toBe(title))
}

describe('WO-2938 Spanish through the production App', () => {
  it('selects Español in Settings, shows CAM and Help with fallback, preserves posted G-code and returns to English', async () => {
    act(seedProject)
    render(<App />)
    modal('post-process')
    const before = screen.getByTestId('post-gcode-preview').textContent!
    expect(before).toContain('G54')
    modal('settings')
    const fields = () => [...document.querySelectorAll<HTMLInputElement>('input')].map(input => input.value)
    const englishFields = fields()
    expect(englishFields.some(value => /\d\.\d/.test(value))).toBe(true)
    await choose('es')
    await waitFor(() => expect(screen.getByTestId('settings-language-header').textContent).toBe('Idioma'))
    expect(useUiPrefs.getState().language).toBe('es')
    expect(screen.getByTestId('settings-language').textContent).toContain('Español')
    expect(document.body.textContent).toContain('Unidades de visualización')
    expect(document.body.textContent).toContain('Download backup') // uncovered English fallback
    expect(fields()).toEqual(englishFields)
    modal(null)
    expect(screen.getByTestId('mode-tab-toolpath').textContent).toBe('Trayectoria')
    expect(document.querySelector('[data-tooltip="Deshacer (Ctrl+Z)"]')).not.toBeNull()
    modal('new-operation')
    const operationWords: string[] = []
    for (const tab of document.querySelectorAll<HTMLButtonElement>('.op-modal-tabs button')) {
      fireEvent.click(tab)
      operationWords.push(document.body.textContent ?? '')
    }
    expect(operationWords.some(text => text.includes('Alt. de seguridad'))).toBe(true)
    expect(operationWords.some(text => text.includes('Alt. de retracción'))).toBe(true)
    modal('new-setup')
    expect(document.body.textContent).toContain('Cara superior del tablero de sacrificio')
    expect(screen.getByTestId('setup-modal-basics').querySelector('input')?.value).toBe('Setup 2')
    modal('tool-library')
    expect(document.body.textContent).toContain('Carburo')
    modal('post-process')
    expect(document.querySelector('.modal-title')?.textContent).toContain('Posprocesado')
    expect(withoutContextStamp(screen.getByTestId('post-gcode-preview').textContent!)).toBe(withoutContextStamp(before))
    fireEvent.click(screen.getByTestId('post-preview-edit'))
    expect(screen.getByLabelText('Editor de código G')).toBeTruthy()
    expect((screen.getByTestId('post-gcode-editor-text') as HTMLTextAreaElement).value).toBe(screen.getByTestId('post-gcode-editor-text').textContent)
    await help('welcome-overview', 'Qué es LienCAM')
    expect(screen.getByTestId('help-topic-content').textContent).toContain('.camproject')
    await help('work-offsets', 'Desfases de trabajo G54-G59')
    expect(screen.getByTestId('help-topic-content').textContent).toContain('part-G54.nc, part-G55.nc')
    await help('import-dxf-svg', 'Importing DXF and SVG')
    expect(screen.getByTestId('help-topic-content').textContent).toContain('DXF and SVG files import as 2D layers')
    await choose('en')
    expect(screen.getByTestId('settings-language-header').textContent).toBe('Language')
    expect(fields()).toEqual(englishFields)
    modal(null)
    expect(screen.getByTestId('mode-tab-toolpath').textContent).toBe('Toolpath')
    await help('welcome-overview', 'What LienCAM is')
  }, 60_000)
})
