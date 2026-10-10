import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const self = 'src/tests/release/wikiMatchesHelp.wo2541.test.ts'
const node = (args: string[]) => execFileSync(process.execPath, args, {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000,
})

describe('WO-2541 wiki matches the in-app Help', () => {
  it('checks generated page text and exact picture bytes through the release CLI', () => {
    expect(node(['tools/release/help-to-wiki.mjs', '--check'])).toMatch(/wiki: current - \d+ pages, \d+ topics, \d+ images/)
  }, 60_000)

  it('runs the wiki check in the exported public CI test list', () => {
    const script = `import { buildPublicTestList } from './tools/release/public-tests.mjs';
      const list = buildPublicTestList();
      console.log(JSON.stringify({ kept: list.kept.includes(${JSON.stringify(self)}),
        excluded: list.excluded.find(entry => entry.path === ${JSON.stringify(self)}) }));`
    expect(JSON.parse(node(['--input-type=module', '-e', script]))).toEqual({ kept: true })
  }, 60_000)
})
