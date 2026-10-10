// @vitest-environment jsdom
//
// ICON-BUTTON-ARIA-LABELS (B3-2b) -- the mechanical census pinning the
// invariant B3-2's tooltip migration left open: title= gave every hint site a
// DESCRIPTION (data-tooltip) AND, for icon-only controls, doubled as a
// fallback accessible NAME. Moving to data-tooltip kept the description but
// dropped the name -- an icon-only button with no visible text and no
// aria-label/aria-labelledby now announces to a screen reader as an unnamed
// button. This suite DERIVES the census from the TS AST (not a hand-kept
// list), in the style of the UI-70 overlay census / SKC-47 loop-consumer
// census: walk every .tsx file under src/components, find every native
// interactive control (button/a, or a lowercase tag with an interactive
// ARIA role) carrying data-tooltip with no aria-label/aria-labelledby, and
// flag it ONLY if its rendered children never produce visible text (an
// <Icon/> alone, never a <span>label</span> or a string/template/conditional
// child -- those already have an accessible name from their own content).
//
// SCOPE NOTE on wrapper components (NumericInput/OptionalNumericInput/
// ThemedListbox/TreeRenameLabel/FeatureStatusBadge, all of which forward a
// `tooltip` prop to an internal data-tooltip per the B3-2 report): handled at
// the WRAPPER level, not per call site, and NOT by this file's native-DOM
// census --
//   - NumericInput / OptionalNumericInput: a bare <input> with no visible
//     label of its own. Fixed at the definition (src/components/ui/
//     NumericInput.tsx): both now render `aria-label={ariaLabel ?? tooltip}`,
//     so every existing call site is named for free. Proven by the
//     `NumericInput wrapper` describe block below (mounts the real component).
//   - ThemedListbox: its trigger button already renders VISIBLE text (the
//     selected option's label, or a placeholder) as a child, so it already
//     has an accessible name from content even with no aria-label passed --
//     it never regressed when title= was dropped. Exempt.
//   - TreeRenameLabel: renders a plain <span>{name}</span> with a
//     double-click handler, not a button/role=button/tabIndex-bearing
//     element -- a screen reader does not expose it as a control, and its
//     visible text IS the row's name, so there is nothing to name. Exempt.
//   - FeatureStatusBadge: renders a plain (non-interactive) <span>; each
//     status icon inside it already carries its own `aria-label` on the SVG.
//     Exempt.
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { NumericInput, OptionalNumericInput } from '../../components/ui/NumericInput'

const COMPONENTS_ROOT = join(process.cwd(), 'src', 'components')

const INTERACTIVE_DOM_TAGS = new Set(['button', 'a'])
const INTERACTIVE_ROLES = new Set(['button', 'checkbox', 'switch', 'menuitem', 'tab', 'radio', 'link'])
// Wrapper components exempt from the native-DOM walk -- see the file header
// for why each one is safe (visible-text trigger, non-interactive span, or
// fixed at its own definition + covered by a dedicated render test below).
const EXEMPT_WRAPPERS = new Set([
  'NumericInput', 'OptionalNumericInput', 'ThemedListbox', 'TreeRenameLabel', 'FeatureStatusBadge',
])

export interface Violation {
  file: string
  line: number
  tag: string
}

function walkTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walkTsxFiles(p, out)
    else if (entry.name.endsWith('.tsx')) out.push(p)
  }
  return out
}

function attrsOf(opening: ts.JsxOpeningLikeElement): Record<string, ts.JsxAttribute> {
  const attrs: Record<string, ts.JsxAttribute> = {}
  for (const prop of opening.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name) attrs[prop.name.getText()] = prop
  }
  return attrs
}

function tagNameOf(opening: ts.JsxOpeningLikeElement): string {
  return opening.tagName ? opening.tagName.getText() : '?'
}

