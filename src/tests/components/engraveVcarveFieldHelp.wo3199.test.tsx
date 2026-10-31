// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { openHelpTopic, useHelpOpen } from '../../help/helpOpen'
import { HelpCenterModal } from '../../components/modals/HelpCenterModal'
import { applyLanguage, i18n } from '../../i18n'
import { engraveVcarveFields, fieldsForOperation } from '../../help/engraveVcarveFields'
import { loadTopic } from '../../help/registry'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size }, clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { validatePersistedSmartHeightState } = await import('../../lib/cam/smartHeights')

const ENGRAVE_TOOL = {
  id: 'engrave-tool', name: '90 degree engraving bit', type: 'chamfer_mill', diameter: 6,
  tipDiameter: 0.5, fluteLength: 10, shankDiameter: 6, overallLength: 50,
  numberOfFlutes: 2, angleFromAxisDeg: 45,
} as unknown as Tool
const V_BIT = {
  id: 'v-bit', name: '90 degree V-bit', type: 'v_bit', diameter: 6,
  tipDiameter: 0, fluteLength: 10, shankDiameter: 6, overallLength: 50,
  numberOfFlutes: 2, angleFromAxisDeg: 45,
} as unknown as Tool
const SNAPSHOT: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 5, feed: 2, top: 10, bottom: 9 },
  machine: { clearance: 15, retract: 5, feed: 2, top: 10, bottom: 9 },
  intent: {
    version: 1,
    clearance: { reference: 'wcs_plane', offset: 15, provenance: 'inferred' },
    retract: { reference: 'wcs_plane', offset: 5, provenance: 'inferred' },
    feed: { reference: 'wcs_plane', offset: 2, provenance: 'inferred' },
    top: { reference: 'wcs_plane', offset: 10, provenance: 'inferred' },
    bottom: { reference: 'wcs_plane', offset: 9, provenance: 'inferred' },
  },
  dependencyIds: ['art', ENGRAVE_TOOL.id, V_BIT.id],
}

function seed() {
  const geometry = {
    id: 'art', name: 'Artwork.svg', filename: 'Artwork.svg', type: 'curves_2d', format: 'svg', loaded: true,
    loopsVersion: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 }, size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 } },
    loops: [{ id: 'loop', layerId: 'art-layer', closed: true, type: 'contour', area: 100,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }],
    layers2d: [{ id: 'art-layer', name: 'Artwork', color: '#fff', visible: true }],
  } as unknown as ImportedGeometry
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [], stock: { type: 'auto' },
    wcs: { id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } },
  } as unknown as Setup
  const current = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [ENGRAVE_TOOL, V_BIT], computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) => {
      expect(validatePersistedSmartHeightState(operation.smartHeight).ok).toBe(true)
      return smartHeightPlanFixture(operation, SNAPSHOT)
    }),
    project: { ...current.project, geometry: [geometry], setups: [setup], activeSetupId: setup.id },
  } as never)
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
  seed()
})
afterEach(async () => { cleanup(); await applyLanguage('en') })

function auditFields() {
  const inputs = [...screen.getByTestId('op-modal-panel').querySelectorAll('input,select,textarea')]
  for (const input of inputs) {
    expect(input.getAttribute('data-field-help'), input.parentElement!.outerHTML).toBeTruthy()
    expect(input.getAttribute('title'), input.parentElement!.outerHTML).toMatch(/.{20}/)
    expect(input.getAttribute('aria-description')).toBe(input.getAttribute('title'))
  }
  return inputs.length
}

