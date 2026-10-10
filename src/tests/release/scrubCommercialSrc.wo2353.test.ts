import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

interface Mention { file: string; names: string[]; source: string; reason: string }
const root = process.cwd()
const evidence = join(root, 'src/tests/evidence/WO-2353')
const baseline: string = JSON.parse(readFileSync(join(evidence, 'scan-before.json'), 'utf8')).commit
// WO-2626 e37a10ac9 deliberately shortened the post-import Help statement.
const mentions: Mention[] = JSON.parse(readFileSync(join(root, 'src/tests/evidence/WO-2650/remaining-mentions.wo2353.json'), 'utf8'))
const changed: string[] = JSON.parse(readFileSync(join(evidence, 'changed-source.json'), 'utf8'))
const scrubbed = 'c73d6ccc2c9c1d7e076776bdf538437186c4e47c'

function runEvidence(mode: 'scan' | 'mentions' | 'files') {
  // Run the real scanner in Node, without Vite transforming release CLI modules.
  return JSON.parse(execFileSync(process.execPath, [join(evidence, 'slice.mjs'), mode], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024,
  }))
}

function executableTokens(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  // AST leaf text handles regex literals and JSX correctly; a plain scanner
  // would misread slash tokens in regexes as comment delimiters.
  const tokens: [number, string][] = []
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    const children = node.getChildren(source)
    if (children.length) children.forEach(visit)
    else tokens.push([node.kind, node.getText(source)])
  }
  visit(source)
  return tokens
}

// The ported adaptive engine (LGPL module) is left as on main here; its comments go to WO-2402 (architect 2026-10-02).
const ENGINE = 'src/lib/cam/adaptiveClearing2d/engine/'
const outsideEngine = (x: { file: string }) => !x.file.startsWith(ENGINE)
// Line numbers move when unrelated work lands. Keep exact content and hit
// multiplicity, so a new occurrence or changed comparison still fails.
// WO-2356 anonymized five already-recorded interoperability comments after
// this evidence was captured. No additional named-product prose is accepted.
const anonymizedMention = ({ reason: _reason, ...mention }: Mention) => {
  // WO-2561 moved this exact interoperability tooltip into the English catalog.
  // Preserve its text and names; no new catalog prose is implicitly accepted.
  // WO-2652: take the text from the recorded mention, so this public test does
  // not itself spell the names the release scanner forbids.
  const tooltip = /data-tooltip="(Import a LienCAM \(\.json\),[^"]*)"/.exec(mention.source)?.[1]
  if (mention.file === 'src/components/modals/PostProcessModal.tsx' && tooltip) return {
    ...mention, file: 'src/i18n/locales/en/setup-stock-tools-machine-post.ts',
    source: `    "import_a_liencam_json_vectric_estlcam_pp": "${tooltip}",`,
  }
  // WO-2649 64ce78ffb dropped every product name except Fusion from the post
  // Help search keywords. Remove exactly the recorded names; nothing is added.
  if (/^src\/help\/topics\/posting-gcode\/(?:entries|index)\.ts$/.test(mention.file)
    && mention.source.includes('post process gcode g-code export')) {
    const dropped = new Set(mention.names.filter(name => name !== 'fusion'))
    return {
      ...mention, names: mention.names.filter(name => !dropped.has(name)),
      source: mention.source.split(' ').filter(word => !dropped.has(word)).join(' '),
    }
  }
  return { ...mention, source: mention.source.replace(/\bEric\b/g, 'Operator') }
}
// WO-2437 records controller-format compatibility, not a business comparison.
// Accept these two exact statements only, retaining the full prose equality gate.
const controllerFormatMentions = [
  { file: 'src/lib/post/dialects/uccnc.ts', names: ['Fusion'],
    source: '    // Material", then M0 - exactly what Fusion\'s UCCNC post writes. The' },
  { file: 'src/lib/post/types.ts', names: ['Fusion'],
    source: '   *  M2001, as Fusion\'s UCCNC post writes it). Absent = the stop is M0 alone. */' },
]

describe('WO-2353 non-test public source naming', () => {
  it('has only the explicitly recorded protected scanner hits', () => {
    // These are evidence records, not additions to the release manifest.
    const report = runEvidence('scan')
    // WO-2622: file additions change the count, not the public-selection rule.
    // Assert the scanner visited every selected tracked source file rather than
    // repinning a historical tree size. Exact hit/prose gates remain below.
    const files: string[] = runEvidence('files')
    expect(files.length).toBeGreaterThan(0)
    expect(new Set(files).size).toBe(files.length)
    expect(report.files).toBe(files.length)
    // WO-2402 supplies reasoned path/rule exceptions for the protected names
    // and removes the engine comparisons. The exact prose guard below still
    // detects new comparisons in files with interoperability exceptions.
    expect(report.hits).toEqual([])
  }, 30_000)

  it('has no new named-product prose, including plain format names', () => {
    const expected = [...mentions.map(anonymizedMention), ...controllerFormatMentions]
      .filter(outsideEngine).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    expect(runEvidence('mentions').filter(outsideEngine)).toEqual(expected)
  })

  it('preserved every executable token, identifier and string in the original scrub', () => {
    // Verify the scrub's own result, rather than freezing product code forever
    // at its pre-scrub baseline and rejecting later unrelated implementations.
    for (const file of changed.filter(path => /\.tsx?$/.test(path))) {
      const before = execFileSync('git', ['show', `${baseline}:${file}`], {
        cwd: root, encoding: 'utf8', windowsHide: true,
      })
      const after = execFileSync('git', ['show', `${scrubbed}:${file}`], {
        cwd: root, encoding: 'utf8', windowsHide: true,
      })
      expect(executableTokens(file, after), file)
        .toEqual(executableTokens(file, before))
    }
  }, 30_000)
})
