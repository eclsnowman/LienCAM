import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-2623: the release-gate dry run on main records a result for G1, G3 and G4,
// and every BLOCKER it names points at a file:line.
const ROOT = resolve(import.meta.dirname, '../../..')
const GATES = readFileSync(resolve(ROOT, 'src/tests/evidence/WO-2623/GATES.md'), 'utf8').replace(/\r\n/g, '\n')
const LINES = GATES.split('\n')

describe('WO-2623 release gates dry run record', () => {
  it('names the source commit it ran on', () => {
    expect(GATES).toMatch(/main `[0-9a-f]{40}`/)
  })

  for (const gate of ['G1', 'G3', 'G4']) {
    it(`records one result for ${gate} in the summary and in its section heading`, () => {
      const row = LINES.find((line) => line.startsWith(`| ${gate} `))
      expect(row, `${gate} summary row`).toBeDefined()
      const result = row!.split('|')[2].trim()
      expect(result).toMatch(/^(PASS|BLOCKER)$/)
      const heading = LINES.find((line) => line.startsWith(`## ${gate} `))
      expect(heading, `${gate} section`).toMatch(new RegExp(` - ${result}$`))
    })
  }

  it('gives every blocker a file:line', () => {
    const blockers = [...GATES.matchAll(/^### (B\d+) - .*$/gm)]
    expect(blockers.map((match) => match[1])).toEqual(['B1', 'B2', 'B3'])
    for (const [index, match] of blockers.entries()) {
      const body = GATES.slice(match.index, blockers[index + 1]?.index ?? GATES.length)
      expect(body, match[1]).toMatch(/[\w./-]+:\d+/)
    }
  })
})