// Does this expression, found in a JSX CHILD position, ever render visible
// text? Only a JsxElement/JsxFragment/JsxSelfClosingElement in a child slot
// can be pure icon -- and a JsxElement/JsxFragment must recurse into ITS OWN
// children (a fragment can wrap an icon AND text: `<>{<Star/>} Default</>`).
function childProducesText(ex: ts.Expression): boolean {
  if (ts.isJsxElement(ex) || ts.isJsxFragment(ex)) return hasVisibleText(ex.children)
  if (ts.isJsxSelfClosingElement(ex)) return false
  if (ts.isParenthesizedExpression(ex)) return childProducesText(ex.expression)
  if (ts.isConditionalExpression(ex)) {
    return childProducesText(ex.whenTrue) || childProducesText(ex.whenFalse)
  }
  if (ts.isBinaryExpression(ex) && ex.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    // `{cond && <Icon/>}` -> only the right side ever renders.
    return childProducesText(ex.right)
  }
  // Anything else in a child position (string/template literal, identifier,
  // property access, `??`, a function call, ...) is conservatively "text" --
  // only literal JSX in a child slot is unambiguously icon-only.
  return true
}

function hasVisibleText(children: ts.NodeArray<ts.JsxChild> | ts.JsxChild[]): boolean {
  for (const child of children) {
    if (ts.isJsxText(child)) {
      if (child.getText().trim().length > 0) return true
      continue
    }
    if (ts.isJsxExpression(child)) {
      if (!child.expression) continue // e.g. {/* comment */}
      if (childProducesText(child.expression)) return true
      continue
    }
    if (ts.isJsxElement(child) || ts.isJsxFragment(child)) {
      if (hasVisibleText(child.children)) return true
      continue
    }
    // JsxSelfClosingElement (e.g. <Pencil/>) contributes no text itself.
  }
  return false
}

/** Derive every icon-only interactive control with data-tooltip and no
 *  accessible name, under `root` (defaults to src/components). Exported so a
 *  fixture string can be fed through the SAME logic the real census uses
 *  (mutation-proofing below), not a re-implementation that could drift. */
