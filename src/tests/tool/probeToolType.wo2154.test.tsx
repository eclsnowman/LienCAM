// @vitest-environment jsdom
//
// WO-2154: the Tool Library has a Probe tool type. Driven through the
// production Tool Library: add a probe, set its fields, save, reload the
// persisted library, read the fields back, export it and import the export.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Tool } from '../../types'

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
const { useCamStore, persistPartialize, persistMigrate, persistMerge } = await import('../../store')
const { importFusionTools } = await import('../../lib/fusionImporter')
const { buildToolProfile, radiusAtZ } = await import('../../lib/tool/toolProfile')
const { probeEffectiveRadius, probeInputOf, probeContactOf } = await import('../../lib/tool/probeTool')
const { TOOL_TYPE_ORDER } = await import('../../lib/tool/toolMeta')

// Captures what the production Export button writes (the desktop host route
// of lib/saveFile), so the import below reads the app's own export.
const saved: { filename: string; data: string }[] = []
;(globalThis as { liencamHost?: unknown }).liencamHost = {
  saveFile: async (filename: string, data: string | Uint8Array) => {
    saved.push({ filename, data: typeof data === 'string' ? data : new TextDecoder().decode(data) })
    return filename
  },
}

function row(label: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>('.tool-form-section .mform-row'))
    .find((candidate) => candidate.querySelector('.mform-label')?.textContent?.trim() === label)
  if (!match) throw new Error(`Missing Tool Library row: ${label}`)
  return match
}

function input(label: string): HTMLInputElement {
  const el = row(label).querySelector('input')
  if (!(el instanceof HTMLInputElement)) throw new Error(`Missing input: ${label}`)
  return el
}

function select(label: string): HTMLSelectElement {
  const el = row(label).querySelector('select')
  if (!(el instanceof HTMLSelectElement)) throw new Error(`Missing select: ${label}`)
  return el
}

function typeInto(label: string, value: string): void {
  const el = input(label)
  act(() => {
    fireEvent.focus(el)
    fireEvent.change(el, { target: { value } })
    fireEvent.blur(el)
  })
}

function choose(label: string, value: string): void {
  act(() => { fireEvent.change(select(label), { target: { value } }) })
}

function tab(name: string): void {
  act(() => { fireEvent.click(screen.getByRole('button', { name })) })
}

function openLibrary(): void {
  render(<ToolLibraryModal />)
  act(() => { useCamStore.getState().openModal('tool-library') })
}

function selectListed(name: string): void {
  const item = Array.from(document.querySelectorAll<HTMLElement>('.tool-list-item'))
    .find((el) => el.querySelector('.tool-list-name')?.textContent === name)
  if (!item) throw new Error(`Tool not listed: ${name}`)
  act(() => { fireEvent.click(item) })
}

function probes(): Tool[] {
  return useCamStore.getState().toolLibrary.filter((t) => t.type === 'probe')
}

// Add the PGFUN TP05C Operator is looking at: 2.0 mm ball, 6 mm shank, NC, on
// probe 2, calibrated in X only.
function addProbeThroughLibrary(): void {
  openLibrary()
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'New' })) })
  tab('General')
  act(() => { fireEvent.change(input('Name'), { target: { value: 'TP05C probe' } }) })
  choose('Type', 'probe')
  tab('Cutter')
  typeInto('Ball (tip) diameter', '2')
  typeInto('Shank diameter', '6')
  typeInto('Overall length', '60')
  choose('Probe input', '2')
  choose('Contact', 'normally_closed')
  typeInto('Calibrated radius X', '0.987')
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })) })
}

beforeEach(() => {
  mem.clear()
  saved.length = 0
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState({ toolLibrary: [], holders: [], consoleEvents: [], consoleReadThroughId: 0 })
  })
})

