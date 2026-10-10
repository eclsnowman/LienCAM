import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { textFor } from '../../i18n'

// WO-2321: both files read their words from this English catalog area, so a
// `tx('key')` lookup is checked as the English text the operator sees.
const tx = textFor('cam-operations-new-operation') as unknown as (key: string) => string
const english = (text: string) => text
  .replace(/^\{\s*tx\('([^']+)'\)\s*\}$/, (_, key: string) => JSON.stringify(tx(key)))
  .replace(/tx\('([^']+)'/g, (_, key: string) => `tx(${JSON.stringify(tx(key))}`)

const SOURCE_FILES = [
  'components/modals/NewOperationModalBody.tsx',
  'components/panels/PropertiesPanel.tsx',
]

interface AutoPlaceholderField {
  file: string
  line: number
  placeholder: string
  tooltip: string | undefined
}

function attributeSource(
  sourceFile: ts.SourceFile,
  attributes: ts.JsxAttributes,
  name: string,
): string | undefined {
  const attribute = attributes.properties.find(
    (candidate): candidate is ts.JsxAttribute =>
      ts.isJsxAttribute(candidate) && candidate.name.getText(sourceFile) === name,
  )
  const text = attribute?.initializer?.getText(sourceFile)
  return text === undefined ? undefined : english(text)
}

function autoPlaceholderFields(file: string): AutoPlaceholderField[] {
  const absolute = join(process.cwd(), 'src', file)
  const source = readFileSync(absolute, 'utf8')
  const sourceFile = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fields: AutoPlaceholderField[] = []

  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const placeholder = attributeSource(sourceFile, node.attributes, 'placeholder')
      if (placeholder?.toLowerCase().includes('auto')) {
        const tooltip = attributeSource(sourceFile, node.attributes, 'tooltip')
          ?? attributeSource(sourceFile, node.attributes, 'data-tooltip')
        fields.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          placeholder,
          tooltip,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return fields
}

describe('HELP-QA-7 auto placeholder disclosure', () => {
  it('keeps every auto placeholder readable and moves its full meaning to the input tooltip', () => {
    const fields = SOURCE_FILES.flatMap(autoPlaceholderFields)

    // WO-1271 added a SIXTH: Edge overrun on Parallel Finish 3D. Raised
    // deliberately, not to make a red go away - it is a real control with a real
    // 'auto' default, and it satisfies every per-field rule below (placeholder
    // exactly "auto", full meaning in the tooltip). The count is a tripwire that
    // forces this decision to be made and written down, which is what it just did.
    expect(fields, 'the modal and PropertiesPanel should retain the six auto-value fields').toHaveLength(6)
    for (const field of fields) {
      expect(field.placeholder, `${field.file}:${field.line} placeholder`).toBe('"auto"')
      expect(field.tooltip, `${field.file}:${field.line} tooltip`).toBeDefined()
    }

    const tooltipText = fields.map(field => field.tooltip).join('\n')
    // Three since WO-1271: Edge overrun's auto IS the tool radius, and its
    // tooltip has to say so or the operator cannot know what "auto" means. Same
    // deliberate raise as the count above, same reason.
    expect(tooltipText.match(/tool radius/gi)).toHaveLength(3)
    expect(tooltipText.match(/selected circle/gi)).toHaveLength(2)
    expect(tooltipText.match(/autoStr/g)).toHaveLength(1)
  })
})
