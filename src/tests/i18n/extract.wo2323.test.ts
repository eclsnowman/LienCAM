// @vitest-environment jsdom
// Record with WO2323_RECORD=1 against main BEFORE extraction. The same real
// components and production stores are used for both sides of the comparison.
import { createElement as h } from 'react'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react'
import { makeMachine, makeTool, makeOp, makeStock, makeWcs, stampGenerationCurrent } from '../post/helpers'
import type { ImportedGeometry, Project, Setup } from '../../types'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { TOOL_TYPE_ORDER } from '../../lib/tool/toolMeta'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size }, clear: () => mem.clear(),
  getItem: (k: string) => mem.get(k) ?? null, key: (i: number) => [...mem.keys()][i] ?? null,
  removeItem: (k: string) => { mem.delete(k) }, setItem: (k: string, v: string) => { mem.set(k, String(v)) },
} })

const { useCamStore } = await import('../../store')
const { SetupModal } = await import('../../components/modals/SetupModal')
const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const { MachineChoiceModal } = await import('../../components/modals/MachineChoiceModal')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { MakeViseForm, ViseProperties } = await import('../../components/workholding/ViseEditor')
const { MakeClampButton, ClampPlacerPanel, ClampProperties, ClampTreeGroup, useClampUi } = await import('../../components/workholding/ClampEditor')
const { PlaceAnotherButton, ExportWorkholdingButton } = await import('../../components/workholding/WorkholdingReuse')
const { workholdingOfGeometry } = await import('../../lib/workholding/vise')

// WO-2437 adds operatorStopMacro to the post config hashed in LCX1 intent.
// The control retains the original snapshot and removes only that added input.
const historicalPost = process.env.WO2621_PRE2437 === '1'
const fixture = historicalPost
  ? 'src/tests/evidence/WO-2323/english-main.json'
  : 'src/tests/evidence/WO-2621/english-current.json'
const operatorStopMacro = UCCNC_CONFIG.options.operatorStopMacro
if (historicalPost) delete UCCNC_CONFIG.options.operatorStopMacro
const attributes = ['title', 'aria-label', 'placeholder', 'alt', 'aria-description', 'data-tooltip']
function english() {
  return {
    text: document.body.textContent,
    attributes: [...document.body.querySelectorAll('*')].flatMap((el) => attributes.flatMap((name) => {
      const value = el.getAttribute(name)
      return value === null ? [] : [`${name}=${value}`]
    })),
  }
}
function body(id: string, name: string, y: number): ImportedGeometry {
  return { id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl', loaded: true, workholding: true,
    position: { x: 0, y, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: -50, y: -10, z: 0 }, max: { x: 50, y: 10, z: 40 },
      size: { x: 100, y: 20, z: 40 }, center: { x: 0, y: 0, z: 20 } },
  } as ImportedGeometry
}
afterEach(() => {
  cleanup(); vi.restoreAllMocks()
  UCCNC_CONFIG.options.operatorStopMacro = operatorStopMacro
})

