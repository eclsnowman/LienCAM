import { beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { featureDisplayName, geometryDisplayName, pickedFaceDisplayName, readableInternalIds } from '../../lib/operatorLabels'

interface Evidence {
  sources: Record<string, string[]>
  tree: string
  model: string
  console: string
  fillet: string
  importedFillet: string
  hint: string
  modelFilteredRows: string[]
  treeFilters: Record<string, string[]>
  renameGeometryUnchanged: boolean
  renamedAwayRows: string[]
  renamedRows: string[]
  restoredAwayRows: string[]
  restoredRows: string[]
  holeSnapOptions: string[]
  holeSnapValues: string[]
  boundaryOwnerName: string
  boundaryReadout: string
  boundaryError: string
  pageErrors: string[]
}
let evidence: Evidence
beforeAll(async () => {
  const out = process.env.WO2858_EVIDENCE === '1' ? 'src/tests/evidence/WO-2858' : mkdtempSync(join(tmpdir(), 'wo2858-'))
  await promisify(execFile)(process.execPath, ['src/tests/evidence/WO-2858/capture.mjs'], { timeout: 240000, env: { ...process.env, WO2858_OUT: out } })
  evidence = JSON.parse(readFileSync(`${out}/${process.env.WO2858_PHASE ?? 'round2-after'}.json`, 'utf8'))
}, 250000)

describe('WO-2858 production naming surfaces', () => {
  it('names both same-feature models in the geometry tree and every source picker', () => {
    for (const text of [evidence.tree, ...Object.values(evidence.sources).map(options => options.join('\n'))]) {
      expect(text).toContain('Bracket A - Extrude F1')
      expect(text).toContain('Knob B - Extrude F1')
    }
  })
  it('finds each CAM geometry row by its displayed name and preserves raw-name matching', () => {
    for (const label of ['Bracket A - Extrude F1', 'Knob B - Extrude F1']) {
      expect(evidence.treeFilters[label]).toHaveLength(1)
      expect(evidence.treeFilters[label][0]).toContain(label)
    }
    expect(evidence.treeFilters['Extrude F1']).toHaveLength(2)
  })
  it('refreshes the CAM filter after model-only renames with the query unchanged', () => {
    expect(evidence.renameGeometryUnchanged).toBe(true)
    expect(evidence.renamedAwayRows).toEqual([])
    expect(evidence.renamedRows).toHaveLength(1)
    expect(evidence.renamedRows[0]).toContain('Renamed bracket - Extrude F1')
    expect(evidence.restoredAwayRows).toEqual([])
    expect(evidence.restoredRows).toHaveLength(1)
    expect(evidence.restoredRows[0]).toContain('Bracket A - Extrude F1')
  })
  it('finds the Model tree sketch by its displayed name', () => {
    expect(evidence.modelFilteredRows).toHaveLength(1)
    expect(evidence.modelFilteredRows[0]).toContain('Sketch 2')
    expect(evidence.modelFilteredRows[0]).not.toMatch(/sketch3d:|datum:/)
  })
  it('renders readable sketch and datum names without internal keys', () => {
    expect(evidence.model).toContain('Sketch 2')
    expect(evidence.model).not.toMatch(/sketch3d:|datum:/)
  })
  it('renders console and fillet readouts without topology keys', () => {
    expect(evidence.console).toContain('New sketch started on')
    expect(evidence.fillet).toContain('Edge')
    expect(evidence.importedFillet).toContain('Edge')
    expect([evidence.console, evidence.fillet, evidence.importedFillet].join('\n')).not.toMatch(/sketch3d:|datum:|:XTR:|:step:face#/)
  })
  it('names the face sketch in real Hole snap choices while retaining pick identities', () => {
    expect(evidence.holeSnapOptions.join('\n')).toContain('(Sketch 2)')
    expect(evidence.holeSnapOptions.join('\n')).not.toMatch(/sketch3d:|datum:/)
    expect(evidence.holeSnapValues).toContain('sketch3d:SK2:naming-point:self')
  })
  it('describes the picked machining boundary on its named model without a topology key', () => {
    expect(evidence.boundaryReadout).toMatch(/face/i)
    expect(evidence.boundaryOwnerName).toMatch(/^(Bracket A|Knob B) - Extrude F1$/)
    expect(evidence.boundaryReadout).toContain(evidence.boundaryOwnerName)
    expect(evidence.boundaryReadout).not.toMatch(/\(id |:XTR:|:step:face#/)
  })
  it('keeps boundary refusal details readable without exposing the raw face key', () => {
    expect(evidence.boundaryError).toContain('not flat and horizontal')
    expect(evidence.boundaryError).toContain('mm of world Z')
    expect(evidence.boundaryError).not.toMatch(/:XTR:|:step:face#/)
  })
  it('uses grammatical target-plane guidance and has no browser errors', () => {
    expect(evidence.hint).not.toContain('its the')
    expect(evidence.pageErrors).toEqual([])
  })
})


describe('WO-2858 names preserve identity and useful operator detail', () => {
  it('qualifies legacy and renamed models while preserving imported and custom body names', () => {
    const body = { format: 'model', name: 'Extrude F1' }
    expect(geometryDisplayName(body, [{ id: 'legacy', name: 'Bracket A' }])).toBe('Bracket A - Extrude F1')
    expect(geometryDisplayName({ ...body, modelItemId: 'knob' }, [{ id: 'knob', name: 'Knob B' }])).toBe('Knob B - Extrude F1')
    expect(geometryDisplayName({ ...body, name: 'Mounting plate' }, [{ id: 'legacy', name: 'Renamed model' }])).toBe('Renamed model - Mounting plate')
    expect(geometryDisplayName({ format: 'step', name: 'Bracket.step' }, [{ id: 'legacy', name: 'Knob B' }])).toBe('Bracket.step')
    expect(body).toEqual({ format: 'model', name: 'Extrude F1' })
  })
  it('names an unnamed face datum and preserves an operator sketch name', () => {
    expect(featureDisplayName('datum:SK2', {})).toBe('Sketch plane 2')
    expect(featureDisplayName('sketch3d:SK2', { name: 'Bolt pattern' })).toBe('Bolt pattern')
  })
  it('formats all topology families emitted by the model kernel in diagnostic text', () => {
    for (const kind of ['XTR', 'REV', 'BOX', 'CUT', 'FUS', 'INT', 'FIL', 'CHM', 'SHL', 'SWP', 'LFT', 'HOL', 'PAT', 'DELF', 'EDIT', 'step', 'stl', 'iges']) {
      const id = `F9:${kind}:surface1`
      expect(readableInternalIds(`Unavailable target ${id}.`)).toBe('Unavailable target picked face.')
      expect(readableInternalIds(`The picked face ("${id}") spans 10.3528 mm of world Z.`)).toBe('The picked face spans 10.3528 mm of world Z.')
    }
  })
  it('formats imported and modeled diagnostics without dropping measurements or punctuation', () => {
    for (const edge of ['(IMP1:step:face#4 ^ IMP1:step:face#74)', '(F1:XTR:SK1:capEnd∧F1:XTR:l1:side)']) {
      expect(readableInternalIds(`Edge ${edge}: radius 2.50 mm.`)).toBe('Edge between 2 faces: radius 2.50 mm.')
    }
    expect(readableInternalIds('Missing face F1:XTR:SK1:capEnd.')).toBe('Missing face picked face.')
    expect(readableInternalIds('The picked face ("F1:XTR:SK1:capEnd") spans 10.3528 mm of world Z.')).toBe('The picked face spans 10.3528 mm of world Z.')
    expect(readableInternalIds('Selected cylinder "IMP1:step:face#4" has radius 2.50 mm.')).toBe('Selected cylinder has radius 2.50 mm.')
    expect(pickedFaceDisplayName('Bracket A - Extrude F1')).toBe('Picked face on Bracket A - Extrude F1.')
    expect(pickedFaceDisplayName()).toBe('picked face')
    expect(readableInternalIds('Z -12.50 mm; feed 600 mm/min; https://example.com')).toBe('Z -12.50 mm; feed 600 mm/min; https://example.com')
  })
})