afterEach(() => {
  cleanup()
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-2154 Probe tool type in the Tool Library', () => {
  it('adds a probe with its fields through the production Tool Library and saves them', () => {
    addProbeThroughLibrary()

    expect(probes()).toHaveLength(1)
    const probe = probes()[0]
    expect(probe.name).toBe('TP05C probe')
    expect(probe.diameter).toBe(2)
    expect(probe.shankDiameter).toBe(6)
    expect(probe.overallLength).toBe(60)
    expect(probe.probeInput).toBe(2)
    expect(probe.probeContact).toBe('normally_closed')
    expect(probe.probeEffectiveRadiusX).toBe(0.987)
    // Y was never calibrated: blank, and the ball radius stands in for it.
    expect(probe.probeEffectiveRadiusY).toBeUndefined()
    expect(probeEffectiveRadius(probe, 'x')).toBe(0.987)
    expect(probeEffectiveRadius(probe, 'y')).toBe(1)

    // The library lists it under its own Probe group.
    expect(screen.getByTestId('tool-group-probe').textContent).toContain('Probe')
  })

  it('reloads the saved probe from the persisted library and shows its fields in the editor', () => {
    addProbeThroughLibrary()
    cleanup()

    // Reload: the persisted blob, JSON round-tripped, migrated and merged into
    // a library that no longer holds the probe - the app's own reload path.
    const blob = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState())))
    const migrated = persistMigrate(blob, 0)
    act(() => { useCamStore.setState({ toolLibrary: [] }) })
    const merged = persistMerge(migrated, useCamStore.getState()) as { toolLibrary: Tool[] }
    act(() => { useCamStore.setState({ toolLibrary: merged.toolLibrary }) })

    expect(probes()).toHaveLength(1)
    openLibrary()
    selectListed('TP05C probe')
    tab('General')
    expect(select('Type').value).toBe('probe')
    tab('Cutter')
    expect(Number(input('Ball (tip) diameter').value)).toBe(2)
    expect(Number(input('Shank diameter').value)).toBe(6)
    expect(select('Probe input').value).toBe('2')
    expect(select('Contact').value).toBe('normally_closed')
    expect(Number(input('Calibrated radius X').value)).toBe(0.987)
    expect(input('Calibrated radius Y').value).toBe('')
    expect(input('Calibrated radius Y').placeholder).toBe('ball 1.000')
  })

  it('a probe shows no flute count: no Flutes field in its editor and no "fl" in its list row', () => {
    addProbeThroughLibrary()
    selectListed('TP05C probe')
    tab('Cutter')
    expect(() => row('Flutes')).toThrow('Missing Tool Library row: Flutes')
    const item = Array.from(document.querySelectorAll<HTMLElement>('.tool-list-item'))
      .find((el) => el.querySelector('.tool-list-name')?.textContent === 'TP05C probe')
    const meta = item?.querySelector('.tool-list-meta')?.textContent ?? ''
    expect(meta).toContain('probe')
    expect(meta).not.toMatch(/\dfl\b/)
  })

  it('exports the probe and imports the export with every probe field intact', async () => {
    addProbeThroughLibrary()
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Export' })) })
    await act(async () => { await Promise.resolve() })
    expect(saved).toHaveLength(1)
    cleanup()

    act(() => { useCamStore.setState({ toolLibrary: [] }) })
    openLibrary()
    const file = new File([saved[0].data], 'probes.json', { type: 'application/json' })
    const fileInput = document.querySelector('input[type="file"][accept=".json,.tools"]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fireEvent.change(fileInput)
    await screen.findByTestId('tool-import-feedback', {}, { timeout: 2000 })

    expect(probes()).toHaveLength(1)
    const probe = probes()[0]
    expect(probe.name).toBe('TP05C probe')
    expect(probe.diameter).toBe(2)
    expect(probe.shankDiameter).toBe(6)
    expect(probe.probeInput).toBe(2)
    expect(probe.probeContact).toBe('normally_closed')
    expect(probe.probeEffectiveRadiusX).toBe(0.987)
    expect(probe.probeEffectiveRadiusY).toBeUndefined()
  })

  it('imports a Fusion-format probe as a Probe, not as an unrecognized cutter', () => {
    const { tools, diagnostics } = importFusionTools({
      data: [{ type: 'probe', description: 'Fusion probe', unit: 'millimeters', geometry: { DC: 2, SFDM: 6, LCF: 20, OAL: 50 } }],
    })
    expect(diagnostics).toEqual([])
    expect(tools).toHaveLength(1)
    expect(tools[0].type).toBe('probe')
    expect(tools[0].diameter).toBe(2)
  })

  it('draws a probe as a ball on a stem, then its shank', () => {
    const probe = { ...addDefaults(), type: 'probe' as const, diameter: 2, shankDiameter: 6, fluteLength: 20, overallLength: 50 }
    const profile = buildToolProfile(probe)
    const stemR = radiusAtZ(profile, 10)
    expect(radiusAtZ(profile, 1)).toBeCloseTo(1, 3) // ball equator (48-segment arc)
    expect(stemR).toBeGreaterThan(0)
    expect(stemR).toBeLessThan(1) // stem narrower than the ball
    expect(radiusAtZ(profile, 30)).toBeCloseTo(3, 6) // 6 mm shank
    expect(profile.cuttingMaxZ).toBe(20)
  })

  it('reads absent probe fields as probe 1, normally open, ball radius', () => {
    const probe = { ...addDefaults(), type: 'probe' as const, diameter: 2 }
    expect(probeInputOf(probe)).toBe(1)
    expect(probeContactOf(probe)).toBe('normally_open')
    expect(probeEffectiveRadius(probe, 'x')).toBe(1)
    expect(probeEffectiveRadius(probe, 'y')).toBe(1)
    expect(TOOL_TYPE_ORDER.at(-1)).toBe('probe')
  })
})

function addDefaults(): Tool {
  return {
    id: 'probe-fixture', name: 'probe', type: 'probe', diameter: 2, fluteLength: 20, shankDiameter: 6,
    overallLength: 50, numberOfFlutes: 1, material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: {},
  }
}
