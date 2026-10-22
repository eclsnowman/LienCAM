// WO-3009 acceptance (2)-(6) on hand-written synthetic programs
// (src/tests/fixtures/reference-cam/). Stores are built in the OS temp dir:
// the harness refuses a store inside the working tree.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ZDexelField } from '../../cam3d/stock'
import { bounds, control } from './alpha3CollectorControls'
import { planChain } from './chainRunner'
import { alpha3Chains } from './registry'
import { compareEntries, runReferenceCapture } from './reference/compare'
import { normaliseProgram } from './reference/normalise'
import { parseProgram } from './reference/parse'
import { isInside, referenceStoreDir, repositoryRoot, STORE_ENV } from './reference/privacy'
import { scoreReferenceSteps } from './reference/rows'
import { assignRoles } from './reference/roles'
import { hashFiles, NORMALISED, PARAMS, PROVENANCE, readReferenceStore, type ReferenceParams } from './reference/store'

const FIXTURES = 'src/tests/fixtures/reference-cam'
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')
const atZero = { originMm: { x: 0, y: 0, z: 0 } }
const scratch = mkdtempSync(join(tmpdir(), 'wo3009-store-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

// The stepped-boss rough row (A.5): 6 mm flat, stock 0..40 x 0..40 x 0..15, program zero at the stock top front left.
const BOSS = { chainId: 'stepped-boss-rough-finish-declared', stepId: 'rough-6-flat' }
const bossParams = (): ReferenceParams => ({
  partId: 'stepped-boss', setupLabel: 'top-declared', stepId: 'rough-6-flat', toolId: 'starter-metric-2', scopeId: 'whole',
  opType: 'adaptive_3d', tool: { type: 'flat_end_mill', diameterMm: 6, cornerRadiusMm: 0 },
  stock: { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 40, maxZ: 15 }, wcsOriginMm: { x: 0, y: 0, z: 15 },
  strategy: { note: 'synthetic: two hand-written skim passes' },
})
function writeEntry(store: string, edit: { params?: (p: ReferenceParams) => void; provenance?: boolean; tamper?: boolean; program?: string } = {}) {
  const params = bossParams(); edit.params?.(params)
  const dir = join(store, params.partId, 'adaptive_3d', params.toolId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'program.nc'), edit.program ?? fixture('boss-skim.nc'))
  writeFileSync(join(dir, PARAMS), JSON.stringify(params, null, 1))
  if (edit.provenance !== false) writeFileSync(join(dir, PROVENANCE), JSON.stringify({ date: '2026-10-21', operator: 'synthetic',
    programVersion: 'hand-written', sessionId: 'none', files: hashFiles(dir, ['program.nc', PARAMS]) }))
  if (edit.tamper) writeFileSync(join(dir, 'program.nc'), fixture('boss-skim.nc').replace('X45', 'X44'))
  return dir
}
const store = (name: string) => { const dir = join(scratch, name); mkdirSync(dir); return dir }

describe('WO-3009 reference-CAM import', () => {
  it('inch program imports with mm coordinates x 25.4', () => {
    const imported = normaliseProgram(parseProgram(fixture('inch-square.nc')), atZero)
    // Hand list, in inches, of inch-square.nc's blocks: [type, x, y, z, feed in/min, arc centre].
    const inches: [string, number, number, number, number?, [number, number]?][] = [
      ['rapid', 0, 0, 0.5], ['feed', 0, 0, -0.04, 10], ['feed', 1, 0, -0.04, 20],
      ['arc_cw', 1.5, 0.5, -0.04, 20, [1, 0.5]], ['feed', 1.5, 1, -0.04, 20], ['rapid', 1.5, 1, 0.5],
    ]
    expect(imported.unavailable).toBeUndefined()
    expect(imported.moves!.map(m => m.type)).toEqual(inches.map(([type]) => type))
    imported.moves!.forEach((move, i) => {
      const [, x, y, z, feed, centre] = inches[i]
      expect(move.x).toBeCloseTo(x * 25.4, 9); expect(move.y).toBeCloseTo(y * 25.4, 9); expect(move.z).toBeCloseTo(z * 25.4, 9)
      if (feed !== undefined) expect(move.feed).toBeCloseTo(feed * 25.4, 9)
      if (centre) { expect(move.cx).toBeCloseTo(centre[0] * 25.4, 9); expect(move.cy).toBeCloseTo(centre[1] * 25.4, 9) }
    })
  })

  it('M-AIR-1 equals the hand value on the one-air-move program', () => {
    const imported = normaliseProgram(parseProgram(fixture('one-air-move.nc')), atZero)
    const moves = assignRoles(imported.moves!, ZDexelField.fromBox(bounds, 0.1), { kind: 'flat', diameter: 2 })
    expect(moves.map(m => m.role)).toEqual(['rapid', 'plunge', 'cut', 'loop_back', 'rapid'])
    // By hand: the only fed move through air is the 38 -> 2 return along the slot just cut: 36 mm.
    expect(control(moves).metrics['M-AIR-1']).toBe(36)
  })

  it('places the program by the recorded WCS offset: Z up, the table at Z = 0', () => {
    const imported = normaliseProgram(parseProgram(fixture('boss-skim.nc')), { originMm: bossParams().wcsOriginMm! })
    expect(imported.moves!.find(m => m.type === 'feed')).toMatchObject({ x: -5, y: 3, z: 13 })
  })

  it('excludes a row with missing provenance, a hash mismatch or no WCS record, each with its reason', () => {
    const root = store('validation')
    const one = (name: string, edit: Parameters<typeof writeEntry>[1]) => { const s = join(root, name); mkdirSync(s); writeEntry(s, edit); return readReferenceStore(s)[0] }
    expect(one('valid', {})).toMatchObject({ status: 'valid', path: 'stepped-boss/adaptive_3d/starter-metric-2' })
    expect(one('no-provenance', { provenance: false })).toEqual({ status: 'excluded', path: 'stepped-boss/adaptive_3d/starter-metric-2', reason: 'missing provenance.json' })
    expect(one('tampered', { tamper: true })).toMatchObject({ status: 'excluded', reason: 'hash mismatch: program.nc' })
    expect(one('no-wcs', { params: p => { delete p.wcsOriginMm } })).toMatchObject({ status: 'excluded',
      reason: 'no WCS record (params.json wcsOriginMm): the harness cannot place the program' })
    const wrong = join(root, 'wrong-folder'); mkdirSync(wrong)
    renameSync(writeEntry(wrong, { params: p => { p.toolId = 'other-tool' } }), join(wrong, 'stepped-boss', 'adaptive_3d', 'starter-metric-2'))
    expect(readReferenceStore(wrong)[0]).toMatchObject({ status: 'excluded',
      reason: 'params.json names stepped-boss/other-tool, folder is stepped-boss/starter-metric-2' })
    const two = join(root, 'two-programs'); mkdirSync(two)
    writeFileSync(join(writeEntry(two), 'second.nc'), fixture('boss-skim.nc'))
    expect(readReferenceStore(two)[0]).toMatchObject({ status: 'excluded', reason: 'more than one program file: program.nc, second.nc' })
  })

  it('lists a tool or stock that differs from the A.5 row as not comparable', async () => {
    const root = store('comparable')
    writeEntry(root, { params: p => { p.tool.diameterMm = 8; p.stock.maxZ = 20 } })
    const result = await compareEntries(readReferenceStore(root))
    expect(result.rows).toEqual([])
    expect(result.notComparable).toEqual([{ path: 'stepped-boss/adaptive_3d/starter-metric-2', key: 'stepped-boss/top-declared/rough-6-flat/starter-metric-2/whole',
      reasons: ['tool diameter 8 mm differs from the A.5 row\'s 6 mm', 'stock maxZ 20 mm differs from the A.5 row\'s 15 mm'] }])
  }, 300_000)

  it('the unparsed-word report lists every ignored word', () => {
    const parsed = parseProgram(fixture('words.nc'))
    expect(parsed.unparsedMotionWord).toBeUndefined()
    expect(parsed.ignoredWords).toEqual({ N: 10, G54: 1, T1: 1, M6: 1, M3: 1, G43: 1, H: 1, M8: 1, G4: 1, P: 1, M5: 1, M30: 1 })
    expect(parsed.spindleRpm).toEqual([12000])
    expect(normaliseProgram(parsed, atZero).moves!.map(m => [m.type, m.x, m.z, m.feed])).toEqual([
      ['rapid', 0, 5, undefined], ['feed', 0, -1, 200], ['feed', 10, -1, 200]])
  })

  it('a motion word it cannot interpret makes the row "n/a: unparsed motion word <word>"', async () => {
    expect(normaliseProgram(parseProgram(fixture('canned-cycle.nc')), atZero).unavailable).toBe('n/a: unparsed motion word G81')
    expect(normaliseProgram(parseProgram(fixture('rotary.nc')), atZero).unavailable).toBe('n/a: unparsed motion word A')
    const chain = alpha3Chains().find(c => c.id === BOSS.chainId)!
    const native = await planChain(chain)
    const [row] = (await scoreReferenceSteps(chain, native, [{ stepId: BOSS.stepId,
      program: normaliseProgram(parseProgram(fixture('canned-cycle.nc')), atZero) }])).rows
    expect(row, 'one reference row').toBeDefined()
    expect(row.engineId).toBe('reference')
    expect(row.status).toBe('n/a')
    expect(row.metrics.cutLengthMm).toEqual({ value: null, reason: 'n/a: unparsed motion word G81' })
    expect(row.metrics['M-AIR-1']).toMatchObject({ value: null, reason: expect.stringContaining('unparsed motion word G81') })
  }, 300_000)

  it('scores a valid store entry with the unchanged collectors under engine id reference and diffs it against the current row', async () => {
    const root = store('scored')
    writeEntry(root)
    const result = await compareEntries(readReferenceStore(root))
    expect(result.excluded).toEqual([]); expect(result.notComparable).toEqual([])
    expect(result.rows).toHaveLength(1)
    const [scored] = result.rows
    expect(scored.reference).toMatchObject({ engineId: 'reference', key: 'stepped-boss/top-declared/rough-6-flat/starter-metric-2/whole', status: 'ready' })
    // By hand: the two 50 mm skims at Z13 cut; the 12 mm descent at X-5 and the 5 mm step at X45
    // pass beside the stock (6 mm tool, stock X 0..40), so they are fed air.
    expect(scored.reference.metrics.cutLengthMm).toBe(100)
    expect(scored.reference.metrics['M-AIR-1']).toBe(17)
    expect(scored.diff?.cells.find(c => c.cell === 'cutLengthMm')).toMatchObject({ current: expect.any(Number), reference: 100 })
    expect(Object.keys(result.report)).toEqual(['adaptive_3d'])
  }, 300_000)

  it('the private capture writes each scored program\'s normalised.moves.json beside it in the store, and a rerun reads the store unchanged', async () => {
    const root = store('capture')
    const dir = writeEntry(root)
    const run = await runReferenceCapture({ [STORE_ENV]: root })
    expect(run.skip).toBeUndefined()
    if (run.skip !== undefined) return
    expect(run.result.rows.map(row => row.path)).toEqual(['stepped-boss/adaptive_3d/starter-metric-2'])
    expect(isInside(run.reportFile, root)).toBe(true)
    expect(isInside(run.reportFile, repositoryRoot())).toBe(false)
    // Every scored program has its normalised moves beside it: the normaliser's own output, in mm in the A.5 world frame.
    expect(existsSync(join(dir, NORMALISED)), `${NORMALISED} beside the scored program`).toBe(true)
    const written = JSON.parse(readFileSync(join(dir, NORMALISED), 'utf8'))
    expect(written.moves).toEqual(normaliseProgram(parseProgram(fixture('boss-skim.nc')), { originMm: bossParams().wcsOriginMm! }).moves)
    // The file is output, not input: the store still validates, and a second capture scores the same row.
    expect(readReferenceStore(root).find(e => e.path === 'stepped-boss/adaptive_3d/starter-metric-2')).toMatchObject({ status: 'valid', programFile: 'program.nc' })
    const again = await runReferenceCapture({ [STORE_ENV]: root })
    expect(again.skip === undefined && again.result.rows.map(row => row.reference.metrics.cutLengthMm)).toEqual([100])
    expect(readdirSync(dir).sort()).toEqual([NORMALISED, PARAMS, 'program.nc', PROVENANCE].sort())
  }, 300_000)

  it('refuses a store path inside the repository and skips the private run when the variable is unset', () => {
    expect(referenceStoreDir({}).skip).toBe(`${STORE_ENV} is not set; the private reference-CAM run is skipped`)
    expect(() => referenceStoreDir({ [STORE_ENV]: join(repositoryRoot(), 'reference-store') }))
      .toThrow('reference store refused: LIENCAM_REFERENCE_CAM_DIR points inside the repository working tree; reference programs must stay outside it')
    expect(referenceStoreDir({ [STORE_ENV]: scratch }).dir).toBe(scratch)
  })
})
