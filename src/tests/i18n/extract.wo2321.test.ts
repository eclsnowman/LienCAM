// @vitest-environment jsdom
import { createElement as h } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Operation } from '../../types'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => mem.set(k, String(v)),
  removeItem: (k: string) => mem.delete(k), clear: () => mem.clear(),
} })
const { useCamStore } = await import('../../store')
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { NestModal } = await import('../../components/modals/NestModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { SimulationPanel } = await import('../../components/simulation/SimulationPanel')
const { ViewportOverlay } = await import('../../components/viewport/ViewportOverlay')
const { ViewportToolbar } = await import('../../components/viewport/ViewportToolbar')
const { DisplayModeControl } = await import('../../components/viewport/DisplayModeControl')
const { ReachShortfallNotice } = await import('../../components/cam/ReachShortfallNotice')
const { ResolvedHeightPlanInspector } = await import('../../components/cam/ResolvedHeightPlanInspector')
const { SeatInViseStrip } = await import('../../components/viewport/SeatInViseStrip')
const { ToolpathFeedEstimatePanel, ToolpathFeedEstimateSummary } = await import('../../components/toolpath/ToolpathFeedEstimatePanel')
const { ViewportContextMenu } = await import('../../components/viewport/ViewportContextMenu')
const defaults = await import('../../components/modals/newOperationModalDefaults')
const { makeOp, makeTool } = await import('../post/helpers')
const { i18n } = await import('../../i18n')

afterEach(cleanup)
const golden = 'src/tests/evidence/WO-2593/goldens/english-main.wo2321.json'
function english(root: HTMLElement) {
  return { text: root.textContent, attributes: Array.from(root.querySelectorAll('*')).flatMap(el =>
    ['title', 'aria-label', 'placeholder', 'data-tooltip', 'alt'].flatMap(name =>
      el.hasAttribute(name) ? [`${name}=${el.getAttribute(name)}`] : [])) }
}

it('renders operation types and every wizard tab, nesting, properties, simulation and overlays identically to main', async () => {
  act(() => {
    useCamStore.getState().newProject()
    const st = useCamStore.getState()
    st.addSetup({ id: 'setup-test', name: 'Test Setup', wcs: {
      id: 'wcs-test', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    }, stock: { type: 'auto' }, operations: [], notes: '' } as unknown as Parameters<typeof st.addSetup>[0])
  })
  const actual: Record<string, ReturnType<typeof english>> = {}
  const capture = (name: string, root: HTMLElement) => { actual[name] = english(root) }
  let view = render(h(NewOperationModal))
  act(() => { useCamStore.getState().openModal('new-operation') })
  const types = Array.from(view.container.querySelectorAll('.op-type-name')).map(el => el.textContent!)
  // WO-2977: Run macro joined the operation types after this golden (operation:run-macro); 17 -> 18.
  expect(types.length).toBe(18)
  for (const type of types) {
    fireEvent.click(Array.from(view.container.querySelectorAll('button')).find(el => el.textContent?.trim() === 'Type & Name')!)
    fireEvent.click(Array.from(view.container.querySelectorAll('.op-type-card')).find(el => el.textContent?.trim() === type)!)
    const tabs = Array.from(view.container.querySelectorAll('.op-modal-tabs button')).map(el => el.textContent!)
    for (const tab of tabs) {
      fireEvent.click(Array.from(view.container.querySelectorAll('.op-modal-tabs button')).find(el => el.textContent === tab)!)
      capture(`${type}/${tab}`, view.container)
    }
  }
  view.unmount()
  act(() => { useCamStore.getState().openModal('new-nest') })
  view = render(h(NestModal)); capture('nest', view.container); view.unmount()
  act(() => { useCamStore.getState().closeModal() })
  view = render(h(PropertiesPanel)); capture('properties', view.container); view.unmount()
  const opParams = {
    contour_2d: defaults.defaultContourParams, pocket_2d: defaults.defaultPocketParams,
    drill: defaults.defaultDrillParams, bore: defaults.defaultBoreParams, face: defaults.defaultFaceParams,
    engrave: defaults.defaultEngraveParams, chamfer: defaults.defaultChamferParams,
    vcarve: defaults.defaultVCarveParams, thread_mill: defaults.defaultThreadMillParams,
    adaptive_clearing_2d: defaults.defaultACParams,
  }
  for (const [type, params] of Object.entries(opParams)) {
    const op = makeOp({ type: type as Operation['type'], params: { ...params }, toolpathMoves: [] })
    act(() => {
      const st = useCamStore.getState()
      useCamStore.setState({ toolLibrary: [makeTool()], project: { ...st.project,
        activeOperationId: op.id, setups: st.project.setups.map(s => ({ ...s, operations: [op] })) } })
    })
    view = render(h(PropertiesPanel)); capture(`properties/${type}`, view.container); view.unmount()
  }
  act(() => { const st = useCamStore.getState(); useCamStore.setState({ project: { ...st.project, activeOperationId: null,
    setups: st.project.setups.map(s => ({ ...s, operations: [] })) } }) })
  view = render(h(SimulationPanel)); capture('simulation', view.container); view.unmount()
  for (const interactionMode of ['normal', 'lay-on-face', 'project-plane'] as const) {
    view = render(h(ViewportOverlay, { interactionMode })); capture(`overlay/${interactionMode}`, view.container); view.unmount()
    view = render(h(ViewportToolbar, { interactionMode, viewport: { current: null }, onEnterLayOnFace() {}, onExitLayOnFace() {}, onEnterProjectPlane() {}, onExitProjectPlane() {} }))
    capture(`toolbar/${interactionMode}`, view.container); view.unmount()
  }
  view = render(h(DisplayModeControl)); capture('display', view.container); view.unmount()
  view = render(h(DisplayModeControl)); fireEvent.click(view.container.querySelector('button')!); capture('display/open', view.container); view.unmount()
  view = render(h(ToolpathFeedEstimatePanel, { showEmpty: true })); capture('feed/empty', view.container); view.unmount()
  view = render(h(ToolpathFeedEstimateSummary, { operationName: 'Fixture operation', units: 'mm', commandedFeedMmMin: 1200, estimate: null }))
  capture('feed/summary', view.container); view.unmount()
  for (const kind of ['empty', 'part', 'stock'] as const) {
    view = render(h(ViewportContextMenu, { at: { x: 0, y: 0 }, target: kind === 'empty' ? { kind } : { kind, id: 'fixture', label: 'Fixture' },
      visibility: { stock: true, workpiece: false, toolpath: true, grid: false }, onAction() {}, onClose() {} }))
    capture(`context/${kind}`, view.container); view.unmount()
  }
  view = render(h(SeatInViseStrip)); capture('seat-in-vise', view.container); view.unmount()
  view = render(h(ReachShortfallNotice, { shortfall: { reachedZ: -2, askedZ: -5, uncutMm: 3 } }))
  capture('reach', view.container); view.unmount()
  view = render(h(ResolvedHeightPlanInspector, { refusal: { code: 'fixture', message: 'Fixture refusal' }, repairMessage: 'Fixture repair' }))
  capture('height-inspector', view.container); view.unmount()
  if (process.env.WO2321_RECORD === '1') writeFileSync(golden, JSON.stringify(actual, null, 2) + '\n')
  const expected = JSON.parse(readFileSync(golden, 'utf8'))
  expect(Object.keys(actual)).toEqual(Object.keys(expected))
  for (const [name, words] of Object.entries(actual)) expect(words, name).toEqual(expected[name])
}, 60_000)

it('updates mounted UI and module-level tab labels when the language changes', async () => {
  act(() => { useCamStore.getState().openModal('new-operation') })
  const view = render(h(NewOperationModal))
  expect(view.container.textContent).toContain('Type & Name')
  i18n.addResourceBundle('wo2321-test', 'cam-operations-new-operation', {
    newOperationModalDefaults: { Type_Name: 'Translated type tab' },
    NewOperationModalBody: { Operation_type: 'Translated operation type' },
  })
  try {
    await act(async () => { await i18n.changeLanguage('wo2321-test') })
    expect(view.container.textContent).toContain('Translated type tab')
    expect(view.container.textContent).toContain('Translated operation type')
  } finally {
    await act(async () => { await i18n.changeLanguage('en') })
    i18n.removeResourceBundle('wo2321-test', 'cam-operations-new-operation')
    act(() => { useCamStore.getState().closeModal() })
  }
})
import { readdirSync } from 'node:fs'
import ts from 'typescript'

it('routes custom tooltip and ariaLabel prose through the catalog, including expression and template forms', () => {
  const files = [
    'modals/NewOperationModal.tsx', 'modals/NewOperationModalBody.tsx',
    'modals/newOperationModalDefaults.tsx', 'modals/newOperationModalParts.tsx',
    'modals/newOperationMachiningBoundaryPickPresentation.ts', 'modals/useNewOperationModalState.ts',
    'modals/NestModal.tsx', 'modals/nestPicker.ts',
    'panels/PropertiesPanel.tsx', 'panels/RoughingScopeSelector.tsx',
    ...['cam', 'toolpath', 'simulation', 'viewport'].flatMap(dir =>
      readdirSync(`src/components/${dir}`).filter(f => /\.tsx?$/.test(f)).map(f => `${dir}/${f}`)),
  ]
  const remaining: string[] = []
  for (const file of files) {
    const source = readFileSync(`src/components/${file}`, 'utf8')
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    function prose(expr: ts.Node): boolean {
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return /[a-zA-Z]/.test(expr.text)
      if (ts.isTemplateExpression(expr)) return /[a-zA-Z]/.test(expr.head.text + expr.templateSpans.map(s => s.literal.text).join(''))
      if (ts.isBinaryExpression(expr)) return prose(expr.left) || prose(expr.right)
      if (ts.isParenthesizedExpression(expr)) return prose(expr.expression)
      if (ts.isConditionalExpression(expr)) return prose(expr.whenTrue) || prose(expr.whenFalse)
      return false
    }
    function visit(node: ts.Node) {
      if (ts.isJsxAttribute(node) && /^(tooltip|ariaLabel)$/.test(node.name.getText(ast)) && node.initializer) {
        const expr = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer
        if (expr && prose(expr)) remaining.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1} ${node.getText(ast)}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  expect(remaining).toEqual([])
})

it('updates the mounted NumericInput tooltip and accessible name from a translated template', async () => {
  const view = render(h(DisplayModeControl))
  fireEvent.click(view.container.querySelector('button')!)
  const input = view.container.querySelector<HTMLInputElement>('input[data-tooltip^="Grid spacing"]')!
  expect(input).not.toBeNull()
  const original = input.getAttribute('aria-label')!
  expect(original).toBe('Grid spacing (mm)')
  const rangeSuffix = ': 5 to 1000 mm'
  expect(input.getAttribute('data-tooltip')).toBe(original + rangeSuffix)
  const unit = original.slice('Grid spacing ('.length, -1)
  i18n.addResourceBundle('wo2321-numeric', 'cam-operations-new-operation', {
    DisplayModeControl: { Grid_spacing_tooltip: 'Spacing for {{p1}}' },
  })
  try {
    await act(async () => { await i18n.changeLanguage('wo2321-numeric') })
    expect(input.getAttribute('data-tooltip')).toBe(`Spacing for ${unit}${rangeSuffix}`)
    expect(input.getAttribute('aria-label')).toBe(`Spacing for ${unit}`)
  } finally {
    await act(async () => { await i18n.changeLanguage('en') })
    i18n.removeResourceBundle('wo2321-numeric', 'cam-operations-new-operation')
  }
})
