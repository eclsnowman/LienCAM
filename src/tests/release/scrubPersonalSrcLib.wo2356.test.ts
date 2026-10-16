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
    // WO-2537 removed two private debug PNGs; WO-2480 added nesting/proxy.ts: 482 -> 481.
    // WO-2637 (ca58aa923) added post/toolNumbers.ts: 481 -> 482.
    // WO-2668 added machine/outputPinWatch.ts: 482 -> 483.
    // WO-2784 RE-PIN 483 -> 516: WO-2759 diagnostics/ (7), WO-2725 projectOpen/ (4 + 14 example
    // thumbnails), WO-2677 machine/macros/macroOutputSelection.ts, WO-2616 sketch/patterns.ts +
    // solver/dependentDimensionRouting.ts + solver/dependentFeatures.ts, WO-2322
    // sketch/sketcher/overlays/SketchPatternEditor.tsx, WO-2748 sketch/tools/dimPreviewConnector.ts +
    // dimensionGuideSizing.ts, WO-2720 update/releaseCheck.ts.
    // WO-2829 RE-PIN 516 -> 518: WO-2787 added cam/adaptiveClearing2d/engine/
    // repositionTime.ts (b850cece6b); WO-2809 added machine/probingSession.ts (1e7a259aea).
    // WO-2875 RE-PIN 518 -> 523: WO-2854 sketch/sketchEditorPose.ts, WO-2857
    // cam/headlessFeatureReplay.ts + cam/modelWorkbenchHelpers.ts, WO-2864
    // tools/projectLibraryIdentity.ts, WO-2867 tools/toolImportIdentity.ts.
    // WO-2875 RE-PIN 523 -> 525: WO-2858 operatorLabels.ts, WO-2877 format/lengthDisplay.ts.
    // WO-2882 RE-PIN 525 -> 527: WO-2859 cam/meshChainInstances.ts (ac6e219161),
    // WO-2878 machine/currentTool.ts (6cf08b5011).
    expect(report.files).toBe(527)
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
