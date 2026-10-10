// WO-2439: the job sheet says how the part is held. The plan is authored
// through the store actions the app's panels call (updateSetup for the WO-2438
// method and note, addWorkholdingDefinition/addWorkholdingInstance for a clamp,
// a contour with tabs), then posted by postProject and written by the same
// sheet builder and PDF writer the Post dialog uses.

import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { Project, Setup } from '../../types'

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
const { buildSetupSheetPdf } = await import('../../lib/post/setupSheetPdf')
const { postProject } = await import('../../lib/post/postProject')
const { UCCNC_CONFIG } = await import('../../lib/post/dialects/uccnc')
const { stockWorldBounds } = await import('../../store/stockAssignment')
const { makeOp: baseOp, makeStock, makeTool, makeWcs, move, stampGenerationCurrent } = await import('./helpers')
const { smartHeightAuthorityFixture } = await import('../helpers/smartHeightAuthorityFixture')
const { stripOperationForPersistence } = await import('../../store/persistenceRegistry')

const state = () => useCamStore.getState()

/** The PDF's logical text (ActualText), as the WO-2293 test reads it. */
function pdfText(bytes: Uint8Array): string[] {
  const source = new TextDecoder().decode(bytes)
  return Array.from(source.matchAll(/\/ActualText <feff([0-9a-f]*)>/g), (m) => {
    return Array.from(m[1].matchAll(/.{4}/g), (c) => String.fromCharCode(parseInt(c[0], 16))).join('')
  }).filter(Boolean)
}

function blankSetup(id: string, name: string, offset: number): Setup {
  const wcs = makeWcs({ id: `wcs-${id}`, label: `G${offset}`, fixtureOffset: offset })
  return { id, name, wcs, stock: makeStock(), notes: '', operations: [] } as Setup
}

/** An operation the store accepts: it carries its Smart Height authority. */
function makeOp(overrides: Parameters<typeof baseOp>[0]) {
  const op = baseOp(overrides)
  op.smartHeight = smartHeightAuthorityFixture(op.type, { heights: op.heights })
  return op
}

const cut = (x: number) => [move({ type: 'rapid', x, y: 10, z: 5 }), move({ x: x + 20, y: 30, z: -1 })]

