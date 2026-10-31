// WO-3221 (WO-3176 Brief B): the posted setup sheet names a tab removal
// contour - which tabbed contour it cuts the tabs from, how many, and how the
// setup says the part is held once they go - and post keeps the operator's own
// action order between the source and the cleanup. The plan is authored
// through the store actions the panels call, posted by postProject and written
// by the same sheet builder the Post dialog uses.

import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { MachineAction, Operation, Project, Setup } from '../../types'
import type { ContourTabRemovalSource } from '../../lib/cam/types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  loadCachedStepDisplay: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { resetDocumentHolder } = await import('../../doc/documentHolder')
const { buildSetupSheetData, renderSetupSheetText } = await import('../../lib/post/setupSheet')
const { postProject } = await import('../../lib/post/postProject')
const { UCCNC_CONFIG } = await import('../../lib/post/dialects/uccnc')
const { stockWorldBounds } = await import('../../store/stockAssignment')
const { makeOp: baseOp, makeStock, makeTool, makeWcs, move, stampGenerationCurrent } = await import('./helpers')
const { smartHeightAuthorityFixture } = await import('../helpers/smartHeightAuthorityFixture')

const state = () => useCamStore.getState()

function makeOp(overrides: Parameters<typeof baseOp>[0]) {
  const op = baseOp(overrides)
  op.smartHeight = smartHeightAuthorityFixture(op.type, { heights: op.heights })
  return op
}

const cut = (x: number) => [move({ type: 'rapid', x, y: 10, z: 5 }), move({ x: x + 20, y: 30, z: -1 })]

const BINDING: ContourTabRemovalSource = {
  version: 1, sourceSetupId: 's1', sourceOperationId: 'outline', sourceIdentity: 'tabsrc-v1-0123456789abcdef',
  loopIds: ['loop-a'],
  targets: [0, 1, 2, 3].map((k) => ({
    loopId: 'loop-a', label: `loop-a#${k}`, center: { x: 10 * k, y: 0 }, width: 8, height: 1.5, shape: 'box' as const,
  })),
}

interface Plan {
  holdingMethod?: Setup['holdingMethod']
  /** An operator stop the operator authored right after the source. */
  stopAfterSource?: boolean
  /** Change the source's tabs after both were generated. */
  editSourceAfter?: boolean
  withCleanup?: boolean
}

/** Author source + cleanup through the store, stamp both current, post, write the sheet. */
async function postPlan(plan: Plan = {}, selected?: string[]) {
  resetDocumentHolder()
  state().newProject()
  const tool = makeTool()
  state().addTool(tool)
  state().addSetup({ id: 's1', name: 'Top', wcs: makeWcs({ id: 'wcs-s1', label: 'G54', fixtureOffset: 54 }),
    stock: makeStock(), notes: '', operations: [] } as Setup)
  if (plan.holdingMethod) state().updateSetup('s1', { holdingMethod: plan.holdingMethod })
  state().addOperation('s1', makeOp({
    id: 'outline', name: 'Cut out', type: 'contour_2d', toolId: tool.id, toolpathMoves: cut(10),
    params: { side: 'outer', direction: 'climb', geometryId: 'g', loopIds: ['loop-a'], tabs: true, tabCount: 4, tabWidth: 8, tabHeight: 1.5 },
  }))
  if (plan.withCleanup !== false) {
    state().addOperation('s1', makeOp({
      id: 'cleanup', name: 'Cut out - tab removal', type: 'contour_2d', toolId: tool.id, toolpathMoves: cut(60),
      params: { side: 'outer', direction: 'climb', geometryId: 'g', loopIds: ['loop-a'], tabs: false, tabRemovalSource: BINDING },
    }))
  }
  if (plan.stopAfterSource) {
    const id = state().addMachineAction('s1', 'operator_stop')
    state().updateMachineAction('s1', id, { name: 'Screw down', message: 'Screw the part down before the tabs go' } as Partial<MachineAction>)
    state().moveSetupListItem('s1', id, 'cleanup')
  }

  const project = structuredClone({ ...state().project, toolLibrary: state().toolLibrary }) as Project
  const setup = project.setups.find((s) => s.id === 's1')!
  for (const op of setup.operations) {
    op.status = 'ready'
    stampGenerationCurrent(project, setup, op, project.toolLibrary.find((t) => t.id === op.toolId)!)
  }
  if (plan.editSourceAfter) {
    const source = setup.operations.find((op) => op.id === 'outline')! as Operation
    source.params = { ...source.params, tabCount: 3 }
  }
  const posted = postProject(project, [setup], UCCNC_CONFIG, {
    mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc',
    ...(selected ? { selectedOpIds: { s1: selected } } : {}),
  })
  if (!posted.ok) return { project, posted }
  const sheet = await buildSetupSheetData(project, [setup], UCCNC_CONFIG, posted.combined!, 'part.nc', stockWorldBounds,
    selected ? { s1: selected } : undefined)
  return { project, posted, sheet, text: renderSetupSheetText(sheet) }
}

