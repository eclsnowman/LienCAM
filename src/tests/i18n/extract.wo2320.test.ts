// @vitest-environment jsdom
// Recorded from main before extraction. Production stores/components; only
// WebGL is stubbed. Build provenance is normalized because commits change it.
import { readFileSync, writeFileSync } from 'node:fs'
import { createElement as h, type ReactElement } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

// WO-2977: the console fixture event is at epoch 0 and the golden was recorded in US Central time
// (06:00:00 PM). Pin the zone so a UTC Linux host renders the same clock text.
const hostTimeZone = process.env.TZ
process.env.TZ = 'America/Chicago'
afterAll(() => { if (hostTimeZone === undefined) delete process.env.TZ; else process.env.TZ = hostTimeZone })
const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: (k: string) => memory.get(k) ?? null,
  key: (i: number) => [...memory.keys()][i] ?? null,
  removeItem: (k: string) => memory.delete(k), setItem: (k: string, v: string) => memory.set(k, String(v)),
} })
vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({ Viewport: () => h('div') }))
const { default: App } = await import('../../App')
const { TopToolbar } = await import('../../components/toolbar/TopToolbar')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { HelpCenterModal } = await import('../../components/modals/HelpCenterModal')
const { HelpFigure } = await import('../../components/modals/HelpFigure')
const { ConfirmModal } = await import('../../components/modals/ConfirmModal')
const { TreeContextMenu } = await import('../../components/panels/TreeContextMenu')
const { TreeRenameLabel } = await import('../../components/panels/TreeRenameLabel')
const { DesignTree } = await import('../../components/panels/DesignTree')
const { BottomConsole } = await import('../../components/panels/BottomConsole')
const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { NumericInput, OptionalNumericInput } = await import('../../components/ui/NumericInput')
const { RefPlaneSelect } = await import('../../components/ui/RefPlaneSelect')
const { HelpLink } = await import('../../components/ui/HelpLink')
const { DisclosureSection } = await import('../../components/ui/DisclosureSection')
const { CollapsiblePanel } = await import('../../components/common/CollapsiblePanel')
const { helpIndex, loadTopic } = await import('../../help/registry')
const { openHelpTopic } = await import('../../help/helpOpen')
const { i18n } = await import('../../i18n')
// WO-2620: re-recorded after WO-2591, WO-2609 and WO-2612 rewrote seven Help
// topics (post-options and machine Help); every other key is WO-2593's, byte for byte.
// WO-2650: WO-2626 corrected Help and WO-2628 added the PC-move topic.
// WO-2883: re-recorded the `help *` keys only (146 topics, updating-liencam added);
// every non-help key is left as it was.
const golden = 'src/tests/evidence/WO-2685/english-main.wo2320.json'
const noop = () => {}

function englishOf(): { text: string; attributes: string[] } {
  const root = document.body.cloneNode(true) as HTMLElement
  for (const id of ['settings-build-info', 'settings-app-version']) {
    root.querySelectorAll(`[data-testid="${id}"]`).forEach(n => { n.textContent = `<${id}>` })
  }
  const attributes: string[] = []
  for (const n of root.querySelectorAll('*')) {
    for (const key of ['title', 'aria-label', 'placeholder', 'alt', 'aria-description', 'data-tooltip']) {
      const value = n.getAttribute(key)
      if (value !== null) attributes.push(`${key}=${value}`)
    }
  }
  return { text: root.textContent ?? '', attributes }
}
afterEach(cleanup)

