// WO-3275 (UI M2 standards 1, 2, 8, 10): the lint tiers. The New UI bans are errors in the new
// code (kit, ui2, commands, notices) and warnings on the old screens, so linting today's code
// gains no error; the kit's inputs alone may hold a raw select or number input.
import { join } from 'node:path'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..')
let eslint: ESLint

beforeAll(() => { eslint = new ESLint({ cwd: ROOT }) })

async function lint(path: string, text: string) {
  const [result] = await eslint.lintText(text, { filePath: join(ROOT, path) })
  return result.messages
    .filter(m => m.ruleId?.startsWith('liencam-ui/'))
    .map(m => `${m.severity === 2 ? 'error' : 'warn'} ${m.ruleId}`)
    .sort()
}

const RAW_SELECT = 'export const F = () => <select><option>a</option></select>\n'
const EVERY_BAN = [
  "import { offsetPath } from '../lib/cam/offset'",
  "export const F = () => (",
  "  <div title=\"hint\" style={{ color: '#ff0000', width: 10 }}>",
  "    <input type=\"number\" />",
  "    <select />",
  "    {(1.5).toFixed(1)}{parseFloat('2')}{String(offsetPath)}",
  "  </div>",
  ")",
].join('\n') + '\n'

describe('WO-3275 lint tiers', () => {
  it('a raw select in the New UI is an error', async () => {
    expect(await lint('src/ui2/shell/Fixture.tsx', RAW_SELECT)).toEqual(['error liencam-ui/no-raw-select'])
  })

  it('the same raw select in an old panel is a warning only', async () => {
    expect(await lint('src/components/panels/Fixture.tsx', RAW_SELECT)).toEqual(['warn liencam-ui/no-raw-select'])
  })

  it('the kit inputs may hold a raw select; the rest of the kit may not', async () => {
    expect(await lint('src/components/kit/inputs/Fixture.tsx', RAW_SELECT)).toEqual([])
    expect(await lint('src/components/kit/surfaces/Fixture.tsx', RAW_SELECT)).toEqual(['error liencam-ui/no-raw-select'])
  })

  it('every ban fires in the strict tier: commands, notices and the kit', async () => {
    const all = [
      'error liencam-ui/no-engine-import',
      'error liencam-ui/no-inline-style',
      'error liencam-ui/no-inline-style',
      'error liencam-ui/no-number-format',
      'error liencam-ui/no-number-format',
      'error liencam-ui/no-raw-colour',
      'error liencam-ui/no-raw-number-input',
      'error liencam-ui/no-raw-select',
      'error liencam-ui/no-title-tooltip',
    ]
    for (const path of ['src/commands/Fixture.tsx', 'src/notices/Fixture.tsx', 'src/components/kit/actions/Fixture.tsx']) {
      expect(await lint(path, EVERY_BAN)).toEqual(all)
    }
  })

  it('a number after # in text is not a colour; a colour is', async () => {
    expect(await lint('src/ui2/Fixture.tsx', "export const t = ['Tool #100', 'issue #12']\n")).toEqual([])
    expect(await lint('src/ui2/Fixture.tsx', "export const t = ['#fff', '1px solid #0a0b0c']\n")).toEqual(['error liencam-ui/no-raw-colour', 'error liencam-ui/no-raw-colour'])
  })

  it('code outside the UI tiers is untouched', async () => {
    expect(await lint('src/lib/units/Fixture.ts', "export const s = (1.5).toFixed(1) + '#ffffff'\n")).toEqual([])
    expect(await lint('src/theme/Fixture.ts', "export const c = '#ffffff'\n")).toEqual([])
  })

  it('keeps the existing boundaries: the New UI may use react but not node builtins', async () => {
    const [result] = await eslint.lintText("import { useState } from 'react'\nimport { readFileSync } from 'node:fs'\nexport const u = [useState, readFileSync]\n", { filePath: join(ROOT, 'src/ui2/Fixture.ts') })
    const restricted = result.messages.filter(m => m.ruleId === 'no-restricted-syntax').map(m => m.message)
    expect(restricted).toEqual(['Architecture boundary: browser-reachable code may not import node: builtins.'])
  })
})