async function openOperation(type: 'engrave' | 'vcarve') {
  render(<NewOperationModal />)
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText(type === 'engrave' ? 'Engrave / Trace' : 'V-Carve'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(type === 'engrave' ? ENGRAVE_TOOL.name : V_BIT.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'art' } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
}

describe('WO-3199 field explanations', () => {
  for (const type of ['engrave', 'vcarve'] as const) it(`explains editable ${type} fields across every tab and conditional mode`, async () => {
    await openOperation(type)
    let count = auditFields()
    fireEvent.click(screen.getByText('Passes'))
    if (type === 'engrave') {
      fireEvent.click(screen.getByText('Trace', { exact: true }))
      fireEvent.change(screen.getByTestId('engrave-style'), { target: { value: 'trochoidal' } })
      fireEvent.click(screen.getByTestId('disclosure-passes-advanced'))
      await waitFor(() => auditFields())
      count += auditFields()
      fireEvent.click(screen.getByText('Left', { exact: true }))
      count += auditFields()
      fireEvent.click(screen.getByText('V-engrave', { exact: true }))
      fireEvent.click(screen.getByText(/^Depth from line width/))
      count += auditFields()
    } else {
      fireEvent.click(screen.getByTestId('vcarve-depth-flat'))
      count += auditFields()
      fireEvent.click(screen.getByTestId('vcarve-clear-tool'))
      count += auditFields()
      fireEvent.click(screen.getByTestId('vcarve-clear-none'))
      count += auditFields()
    }
    fireEvent.click(screen.getByText('Heights', { exact: true }))
    for (const name of ['Clearance', 'Retract', 'Feed', 'Top']) {
      fireEvent.click(screen.getByRole('button', { name: `Expand ${name} Height height` }))
      count += auditFields()
    }
    count += auditFields()
    if (type === 'engrave') {
      fireEvent.click(screen.getByText('Passes', { exact: true }))
      fireEvent.click(screen.getByText(/^Depth from line width/))
      fireEvent.click(screen.getByText('Heights', { exact: true }))
      fireEvent.click(screen.getByTestId('engrave-follow-surface'))
      count += auditFields()
      expect(screen.getByTestId('engrave-follow-surface').getAttribute('title')).toContain('does not sample stock')
      fireEvent.click(screen.getByText('Linking', { exact: true }))
      count += auditFields()
      fireEvent.click(screen.getByTestId('contour-tabs-enabled'))
      count += auditFields()
      fireEvent.click(screen.getByText('Ramp (linear)', { exact: true }))
      count += auditFields()
    }
    fireEvent.click(screen.getByText('Feedrate', { exact: true }))
    const override = screen.getByText('Override tool feeds & speeds for this operation').closest('label')!.querySelector('input')!
    fireEvent.click(override)
    count += auditFields()
    expect(count).toBeGreaterThan(25)
  })

  for (const type of ['engrave', 'vcarve'] as const) it(`explains ${type} Properties and preserves authored values`, async () => {
    await openOperation(type)
    fireEvent.click(screen.getByText('Heights', { exact: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand Top Height height' }))
    if (type === 'engrave') {
      const depth = screen.getByText('Engraving depth').closest('.op-field-row')!.querySelector('input')!
      fireEvent.change(depth, { target: { value: '0.5' } })
      fireEvent.blur(depth)
    }
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    const project = useCamStore.getState().project
    const op = project.setups[0].operations.at(-1)!
    expect(op.type).toBe(type)
    const before = JSON.stringify(op)
    cleanup()
    act(() => useCamStore.setState({ project: { ...project, activeOperationId: op.id } }))
    render(<PropertiesPanel />)
    await waitFor(() => expect(screen.getByTestId('props-quickedit')).toBeTruthy())
    for (const button of document.querySelectorAll<HTMLButtonElement>('.props-disclosure > button[aria-expanded="false"]')) fireEvent.click(button)
    await waitFor(() => {
      const inputs = [...document.querySelectorAll('.props-section-op input,.props-section-op select')]
      expect(inputs.length).toBeGreaterThan(2)
      expect(inputs.filter(input => !input.getAttribute('title')).map(input => input.closest('.props-group')?.outerHTML ?? input.parentElement!.outerHTML)).toEqual([])
      for (const input of inputs) expect(input.getAttribute('title')).toMatch(/.{20}/)
    })
    expect(document.querySelector('[data-engrave-vcarve-field="plunge"] input')?.getAttribute('data-field-help')).toBe('plunge')
    expect(document.querySelector('[data-engrave-vcarve-field="cutFeed"] input')?.getAttribute('data-field-help')).toBe('cutFeed')
    fireEvent.click(screen.getByTestId('quickedit-change-tool'))
    await waitFor(() => expect(document.querySelector('.op-tool-row')?.getAttribute('data-field-help')).toBe('tool'))
    expect(JSON.stringify(useCamStore.getState().project.setups[0].operations.at(-1))).toBe(before)
  })

  for (const language of ['de', 'es', 'fr']) it(`keeps field help attached after switching to ${language}`, async () => {
    await openOperation('vcarve')
    fireEvent.click(screen.getByText('Passes', { exact: true }))
    fireEvent.click(screen.getByTestId('vcarve-depth-flat'))
    await act(async () => applyLanguage(language))
    await waitFor(() => auditFields())
    const input = document.querySelector('[data-field-help="startDepth"]')!
    expect(input.getAttribute('title')).toBe(i18n.getResource(language, 'engrave-vcarve-fields.wo3199', 'startDepth'))
  })

  it('renders the actual labelled pictures in both Help topics', async () => {
    useHelpOpen.setState({ requested: null, overlay: false })
    render(<HelpCenterModal />)
    for (const operation of ['engrave', 'vcarve']) {
      act(() => openHelpTopic(operation))
      await waitFor(() => expect(screen.getByTestId('help-topic-content').querySelector('h2')?.textContent).toBe(operation === 'engrave' ? 'Engraving' : 'V-carving'))
      await waitFor(() => {
        const pictures = [...screen.getByTestId('engrave-vcarve-guide').querySelectorAll('img')]
        expect(pictures.length).toBeGreaterThan(10)
        expect(pictures.some(picture => picture.getAttribute('src')?.includes(`${operation}-01-name`))).toBe(true)
      })
    }
  })

  it('keeps generated wiki field text and copied picture bytes in sync', async () => {
    const modulePath = '../../../tools/release/help-to-wiki.mjs'
    const { generateWiki } = await import(modulePath) as { generateWiki: () => Promise<{ pages: Map<string, string> }> }
    const generated = await generateWiki()
    expect(readFileSync('docs/wiki/Toolpaths-2.5D.md', 'utf8').replaceAll('\r\n', '\n')).toBe(generated.pages.get('Toolpaths-2.5D.md'))
    const pictures = readdirSync('src/help/field-guides').filter(name => name.endsWith('.png'))
    expect(pictures).toContain('cut-diagram.png')
    for (const name of pictures) expect(readFileSync(`docs/wiki/images/wo3199/${name}`)).toEqual(readFileSync(`src/help/field-guides/${name}`))
  })

  it('keeps the same field inventory in both Help topics and translates every hover sentence', async () => {
    for (const op of ['engrave', 'vcarve']) {
      const topic = (await loadTopic(op))!
      const table = topic.sections.find(section => section.kind === 'table')!
      expect(table.kind).toBe('table')
      if (table.kind === 'table') expect(table.rows.map(row => row.cells)).toEqual(fieldsForOperation(op).map(field => [field.label, field.text]))
    }
    for (const language of ['de', 'es', 'fr']) {
      await applyLanguage(language)
      for (const field of engraveVcarveFields) {
        const text = i18n.getResource(language, 'engrave-vcarve-fields.wo3199', field.id)
        expect(text, `${language}:${field.id}`).toBeTruthy()
        expect(text).not.toBe(field.text)
      }
    }
  })
})