// Exercise translated values through production components without shipping a
// pilot catalog. Include the erroneous identifier entries to catch regressions.
async function withAuditLanguage(check: () => void | Promise<void>) {
  i18n.addResourceBundle('de', 'language', { label: 'Oberflaechensprache' }, true, true)
  i18n.addResourceBundle('de', 'app-shell-settings-menus', {
    SettingsModal: { label: 'Bezeichnung' },
    DesignTree: { toolpath: 'bahn:{{setupId}}:{{opId}}', sketch: 'skizze:{{geoId}}:{{layerId}}', vise: 'schraubstock:{{id}}', section: 'Schnitt', section2: 'Schnitt {{value}}' },
    TreeContextMenu: { show: 'Anzeigen', hide: 'Verbergen', lock: 'Sperren', unlock: 'Entsperren' },
    TreeMenuLabels: { show: 'Anzeigen', hide: 'Verbergen', lock: 'Sperren', unlock: 'Entsperren' },
    BottomConsole: { all: 'alle', info: 'hinweis', success: 'erfolg', warning: 'warnung', error: 'fehler' },
  }, true, true)
  try {
    await act(async () => { await i18n.changeLanguage('de') })
    await check()
  } finally {
    cleanup()
    await act(async () => { await i18n.changeLanguage('en') })
    i18n.removeResourceBundle('de', 'language')
    i18n.removeResourceBundle('de', 'app-shell-settings-menus')
  }
}

it('WO-2320 audit: language picker uses the language catalog label', async () => {
  await withAuditLanguage(() => {
    act(() => useCamStore.getState().openModal('settings'))
    render(h(SettingsModal))
    expect(document.querySelector('[data-testid="settings-language"]')?.getAttribute('aria-label')).toBe('Oberflaechensprache')
  })
})

it('WO-2320 audit: export menu keeps operation and sketch row ids fixed', async () => {
  const { useExportCenter } = await import('../../lib/exportCenter')
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState(s => ({ activeModal: null, workspace: 'cam', activeSketch: null,
      project: { ...s.project, activeSetupId: 'su1', geometry: [{
        id: 'g1', name: 'Sketches', filename: '', type: '2d', format: 'sketch', loaded: true,
        boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 1 } },
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loops: [],
        layers2d: [{ id: 'l1', name: 'Outline', visible: true, sourceType: 'sketch' }],
        sketches: [{ id: 'sk1', layerId: 'l1', ownerGeometryId: 'g1', entities: [], constraints: [], dimensions: [], solveStatus: null }],
      } as unknown as import('../../types').ImportedGeometry], setups: [{
        id: 'su1', name: 'Setup', notes: '',
        wcs: { id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } },
        operations: [{ id: 'op1', name: 'Contour', type: 'contour_2d', enabled: true, status: 'pending', toolId: 't1', geometrySelections: [], heights: {}, passes: {}, linking: {}, params: {} }],
      } as unknown as import('../../types').Setup] },
    }))
    useUiPrefs.setState({ treeGeometryExpanded: true, treeSetupsExpanded: true, expandedSetupIds: ['su1'], collapsedPartIds: [], collapsedFolderIds: [] })
  })
  await withAuditLanguage(() => {
    for (const [testId, rowId] of [['tree-name-op', 'toolpath:su1:op1'], ['tree-name-layer', 'sketch:g1:l1']]) {
      cleanup()
      useExportCenter.setState({ pickedRowId: null })
      render(h(DesignTree))
      fireEvent.contextMenu(document.querySelector(`[data-testid="${testId}"]`)!)
      const item = document.querySelector('[data-testid="tree-context-menu"] [data-action="export"]')
      expect(item, rowId).not.toBeNull()
      fireEvent.click(item!)
      expect(useCamStore.getState().activeModal).toBe('export')
      expect(useExportCenter.getState().pickedRowId).toBe(rowId)
    }
  })
})

