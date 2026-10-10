// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CommandHistory, FeatureDag } from '../../doc'
import { useFormSession, type FormSessionDeps } from '../../components/model3d/form/useFormSession'
import { WorkbenchToolRail, type RailSection } from '../../components/model3d/workbench/WorkbenchToolRail'
import { useFormStore } from '../../form/formStore'
import { boxCage } from '../../form/starters'
import { readPref } from '../../components/common/useToolPaletteLayout'

const st = useFormStore.getState
let overflowing = true
let deps: FormSessionDeps
function Rail({ sections }: { sections?: RailSection[] }) {
  const session = useFormSession(deps)
  return <WorkbenchToolRail sketchActive={false} modelingSections={sections ?? session.railSections} sketchHistoryTools={[]} onFinishSketch={() => {}} />
}
const header = () => screen.getByTestId('workbench-rail-collapse-form-create')
const open = () => expect(header().getAttribute('aria-expanded')).toBe('true')
const folded = () => expect(header().getAttribute('aria-expanded')).toBe('false')
const edit = () => act(() => { st().beginDrag(); st().endDrag() })
const pref = () => readPref('liencam.rail.collapsed')

beforeEach(() => {
  window.localStorage.clear()
  overflowing = true
  const dag = new FeatureDag()
  deps = { runtime: null, canvasRef: { current: null }, dag, history: new CommandHistory(dag), onApplied: vi.fn(), showBody: vi.fn() }
  st().openSession({ featureId: null, name: 'New', cage: boxCage() })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => overflowing ? 1052 : 800)
})
afterEach(() => { cleanup(); st().closeSession(); vi.restoreAllMocks() })