describe('WO-3221 setup sheet: the tab removal contour', () => {
  it('names the source by its number, every tab removed, and the holding method', async () => {
    const { sheet } = await postPlan({ holdingMethod: 'screws' })
    const lines = sheet!.lines
    const heading = lines.indexOf('  Workholding:')
    const firstOp = lines.indexOf('1. "Cut out"')
    expect(heading).toBeGreaterThan(-1)
    expect(lines.slice(heading, firstOp).filter(Boolean)).toEqual([
      '  Workholding:',
      '    Method: Screws',
      '    Tabs, operation 1 "Cut out": 4 tabs per contour, 8mm wide x 1.5mm high, box',
      '    Tab removal, operation 2 "Cut out - tab removal": removes all 4 tabs of operation 1 "Cut out" on 1 contour, tabs off; holding method Screws',
    ])
    expect(lines).toContain('2. "Cut out - tab removal"')
  })

  it('says when no holding method is chosen; claims none', async () => {
    const { text } = await postPlan({})
    expect(text).toContain(
      '    Tab removal, operation 2 "Cut out - tab removal": removes all 4 tabs of operation 1 "Cut out" on 1 contour, tabs off; no holding method chosen')
  })

  it('posting only the cleanup names its source by name', async () => {
    const { text } = await postPlan({ holdingMethod: 'tape_glue' }, ['cleanup'])
    expect(text).toContain(
      '    Tab removal, operation 1 "Cut out - tab removal": removes all 4 tabs of "Cut out" on 1 contour, tabs off; holding method Tape and glue')
  })

  it('posts the operator\'s own stop between the source and the cleanup, in list order, and adds none of its own', async () => {
    const withStop = await postPlan({ holdingMethod: 'screws', stopAfterSource: true })
    expect(withStop.posted.ok, JSON.stringify(withStop.posted.diagnostics)).toBe(true)
    const gcode = withStop.posted.combined!.gcode.split('\n')
    const spans = withStop.posted.combined!.operationSpans!
    const sourceEnd = Math.max(...spans.filter((s) => s.opId === 'outline').map((s) => s.endLine))
    const cleanupStart = Math.min(...spans.filter((s) => s.opId === 'cleanup').map((s) => s.startLine))
    const stopLine = gcode.findIndex((line) => line.includes('Screw the part down before the tabs go')) + 1
    expect(stopLine).toBeGreaterThan(sourceEnd)
    expect(stopLine).toBeLessThan(cleanupStart)
    const without = await postPlan({ holdingMethod: 'screws' })
    expect(without.posted.ok).toBe(true)
    // Program stops and the dialect's operator-stop macro (UCCNC: M2001).
    const m0 = (text: string) => text.split('\n').filter((line) => /^(N\d+\s+)?(M0?0|M0?1|M2001)\b/.test(line.trim())).length
    expect(m0(without.posted.combined!.gcode)).toBe(0)
    expect(m0(withStop.posted.combined!.gcode)).toBeGreaterThan(0)
  })

  it('a source changed after the cleanup was generated: the cleanup is not posted', async () => {
    const { posted } = await postPlan({ editSourceAfter: true })
    expect(posted.ok).toBe(false)
    expect(JSON.stringify(posted.diagnostics)).toContain('cleanup')
  })

  it('a project without a tab removal contour prints no removal row', async () => {
    const { text } = await postPlan({ holdingMethod: 'screws', withCleanup: false })
    expect(text).not.toContain('Tab removal')
  })
})
