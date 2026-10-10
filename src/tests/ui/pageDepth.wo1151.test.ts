import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const tokens = readFileSync(path.join(root, 'src/theme/tokens.css'), 'utf8')
const app = readFileSync(path.join(root, 'src/styles/app.css'), 'utf8')
const capture = readFileSync(path.join(root, 'src/tests/evidence/WO-1151/capture.mjs'), 'utf8')

function declaration(source: string, name: string): string | undefined {
  return source.match(new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*:\\s*([^;]+);`, 'm'))?.[1].trim()
}

function delimitedBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Missing or invalid CSS block markers: ${startMarker} -> ${endMarker}`)
  }
  return source.slice(start, end)
}

const neutralityBlock = delimitedBlock(
  app,
  '/* WO-1151: 12px is the app-wide xs floor.',
  '/* End WO-1151 xs line-box neutrality block. */',
)

describe('WO-1151 page depth and type floor', () => {
  it('keeps 12px as the application type floor', () => {
    expect(declaration(tokens, '--font-size-xs')).toBe('12px')
    expect(tokens).not.toMatch(/--font-size-[\w-]+\s*:\s*11px\s*;/)
  })

  it('creates depth with the page well and canvas surfaces', () => {
    expect(declaration(tokens, '--slate-400')).toBe('#98a5b4')
    expect(declaration(tokens, '--surface-page')).toBe('#090c10')
    expect(declaration(tokens, '--surface-canvas')).toBe('#0d1117')
    expect(declaration(tokens, '--surface-input')).toBe('#0f141b')
    expect(declaration(tokens, '--vp-canvas')).toBe('#0d1117')
    expect(declaration(tokens, '--surface-1')).toBe('var(--slate-900)')
    expect(declaration(tokens, '--surface-2')).toBe('var(--slate-850)')
  })

  it('leaves the protected blue and hover roles unchanged', () => {
    expect(declaration(tokens, '--role-identity')).toBe('var(--blue-500)')
    expect(declaration(tokens, '--role-identity-light')).toBe('var(--blue-300)')
    expect(declaration(tokens, '--role-selection')).toBe('var(--blue-900)')
    expect(declaration(tokens, '--surface-hover')).toBe('var(--slate-800)')
  })

  it('keeps two form columns while the Tool Library diagram shares spare space', () => {
    expect(app).toMatch(/\.tool-form-section\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s)
    expect(app).toMatch(/\.tool-form-col\s*\{[^}]*flex:\s*1 1 0;[^}]*min-width:\s*0;/s)
    expect(app).toMatch(/\.tool-diagram-col\s*\{[^}]*min-width:\s*360px;[^}]*flex:\s*1 1 0;/s)
    expect(app).toMatch(/\.tool-diagram-col\s*>\s*svg\s*\{[^}]*flex:\s*1 1 auto;/s)
    expect(app).toMatch(/\.tool-form-section\s*>\s*\.mform-section-header[^{]*\{\s*grid-column:\s*1 \/ -1;/s)
  })

  it('preserves compact xs line boxes without adding padding', () => {
    expect(neutralityBlock).toContain('--wo1151-xs-line-box: 13px;')
    expect(neutralityBlock).toContain('--wo1151-xs-line-box: 15px;')
    expect(neutralityBlock).toContain('--wo1151-xs-line-box: 12px;')
    expect(neutralityBlock).toContain('--wo1151-xs-line-box: 11px;')
    expect(neutralityBlock).toMatch(/\.mform-help\[data-testid="user-data-storage-status"\]\s*\{\s*letter-spacing:\s*-0\.5px;/s)
    expect(neutralityBlock).not.toMatch(/\bpadding(?:-[a-z]+)?\s*:/)
  })

  it('censuses and pins shorthand and inline xs consumers', () => {
    expect(neutralityBlock).toMatch(/\.pendant-bridge-state,[\s\S]*\.pendant-field,[\s\S]*\.pendant-qr-wrap,[\s\S]*\[style\*="var\(--font-size-xs\)"\][\s\S]*line-height:\s*13px;/)
    expect(capture.match(/rule\.style\.fontSize\.includes\('var\(--font-size-xs\)'\)/g)).toHaveLength(2)
    expect(capture.match(/rule\.style\.font\.includes\('var\(--font-size-xs\)'\)/g)).toHaveLength(2)
    expect(capture).toContain('selectors.add(\'[style*="var(--font-size-xs)"]\')')
    expect(capture).toContain("identifyInlineConsumers(directory = path.join(repoRoot, 'src/components'))")
    expect(capture).toContain("inlineProbe.style.display = 'block'")
    expect(capture).toContain("inlineProbe.style.fontSize = 'var(--font-size-xs)'")
  })
})
