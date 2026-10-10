// WO-2632: the licence gate (WO-2623 G4 B3) asks that every exported example file has a
// "Yes" rights row in docs/release-licences.md, and that medallion.png's origin is recorded.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '../../..')
const rows = new Map<string, { source: string; verdict: string }>()
for (const line of readFileSync(path.join(root, 'docs/release-licences.md'), 'utf8').split(/\r?\n/)) {
  const match = /^\| `([^`]+)` \| (.*) \| ([^|]+) \|$/.exec(line.trim())
  if (match) rows.set(match[1], { source: match[2], verdict: match[3].trim() })
}

const walk = (rel: string): string[] =>
  readdirSync(path.join(root, rel)).sort().flatMap(name => {
    const relPath = `${rel}/${name}`
    return statSync(path.join(root, relPath)).isDirectory() ? walk(relPath) : [relPath]
  })
const exampleFiles = walk('examples')

describe('WO-2632 sample rights are recorded', () => {
  it('every example file has a row that allows sharing', () => {
    expect(exampleFiles.length).toBeGreaterThan(100)
    expect(exampleFiles.filter(file => !rows.has(file))).toEqual([])
    expect(exampleFiles.filter(file => !/^Yes\b/.test(rows.get(file)!.verdict))).toEqual([])
  })

  it('every example folder is covered', () => {
    const folders = readdirSync(path.join(root, 'examples')).filter(name => statSync(path.join(root, 'examples', name)).isDirectory())
    for (const folder of folders) expect([...rows.keys()].some(file => file.startsWith(`examples/${folder}/`))).toBe(true)
    expect(rows.has('examples/README.md')).toBe(true)
  })

  it('medallion.png is recorded as AI-generated within this project', () => {
    const row = rows.get('examples/07-relief-medallion/medallion.png')!
    expect(row.source).toMatch(/AI-generated within this project/)
    expect(row.source).toMatch(/WO-2379/)
    expect(row.source).toMatch(/build-relief-medallion\.mjs/)
    expect(row.source).toMatch(/Apache-2\.0/)
  })
})
