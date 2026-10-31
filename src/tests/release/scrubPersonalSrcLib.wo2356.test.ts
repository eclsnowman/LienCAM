import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { parseLinuxcncGatewayAddress } from '../../lib/machine/linuxcnc/gatewayTransport'

function evidence(mode: string) {
  return JSON.parse(execFileSync(process.execPath, [join(process.cwd(), 'src/tests/evidence/WO-2356/slice.mjs'), mode], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024,
  }))
}

const git = (...args: string[]) => execFileSync('git', args, {
  cwd: process.cwd(), encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024,
})

function tokens(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const result: [number, string][] = []
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    const children = node.getChildren(source)
    if (children.length) children.forEach(visit)
    else result.push([node.kind, node.getText(source)])
  }
  visit(source)
  return result
}

describe('WO-2356 personal information in library source', () => {
  it('has no personal attribution or LAN example hits, preserving legacy product database IDs', () => {
    // The scanner treats the hyphenated product name as a standalone surname.
    // WO-2402 explicitly exempts these persisted IDs in the real manifest.
    const report = evidence('scan')
    // WO-3208: measure the tracked inventory instead of pinning historical tree
    // growth. The scanner must still visit every library file and find zero hits.
    const files = git('ls-files', '-z', '--', 'src/lib').split('\0').filter(Boolean)
    expect(files.length).toBeGreaterThan(0)
    expect(report.files).toBe(files.length)
    expect(report.hits).toEqual([])
    expect(Object.entries(report.counts).filter(([rule]) => rule !== 'personal:lien').every(([, count]) => count === 0)).toBe(true)
  }, 30_000)

  it('detects a restored owner attribution through the real scanner and manifest', () => {
    expect(evidence('negative').counts['personal:eric']).toBe(1)
  }, 30_000)

  it('preserved every executable token except five explicitly listed prose literals in the original scrub', () => {
    // This historical invariant belongs to the scrub commits. Later product
    // work must not be compared against a permanently frozen source baseline.
    const directory = join(process.cwd(), 'src/tests/evidence/WO-2356')
    const baseline = JSON.parse(readFileSync(join(directory, 'scan-before.json'), 'utf8')).commit
    const scrubbed = '74cb0b83a1655b186726286da0937396a434c921'
    const changed: string[] = JSON.parse(readFileSync(join(directory, 'changed-source.json'), 'utf8'))
    const allowed: { file: string; before: string; after: string }[] = JSON.parse(readFileSync(join(directory, 'allowed-strings.json'), 'utf8'))
    let compared = 0
    let literalChanges = 0
    for (const file of changed.filter(path => /\.[cm]?[jt]sx?$/.test(path))) {
      const before = tokens(file, git('show', `${baseline}:${file}`))
      const after = tokens(file, git('show', `${scrubbed}:${file}`))
      expect(after.length, file).toBe(before.length)
      const normalized = after.map(([kind, text], index) => {
        if (kind === ts.SyntaxKind.StringLiteral && before[index][0] === kind
          && allowed.some(entry => entry.file === file && entry.before === before[index][1] && entry.after === text)) {
          literalChanges += 1
          return before[index]
        }
        return [kind, text]
      })
      expect(normalized, file).toEqual(before)
      compared += 1
    }
    expect(compared).toBe(98)
    expect(literalChanges).toBe(5)
  }, 60_000)

  it('keeps gateway address parsing for local, LAN, documentation and IPv6 hosts', () => {
    expect(parseLinuxcncGatewayAddress('')).toEqual({ host: '127.0.0.1' })
    expect(parseLinuxcncGatewayAddress('192.168.1.20:8327')).toEqual({ host: '192.168.1.20', port: 8327 })
    expect(parseLinuxcncGatewayAddress('192.0.2.20:8327')).toEqual({ host: '192.0.2.20', port: 8327 })
    expect(parseLinuxcncGatewayAddress('::1')).toEqual({ host: '::1' })
    expect(() => parseLinuxcncGatewayAddress('bad host')).toThrow('is not a network address')
  })
})
