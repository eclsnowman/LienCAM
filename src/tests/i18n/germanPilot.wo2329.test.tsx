// @vitest-environment jsdom
//
// WO-2329: the German pilot through the real app. The operator opens
// Settings > Language, sees Deutsch labelled as machine-translated with where
// a correction goes, chooses it, and the app shows German on every screen area
// sampled here and in Help - with any line German does not have yet showing
// its English, never a blank. Shortcut letters and G-code words stay English,
// numbers keep their "." decimal, and choosing English again gives back the
// exact text the app showed before German was ever chosen.
//
// Nothing here is stood in for except the 3D viewport (jsdom has no WebGL),
// as in englishByteIdentical.wo2319.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent, waitFor, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { Project, Setup } from '../../types'
import { makeTool, makeOp, makeWcs, makeMachine, makeStock, stampGenerationCurrent } from '../post/helpers'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { openHelpTopic } = await import('../../help/helpOpen')
const { i18n, AVAILABLE_LANGUAGES, languageName } = await import('../../i18n')
const session = await import('../../lib/machine/machineSession')
const { useMachineControl } = await import('../../store/machineControlStore')
const { withoutContextStamp } = await import('../../components/gcode/gcodeEditing')

// Build provenance, not words: the commit and version change with every commit.
const PROVENANCE = ['settings-build-info', 'settings-app-version']
const ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt', 'aria-description', 'data-tooltip']

/** Every word a user can read or hear, in document order, plus field values. */
function wordsOf(root: HTMLElement): string[] {
  const copy = root.cloneNode(true) as HTMLElement
  for (const id of PROVENANCE) {
    copy.querySelectorAll(`[data-testid="${id}"]`).forEach((node) => { node.textContent = `<${id}>` })
  }
  const out: string[] = []
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let node: Node | null = walker.currentNode; node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.parentElement?.closest('script, style') != null) continue
      const text = node.textContent ?? ''
      if (text.trim() !== '') out.push(text)
    } else if (node instanceof Element) {
      for (const name of ATTRIBUTES) {
        const value = node.getAttribute(name)
        if (value !== null && value.trim() !== '') out.push(`@${name}=${value}`)
      }
    }
  }
  return out
}

function fieldValues(root: HTMLElement): string[] {
  return [...root.querySelectorAll('input')].map((input) => `${input.getAttribute('data-testid') ?? ''}=${input.value}`)
}

function byTestId(id: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (node === null) throw new Error(`no [data-testid="${id}"] on screen`)
  return node
}

function chooseLanguage(code: string) {
  act(() => { useCamStore.getState().openModal('settings') })
  act(() => { fireEvent.click(byTestId('settings-language')) })
  act(() => { fireEvent.click(byTestId(`settings-language-option-${code}`)) })
}

async function openControl() {
  act(() => { useCamStore.getState().closeModal() })
  act(() => { useCamStore.getState().setWorkspace('control') })
  await waitFor(() => {
    expect(document.querySelector('[data-testid="control-workspace-loading"]')).toBeNull()
    expect(document.querySelector('[data-testid="control-cyclestart"]')).not.toBeNull()
  }, { timeout: 30_000 })
}

async function openHelpAt(id: string, title: string) {
  act(() => { useCamStore.getState().closeModal() })
  act(() => { openHelpTopic(id) })
  await waitFor(() => {
    expect(byTestId('help-topic-content').querySelector('h2')?.textContent).toBe(title)
  }, { timeout: 10_000 })
}

/** The screens sampled for the English round trip. */
async function englishScreens(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  act(() => { useCamStore.getState().closeModal(); useCamStore.getState().setWorkspace('cam') })
  out['cam workspace'] = wordsOf(document.body)
  act(() => { useCamStore.getState().openModal('settings') })
  out['settings dialog'] = wordsOf(document.body)
  out['settings fields'] = fieldValues(document.body)
  await openHelpAt('welcome-overview', 'What LienCAM is')
  out['help welcome'] = wordsOf(document.body)
  await openControl()
  out['control workspace'] = wordsOf(document.body)
  act(() => { useCamStore.getState().setWorkspace('cam') })
  return out
}

afterEach(cleanup)

