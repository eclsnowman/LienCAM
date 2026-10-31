// WO-3275 (UI M2 standard 13): the UI debt ratchet. The recount on this tree equals the record
// in tools/ui-debt.json, and one planted raw <select> in a temporary copy of the screens makes
// the check report a rise. Every order's slice runs this file, so the ratchet holds without
// editing the gate runner.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

type Counts = Record<string, number>
interface UiDebtTool {
  REPO_ROOT: string
  METRIC_NAMES: string[]
  countUiDebt(root?: string): Counts
  compareUiDebt(record: { counts: Counts }, counts: Counts): { metric: string; was: number | null; now: number }[]
  readRecord(): { counts: Counts }
}
const { compareUiDebt, countUiDebt, METRIC_NAMES, readRecord, REPO_ROOT } =
  (await import(/* @vite-ignore */ new URL('../../../tools/ui-debt.mjs', import.meta.url).href)) as UiDebtTool

const scratch: string[] = []
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })

describe('WO-3275 ui-debt ratchet', () => {
  it('records every section 2 count', () => {
    const record = readRecord()
    expect(Object.keys(record.counts).sort()).toEqual([...METRIC_NAMES, 'bigFiles'].sort())
    for (const value of Object.values(record.counts)) expect(value).toBeGreaterThan(0)
  })

  it('no count rose above the record on this tree', () => {
    expect(compareUiDebt(readRecord(), countUiDebt())).toEqual([])
  })

  it('a planted raw select is a rise', () => {
    const copy = mkdtempSync(join(tmpdir(), 'wo3275-debt-'))
    scratch.push(copy)
    for (const part of ['src/components', 'src/ui2', 'src/App.tsx']) cpSync(join(REPO_ROOT, part), join(copy, part), { recursive: true })
    const before = countUiDebt(copy)
    expect(compareUiDebt(readRecord(), before)).toEqual([])
    writeFileSync(join(copy, 'src/components/Planted.tsx'), 'export const P = () => <select><option>a</option></select>\n')
    const rises = compareUiDebt(readRecord(), countUiDebt(copy))
    expect(rises).toEqual([{ metric: 'rawSelect', was: readRecord().counts.rawSelect, now: before.rawSelect + 1 }])
  })

  it('counts patterns, not words in comments, and leaves the kit to the lint', () => {
    const copy = mkdtempSync(join(tmpdir(), 'wo3275-debt-'))
    scratch.push(copy)
    const files = {
      'src/components/A.tsx': "// <select> and .toFixed( in a comment\nexport const A = () => <input type=\"number\" title=\"t\" style={{ color: '#fff' }} />\nconst n = parseFloat('1').toFixed(2)\n",
      'src/components/kit/inputs/Select.tsx': 'export const S = () => <select />\n',
      'src/App.tsx': "import { x } from './lib/cam/engine'\nimport type { Y } from './cam3d/y'\nwindow.addEventListener('keydown', () => {})\n",
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(copy, path)), { recursive: true })
      writeFileSync(join(copy, path), text)
    }
    expect(countUiDebt(copy)).toEqual({
      rawSelect: 0, rawNumberInput: 1, titleTooltip: 1, inlineStyle: 1, rawHex: 1,
      toFixed: 1, parseFloat: 1, keydownListener: 1, engineImport: 1, bigFiles: 0,
    })
  })
})