it('WO-2320 audit: vise collapse key survives a language switch', async () => {
  act(() => {
    useCamStore.getState().newProject()
    for (const [id, y] of [['fixed', 0], ['jaw', 50]] as const) useCamStore.getState().addGeometry({
      id, name: id, filename: `${id}.stl`, type: 'mesh', format: 'stl', loaded: true, workholding: true,
      boundingBox: { min: { x: -50, y: -10, z: 0 }, max: { x: 50, y: 10, z: 40 }, size: { x: 100, y: 20, z: 40 }, center: { x: 0, y: 0, z: 20 } },
      position: { x: 0, y, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    })
    useCamStore.getState().makeVise({ name: 'Bench vise', fixedGeometryId: 'fixed', jawGeometryId: 'jaw', slide: { kind: 'jaw-axis', axis: 'y' }, minMm: 0, maxMm: 60, setupId: null })
    const id = useCamStore.getState().project.workholding!.instances[0].id
    useUiPrefs.setState({ treeGeometryExpanded: true, collapsedPartIds: [], collapsedFolderIds: [`vise:${id}`] })
  })
  await withAuditLanguage(() => {
    render(h(DesignTree))
    const row = document.querySelector('[data-testid="tree-vise-row"]')!
    expect(row.querySelector('.tree-part-collapse')?.getAttribute('data-tooltip')).toBe('Show its bodies')
    fireEvent.click(row.querySelector('.tree-part-collapse')!)
    const id = useCamStore.getState().project.workholding!.instances[0].id
    expect(useUiPrefs.getState().collapsedFolderIds).not.toContain(`vise:${id}`)
    expect(row.querySelector('.tree-part-collapse')?.getAttribute('data-tooltip')).toBe('Hide its bodies')
  })
})

it('WO-2320 audit: menu translates Show Hide Lock and Unlock at the rendering boundary', async () => {
  await withAuditLanguage(() => {
    for (const [visible, locked, showHide, lockUnlock] of [[true, false, 'Verbergen', 'Sperren'], [false, true, 'Anzeigen', 'Entsperren']] as const) {
      cleanup()
      render(h(TreeContextMenu, { at: { x: 10, y: 10 }, target: { kind: 'layer', geoId: 'g', layerId: 'l', sketchEditable: true, canRename: true, visible, locked }, onAction: noop, onClose: noop }))
      expect(document.querySelector('[data-action="layer-toggle-visibility"]')?.textContent).toBe(showHide)
      expect(document.querySelector('[data-action="layer-toggle-lock"]')?.textContent).toBe(lockUnlock)
    }
  })
})

it('WO-2320 audit: console translates chip contents while preserving severity filters', async () => {
  act(() => useCamStore.setState({ consoleEvents: [
    { id: 1, at: 0, severity: 'error', source: 'fixture', message: 'Error event' },
    { id: 2, at: 0, severity: 'info', source: 'fixture', message: 'Info event' },
  ], consoleReadThroughId: 0 }))
  await withAuditLanguage(() => {
    render(h<import('../../components/panels/BottomConsole').BottomConsoleProps>(BottomConsole, { defaultExpanded: true }))
    for (const [id, label] of [['all', 'alle'], ['info', 'hinweis'], ['success', 'erfolg'], ['warning', 'warnung'], ['error', 'fehler']]) {
      expect(document.querySelector(`[data-testid="console-filter-${id}"]`)?.textContent).toBe(label)
    }
    fireEvent.click(document.querySelector('[data-testid="console-filter-error"]')!)
    expect(document.querySelector('[data-testid="console-event-1"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="console-event-2"]')).toBeNull()
  })
})

it('WO-2320 audit: section counter retains English-named sections after a language switch', async () => {
  const modelClient = await import('../../lib/cam/geometry/occt/model/modelClient')
  const derive = vi.spyOn(modelClient, 'deriveSection').mockResolvedValue({ z: 0, loops: [{
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, type: 'contour', area: 50,
  }] })
  const globals = window as unknown as Record<string, unknown>
  const previous = globals.__cncViewport
  globals.__cncViewport = {
    enterBrepWorldSliceMode: (_id: string, _preview: unknown, confirm: (z: number) => void) => { confirm(0); return true },
    worldHorizontalSectionPlane: () => ({ origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], yAxis: [0, 1, 0] }),
    enterTargetPlaneMode: (_id: string, confirm: (normal: { x: number; y: number; z: number }, centroid: { x: number; y: number; z: number }) => void) => confirm({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }),
  }
  try {
    act(() => {
      useCamStore.getState().newProject()
      useCamStore.getState().addGeometry({ id: 'step1', name: 'Step part', filename: 'part.step', type: 'mesh', format: 'step', loaded: true,
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
        boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 }, size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 } },
        layers2d: [{ id: 'section1', name: 'Section 1', visible: true, color: '#ff0000' }], loops: [],
      })
      useUiPrefs.setState({ treeGeometryExpanded: true, collapsedPartIds: [], collapsedFolderIds: [] })
    })
    await withAuditLanguage(async () => {
      render(h(DesignTree))
      fireEvent.click(document.querySelector('[data-testid="tree-step-section"]')!)
      await waitFor(() => expect(useCamStore.getState().project.geometry[0].layers2d).toHaveLength(2))
      expect(useCamStore.getState().project.geometry[0].layers2d?.[1].name).toBe('Schnitt 2')
    })
  } finally {
    derive.mockRestore()
    if (previous === undefined) delete globals.__cncViewport
    else globals.__cncViewport = previous
  }
})