describe('WO-2329: German pilot through Settings > Language', () => {
  it('labels Deutsch as machine-translated, shows German with English fallback, keeps letters and decimals, and returns to the exact English', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      act(() => {
        useCamStore.getState().newProject()
        useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
        useCamStore.getState().setWorkspace('cam')
      })
      render(<App />)
      // One English pass first, so Control and Help have mounted once in both
      // snapshots; the second pass is the English the round trip must match.
      await englishScreens()
      const before = await englishScreens()

      // The picker lists Deutsch and says, in German, that it is machine
      // translation and where a correction goes.
      act(() => { useCamStore.getState().openModal('settings') })
      act(() => { fireEvent.click(byTestId('settings-language')) })
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(AVAILABLE_LANGUAGES.map(languageName))
      act(() => { fireEvent.click(byTestId('settings-language')) })
      expect(byTestId('settings-language-note-de').textContent)
        .toBe('Deutsch: Maschinell übersetzt - Korrekturen willkommen: Hilfe > Problem melden.')
      const englishFields = fieldValues(document.body)

      chooseLanguage('de')
      await waitFor(() => { expect(byTestId('settings-language-header').textContent).toBe('Sprache') })
      expect(i18n.language).toBe('de')
      expect(document.documentElement.lang).toBe('de')

      // Settings: German words, the untranslated User Data section in English,
      // and every number field exactly as it was in English ("." decimal).
      const settings = wordsOf(document.body)
      expect(settings).toContain('Einheiten')
      expect(settings).toContain('Oberflächensprache')
      expect(settings).toContain('Download backup')
      expect(fieldValues(document.body)).toEqual(englishFields)
      expect(englishFields.some((field) => /\d\.\d/.test(field))).toBe(true)

      // CAM workspace header: German tabs; shortcut letters stay as they are.
      act(() => { useCamStore.getState().closeModal() })
      const cam = wordsOf(document.body)
      expect(cam).toContain('Aufspannung')
      expect(cam).toContain('Werkzeugweg')
      expect(cam).toContain('@data-tooltip=Rückgängig (Ctrl+Z)')

      // Help: German categories and topic, the note, and English for a topic
      // German does not have yet.
      await openHelpAt('welcome-overview', 'Was LienCAM ist')
      expect(byTestId('help-machine-translation-note').textContent)
        .toBe('Maschinell übersetzt - Korrekturen willkommen: Hilfe > Problem melden.')
      expect(byTestId('help-topic-content').textContent).toContain('.camproject-Dateien')
      expect(wordsOf(document.body)).toContain('Problem melden')
      await openHelpAt('work-offsets', 'Nullpunktverschiebungen G54-G59')
      expect(byTestId('help-topic-content').textContent).toContain('part-G54.nc, part-G55.nc')
      await openHelpAt('import-dxf-svg', 'Importing DXF and SVG')
      expect(byTestId('help-topic-content').textContent).toContain('DXF and SVG files import as 2D layers')

      // Control: the glossary's NC-Start and Vorschub-Stopp on the transport bar.
      await openControl()
      expect(byTestId('control-cyclestart').textContent).toBe(' NC-START')
      expect(byTestId('control-feedhold').textContent).toBe(' Vorschub-Stopp')
      expect(byTestId('control-feedhold').getAttribute('data-tooltip') ?? '').not.toBe('')

      // Back to English: every sampled screen is character for character what
      // it was before German was chosen.
      act(() => { useCamStore.getState().setWorkspace('cam') })
      chooseLanguage('en')
      await waitFor(() => { expect(byTestId('settings-language-header').textContent).toBe('Language') })
      expect(document.documentElement.lang).toBe('en')
      expect(document.querySelector('[data-testid="help-machine-translation-note"]')).toBeNull()
      const after = await englishScreens()
      expect(Object.keys(after)).toEqual(Object.keys(before))
      for (const name of Object.keys(before)) {
        expect(before[name].length, `${name}: words recorded`).toBeGreaterThan(5)
        expect(after[name], name).toEqual(before[name])
      }
    } finally {
      errorSpy.mockRestore()
    }
  }, 120_000)

  // The architect's fix round (2026-10-13): every area that got German shows
  // it through the real app, and what goes to the machine does not change. A
  // program posted with German chosen is the English post byte for byte, a
  // setup or tool created with German chosen gets the same default name it
  // gets in English (that name is written into the posted file), and a message
  // from the simulated controller reads exactly as the controller sent it.
  it('shows German in every sampled area while the posted program, default names and controller messages stay exactly as in English', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const saved: Array<{ name: string; text: string }> = []
    ;(globalThis as { liencamHost?: unknown }).liencamHost = {
      saveFile: async (name: string, data: string | Uint8Array) => {
        saved.push({ name, text: typeof data === 'string' ? data : new TextDecoder().decode(data) })
        return name
      },
    }
    try {
      act(() => {
        useCamStore.getState().newProject()
        useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
        useCamStore.getState().setWorkspace('cam')
        const tool = makeTool()
        const op = makeOp({ toolId: tool.id })
        const setup = { id: 'setup-1', name: 'Setup 1', wcs: makeWcs(), stock: makeStock(), operations: [op], notes: '' }
        const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
        const project = { ...s.project, name: 'Pilot', machine: makeMachine(), setups: [setup], activeSetupId: setup.id }
        stampGenerationCurrent({ ...project, toolLibrary: [tool] } as unknown as Project, setup as unknown as Setup, op, tool)
        useCamStore.setState({ project, toolLibrary: [tool] } as never)
      })
      render(<App />)
      expect(i18n.language).toBe('en')

      /** Post Process: the preview text and the bytes Export writes. */
      async function post(): Promise<{ preview: string; file: { name: string; text: string } }> {
        act(() => { useCamStore.getState().closeModal(); useCamStore.getState().setWorkspace('cam') })
        act(() => { useCamStore.getState().openModal('post-process') })
        const preview = byTestId('post-gcode-preview').textContent ?? ''
        const exportButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => /^\s*Export \.nc\s*$/.test(button.textContent ?? ''))
        if (exportButton === undefined) throw new Error('no Export .nc button')
        saved.length = 0
        fireEvent.click(exportButton)
        await waitFor(() => { expect(saved).toHaveLength(1) })
        return { preview, file: { ...saved[0] } }
      }
      /** The name a new setup and a new tool start with. */
      function defaultNames(): { setup: string; tool: string[] } {
        act(() => { useCamStore.getState().closeModal() })
        act(() => { useCamStore.getState().openModal('new-setup') })
        const setup = byTestId('setup-modal-basics').querySelector('input')?.value ?? ''
        act(() => { useCamStore.getState().closeModal() })
        act(() => { useCamStore.getState().openModal('tool-library') })
        // The New-tool button's tooltip is not translated yet, so it reads the same in both.
        act(() => { fireEvent.click(document.querySelector('button.machine-list-btn[data-tooltip="New tool"]')!) })
        act(() => { fireEvent.click(document.querySelector('button.tool-tab')!) }) // General: the name field
        const tool = [...document.querySelectorAll('input')].map((input) => input.value)
          .filter((value) => /new tool|neues werkzeug/i.test(value))
        act(() => { useCamStore.getState().closeModal() })
        return { setup, tool }
      }
      /** What the simulated controller says back to a clamped spindle speed. */
      async function controllerSays(): Promise<string[]> {
        await openControl()
        await act(async () => { await session.connectMachine('simulator', 115200) })
        await waitFor(() => { expect(useMachineControl.getState().connectionPhase).toBe('connected') }, { timeout: 10_000 })
        const first = useMachineControl.getState().consoleLines.length
        const reply = await session.getMachineController().sendCommandAwait('M3 S999999')
        await session.getMachineController().sendCommandAwait('M5')
        expect(reply?.ok).toBe(true)
        const said = useMachineControl.getState().consoleLines.slice(first)
          .filter((line) => line.dir === 'rx').map((line) => `${line.severity}:${line.text}`)
        await act(async () => { await session.disconnectMachine() })
        act(() => { useMachineControl.setState({ consoleLines: [] }) })
        return said
      }

      const englishPost = await post()
      const englishNames = defaultNames()
      const englishController = await controllerSays()
      expect(englishPost.preview).toContain('G54')
      expect(englishPost.file.name.endsWith('.nc')).toBe(true)
      expect(englishNames.setup).toBe('Setup 2')
      expect(englishNames.tool).toEqual(['New Tool'])
      expect(englishController).toHaveLength(1)
      expect(englishController[0]).toMatch(/^warn:M3 S999999 was clamped to \d+ RPM: this machine allows \d+-\d+ RPM\.$/)

      act(() => { useCamStore.getState().setWorkspace('cam') })
      chooseLanguage('de')
      await waitFor(() => { expect(byTestId('settings-language-header').textContent).toBe('Sprache') })
      act(() => { useCamStore.getState().closeModal() })

      // App shell.
      expect(wordsOf(document.body)).toContain('Werkzeugweg')

      // Post Process and the G-code editor: German around the program, the
      // program itself, its file name and extension the English post exactly.
      const germanPost = await post()
      expect(document.querySelector('.modal-title')?.textContent).toBe('Postprozessor — Pilot (1 setup, all operations)')
      expect(byTestId('post-preview-edit').textContent?.trim()).toBe('Bearbeiten')
      // Each post stamps its own time and checksum into the LienCAM context
      // block after M30; every other byte must match.
      expect(withoutContextStamp(germanPost.preview)).toBe(withoutContextStamp(englishPost.preview))
      expect(germanPost.file.name).toBe(englishPost.file.name)
      expect(withoutContextStamp(germanPost.file.text)).toBe(withoutContextStamp(englishPost.file.text))
      act(() => { fireEvent.click(byTestId('post-preview-edit')) })
      const editing = wordsOf(document.body)
      expect(editing).toContain('@aria-label=G-Code-Editor')
      expect(editing).toContain('An Steuerung senden')
      expect((byTestId('post-gcode-editor-text') as HTMLTextAreaElement).value).toBe(germanPost.preview)
      act(() => { useCamStore.getState().closeModal() })

      // Setup and Tool Library: German choices, English default names.
      act(() => { useCamStore.getState().openModal('new-setup') })
      expect(wordsOf(document.body)).toContain('Opferplatte oben')
      act(() => { useCamStore.getState().closeModal() })
      act(() => { useCamStore.getState().openModal('tool-library') })
      expect(wordsOf(document.body)).toContain('Hartmetall')
      act(() => { useCamStore.getState().closeModal() })
      expect(defaultNames()).toEqual(englishNames)

      // CAM operations: the operation editor's heights, in the glossary's
      // German (Clearance Height = Sicherheitshöhe), on whichever tab draws them.
      act(() => { useCamStore.getState().openModal('new-operation') })
      const operationTabs = [...document.querySelectorAll<HTMLButtonElement>('.op-modal-tabs button')]
      expect(operationTabs.length).toBeGreaterThan(0)
      const operationWords: string[] = []
      for (const tab of operationTabs) {
        act(() => { fireEvent.click(tab) })
        operationWords.push(...wordsOf(document.body))
      }
      expect(operationWords).toContain('Sicherheitshöhe')
      act(() => { useCamStore.getState().closeModal() })

      // Operator messages: why an operation went amber, in German.
      act(() => { fireEvent.click(byTestId('tree-expand-all')) })
      act(() => {
        useCamStore.getState().updateOperation('setup-1', 'op1', { status: 'outdated', outdatedReason: { kind: 'tool' } })
      })
      expect(wordsOf(document.body).some((word) => word.includes('sein Werkzeug wurde geändert'))).toBe(true)

      // Sketch: the tool rail.
      act(() => { fireEvent.click(byTestId('mode-tab-sketch')) })
      act(() => { fireEvent.click(document.querySelector('.sketch-entry-new')!) })
      await waitFor(() => { expect(wordsOf(document.body)).toContain('Linie') })
      expect(wordsOf(document.body)).toContain('Rechteck')
      act(() => { useCamStore.getState().setActiveSketch(null) })

      // Control: the glossary's NC-START, and the controller's own message
      // unchanged. (Probing is sampled in germanPilotProbing.wo2329: its
      // routine names are read once, when Control first opens.)
      await openControl()
      expect(byTestId('control-cyclestart').textContent).toBe(' NC-START')
      expect(await controllerSays()).toEqual(englishController)

      act(() => { useCamStore.getState().setWorkspace('cam') })
      chooseLanguage('en')
      await waitFor(() => { expect(byTestId('settings-language-header').textContent).toBe('Language') })
    } finally {
      delete (globalThis as { liencamHost?: unknown }).liencamHost
      errorSpy.mockRestore()
    }
  }, 120_000)
})