/** Author the plan through the store, then post it the way the Post dialog does. */
export async function authoredSheet() {
  resetDocumentHolder()
  state().newProject()
  const tool = makeTool()
  state().addTool(tool)
  state().addSetup(blankSetup('s1', 'Top', 54))
  state().addSetup(blankSetup('s2', 'Bottom', 55))
  state().updateSetup('s1', {
    holdingMethod: 'clamps',
    notes: 'Masking tape on spoilboard and stock\nSuperglue the tape faces together',
  })
  state().addWorkholdingDefinition({
    id: 'def-clamp', revision: 1, name: 'Strap clamp', kind: 'clamp',
    components: [{ id: 'c1', name: 'Strap', geometryId: 'g-strap', localPose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } } }],
  })
  for (const id of ['clamp-a', 'clamp-b']) {
    state().addWorkholdingInstance({
      id, definitionId: 'def-clamp', definitionRevision: 1,
      setupScope: { kind: 'setups', setupIds: ['s1'] },
      worldPose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      jointValuesMm: {},
    })
  }
  state().addOperation('s1', makeOp({ id: 'rough', name: 'Rough pocket', type: 'pocket_2d', toolId: tool.id, toolpathMoves: cut(10) }))
  state().addOperation('s1', makeOp({
    id: 'outline', name: 'Cut out', type: 'contour_2d', toolId: tool.id, toolpathMoves: cut(60),
    params: { side: 'outer', direction: 'climb', geometryId: 'g', loopIds: [], tabs: true, tabCount: 6, tabWidth: 10, tabHeight: 1.5, tabShape: 'triangular' },
  }))
  // The second setup has a contour too, but without tabs: nothing to say.
  state().addOperation('s2', makeOp({
    id: 'face', name: 'Face back', type: 'contour_2d', toolId: tool.id, toolpathMoves: cut(110),
    params: { side: 'outer', direction: 'climb', geometryId: 'g', loopIds: [], tabs: false, tabCount: 4 },
  }))

  // As the Post dialog does: the store's tool library rides with the project.
  const project = structuredClone({ ...state().project, toolLibrary: state().toolLibrary }) as Project
  for (const setup of project.setups) {
    for (const op of setup.operations) {
      op.status = 'ready'
      stampGenerationCurrent(project, setup, op, project.toolLibrary.find((t) => t.id === op.toolId)!)
    }
  }
  const setups = project.setups.filter((s) => s.id === 's1' || s.id === 's2')
  const posted = postProject(project, setups, UCCNC_CONFIG, { mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc' })
  expect(posted.ok, JSON.stringify(posted.diagnostics)).toBe(true)
  const result = posted.combined!
  const sheet = await buildSetupSheetData(project, setups, UCCNC_CONFIG, result, 'part.nc', stockWorldBounds)
  return { project, sheet, result, text: renderSetupSheetText(sheet) }
}

describe('WO-2439 job sheet workholding section', () => {
  it('states the method, note, clamps and tabs of the setup before its operations', async () => {
    const { sheet } = await authoredSheet()
    const lines = sheet.lines
    const top = lines.indexOf('Setup: "Top" (G54)')
    const bottom = lines.indexOf('Setup: "Bottom" (G55)')
    expect(top).toBeGreaterThan(-1)
    expect(bottom).toBeGreaterThan(top)
    const topRows = lines.slice(top, bottom)
    const heading = topRows.indexOf('  Workholding:')
    const firstOp = topRows.indexOf('1. "Rough pocket"')
    expect(heading).toBeGreaterThan(-1)
    expect(firstOp).toBeGreaterThan(heading)
    expect(topRows.slice(heading, firstOp).filter(Boolean)).toEqual([
      '  Workholding:',
      '    Method: Clamps',
      '    Note: "Masking tape on spoilboard and stock"',
      '    Note: "Superglue the tape faces together"',
      '    Clamp: "Strap clamp" x 2',
      '    Tabs, operation 2 "Cut out": 6 tabs per contour, 10mm wide x 1.5mm high, triangular',
    ])
    // Run order: the tab row names the operation by its number in the list below.
    expect(topRows).toContain('2. "Cut out"')
  })

  it('prints no section for a setup with no method, note, holder or tabs', async () => {
    const { sheet } = await authoredSheet()
    const bottom = sheet.lines.indexOf('Setup: "Bottom" (G55)')
    const bottomRows = sheet.lines.slice(bottom, sheet.lines.findIndex((l, i) => i > bottom && l.startsWith('File:')))
    expect(bottomRows.some((l) => l.includes('Workholding'))).toBe(false)
    expect(bottomRows.some((l) => l.includes('Tabs'))).toBe(false)
    expect(bottomRows.some((l) => l.includes('Clamp'))).toBe(false)
    expect(bottomRows).toContain('3. "Face back"')
  })

  it('places the section before the operation list in the PDF', async () => {
    const { sheet, result } = await authoredSheet()
    const bytes = buildSetupSheetPdf(sheet, result.gcode)
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe('%PDF-1.4')
    const text = pdfText(bytes)
    expect(text).toEqual(sheet.lines.filter(Boolean))
    const heading = text.indexOf('  Workholding:')
    expect(heading).toBeGreaterThan(text.indexOf('Setup: "Top" (G54)'))
    expect(heading).toBeLessThan(text.indexOf('1. "Rough pocket"'))
    expect(text.indexOf('    Clamp: "Strap clamp" x 2')).toBeLessThan(text.indexOf('1. "Rough pocket"'))
  })

  /** Re-post the authored plan with the contour's selection and saved tab
   *  locations edited, as the Post dialog would after the operation is changed. */
  async function tabRow(edit: (op: Project['setups'][number]['operations'][number]) => void) {
    const { project } = await authoredSheet()
    const setups = project.setups.filter((s) => s.id === 's1' || s.id === 's2')
    const outline = setups[0].operations.find((o) => o.id === 'outline')!
    edit(outline)
    for (const setup of setups) {
      for (const op of setup.operations) stampGenerationCurrent(project, setup, op, project.toolLibrary.find((t) => t.id === op.toolId)!)
    }
    const posted = postProject(project, setups, UCCNC_CONFIG, { mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc' })
    expect(posted.ok, JSON.stringify(posted.diagnostics)).toBe(true)
    const sheet = await buildSetupSheetData(project, setups, UCCNC_CONFIG, posted.combined!, 'part.nc', stockWorldBounds)
    return sheet.lines.find((l) => l.startsWith('    Tabs, operation 2'))
  }

  it('counts only tabs placed on the contours the operation cuts', async () => {
    // Tabs placed on A and B, then the operation edited to cut A and C: the
    // cut reads A's locations and ignores B's, so the sheet does too.
    const row = await tabRow((op) => {
      Object.assign(op.params, { loopIds: ['A', 'C'], tabCount: 4, tabLocations: { A: [0.25, 0.75], B: [0.1, 0.3, 0.5, 0.7] } })
    })
    expect(row).toBe('    Tabs, operation 2 "Cut out": 2 tabs placed by hand on 1 contour, 4 per other contour, 10mm wide x 1.5mm high, triangular')
    // Cutting A only: every cut contour has its tabs placed by hand.
    const aOnly = await tabRow((op) => {
      Object.assign(op.params, { loopIds: ['A'], tabCount: 4, tabLocations: { A: [0.25, 0.75], B: [0.1, 0.3, 0.5, 0.7] } })
    })
    expect(aOnly).toBe('    Tabs, operation 2 "Cut out": 2 tabs placed by hand on 1 contour, 10mm wide x 1.5mm high, triangular')
  })

  it('says the same thing about an all-contours cut before and after save and reopen', async () => {
    // With no loop selected, which loops are cut is resolved at compute time;
    // the saved plan does not name them, so no hand-placed total is claimed.
    const locations = { A: [0.25, 0.75], B: [0.1, 0.3, 0.5] }
    const expected = '    Tabs, operation 2 "Cut out": 4 tabs per contour unless placed by hand, 10mm wide x 1.5mm high, triangular'
    const live = await tabRow((op) => {
      Object.assign(op.params, { loopIds: [], tabCount: 4, tabLocations: locations })
      op.contourTabPreview = { loops: [{ loopId: 'B', path: [], perimeter: 100 }], tabTopZ: 0 }
    })
    expect(live).toBe(expected)
    // The file save strips the preview; the reopened job prints the same row.
    const reopened = await tabRow((op) => {
      Object.assign(op.params, { loopIds: [], tabCount: 4, tabLocations: locations })
      op.contourTabPreview = { loops: [{ loopId: 'B', path: [], perimeter: 100 }], tabTopZ: 0 }
      const saved = JSON.parse(JSON.stringify(stripOperationForPersistence(op, 'file')))
      expect(saved.contourTabPreview).toBeUndefined()
      for (const key of Object.keys(op)) delete (op as unknown as Record<string, unknown>)[key]
      Object.assign(op, saved)
    })
    expect(reopened).toBe(expected)
    // No hand placement: the uniform count is exact either way.
    const uniform = await tabRow((op) => { Object.assign(op.params, { loopIds: [], tabCount: 4, tabLocations: {} }) })
    expect(uniform).toBe('    Tabs, operation 2 "Cut out": 4 tabs per contour, 10mm wide x 1.5mm high, triangular')
  })

  it('leaves the posted program untouched by the plan', async () => {
    const { project, result } = await authoredSheet()
    const plain = structuredClone(project)
    plain.workholding = undefined
    for (const setup of plain.setups) { setup.notes = ''; setup.holdingMethod = undefined }
    const setups = plain.setups.filter((s) => s.id === 's1' || s.id === 's2')
    for (const setup of setups) {
      for (const op of setup.operations) stampGenerationCurrent(plain, setup, op, plain.toolLibrary.find((t) => t.id === op.toolId)!)
    }
    const again = postProject(plain, setups, UCCNC_CONFIG, { mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc' })
    expect(again.ok, JSON.stringify(again.diagnostics)).toBe(true)
    expect(again.combined!.gcode).toBe(result.gcode)
  })
})
