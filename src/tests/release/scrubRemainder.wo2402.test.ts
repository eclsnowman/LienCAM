import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const read = (path: string) => readFileSync(path, 'utf8')
const discovery = JSON.parse(read('src/tests/evidence/WO-2402/discovery.json')) as {
  baseline: string; fixturePairs: [string, string][]
}
const manifest = JSON.parse(read('tools/release/manifest.json')) as {
  selection: { action: string; path: string; reason: string }[]
  scan: { ruleExceptions: { path: string; rule: string; reason: string }[] }
}
const git = (...args: string[]) => execFileSync('git', args, {
  encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024,
})

function tokens(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const result: string[] = []
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    const children = node.getChildren(source)
    if (children.length) children.forEach(visit)
    else result.push(node.getText(source))
  }
  visit(source)
  return result
}

describe('WO-2402 authorized naming remainder', () => {
  it('moves private export exclusions with renamed test inputs', () => {
    const beforeManifest = JSON.parse(git('show', `${discovery.baseline}:tools/release/manifest.json`)) as typeof manifest
    for (const [before, after] of discovery.fixturePairs) {
      const exclusions = beforeManifest.selection.filter(entry => entry.action === 'exclude' && entry.path === before)
      for (const entry of exclusions) {
        expect(manifest.selection).toContainEqual({ ...entry, path: after })
        expect(manifest.selection).not.toContainEqual(entry)
      }
    }
  })
  it('keeps renamed fixture bytes and paired report inputs intact', () => {
    for (const [before, after] of discovery.fixturePairs.filter(([path]) => /\.(?:nc|json|camproject)$/.test(path))) {
      expect(read(after).replace(/\r\n/g, '\n'), after)
        .toBe(git('show', `${discovery.baseline}:${before}`).replace(/\r\n/g, '\n'))
    }
  })

  it('preserves the newly granted private fixture bytes and consumer routes', () => {
    const fix = JSON.parse(read('src/tests/evidence/WO-2402/fix-fixtures.json')) as {
      baseline: string; pairs: [string, string][]
    }
    for (const [before, after] of fix.pairs) {
      // Both fixtures are text; a Windows checkout writes CRLF where git stores LF.
      expect(readFileSync(after, 'utf8').replace(/\r\n/g, '\n'), after).toBe(execFileSync('git', ['show', `${fix.baseline}:${before}`], {
        encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024,
      }).replace(/\r\n/g, '\n'))
      const consumers = after.endsWith('.camproject')
        ? ['src/tests/cam/boreZeroKernelMount.wo335.test.ts', 'src/tests/cam/boreZeroOwnerResolution.wo355.test.ts']
        : ['src/tests/model3d/workbenchDepthScene.UI-81C.test.ts']
      for (const consumer of consumers) {
        expect(read(consumer), consumer).toContain(after)
        expect(read(consumer), consumer).not.toContain(before)
      }
    }
  })

  it('preserves every executable adaptive-engine token', () => {
    // WO-2784 RE-PIN: this invariant belongs to the scrub commit (363a1b0f8a, the only WO-2402
    // edit to these files), not to whatever main holds later. WO-2752 (02bbb81663, owner 10-11:
    // "This is an important bug to fix") legitimately changed processFeature.ts; comparing main
    // against the frozen pre-scrub baseline made that product fix read as a scrub violation.
    // Same rule as WO-2356's historical-invariant test.
    const scrubbed = '363a1b0f8a'
    for (const file of ['emit.ts', 'processFeature.ts']) {
      const path = `src/lib/cam/adaptiveClearing2d/engine/${file}`
      expect(tokens(path, git('show', `${scrubbed}:${path}`)), path).toEqual(tokens(path, git('show', `${discovery.baseline}:${path}`)))
    }
  })

  it('requires a reason and a unique exact path plus rule for every new exception', () => {
    const additions = JSON.parse(read('src/tests/evidence/WO-2402/exceptions.json')).entries as typeof manifest.scan.ruleExceptions
    expect(additions.length).toBeGreaterThan(0)
    // WO-2537 made these comparison DXFs private instead of exempting their names.
    const privateComparisons = new Set([
      'test_fixtures/adaptive-clearing/spirals/fusion/All fixtures as DXF.dxf',
      'test_fixtures/adaptive-clearing/spirals/fusion/Polyline All Fixtures.dxf',
    ])
    for (const entry of additions) {
      expect(entry.reason.trim().length, entry.path).toBeGreaterThan(20)
      expect(entry.path.endsWith('/'), entry.path).toBe(false)
      expect(entry.rule).not.toBe('*')
      const exceptions = manifest.scan.ruleExceptions.filter(other => other.path === entry.path && other.rule === entry.rule)
      if (privateComparisons.has(entry.path)) {
        expect(exceptions).toHaveLength(0)
        expect(manifest.selection).toContainEqual({
          action: 'exclude', path: 'test_fixtures/adaptive-clearing/spirals/fusion/',
          reason: 'WO-2537: Private commercial CAM comparison scratch and pictures.',
        })
      } else expect(exceptions).toHaveLength(1)
    }
  })

  it('has no owner hits in edited tests except unchanged private inputs outside rename authority', () => {
    const report = JSON.parse(execFileSync(process.execPath, ['src/tests/evidence/WO-2402/verify.mjs', 'owned-json'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024,
    })) as { hits: { file: string; line: number; rule: string }[] }
    const personal = report.hits.filter(hit => hit.rule.startsWith('personal:'))
    for (const hit of personal) {
      const line = read(hit.file).split(/\r?\n/)[hit.line - 1]
      expect(line, `${hit.file}:${hit.line}`).toContain('test_fixtures/evidence/')
      const privateInput = line.match(/['"]([^'"]*test_fixtures\/evidence\/[^'"]+)['"]/)?.[1]
      expect(privateInput, hit.file).toBeDefined()
      expect(git('show', `${discovery.baseline}:${hit.file}`), hit.file).toContain(privateInput!)
    }
  }, 120_000)
  it('requires the entire manifest-selected export to scan clean', async () => {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ['src/tests/evidence/WO-2402/verify.mjs', 'json'], {
        encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024,
      }, (error, stdout) => error ? reject(error) : resolve(stdout))
    })
    const report = JSON.parse(output) as { files: number; hits: unknown[] }
    expect(report.files).toBeGreaterThan(4000)
    expect(report.hits).toEqual([])
  }, 120_000)

})