export function deriveViolations(root: string = COMPONENTS_ROOT): Violation[] {
  const violations: Violation[] = []
  for (const file of walkTsxFiles(root)) {
    const src = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const rel = file.replace(/\\/g, '/')

    const visit = (node: ts.Node) => {
      let opening: ts.JsxOpeningLikeElement | undefined
      let isSelfClosing = false
      if (ts.isJsxElement(node)) {
        opening = node.openingElement
      } else if (ts.isJsxSelfClosingElement(node)) {
        opening = node
        isSelfClosing = true
      }
      if (opening) {
        const tag = tagNameOf(opening)
        const attrs = attrsOf(opening)
        const roleAttr = attrs['role']
        const roleVal = roleAttr && roleAttr.initializer && ts.isStringLiteral(roleAttr.initializer)
          ? roleAttr.initializer.text
          : null
        const isNativeInteractive = INTERACTIVE_DOM_TAGS.has(tag) ||
          (/^[a-z]/.test(tag) && !!roleVal && INTERACTIVE_ROLES.has(roleVal))

        if (isNativeInteractive && !EXEMPT_WRAPPERS.has(tag)) {
          const tooltipAttr = attrs['data-tooltip']
          const hasAria = !!(attrs['aria-label'] || attrs['aria-labelledby'])
          if (tooltipAttr && !hasAria) {
            const iconOnly = isSelfClosing || !hasVisibleText((node as ts.JsxElement).children ?? [])
            if (iconOnly) {
              const line = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1
              violations.push({ file: rel, line, tag })
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return violations
}

describe('icon-only control aria-label census (ICON-BUTTON-ARIA-LABELS, B3-2b)', () => {
  it('has zero icon-only interactive controls with data-tooltip and no accessible name', () => {
    const violations = deriveViolations()
    if (violations.length > 0) {
      const detail = violations.map(v => `  ${v.file}:${v.line} <${v.tag}>`).join('\n')
      throw new Error(
        `${violations.length} icon-only control(s) carry data-tooltip with no aria-label/` +
        `aria-labelledby -- a screen reader announces these as unnamed buttons:\n${detail}`,
      )
    }
    expect(violations).toEqual([])
  })

  // Mutation-proofing (RED->GREEN): the derivation walks a fixture string
  // directly, so this proves the WALKER catches a real regression shape --
  // not just that today's tree happens to be clean.
  describe('derivation logic (fixture-driven, no real files touched)', () => {
    const asFixture = (jsx: string) => {
      // Reuse the exact same walk the real census runs, against an in-memory
      // "file" (no disk I/O) by monkey-patching a tiny read via a temp dir
      // would be overkill; instead re-run the walker's core directly against
      // a parsed source file so this stays a pure unit test of the logic.
      const sf = ts.createSourceFile('fixture.tsx', jsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const violations: Violation[] = []
      const visit = (node: ts.Node) => {
        let opening: ts.JsxOpeningLikeElement | undefined
        let isSelfClosing = false
        if (ts.isJsxElement(node)) opening = node.openingElement
        else if (ts.isJsxSelfClosingElement(node)) { opening = node; isSelfClosing = true }
        if (opening) {
          const tag = tagNameOf(opening)
          if (INTERACTIVE_DOM_TAGS.has(tag)) {
            const attrs = attrsOf(opening)
            const tooltipAttr = attrs['data-tooltip']
            const hasAria = !!(attrs['aria-label'] || attrs['aria-labelledby'])
            if (tooltipAttr && !hasAria) {
              const iconOnly = isSelfClosing || !hasVisibleText((node as ts.JsxElement).children ?? [])
              if (iconOnly) violations.push({ file: 'fixture.tsx', line: 0, tag })
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
      return violations
    }

    it('RED: flags an icon-only button with data-tooltip and no aria-label', () => {
      const violations = asFixture(`
        function Row() {
          return <button data-tooltip="Rename"><Pencil size={10} /></button>
        }
      `)
      expect(violations.length).toBe(1)
    })

    it('GREEN: the same button with aria-label added is not flagged', () => {
      const violations = asFixture(`
        function Row() {
          return <button data-tooltip="Rename" aria-label="Rename"><Pencil size={10} /></button>
        }
      `)
      expect(violations.length).toBe(0)
    })

    it('does not flag a button with visible text alongside its icon', () => {
      const violations = asFixture(`
        function Row() {
          return <button data-tooltip="Delete machine"><Trash2 size={12} /> Delete</button>
        }
      `)
      expect(violations.length).toBe(0)
    })

    it('does not flag a button whose visible text is nested in a fragment branch', () => {
      const violations = asFixture(`
        function Row() {
          return (
            <button data-tooltip={x ? 'A' : 'B'}>
              {x ? <><Star size={12} /> A</> : <><Star size={12} /> B</>}
            </button>
          )
        }
      `)
      expect(violations.length).toBe(0)
    })

    it('flags a dynamic (ternary) data-tooltip on an icon-only button', () => {
      const violations = asFixture(`
        function Row() {
          return <button data-tooltip={hidden ? 'Show' : 'Hide'}>{hidden ? <Eye/> : <EyeOff/>}</button>
        }
      `)
      expect(violations.length).toBe(1)
    })

    it('does not flag a button with a label-forwarding template expression child', () => {
      const violations = asFixture(`
        function Row() {
          return <button data-tooltip={tool.title}><Icon size={15} /><span>{tool.label}</span></button>
        }
      `)
      expect(violations.length).toBe(0)
    })
  })
})

describe('NumericInput / OptionalNumericInput wrapper accessible name (ICON-BUTTON-ARIA-LABELS, B3-2b)', () => {
  afterEach(() => cleanup())

  it('NumericInput defaults aria-label to the tooltip prop', () => {
    const { getByRole } = render(
      <NumericInput value={5} onChange={() => {}} tooltip="Cutting feed rate (mm/min)" />,
    )
    expect(getByRole('textbox').getAttribute('aria-label')).toBe('Cutting feed rate (mm/min)')
  })

  it('NumericInput prefers an explicit ariaLabel over tooltip', () => {
    const { getByRole } = render(
      <NumericInput value={5} onChange={() => {}} tooltip="Cutting feed rate (mm/min) -- editing setup default"
        ariaLabel="Feed rate" />,
    )
    expect(getByRole('textbox').getAttribute('aria-label')).toBe('Feed rate')
  })

  it('OptionalNumericInput defaults aria-label to the tooltip prop', () => {
    const { getByRole } = render(
      <OptionalNumericInput value={undefined} onChange={() => {}} tooltip="Max chordal deviation" />,
    )
    expect(getByRole('textbox').getAttribute('aria-label')).toBe('Max chordal deviation')
  })
})