it('WO-2320 matches main English across shell, settings, help, menus and common controls', async () => {
  const out: Record<string, ReturnType<typeof englishOf>> = {}
  const snap = (name: string) => {
    out[name] = englishOf()
    if (Object.keys(out).length % 25 === 0) console.log(`WO-2320 recorded ${Object.keys(out).length} component states`)
  }
  const mount = (name: string, element: ReactElement) => { cleanup(); render(element); snap(name) }
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ activeModal: null, consoleEvents: [], consoleReadThroughId: 0 })
    useCamStore.getState().setWorkspace('cam')
    useUiPrefs.setState({ language: 'en' })
  })
  render(h(App))
  snap('cam shell and empty design tree')
  act(() => useCamStore.getState().openModal('settings'))
  await waitFor(() => expect(document.querySelector('[data-testid="user-data-storage-status"]')?.textContent).not.toContain('Inspecting'))
  snap('settings and storage')
  act(() => useCamStore.getState().closeModal())
  fireEvent.click(document.querySelector('[data-testid="console-strip"]')!)
  snap('expanded empty console')
  act(() => useCamStore.getState().setWorkspace('control'))
  await waitFor(() => expect(document.querySelector('[data-testid="control-workspace-loading"]')).toBeNull(), { timeout: 30000 })
  snap('control shell')
  act(() => useCamStore.getState().setWorkspace('cam'))
  cleanup()
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.getState().addGeometry({
      id:'g1',name:'Fixture part',filename:'fixture.dxf',type:'curves_2d',format:'dxf',loaded:true,
      boundingBox:{min:{x:0,y:0,z:0},max:{x:10,y:10,z:0},size:{x:10,y:10,z:0},center:{x:5,y:5,z:0}},
      position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},
      layers2d:[{id:'l1',name:'Fixture layer',color:'#ff0000',visible:true}],
      loops:[{id:'lp1',layerId:'l1',closed:true,type:'contour',area:50,points:[{x:0,y:0},{x:10,y:0},{x:10,y:10}]}],
    })
    useCamStore.getState().addFixedStock({id:'fs1',name:'Fixture stock',width:100,height:80,depth:10,position:{x:0,y:0,z:0}})
    useCamStore.setState(s=>({project:{...s.project,activeSetupId:'su1',activeOperationId:null,setups:[{
      id:'su1',name:'Fixture setup',wcs:{id:'w1',label:'G54',fixtureOffset:54,origin:{x:0,y:0,z:0},xAxis:{x:1,y:0,z:0},yAxis:{x:0,y:1,z:0},zAxis:{x:0,y:0,z:1}},
      operations:[{id:'op1',name:'Fixture operation',type:'contour_2d',enabled:true,status:'pending',toolId:'t1',geometrySelections:[],heights:{},passes:{},linking:{},params:{}} as unknown as import('../../types').Operation],notes:'',
    } as import('../../types').Setup]}}))
    useUiPrefs.setState({treeStockExpanded:true,treeGeometryExpanded:true,treeSetupsExpanded:true,expandedSetupIds:['su1'],expandedStockIds:['fs1'],expandedLayerKeys:['g1:l1'],collapsedPartIds:[],collapsedFolderIds:[]})
  })
  render(h(DesignTree)); snap('populated design tree')
  fireEvent.click(document.querySelector('[data-testid="tree-collapse-all"]')!); snap('collapsed design tree')
  fireEvent.click(document.querySelector('[data-testid="tree-expand-all"]')!)
  for (const status of ['computing','error','degraded','outdated','unsupported','ready'] as const) {
    act(()=>useCamStore.setState(s=>({project:{...s.project,setups:s.project.setups.map(setup=>({...setup,operations:setup.operations.map(op=>({...op,status}))}))}})))
    snap(`design tree operation ${status}`)
  }
  fireEvent.change(document.querySelector('[data-testid="tree-filter-input"]')!,{target:{value:'zzzz-no-match'}}); snap('tree no matching filter')
  cleanup()
  act(()=>useCamStore.setState({consoleEvents:[{id:1,at:0,severity:'error',source:'fixture',message:'Controller fixture stays English'}],consoleReadThroughId:0}))
  render(h<import('../../components/panels/BottomConsole').BottomConsoleProps>(BottomConsole,{defaultExpanded:true})); snap('console error event')
  for(const severity of ['info','success','warning','error','all']) {
    fireEvent.click(document.querySelector(`[data-testid="console-filter-${severity}"]`)!); snap(`console filter ${severity}`)
  }
  act(()=>useCamStore.setState({consoleEvents:[],activeModal:null}))
  cleanup()
  render(h(HelpCenterModal))
  for (const topic of helpIndex()) {
    const body = await loadTopic(topic.id)
    act(() => openHelpTopic(topic.id))
    const marker = body?.sections.find(s => s.kind === 'paragraph' || s.kind === 'steps' || s.kind === 'heading')
    const bodyText = marker && ('text' in marker ? marker.text : 'steps' in marker ? marker.steps[0] : topic.title)
    await waitFor(() => {
      expect(document.querySelector('[data-testid="help-topic-content"] h2')?.textContent).toBe(topic.title)
      expect(document.querySelector('[data-testid="help-topic-content"]')?.textContent).toContain(bodyText ?? topic.title)
    })
    snap(`help ${topic.id}`)
  }
  fireEvent.change(document.querySelector('[data-testid="help-search"]')!, { target: { value: 'zzzz-no-topic' } })
  snap('help no results')
  cleanup()
  act(() => {
    useCamStore.getState().closeModal()
    void useCamStore.getState().requestConfirm({ title: 'Fixture confirmation', body: 'Fixture body', confirmLabel: 'Proceed', tone: 'danger' })
  })
  render(h(ConfirmModal)); snap('confirm danger')
  act(() => useCamStore.getState().resolveConfirm(false))
  mount('help figure', h(HelpFigure, { src: '/help/fixture.png', alt: 'Fixture figure' }))
  fireEvent.click(document.querySelector('figure')!); snap('help figure lightbox')
  const targets: import('../../lib/tree/treeContextMenu').TreeContextTarget[] = [
    {kind:'setup',setupId:'s'}, {kind:'op',setupId:'s',opId:'o',index:0,count:2,status:'idle'},
    {kind:'geometry',geoId:'g',canToggleVisibility:true,hidden:false,wrappable:true,booleanSource:true,multiBodySplit:true},
    {kind:'layer',geoId:'g',layerId:'l',sketchEditable:true,canRename:true,locked:false,visible:true},
    {kind:'model-item',modelItemId:'m'}, {kind:'stock-fixed',stockId:'s',gizmoActive:false},
    {kind:'stock-auto',stockId:'s'}, {kind:'folder',folderId:'f'},
    {kind:'op-folder',folderId:'f',setupId:'s',enableState:'mixed',hasOperations:true},
    {kind:'nest',nestId:'n',visible:true,stale:true},
  ]
  for (const target of targets) mount(`menu ${target.kind}`, h(TreeContextMenu, { at:{x:10,y:10},target,onAction:noop,onClose:noop,onExport:noop }))
  for (const target of targets) {
    const toggled = Object.assign({},target,{hidden:true,visible:false,locked:true,gizmoActive:true,enabled:false,status:'computing',enableState:'enabled' as const})
    mount(`menu alternate ${target.kind}`,h(TreeContextMenu,{at:{x:10,y:10},target:toggled,onAction:noop,onClose:noop,onExport:noop}))
  }
  mount('rename label', h(TreeRenameLabel,{name:'Bracket',editing:false,className:'tree-item-label',onStart:noop,onCommit:noop,onCancel:noop}))
  mount('numeric range', h(NumericInput,{value:4,min:1,max:10,units:'mm',tooltip:'Fixture depth',onChange:noop}))
  mount('optional numeric', h(OptionalNumericInput,{value:undefined,min:1,max:10,units:'mm',onChange:noop}))
  mount('reference planes',h(RefPlaneSelect,{value:'stock_top',onChange:noop}))
  mount('help link',h(HelpLink,{topic:'setup-wcs'}))
  mount('disclosure',h(DisclosureSection,{title:'Fixture section',children:'Fixture content'}))
  mount('collapsible',h(CollapsiblePanel,{panelKey:'wo2320',title:'Fixture panel',children:'Fixture content'}))
  fireEvent.click(document.querySelector('button')!); snap('collapsed panel')
  if(process.env.WO2320_RECORD === '1') writeFileSync(golden, JSON.stringify(out,null,2)+'\n')
  const expected = JSON.parse(readFileSync(golden,'utf8')) as typeof out
  expect(Object.keys(out)).toEqual(Object.keys(expected))
  for(const key of Object.keys(expected)) {
    // Compact diagnostics prevent a long Help body from hiding the differing
    // character among thousands of unchanged words.
    const actual = out[key], main = expected[key]
    let offset = 0
    while (offset < main.text.length && main.text[offset] === actual.text[offset]) offset++
    expect(actual.text === main.text, `${key}: text differs at ${offset}; main=${JSON.stringify(main.text.slice(offset,offset+100))}; actual=${JSON.stringify(actual.text.slice(offset,offset+100))}`).toBe(true)
    expect(actual.attributes,key).toEqual(main.attributes)
  }
},300000)

it('WO-2320 toolbar attributes match the main snapshot', () => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ activeModal: null, consoleEvents: [], consoleReadThroughId: 0 })
    useCamStore.getState().setWorkspace('cam')
    useUiPrefs.setState({ language: 'en' })
  })
  // The explicit negative run changes one loaded catalog value and must fail
  // this same main snapshot assertion. Restore even when that assertion throws.
  const key = 'TopToolbar.newProject'
  const original = i18n.getResource('en','app-shell-settings-menus',key) as string
  try {
    if (process.env.WO2320_NEGATIVE === '1') i18n.addResource('en','app-shell-settings-menus',key,'NEGATIVE CONTROL')
    render(h(TopToolbar, { showPartTab: true }))
    const main = JSON.parse(readFileSync(golden,'utf8')) as Record<string, ReturnType<typeof englishOf>>
    const shellAttributes = main['cam shell and empty design tree'].attributes
    const headerEnd = shellAttributes.indexOf('data-tooltip=Double-click to rename project')
    expect(headerEnd).toBeGreaterThan(0)
    expect(englishOf().attributes).toEqual(shellAttributes.slice(0,headerEnd))
  } finally {
    i18n.addResource('en','app-shell-settings-menus',key,original)
  }
})
