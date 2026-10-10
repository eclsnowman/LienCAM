// @vitest-environment jsdom
//
// WO-411 slice 4 - the probe routine editor + preview, now the Control page's
// own "Routines" sub-tab (Operator ruling 2026-08-21: at 1536x750 the station under the
// Probing operator station was cut off and did not scroll; "Perhaps custom
// probe needs its own tab? Probe tab is getting pretty busy.").
// Presentation and library wiring only: the list, selecting, editing a field
// (validation error named by step, inline), Check -> preview lines from the
// expander against a live-shaped machine context, import / export round trip
// through the store, factory read-only, Duplicate / Delete / Hide / Restore,
// quarantine listing, and the Run button disabled (slice 3 is not here).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import { resolveProbeConfig } from '../../lib/machine/toolTable'
import { FACTORY_BORE_CENTRE, FACTORY_PROBE_ROUTINES } from '../../lib/machine/probeRoutineFactory'
import { exportRoutines } from '../../lib/machine/probeRoutineFile'
import type { ProbeRoutine } from '../../lib/machine/probeRoutineFormat'

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

const { ProbeRoutineEditor } = await import('../../components/machine/ProbeRoutineEditor')
const { ProbeRoutinesTab } = await import('../../components/machine/ProbeRoutinesTab')
const { useProbeRoutineStore } = await import('../../store/probeRoutineStore')

// A machine the factory bore fits on: 300 x 300 x 100, zero at min, probe
// parked in the middle of the table at probing depth.
const envelope = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 300, y: 300, z: 100 },
)
const probe = resolveProbeConfig(null, {
  positioningFeed: 1200, fastFeed: 300, slowFeed: 40, retract: 2, maxTravel: 30,
  surfaceClearance: 5, overtravel: 5, crossOverLift: 10, padThickness: 10,
})
const START = { x: 100, y: 100, z: 40 }

function mount(overrides: Partial<Parameters<typeof ProbeRoutineEditor>[0]> = {}) {
  return render(
    <ProbeRoutineEditor
      start={START}
      envelopeStatus="homed"
      envelope={envelope}
      probe={probe}
      tipRadiusMm={1.5}
      axisLimits={null}
      activeWcs="G54"
      // WO-2065: the Bore works from its top; the Routines tab fills it from work Z0 (WO-2074)
      workZeroMachineZ={25}
      units="mm"
      defaultOpen
      {...overrides}
    />,
  )
}

// WO-411 cleanup: the list is a dropdown - picking is selecting its option.
const pick = (id: string) => fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: id } })
const check = () => fireEvent.click(screen.getByTestId('probe-routine-check'))
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } })

beforeEach(() => {
  mem.clear()
  act(() => { useProbeRoutineStore.setState({ routines: {}, quarantined: {}, hidden: [] }) })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WO-411 slice 4 - the Routines station (its own Control sub-tab)', () => {
  it('hosted as the Routines tab it is open, has no Show/Hide toggle, no DRO / offset strip, and the tip radius sits in the picker row', () => {
    render(<ProbeRoutinesTab />)
    expect(screen.getByTestId('control-routines-panel')).toBeTruthy()
    // Operator 2026-08-21 cleanup: no machine-position strip, no active-offset chip on this tab
    expect(screen.queryByTestId('control-routines-machine-status')).toBeNull()
    for (const axis of ['x', 'y', 'z']) expect(screen.queryByTestId(`control-routines-dro-${axis}`)).toBeNull()
    expect(screen.queryByTestId('control-routines-active-wcs')).toBeNull()
    // the tip radius is the one live number kept, inline in the picker row
    const tip = screen.getByTestId('control-routines-tip-radius-cell')
    expect(tip).toBeTruthy()
    expect(screen.getByTestId('probe-routine-picker-row').contains(tip)).toBe(true)
    const section = screen.getByTestId('probe-routine-section')
    expect(section.getAttribute('data-open')).toBe('true')
    expect(screen.queryByTestId('probe-routine-toggle')).toBeNull()
    expect(screen.getByTestId('probe-routine-select').tagName).toBe('SELECT')
    expect(screen.getByTestId('probe-routine-editor-empty')).toBeTruthy()
    // the station is the panel body's only child: two columns, nothing above them but the picker row
    const body = section.parentElement!
    expect(body.className).toContain('panel-body')
    expect(body.children).toHaveLength(1)
    expect(screen.getByTestId('probe-routine-columns').children).toHaveLength(2)
  })

  it('lists every factory routine, read-only, and (as a plain station) opens collapsed by default', () => {
    const { unmount } = render(
      <ProbeRoutineEditor start={START} envelopeStatus="homed" envelope={envelope} probe={probe} tipRadiusMm={1.5} activeWcs="G54" units="mm" />,
    )
    expect(screen.getByTestId('probe-routine-section').getAttribute('data-open')).toBe('false')
    expect(screen.queryByTestId('probe-routine-list')).toBeNull()
    fireEvent.click(screen.getByTestId('probe-routine-toggle'))
    expect(screen.getByTestId('probe-routine-section').getAttribute('data-open')).toBe('true')
    unmount()

    mount()
    // the dropdown: every factory routine is an option under the "Factory" group
    const list = screen.getByTestId('probe-routine-list')
    const factoryGroup = within(list).getByTestId('probe-routine-group-factory') as HTMLOptGroupElement
    expect(factoryGroup.label).toBe('Factory')
    for (const routine of FACTORY_PROBE_ROUTINES) {
      const item = within(list).getByTestId(`probe-routine-item-${routine.id}`) as HTMLOptionElement
      expect(item.tagName).toBe('OPTION')
      expect(item.getAttribute('data-kind')).toBe('factory')
      expect(item.textContent).toContain(routine.name)
      expect(factoryGroup.contains(item)).toBe(true)
    }
    expect(within(list).queryByTestId('probe-routine-group-user')).toBeNull()
    // nothing selected yet -> the editor says so, the Run button is there and disabled
    expect(screen.getByTestId('probe-routine-editor-empty')).toBeTruthy()
    const run = screen.getByTestId('probe-routine-run') as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(screen.getByTestId('probe-routine-run-note').textContent).toBe('Check the routine first; Run appears with a clean preview.')
  })

  it('selecting the factory bore shows a read-only editor: badge, inputs, numbered steps as sentences, outputs, Duplicate to edit', () => {
    mount()
    pick('factory.bore-centre')
    expect(screen.getByTestId('probe-routine-badge').textContent).toBe('FACTORY')
    expect(screen.getByTestId('probe-routine-readonly-note').textContent).toContain('Duplicate to edit')
    expect((screen.getByTestId('probe-routine-name') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByTestId('probe-routine-name') as HTMLInputElement).value).toBe('Bore centre')
    // the declared input, with its bounds, read-only, and a value field that is not
    expect((screen.getByTestId('probe-routine-input-diameter-max') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByTestId('probe-routine-input-diameter-max') as HTMLInputElement).value).toBe('300')
    expect((screen.getByTestId('probe-routine-input-value-diameter') as HTMLInputElement).readOnly).toBe(false)
    // WO-2554: 26 seek-only steps, numbered in document order (a branch arm's step counts), each a readable sentence;
    // since WO-2065 steps 4-9 work out the heights and descend to probing depth before the walls
    expect(screen.getByTestId('probe-routine-step-9-sentence').textContent).toContain("'left' Probe toward X- up to calc.search mm")
    expect(screen.getByTestId('probe-routine-step-11-sentence').textContent).toContain("'backFromLeft' Move to X 0 (start-relative)")
    expect(screen.getByTestId('probe-routine-step-26').getAttribute('data-kind')).toBe('check')
    expect(screen.queryByTestId('probe-routine-step-27')).toBeNull()
    // no add / remove controls on a factory routine; no Save, no Delete, but Hide, Duplicate, Export
    expect(screen.queryByTestId('probe-routine-add-step')).toBeNull()
    expect(screen.queryByTestId('probe-routine-save')).toBeNull()
    expect(screen.queryByTestId('probe-routine-delete')).toBeNull()
    expect(screen.getByTestId('probe-routine-hide')).toBeTruthy()
    expect(screen.getByTestId('probe-routine-duplicate')).toBeTruthy()
    expect(screen.getByTestId('probe-routine-export')).toBeTruthy()
    // outputs
    expect((screen.getByTestId('probe-routine-output-1-axis-X') as HTMLInputElement).value).toBe('calc.centreX')
    expect((screen.getByTestId('probe-routine-output-2-item-1-expr') as HTMLInputElement).value).toBe('calc.diameterX')
    // no validation problems on a factory routine
    expect(screen.queryByTestId('probe-routine-errors')).toBeNull()
  })

  it('Check on the factory bore shows the numbered preview with real machine numbers, feeds and the proposal sentences', () => {
    mount()
    pick('factory.bore-centre')
    check()
    const preview = screen.getByTestId('probe-routine-preview')
    expect(preview.getAttribute('data-state')).toBe('ok')
    const lines = screen.getAllByTestId('probe-routine-preview-line').map((li) => li.textContent)
    expect(lines.length).toBe(26)
    // WO-2065: top = work Z0 (machine Z 25) -> safe Z 30, depth Z 20; started at Z 40 it descends straight down
    expect(lines[6]).toBe('7. descend to machine Z 20.0 at 300 mm/min, stopping if it touches anything (then it backs off 2 mm and carries on)')
    // WO-2554: seek from the start using Maximum search, then return away from the contact.
    expect(lines[8]).toBe('9. probe toward X- up to 30 mm: search 300 then 40 mm/min, back off 2 mm')
    expect(lines[10]).toBe('11. move to machine X 100.0 at 1200 mm/min')
    expect(lines[0]).toContain('1. check input.diameter / 2 > probe.tipRadiusMm')
    const proposals = screen.getAllByTestId('probe-routine-preview-proposal').map((li) => li.textContent)
    expect(proposals[0]).toContain('Would propose the active work offset (G54): X = calc.centreX, Y = calc.centreY - "Set work zero at the bore centre"; written only after you confirm.')
    expect(proposals[1]).toBe('Would report: Diameter (X) = calc.diameterX (mm); Diameter (Y) = calc.diameterY (mm).')
    // WO-2554: four seeks, four returns, initial rise branch, descent and final rise.
    expect(screen.getByTestId('probe-routine-preview-count').textContent).toBe('11 motion steps, 4 touches')
    expect(screen.getByTestId('probe-routine-sketch')).toBeTruthy()
    // still no way to run it from here
    expect((screen.getByTestId('probe-routine-run') as HTMLButtonElement).disabled).toBe(true)
    // WO-2554: a changed nominal makes Check stale but cannot move the seek or its return.
    type('probe-routine-input-value-diameter', '40')
    expect(screen.getByTestId('probe-routine-preview-stale')).toBeTruthy()
    check()
    expect(screen.queryByTestId('probe-routine-preview-stale')).toBeNull()
    expect(screen.getAllByTestId('probe-routine-preview-line')[8].textContent).toBe(lines[8])
    expect(screen.getAllByTestId('probe-routine-preview-line')[10].textContent).toBe(lines[10])
    // inches: the same step in display units
    cleanup()
    mount({ units: 'inch' })
    pick('factory.bore-centre')
    check()
    expect(screen.getAllByTestId('probe-routine-preview-line')[10].textContent).toBe('11. move to machine X 3.937 at 47.24 in/min')
  })

  it('Check against a machine the bore does not fit on lists expansion errors in plain words naming the step', () => {
    // WO-2554: a seek at the X- machine limit has no room, so Check names that touch.
    mount({ start: { x: 0, y: 100, z: 40 } })
    pick('factory.bore-centre')
    check()
    expect(screen.getByTestId('probe-routine-preview').getAttribute('data-state')).toBe('errors')
    const errors = screen.getAllByTestId('probe-routine-preview-error')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].textContent).toMatch(/^Step 9 \(touch 'left'\): /)
    expect(errors[0].textContent).toContain('no wall search is possible toward X- from the machine limit')
    expect(errors[0].getAttribute('data-code')).toBe('E_FIELD_INVALID')
  })

  it('Check without a homed machine is blocked with a sentence, never a preview', () => {
    mount({ start: null, envelopeStatus: 'not-homed' })
    pick('factory.bore-centre')
    check()
    expect(screen.getByTestId('probe-routine-preview').getAttribute('data-state')).toBe('blocked')
    expect(screen.getByTestId('probe-routine-preview-blocked').textContent).toContain('home the machine ($H) first')
    expect(screen.queryAllByTestId('probe-routine-preview-line')).toHaveLength(0)
  })

  it('Duplicate makes a user copy with a non-reserved id; editing a field shows the validation sentence inline naming the step; Save is refused until it is fixed', () => {
    mount()
    pick('factory.bore-centre')
    fireEvent.click(screen.getByTestId('probe-routine-duplicate'))
    expect(screen.getByTestId('probe-routine-badge').textContent).toBe('USER')
    const copy = useProbeRoutineStore.getState().getRoutine('user.bore-centre')
    expect(copy?.provenance.kind).toBe('user')
    expect(copy?.id.startsWith('factory.')).toBe(false)
    expect(screen.getByTestId('probe-routine-item-user.bore-centre').getAttribute('data-kind')).toBe('user')
    expect(screen.getByTestId('probe-routine-group-user').contains(screen.getByTestId('probe-routine-item-user.bore-centre'))).toBe(true)
    expect((screen.getByTestId('probe-routine-select') as HTMLSelectElement).value).toBe('user.bore-centre')
    expect((screen.getByTestId('probe-routine-name') as HTMLInputElement).readOnly).toBe(false)

    // the input declaration: max below the default -> E_INPUT_DEFAULT_OUT_OF_RANGE, inline under the input and in the summary
    type('probe-routine-input-diameter-max', '10')
    const inputErrors = screen.getByTestId('probe-routine-input-diameter-errors').textContent ?? ''
    expect(inputErrors).toMatch(/^Input 'diameter': /)
    expect(screen.getAllByTestId('probe-routine-error').some((li) => li.getAttribute('data-code') === 'E_INPUT_DEFAULT_OUT_OF_RANGE')).toBe(true)
    expect((screen.getByTestId('probe-routine-save') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('probe-routine-run') as HTMLButtonElement).disabled).toBe(true)
    type('probe-routine-input-diameter-max', '300')
    expect(screen.queryByTestId('probe-routine-input-diameter-errors')).toBeNull()

    // a calc expression with abs( -> E_EXPR_UNBOUNDED naming step 2 (calc 'search'), shown under that step
    type('probe-routine-step-2-expr', 'abs(input.diameter / 2)')
    const stepErrors = screen.getByTestId('probe-routine-step-2-errors')
    const sentence = within(stepErrors).getAllByTestId('probe-routine-step-error')[0]
    expect(sentence.getAttribute('data-code')).toBe('E_EXPR_UNBOUNDED')
    expect(sentence.textContent).toMatch(/^Step 2 \(calc 'search'\): /)
    expect(screen.getByTestId('probe-routine-step-2').className).toContain('probe-routine-step-error')
    // Check with a static error shows the same sentences, not a preview
    check()
    expect(screen.getByTestId('probe-routine-preview').getAttribute('data-state')).toBe('errors')
    expect(screen.getAllByTestId('probe-routine-preview-error')[0].textContent).toMatch(/^Step 2 \(calc 'search'\): /)
    // fix it, save it, the store has the edit
    type('probe-routine-step-2-expr', 'probe.maxTravelMm')
    expect(screen.queryByTestId('probe-routine-step-2-errors')).toBeNull()
    type('probe-routine-name', 'My bore')
    expect((screen.getByTestId('probe-routine-save') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('probe-routine-save'))
    expect(useProbeRoutineStore.getState().getRoutine('user.bore-centre')?.name).toBe('My bore')
    expect(screen.getByTestId('probe-routine-status').textContent).toContain('Saved "My bore".')
  })

  it('steps can be added, reordered and removed on a user routine, and the numbering follows', () => {
    mount()
    fireEvent.click(screen.getByTestId('probe-routine-new'))
    expect(screen.getByTestId('probe-routine-badge').textContent).toContain('USER (unsaved)')
    type('probe-routine-id-input', 'user.my-edge')
    type('probe-routine-name', 'My edge')
    fireEvent.change(screen.getByTestId('probe-routine-add-step-kind'), { target: { value: 'move' } })
    fireEvent.click(screen.getByTestId('probe-routine-add-step'))
    fireEvent.change(screen.getByTestId('probe-routine-add-step-kind'), { target: { value: 'touch' } })
    fireEvent.click(screen.getByTestId('probe-routine-add-step'))
    expect(screen.getByTestId('probe-routine-step-1').getAttribute('data-kind')).toBe('move')
    expect(screen.getByTestId('probe-routine-step-2').getAttribute('data-kind')).toBe('touch')
    fireEvent.click(screen.getByLabelText('Move step 2 up'))
    expect(screen.getByTestId('probe-routine-step-1').getAttribute('data-kind')).toBe('touch')
    fireEvent.click(screen.getByTestId('probe-routine-step-2-remove'))
    expect(screen.queryByTestId('probe-routine-step-2')).toBeNull()
    // a fresh routine with one touch validates and saves; it lands in the store as user
    fireEvent.click(screen.getByTestId('probe-routine-save'))
    expect(useProbeRoutineStore.getState().getRoutine('user.my-edge')?.provenance.kind).toBe('user')
    expect(screen.getByTestId('probe-routine-item-user.my-edge')).toBeTruthy()
    // and it can be deleted from the editor
    fireEvent.click(screen.getByTestId('probe-routine-delete'))
    expect(useProbeRoutineStore.getState().getRoutine('user.my-edge')).toBeNull()
    expect(screen.queryByTestId('probe-routine-item-user.my-edge')).toBeNull()
  })

  it('Hide removes a factory routine from use and Restore factory routines brings it back without touching user routines', () => {
    act(() => { useProbeRoutineStore.getState().saveRoutine({ ...FACTORY_BORE_CENTRE, id: 'user.keep-me', name: 'Keep me', provenance: { kind: 'user' } }) })
    mount()
    pick('factory.edge.x-minus')
    fireEvent.click(screen.getByTestId('probe-routine-hide'))
    expect(useProbeRoutineStore.getState().hidden).toEqual(['factory.edge.x-minus'])
    expect(screen.getByTestId('probe-routine-item-factory.edge.x-minus').className).toContain('probe-routine-item-hidden')
    expect(screen.getByTestId('probe-routine-item-factory.edge.x-minus').textContent).toContain('(hidden)')
    expect(useProbeRoutineStore.getState().listRoutines().some((e) => e.routine.id === 'factory.edge.x-minus')).toBe(false)
    fireEvent.click(screen.getByTestId('probe-routine-restore'))
    expect(useProbeRoutineStore.getState().hidden).toEqual([])
    expect(screen.getByTestId('probe-routine-item-factory.edge.x-minus').className).not.toContain('probe-routine-item-hidden')
    expect(useProbeRoutineStore.getState().getRoutine('user.keep-me')?.name).toBe('Keep me')
  })

  it('Export hands the library file to the browser and Import brings it back as an imported routine that shows its reviewed-once state', async () => {
    const blobs: Blob[] = []
    const createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:probe-routines' })
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    mount()
    pick('factory.bore-centre')
    fireEvent.click(screen.getByTestId('probe-routine-export'))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clicks).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('probe-routine-status').textContent).toContain('Exported "Bore centre" as bore-centre.liencam-probe.json')
    const text = await blobs[0].text()
    const parsed = JSON.parse(text) as { format: string; routines: ProbeRoutine[] }
    expect(parsed.format).toBe('liencam-probe-routines')
    expect(parsed.routines[0].id).toBe('factory.bore-centre')

    // import the same text through the file input (the round trip the store owns)
    const file = new File([text], 'shop.liencam-probe.json', { type: 'application/json' })
    const input = screen.getByTestId('probe-routine-import-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    const report = screen.getByTestId('probe-routine-import-report')
    expect(report.textContent).toContain('Accepted: "Bore centre" (imported.bore-centre)')
    expect(report.textContent).toContain("'factory.bore-centre'")
    const imported = useProbeRoutineStore.getState().getRoutine('imported.bore-centre')
    expect(imported?.provenance.kind).toBe('imported')
    expect(imported?.provenance.importedFrom).toBe('shop.liencam-probe.json')
    // the dropdown shows it under Imported, not yet reviewed; the single accepted routine is selected
    expect(screen.getByTestId('probe-routine-group-imported').contains(screen.getByTestId('probe-routine-item-imported.bore-centre'))).toBe(true)
    expect(screen.getByTestId('probe-routine-item-imported.bore-centre').textContent).toContain('not yet reviewed')
    expect(screen.getByTestId('probe-routine-reviewed-imported.bore-centre').textContent).toBe('not yet reviewed')
    expect(screen.getByTestId('probe-routine-badge').textContent).toBe('IMPORTED')
    // Check on the stored (unedited) imported routine records the review for that exact preview.
    // WO-2065: an imported copy keeps its own top default (machine Z 0, below this table), so the
    // operator types the hole's top first, as he would for any routine that is not the factory one.
    type('probe-routine-input-value-topZ', '25')
    check()
    expect(screen.getByTestId('probe-routine-preview').getAttribute('data-state')).toBe('ok')
    const hash = useProbeRoutineStore.getState().getRoutine('imported.bore-centre')?.provenance.reviewedHash
    expect(typeof hash).toBe('string')
    expect(screen.getByTestId('probe-routine-reviewed-imported.bore-centre').textContent).toBe('reviewed once')
    expect(screen.getByTestId('probe-routine-item-imported.bore-centre').textContent).toContain('reviewed once')
    expect(useProbeRoutineStore.getState().isReviewed('imported.bore-centre', hash!)).toBe(true)
    // editing an imported routine and saving turns it into a user routine (review dropped)
    type('probe-routine-name', 'Shop bore')
    fireEvent.click(screen.getByTestId('probe-routine-save'))
    expect(useProbeRoutineStore.getState().getRoutine('imported.bore-centre')?.provenance.kind).toBe('user')
  })

  it('a whole-file refusal (newer format) reads as a sentence in the import report and stores nothing', async () => {
    mount()
    const newer = JSON.stringify({ ...JSON.parse(exportRoutines([FACTORY_BORE_CENTRE])), schemaVersion: 2 })
    const input = screen.getByTestId('probe-routine-import-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([newer], 'newer.liencam-probe.json')] } })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.getByTestId('probe-routine-import-report').textContent).toContain('Import refused')
    expect(screen.getByTestId('probe-routine-import-report').textContent).toContain('newer LienCAM')
    expect(Object.keys(useProbeRoutineStore.getState().routines)).toEqual([])
  })

  it('a stored routine with an unknown step kind is listed as quarantined with its reason, and can be deleted', () => {
    const broken = { ...FACTORY_BORE_CENTRE, id: 'user.broken', name: 'Broken', provenance: { kind: 'user' }, steps: [{ kind: 'gcode', line: 'G0 X0' }] }
    act(() => {
      useProbeRoutineStore.setState({
        routines: {},
        hidden: [],
        quarantined: { 'user.broken': { json: broken, errors: ["Step 1 (gcode): 'gcode' is not a step kind this version knows (move, touch, calc, check, branch)."] } },
      })
    })
    mount()
    const item = screen.getByTestId('probe-routine-quarantined-user.broken')
    expect(item.textContent).toContain('Broken')
    expect(item.textContent).toContain('QUARANTINED')
    expect(item.textContent).toContain("Step 1 (gcode): 'gcode' is not a step kind")
    fireEvent.click(screen.getByTestId('probe-routine-quarantined-delete-user.broken'))
    expect(useProbeRoutineStore.getState().quarantined).toEqual({})
    expect(screen.queryByTestId('probe-routine-quarantined-user.broken')).toBeNull()
  })

  it('the Source view shows the routine JSON read-only', () => {
    mount()
    pick('factory.boss-centre')
    fireEvent.click(screen.getByTestId('probe-routine-source-toggle'))
    const source = screen.getByTestId('probe-routine-source')
    expect(source.tagName).toBe('PRE')
    expect(source.textContent).toContain('"id": "factory.boss-centre"')
    expect(screen.queryByTestId('probe-routine-steps')).toBeNull()
    fireEvent.click(screen.getByTestId('probe-routine-source-toggle'))
    expect(screen.getByTestId('probe-routine-steps')).toBeTruthy()
  })
})
