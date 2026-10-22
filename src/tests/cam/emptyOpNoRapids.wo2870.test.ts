// WO-2870: an operation with nothing left to cut posts no rapid dips or
// diagonal descents; it posts one line saying it has nothing to cut.
//
// Architect sweep 3 (10-16): Face 1 cleared the whole top to Z-5, so Pocket 3
// had no cutting moves at all, yet its posted block was all G0 - diagonal
// descents to Z-1 and Z-3 while moving 17 mm in XY, travel at Z-1/Z-3 and
// plunges to Z-3/Z-4. The setup below reproduces that shape through the real
// Post Process path (buildPostInput -> postProject, every built-in dialect).
import { describe, expect, it } from 'vitest'
import { postProject, type PostProjectOptions } from '../../lib/post/postProject'
import { GENERIC_CONFIG, GRBL_CONFIG, LINUXCNC_CONFIG, UCCNC_CONFIG, type PostConfig } from '../../lib/post'
import type { MachineAction, Operation, Project, Setup, Stock, ToolpathMove } from '../../types'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from '../post/helpers'

const face: ToolpathMove[] = [
  move({ type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' }),
  move({ type: 'feed', x: 0, y: 0, z: -5, feed: 400, role: 'plunge' }),
  move({ type: 'feed', x: 50, y: 0, z: -5, feed: 2000, role: 'cut' }),
  move({ type: 'feed', x: 50, y: 50, z: -5, feed: 2000, role: 'cut' }),
  move({ type: 'rapid', x: 50, y: 50, z: 10, role: 'rapid' }),
]
// Pocket 3 as posted in the sweep: rapids only, every one below the stock top.
const emptyPocket: ToolpathMove[] = [
  move({ type: 'rapid', x: 10, y: 10, z: 10, role: 'rapid' }),
  move({ type: 'rapid', x: 27, y: 10, z: -1, role: 'rapid' }),
  move({ type: 'rapid', x: 27, y: 20, z: -1, role: 'rapid' }),
  move({ type: 'rapid', x: 10, y: 20, z: -3, role: 'rapid' }),
  move({ type: 'rapid', x: 10, y: 20, z: -4, role: 'rapid' }),
  move({ type: 'rapid', x: 10, y: 20, z: 10, role: 'rapid' }),
]
const contour: ToolpathMove[] = [
  move({ type: 'rapid', x: 60, y: 0, z: 10, role: 'rapid' }),
  move({ type: 'feed', x: 60, y: 0, z: -5, feed: 300, role: 'plunge' }),
  move({ type: 'feed', x: 60, y: 50, z: -5, feed: 1200, role: 'cut' }),
  move({ type: 'rapid', x: 60, y: 50, z: 10, role: 'rapid' }),
]

interface Build { pocketStatus?: Operation['status']; stopBeforePocket?: boolean; pocketLast?: boolean }

function build(opts: Build = {}) {
  const operations: Operation[] = [
    makeOp({ id: 'face', name: 'Face 1', type: 'face', toolId: 't1', toolpathMoves: face }),
    makeOp({ id: 'pocket', name: 'Pocket 3', type: 'pocket_2d', toolId: 't2', toolpathMoves: emptyPocket }),
    makeOp({ id: 'contour', name: 'Contour 4', type: 'contour_2d', toolId: 't1', toolpathMoves: contour }),
  ]
  if (opts.pocketLast) operations.push(operations.splice(1, 1)[0])
  const actions: MachineAction[] = opts.stopBeforePocket ? [{
    id: 'stop', kind: 'operator_stop', name: 'Operator stop', enabled: true, afterOpId: 'face', message: 'Check clamps',
  }] : []
  const setup: Setup = { id: 's1', name: 'Setup 1', wcs: makeWcs(),
    stock: { type: 'rectangular', width: 100, depth: 100, height: 20, origin: { x: 0, y: 0, z: 0 } } as unknown as Stock,
    operations, machineActions: actions, notes: '' }
  const project: Project = { id: 'wo2870', name: 'WO-2870', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine(), toolLibrary: [makeTool(), makeTool({ id: 't2', toolNumber: 2 })],
    geometry: [], setups: [setup], activeSetupId: null, activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '' }
  for (const op of operations) stampGenerationCurrent(project, setup, op, project.toolLibrary.find(t => t.id === op.toolId)!)
  if (opts.pocketStatus) operations.find(o => o.id === 'pocket')!.status = opts.pocketStatus
  return { project, setup }
}

function post(config: PostConfig, opts: Build = {}, extra: Partial<PostProjectOptions> = {}) {
  const { project, setup } = build(opts)
  return postProject(project, [setup], config, { mode: 'combined', pauseBetweenSetups: false, baseName: 'wo2870', ext: 'nc', ...extra })
}

const lines = (gcode: string) => gcode.split(/\r?\n/)
const isComment = (l: string) => /^\s*(\(.*\)|;.*)\s*$/.test(l)
const sayNothing = (l: string) => /Pocket 3: nothing left to cut/.test(l)

describe('WO-2870 an operation with nothing left to cut posts no motion', () => {
  for (const config of [UCCNC_CONFIG, GENERIC_CONFIG, LINUXCNC_CONFIG, GRBL_CONFIG]) {
    it(`${config.id}: one plain line, no rapid below the stock top, no tool change for it`, () => {
      const result = post(config)
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      const out = lines(result.combined!.gcode)
      const said = out.filter(sayNothing)
      expect(said).toHaveLength(1)
      expect(isComment(said[0])).toBe(true)
      // No rapid anywhere in the program goes below the stock top (Z0).
      const lowRapids = out.filter(l => /^G0\b/.test(l) && /Z-\d/.test(l))
      expect(lowRapids).toEqual([])
      // None of the sweep's Pocket 3 coordinates appear.
      expect(out.some(l => /X27\b/.test(l) || /Z-[134]\b/.test(l))).toBe(false)
      // Pocket 3 used tool 2; with nothing to cut no tool 2 is ever loaded.
      expect(out.some(l => /\bT2\b/.test(l))).toBe(false)
      // The line sits between Face 1's motion and Contour 4's.
      const at = out.indexOf(said[0])
      expect(out.slice(0, at).some(l => /Y50/.test(l))).toBe(true)
      expect(out.slice(at).some(l => /X60/.test(l))).toBe(true)
    })
  }

  it('the program context still builds (the line belongs to no operation span)', () => {
    const result = post(UCCNC_CONFIG, {}, { programContext: true })
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    const envelope = result.combined!.programContextEnvelope
    expect(envelope?.included, JSON.stringify(envelope)).toBe(true)
  })

  it('a stop placed after Face 1 still runs, and the line is posted once', () => {
    const result = post(UCCNC_CONFIG, { stopBeforePocket: true })
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    const out = lines(result.combined!.gcode)
    expect(out.filter(sayNothing)).toHaveLength(1)
    expect(out.some(l => /Check clamps/.test(l))).toBe(true)
  })

  it('as the last operation, the line comes after the last cut', () => {
    const result = post(UCCNC_CONFIG, { pocketLast: true })
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    const out = lines(result.combined!.gcode)
    const at = out.findIndex(sayNothing)
    expect(at).toBeGreaterThan(out.findIndex(l => /X60 Y50/.test(l)))
  })

  it('left out of the selection, it posts nothing at all', () => {
    const result = post(UCCNC_CONFIG, {}, { selectedOpIds: { s1: ['face', 'contour'] } })
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    expect(lines(result.combined!.gcode).some(sayNothing)).toBe(false)
  })

  // Fix round 1 (astra audit): an export in which nothing is left to cut posts
  // no motion at all - not even the program end's retract - only its lines.
  const onlyComments = (gcode: string) => lines(gcode).filter(l => l.trim() !== '').every(isComment)
  for (const config of [UCCNC_CONFIG, GENERIC_CONFIG, LINUXCNC_CONFIG, GRBL_CONFIG]) {
    it(`${config.id}: combined export of only the empty Pocket posts its line and no motion`, () => {
      const result = post(config, {}, { selectedOpIds: { s1: ['pocket'] } })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      const gcode = result.combined!.gcode
      expect(lines(gcode).filter(sayNothing)).toHaveLength(1)
      expect(onlyComments(gcode), gcode).toBe(true)
      expect(result.diagnostics.some(d => /nothing left to cut/.test(d.message) && /no motion/.test(d.message))).toBe(true)
    })
    it(`${config.id}: separate export of only the empty Pocket is one file with its line and no motion`, () => {
      const result = post(config, {}, { mode: 'separate', selectedOpIds: { s1: ['pocket'] } })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      expect(result.files).toHaveLength(1)
      const gcode = result.files![0].result.gcode
      expect(lines(gcode).filter(sayNothing)).toHaveLength(1)
      expect(onlyComments(gcode), gcode).toBe(true)
    })
  }

  it('multi-setup: when every setup has nothing left to cut, the combined export posts only the lines', () => {
    const one = build()
    const two = build()
    const setup2: Setup = { ...two.setup, id: 's2', name: 'Setup 2', wcs: makeWcs({ fixtureOffset: 55 }),
      operations: two.setup.operations.map(op => ({ ...op, id: `${op.id}-2`, name: `${op.name} (2)` })) }
    const project: Project = { ...one.project, setups: [one.setup, setup2] }
    for (const op of setup2.operations) stampGenerationCurrent(project, setup2, op, project.toolLibrary.find(t => t.id === op.toolId)!)
    for (const op of one.setup.operations) stampGenerationCurrent(project, one.setup, op, project.toolLibrary.find(t => t.id === op.toolId)!)
    for (const mode of ['combined', 'separate'] as const) {
      const result = postProject(project, [one.setup, setup2], UCCNC_CONFIG, { mode, pauseBetweenSetups: true,
        baseName: 'wo2870', ext: 'nc', selectedOpIds: { s1: ['pocket'], s2: ['pocket-2'] } })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      const programs = mode === 'combined' ? [result.combined!.gcode] : result.files!.map(f => f.result.gcode)
      expect(programs).toHaveLength(mode === 'combined' ? 1 : 2)
      const all = programs.join('')
      expect(all).toContain('Pocket 3: nothing left to cut')
      expect(all).toContain('Pocket 3 [2]: nothing left to cut')
      for (const gcode of programs) expect(onlyComments(gcode), gcode).toBe(true)
    }
  })

  it('an outdated rapid-only operation is still refused by its status', () => {
    const result = post(UCCNC_CONFIG, { pocketStatus: 'outdated' })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some(d => d.level === 'error')).toBe(true)
  })
})