describe('WO-2323: rendered English equals main', () => {
  it('matches every owned dialog and workholding surface through production stores', async () => {
    // Program-context comments legitimately contain time and project identity.
    // Fix those inputs instead of stripping any generated output from evidence.
    vi.spyOn(Date, 'now').mockReturnValue(1791000000000)
    const actual: Record<string, ReturnType<typeof english>> = {}
    const capture = (name: string) => {
      expect(document.body.textContent?.length, `${name} renders a real surface`).toBeGreaterThan(0)
      actual[name] = english()
    }
    const state = () => useCamStore.getState()
    act(() => {
      state().newProject()
      const tool = makeTool()
      const op = makeOp()
      const setup = { id: 'setup-a', name: 'Setup A', wcs: makeWcs(), stock: makeStock(), operations: [op], notes: '' } as Setup
      const project = { ...state().project, id: 'snapshot-project', name: 'Snapshot project', machine: makeMachine(), setups: [setup], activeSetupId: setup.id }
      stampGenerationCurrent({ ...project, toolLibrary: [tool] } as Project, setup, op, tool)
      useCamStore.setState({ project, toolLibrary: [tool], machineLibrary: [makeMachine(), makeMachine({ id: 'm2', name: 'Second machine' })],
        appSettings: { ...state().appSettings, displayUnits: 'mm', defaultMachineId: 'm1' }, editingSetupId: null, activeModal: null })
      state().addFixedStock({ id: 'stock-a', name: 'Plate', width: 100, height: 60, depth: 20, position: { x: 0, y: 0, z: 0 } })
    })
    render(h(SetupModal))
    act(() => { state().openModal('new-setup') })
    capture('setup/new/corner')
    fireEvent.click(screen.getByRole('button', { name: 'Add fixture layer' }))
    capture('setup/fixture-stack')
    for (const tab of ['Snap', 'Manual', 'Circular Center']) {
      fireEvent.click(screen.getByRole('button', { name: tab }))
      capture(`setup/new/${tab}`)
    }
    cleanup()
    act(() => { useCamStore.setState({ activeModal: 'edit-setup', editingSetupId: 'setup-a' }) })
    render(h(SetupModal))
    capture('setup/edit')
    cleanup()
    act(() => { state().openModal('tool-library') })
    render(h(ToolLibraryModal))
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    capture('tools/general')
    for (const tab of ['Cutter', 'Cutting Data', 'Post']) {
      fireEvent.click(screen.getByRole('button', { name: tab }))
      capture(`tools/${tab}`)
      if (tab === 'Cutting Data') {
        fireEvent.click(screen.getByRole('button', { name: '? Material guide' }))
        capture('tools/material-guide')
      }
    }
    fireEvent.click(screen.getByTestId('tool-view-holders'))
    capture('holders/empty')
    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    capture('holders/editor')
    cleanup()
    for (const type of TOOL_TYPE_ORDER) {
      act(() => { useCamStore.setState({ toolLibrary: [makeTool({ type, angleFromAxisDeg: 59 })] }) })
      render(h(ToolLibraryModal))
      fireEvent.click(screen.getByRole('button', { name: 'Cutter' }))
      capture(`tools/type/${type}`)
      const angleHelp = screen.queryByRole('button', { name: 'Tool angle help' })
      if (angleHelp) {
        fireEvent.click(angleHelp)
        capture(`tools/angle-help/${type}`)
      }
      cleanup()
    }
    act(() => { useCamStore.setState({ toolLibrary: [makeTool()] }) })
    act(() => { state().openModal('machine-config') })
    render(h(MachineLibraryModal))
    capture('machines/editor')
    for (const button of [...document.querySelectorAll<HTMLElement>('.machine-modal .disclosure-header')]) {
      if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button)
    }
    capture('machines/expanded')
    fireEvent.click(screen.getByRole('button', { name: 'Examples' }))
    capture('machines/examples')
    cleanup()
    act(() => { state().setMachineChoiceRequired(true) })
    render(h(MachineChoiceModal))
    capture('machines/choice')
    cleanup()
    act(() => {
      // Earlier stock/tool edits deliberately exercise the production stores.
      // Stamp their final inputs so the ordinary full-preview route is live.
      const setup = state().project.setups[0]
      const op = { ...setup.operations[0], status: 'ready' as const }
      const currentSetup = { ...setup, operations: [op] }
      const project = { ...state().project, setups: [currentSetup] }
      stampGenerationCurrent({ ...project, toolLibrary: state().toolLibrary }, currentSetup, op, state().toolLibrary[0])
      useCamStore.setState({ project })
      state().openModal('post-process')
    })
    render(h(PostProcessModal))
    capture('post/properties')
    for (const tab of ['Preview', 'About this post']) {
      fireEvent.click(screen.getByRole('button', { name: tab }))
      capture(`post/${tab}`)
      if (tab === 'Preview') {
        fireEvent.contextMenu(screen.getByTestId('post-gcode-preview'), { clientX: 100, clientY: 100 })
        capture('post/context-menu')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Open full preview' }))
        capture('post/full-preview')
        fireEvent.click(document.querySelector('.gcode-flyout-close')!)
      }
    }
    cleanup()
    act(() => { state().addGeometry(body('fixed', 'Fixed body', 0)) })
    render(h(MakeViseForm, { fixedGeo: state().project.geometry[0], onDone: () => {} }))
    capture('vise/no-jaw')
    cleanup()
    act(() => { state().addGeometry(body('jaw', 'Moving jaw', 50)) })
    render(h(MakeViseForm, { fixedGeo: state().project.geometry[0], onDone: () => {} }))
    capture('vise/make')
    cleanup()
    let viseId = ''
    act(() => { viseId = state().makeVise({ name: 'Bench vise', fixedGeometryId: 'fixed', jawGeometryId: 'jaw',
      slide: { kind: 'jaw-axis', axis: 'y' }, minMm: 0, maxMm: 100, setupId: 'setup-a' })! })
    const membership = workholdingOfGeometry(state().project.workholding, 'fixed')!
    render(h(ViseProperties, { membership }))
    capture('vise/properties')
    cleanup()
    render(h(PlaceAnotherButton, { instanceId: viseId }))
    render(h(ExportWorkholdingButton, { instanceId: viseId, testId: 'export' }))
    capture('workholding/reuse')
    cleanup()
    act(() => { state().addGeometry(body('clamp', 'Strap clamp', 100)) })
    render(h(MakeClampButton, { geo: state().project.geometry.find(g => g.id === 'clamp')! }))
    capture('clamp/make')
    fireEvent.click(screen.getByRole('button', { name: 'Make clamp' }))
    cleanup()
    render(h(ClampPlacerPanel))
    capture('clamp/placer')
    cleanup()
    const definitionId = useClampUi.getState().placing!.definitionId
    let clampId = ''
    act(() => { clampId = state().placeClamp({ definitionId, target: { kind: 'stock', id: 'stock-a', loopId: 'outline' }, fraction: 0.25, setupId: 'setup-a' })! })
    render(h(ClampProperties, { instanceId: clampId }))
    capture('clamp/properties')
    cleanup()
    render(h(ClampTreeGroup))
    capture('clamp/tree')
    if (process.env.WO2621_CAPTURE === '1') writeFileSync(`src/tests/evidence/WO-2621/english-${historicalPost ? 'pre2437' : 'current'}.json`, `${JSON.stringify(actual, null, 2)}\n`)
    if (process.env.WO2323_RECORD === '1') writeFileSync(fixture, `${JSON.stringify(actual, null, 2)}\n`)
    const main = JSON.parse(readFileSync(fixture, 'utf8'))
    if (historicalPost) {
      // WO-2591 hides the redundant UCCNC M0-after-M6 control.
      expect(main['post/properties'].text).toContain('Pause (M0) after tool change')
      main['post/properties'].text = main['post/properties'].text.replace('Pause (M0) after tool change', '')
    }
    expect(actual).toEqual(main)
    expect(Object.keys(actual).length).toBeGreaterThanOrEqual(20)
  }, 120000)
})