describe('WO-2503 Start-from folds only after an edit on an overflowing rail', () => {
  it('folds after the first edit without saving a preference, leaves all other groups open', () => {
    render(<Rail />); open()
    const before = pref()
    edit(); folded()
    expect(pref()).toEqual(before)
    for (const id of ['form-symmetry', 'form-display']) expect(screen.getByTestId(`workbench-rail-collapse-${id}`).getAttribute('aria-expanded')).toBe('true')
  })

  it('measures the inner scrollport, even when the clipping aside reports no overflow', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('panel-body') ? 1052 : 800
    })
    render(<Rail />); edit(); folded()
  })

  it('a fitting rail stays open; resize alone does nothing, the next edit remeasures', () => {
    overflowing = false
    const view = render(<Rail />)
    edit(); open()
    overflowing = true
    fireEvent(window, new Event('resize'))
    view.rerender(<Rail />); open()
    act(() => st().setDisplayMode('cage')); open()
    edit(); folded()
  })

  it('a header click reopens in one click and wins over more edits, undo/redo and resize', () => {
    render(<Rail />); edit(); folded()
    fireEvent.click(header()); open()
    expect(pref()).toEqual([])
    edit(); open()
    act(() => { st().undo(); st().redo() }); open()
    overflowing = false; fireEvent(window, new Event('resize')); open()
    overflowing = true; edit(); open()
  })

  it.each(['fold', 'unfold'] as const)('manual %s before any edit always wins and is saved', (choice) => {
    render(<Rail />)
    fireEvent.click(header())
    if (choice === 'unfold') fireEvent.click(header())
    edit()
    if (choice === 'fold') { folded(); expect(pref()).toEqual(['form-create']) }
    else { open(); expect(pref()).toEqual([]) }
  })

  it('new sessions reset the automatic fold even with openSession while already active', () => {
    render(<Rail />); edit(); folded()
    act(() => st().openSession({ featureId: 'FRM1', name: 'Existing', cage: boxCage() })); open()
    edit(); folded()
    act(() => { st().closeSession(); st().openSession({ featureId: null, name: 'Next' }) }); open()
    expect(pref()).toBeUndefined()
  })

  it('a remembered manual fold survives new sessions and is not treated as an automatic fold', () => {
    render(<Rail />); fireEvent.click(header()); folded()
    act(() => st().openSession({ featureId: null, name: 'Next' })); folded()
    fireEvent.click(header()); open(); edit(); open()
  })

  it('keeps the one automatic fold and manual choice if the rail remounts in the same session', () => {
    render(<Rail />); edit(); folded()
    cleanup(); render(<Rail />); folded()
    fireEvent.click(header()); open()
    cleanup(); render(<Rail />); edit(); open()
  })

  it.each(['box', 'cylinder', 'sphere', 'torus', 'plane', 'pipe', 'extrude', 'revolve'] as const)('Start-from %s adds history without folding; the next recorded edit folds', (kind) => {
    render(<Rail />)
    fireEvent.click(screen.getByTestId(`form-starter-${kind}`)); open()
    expect(st().history.past).toHaveLength(1)
    expect(st().editVersion).toBe(0)
    edit(); folded()
  })

  it('Face replacement is creation; adding the following face is an edit', () => {
    render(<Rail />)
    fireEvent.click(screen.getByTestId('form-starter-face'))
    act(() => { for (const [x, y] of [[0, 0], [10, 0], [10, 10], [0, 10]]) st().addFaceClick({ at: [x, y, 0] }) })
    expect(st().history.past).toHaveLength(1); open()
    act(() => { for (const [x, y] of [[20, 0], [30, 0], [30, 10], [20, 10]]) st().addFaceClick({ at: [x, y, 0] }) })
    expect(st().history.past).toHaveLength(2); folded()
  })

  it('async From body adds history without folding', async () => {
    deps.selectedBodyMesh = async () => ({ featureId: 'B1', mesh: {
      position: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], index: [0, 1, 2, 0, 2, 3], triFace: [0, 0],
    } })
    render(<Rail />)
    fireEvent.click(screen.getByTestId('form-starter-body'))
    await waitFor(() => expect(st().startedFrom).toBe('body'))
    expect(st().history.past).toHaveLength(1); open()
    edit(); folded()
  })

  it('multi-profile Loft adds history without folding under the next-profile button', () => {
    let profile = 0
    const pts = [[0, 0], [10, 0], [10, 10], [0, 10]]
    deps.selectedSketch = () => ({ name: `Sketch ${profile}`, frame: { origin: { x: 0, y: 0, z: profile * 10 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
      entities: pts.map(([x, y], i) => ({ id: `l${i}`, kind: 'line', construction: false, start: { x, y }, end: { x: pts[(i + 1) % 4][0], y: pts[(i + 1) % 4][1] } })),
    })
    render(<Rail />)
    fireEvent.click(screen.getByTestId('form-starter-loft'))
    profile++
    fireEvent.click(screen.getByTestId('form-starter-loft'))
    expect(st().startedFrom).toBe('loft')
    expect(st().history.past).toHaveLength(1); open()
    profile++
    fireEvent.click(screen.getByTestId('form-starter-loft'))
    expect(st().history.past).toHaveLength(2); open()
    edit(); folded()
  })

  it('recorded topology changes fold; unrecorded updates and non-cage choices do not', () => {
    render(<Rail />)
    act(() => { st().setSymmetry('x'); st().setTransformMode('rotate'); st().setName('Renamed'); st().setSelection({ points: [], edges: [], faces: [0] }); st().applyCage(st().cage, { topology: false, record: false }) }); open()
    act(() => st().subdivideSelection()); folded()
  })

  it('still detects an edit at the undo history limit', () => {
    overflowing = false
    render(<Rail />)
    for (let i = 0; i < 200; i++) edit()
    expect(st().history.past).toHaveLength(200); open()
    overflowing = true; edit()
    expect(st().history.past).toHaveLength(200); folded()
  })

  it('does not fold another tools rail while Form store changes', () => {
    const { rerender } = render(<Rail />)
    const other: RailSection[] = [{ id: 'relief-create', title: 'Relief', tools: [] }]
    rerender(<Rail sections={other} />)
    edit()
    expect(screen.getByTestId('workbench-rail-collapse-relief-create').getAttribute('aria-expanded')).toBe('true')
    expect(pref()).toBeUndefined()
  })
})
