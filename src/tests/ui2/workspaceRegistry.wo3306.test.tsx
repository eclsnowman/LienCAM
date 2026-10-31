// @vitest-environment jsdom
//
// WO-3306 (UI M2 Wave 2 seam): the workspace registry. A lane adds to the New UI shell from its own
// folder by exporting one `registration`; the shell reads only the registry. A slot nobody
// registered keeps today's hosted panel, and the shell's own ribbon table is the registry's first
// registration, so nothing registered looks and acts exactly as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement as h } from 'react'
import { READY } from '../../commands'
import { resolveMessage } from '../../notices'
import { useCamStore } from '../../store'
import {
  RegistryConflictError, WorkspaceRegistryProvider, collectRegistrations, createDefaultRegistry, createWorkspaceRegistry,
  useWorkspaceRegistry, workspaceRegistry, type WorkspaceRegistration, type WorkspaceRegistry,
} from '../../ui2/registry'
import { Ui2Shell } from '../../ui2/shell'

vi.mock('../../ui2/shell/hosts', async () => {
  const { createElement: el } = await import('react')
  const { typedMock } = await import('../support/typedMock')
  const stand = (id: string) => () => el('div', { 'data-testid': id })
  return typedMock<typeof import('../../ui2/shell/hosts')>({
    BrowserHost: stand('host-browser'),
    PropertiesHost: stand('host-properties'),
    ConsoleHost: stand('host-console'),
    MachineStatusHost: () => el('span', { 'data-testid': 'host-machine-status' }),
    ViewportHost: stand('host-viewport'),
    ModelWorkspaceHost: stand('host-model'),
    ControlWorkspaceHost: stand('host-control'),
    WindowHosts: ({ replaced }: { replaced?: ReadonlySet<string> }) => el('div', { 'data-testid': 'host-windows', 'data-replaced': [...(replaced ?? [])].sort().join(',') }),
    useAppWiring: () => {},
  })
})

const LABEL = {
  nest: 'ui2-shell.wo3285:actNest',
  machine: 'ui2-shell.wo3285:actMachine',
  caption: 'ui2-shell.wo3285:groupOutput',
  exit: 'ui2-shell.wo3285:browserClose',
} as const

const fresh = (...lanes: WorkspaceRegistration[]): WorkspaceRegistry => {
  const registry = createDefaultRegistry({ modules: {} })
  for (const lane of lanes) registry.register(lane)
  return registry
}
const ids = (items: readonly { readonly id: string }[]) => items.map(i => i.id)
const Stand = (id: string) => () => h('div', { 'data-testid': id }, id)

function shellWith(registry: WorkspaceRegistry) {
  return render(<WorkspaceRegistryProvider registry={registry}><Ui2Shell /></WorkspaceRegistryProvider>)
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/?newui=1')
  useCamStore.setState({ workspace: 'cam', activeModal: null, viewer: { ...useCamStore.getState().viewer, mode: 'setup' } })
})
afterEach(cleanup)

describe('WO-3306 the shell\'s own table is the registry\'s first registration', () => {
  it('offers in every workspace exactly the groups and actions the shipped table offered', () => {
    const registry = fresh()
    const table = (w: 'setup' | 'sketch' | 'model' | 'toolpath' | 'simulate' | 'control') =>
      registry.ribbonGroups(w).map(g => `${g.id}:${ids(g.actions).join('+')}`)
    const project = 'project:new+open+save+export'
    expect(table('setup')).toEqual([project, 'setup:new-setup+machine+nest'])
    expect(table('sketch')).toEqual([project, 'sketch:edit-sketch'])
    expect(table('model')).toEqual([project, 'model:new-model'])
    expect(table('toolpath')).toEqual([project, 'toolpath:new-operation', 'output:post'])
    expect(table('simulate')).toEqual([project, 'output:post'])
    expect(table('control')).toEqual([])
  })

  it('lists every action once, at the first place it shows, for command search', () => {
    const places = fresh().ribbonPlaces().map(p => `${p.action.id}@${p.workspace}/${p.group.id}`)
    expect(places).toEqual([
      'new@setup/project', 'open@setup/project', 'save@setup/project', 'export@setup/project',
      'new-setup@setup/setup', 'machine@setup/setup', 'nest@setup/setup', 'edit-sketch@sketch/sketch',
      'new-model@model/model', 'new-operation@toolpath/toolpath', 'post@toolpath/output',
    ])
  })

  it('has the Show card rows of the shipped overlay, in its order, on the CAM tabs only', () => {
    const registry = fresh()
    expect(ids(registry.showRows('setup'))).toEqual(['showStock', 'showWorkpiece', 'showToolpath', 'showMachine', 'showGrid', 'showAxes'])
    expect(registry.showRows('toolpath')).toHaveLength(6)
    expect(registry.showRows('model')).toHaveLength(0)
    expect(registry.showRows('control')).toHaveLength(0)
  })

  it('names every label with a key the catalogue resolves in English', () => {
    const registry = fresh()
    const keys = new Set<string>()
    for (const w of ['setup', 'sketch', 'model', 'toolpath', 'simulate', 'control'] as const) {
      for (const g of registry.ribbonGroups(w)) { keys.add(g.captionKey); for (const a of g.actions) keys.add(a.labelKey) }
      for (const r of registry.showRows(w)) keys.add(r.labelKey)
    }
    expect(keys.size).toBeGreaterThan(10)
    for (const key of keys) expect(resolveMessage(key as never), key).not.toBe(key.slice(key.indexOf(':') + 1))
  })

  it('collects without a conflict from the real tree', () => {
    expect(() => createDefaultRegistry()).not.toThrow()
    expect(ids(workspaceRegistry.ribbonGroups('setup'))).toContain('project')
  })
})

describe('WO-3306 registering', () => {
  it('orders groups across lanes by their order key, ties by registration order, and "all" shows everywhere', () => {
    const registry = fresh(
      { owner: 'a', ribbonGroups: [{ id: 'late', workspace: 'toolpath', order: 900, captionKey: LABEL.caption, actions: [] }] },
      {
        owner: 'b',
        ribbonGroups: [
          { id: 'early', workspace: ['toolpath', 'setup'], order: 50, captionKey: LABEL.caption, actions: [] },
          { id: 'everywhere', workspace: 'all', order: 150, captionKey: LABEL.caption, actions: [] },
          { id: 'tie', workspace: 'toolpath', order: 900, captionKey: LABEL.caption, actions: [] },
        ],
      },
    )
    expect(ids(registry.ribbonGroups('toolpath'))).toEqual(['early', 'project', 'everywhere', 'toolpath', 'output', 'late', 'tie'])
    expect(ids(registry.ribbonGroups('control'))).toEqual(['everywhere'])
    expect(ids(registry.ribbonGroups('model'))).toEqual(['project', 'everywhere', 'model'])
  })

  it('refuses a second holder of a one-thing slot, names both owners and adds nothing', () => {
    const registry = fresh({
      owner: 'sketch',
      ribbonGroups: [{ id: 'draw', workspace: 'sketch', order: 300, captionKey: LABEL.caption, actions: [] }],
      modes: [{ id: 'trim', workspace: 'sketch', labelKey: LABEL.nest, exitLabelKey: LABEL.exit }],
      propertiesCards: [{ id: 'line', workspace: 'sketch', kind: 'line', order: 1, matches: () => true, Component: Stand('p') }],
      browserSections: [{ id: 'layers', workspace: 'sketch', order: 1, titleKey: LABEL.nest, Component: Stand('b') }],
      commands: [{ id: 'sketch.line', labelKey: LABEL.nest, place: 'sketch', group: 'draw', kind: 'momentary', availability: () => READY, run: () => {} }],
      windows: [{ id: 'sketch-dialog', Component: Stand('w') }],
    })
    const clash = (second: WorkspaceRegistration) => {
      let thrown: unknown
      try { registry.register(second) } catch (e) { thrown = e }
      expect(thrown).toBeInstanceOf(RegistryConflictError)
      const message = (thrown as Error).message
      expect(message).toContain('"sketch"')
      expect(message).toContain('"model"')
    }
    clash({ owner: 'model', ribbonGroups: [{ id: 'fresh', workspace: 'model', order: 1, captionKey: LABEL.caption, actions: [] }, { id: 'draw', workspace: 'sketch', order: 1, captionKey: LABEL.caption, actions: [] }] })
    clash({ owner: 'model', modes: [{ id: 'trim', workspace: 'sketch', labelKey: LABEL.nest, exitLabelKey: LABEL.exit }] })
    clash({ owner: 'model', propertiesCards: [{ id: 'line-2', workspace: 'sketch', kind: 'line', order: 2, matches: () => true, Component: Stand('q') }] })
    clash({ owner: 'model', browserSections: [{ id: 'layers', workspace: 'model', order: 1, titleKey: LABEL.nest, Component: Stand('b') }] })
    clash({ owner: 'model', commands: [{ id: 'sketch.line', labelKey: LABEL.nest, place: 'model', group: 'x', kind: 'momentary', availability: () => READY, run: () => {} }] })
    clash({ owner: 'model', windows: [{ id: 'sketch-dialog', Component: Stand('w') }] })
    // the clash added nothing from the refused registration, not even its first, valid group
    expect(ids(registry.ribbonGroups('model'))).toEqual(['project', 'model'])
    expect(registry.windows()).toHaveLength(1)
    // the same kind in ANOTHER workspace is a different slot
    expect(() => registry.register({ owner: 'model', propertiesCards: [{ id: 'line-m', workspace: 'model', kind: 'line', order: 1, matches: () => true, Component: Stand('q') }] })).not.toThrow()
  })

  it('refuses a command that reuses a shortcut, a number key or a workspace command id, and adds none of it', () => {
    const cmd = (id: `${string}.${string}`, shortcut?: string) => ({ id, labelKey: LABEL.nest, place: 'setup' as const, group: 'g', kind: 'momentary' as const, shortcut, availability: () => READY, run: () => {} })
    const registry = fresh({ owner: 'a', commands: [cmd('a.one', 'Y')] })
    expect(() => registry.register({ owner: 'b', commands: [cmd('b.ok', 'U'), cmd('b.two', 'Y')] })).toThrow(/"a" and "b"/)
    expect(() => registry.register({ owner: 'b', commands: [cmd('b.ok', 'U'), cmd('b.three', '3')] })).toThrow(/"shell" and "b"/)
    expect(() => registry.register({ owner: 'b', commands: [cmd('b.ok', 'U'), cmd('workspace.setup')] })).toThrow(/"shell" and "b"/)
    expect(registry.commandRegistry.get('b.ok')).toBeUndefined()
    expect(() => registry.register({ owner: 'b', commands: [cmd('b.ok', 'U')] })).not.toThrow()
  })

  it('leaves no command behind when one command of a registration cannot be declared', () => {
    const registry = fresh()
    const good = { id: 'a.good' as const, labelKey: LABEL.nest, place: 'setup' as const, group: 'g', kind: 'momentary' as const, availability: () => READY, run: () => {} }
    expect(() => registry.register({ owner: 'a', commands: [good, { ...good, id: 'a.bad' as const, kind: 'wrong' as never }] })).toThrow()
    expect(registry.commandRegistry.get('a.good')).toBeUndefined()
    expect(() => registry.register({ owner: 'a', commands: [good] })).not.toThrow()
  })

  it('refuses a group that replaces itself', () => {
    const registry = fresh()
    expect(() => registry.register({ owner: 'a', ribbonGroups: [{ id: 'setup', workspace: 'setup', order: 1, captionKey: LABEL.caption, replaces: 'setup', actions: [] }] })).toThrow(/replaces itself/)
    expect(ids(registry.ribbonGroups('setup'))).toEqual(['project', 'setup'])
  })

  it('undoes a registration', () => {
    const registry = fresh()
    const undo = registry.register({ owner: 'a', ribbonGroups: [{ id: 'g', workspace: 'setup', order: 1, captionKey: LABEL.caption, actions: [] }] })
    expect(ids(registry.ribbonGroups('setup'))).toContain('g')
    undo()
    expect(ids(registry.ribbonGroups('setup'))).not.toContain('g')
    expect(() => registry.register({ owner: 'b', ribbonGroups: [{ id: 'g', workspace: 'setup', order: 1, captionKey: LABEL.caption, actions: [] }] })).not.toThrow()
  })

  it('lets a lane take over one of the shell\'s own groups with `replaces`, and no other', () => {
    const registry = fresh({
      owner: 'setup',
      ribbonGroups: [{ id: 'setup-tools', workspace: 'setup', order: 200, captionKey: LABEL.caption, replaces: 'setup', actions: [{ id: 'mine', labelKey: LABEL.nest, run: () => {} }] }],
    })
    expect(registry.ribbonGroups('setup').map(g => `${g.id}:${ids(g.actions).join('+')}`)).toEqual(['project:new+open+save+export', 'setup-tools:mine'])
    expect(() => registry.register({
      owner: 'toolpath',
      ribbonGroups: [{ id: 'x', workspace: 'toolpath', order: 1, captionKey: LABEL.caption, replaces: 'setup-tools', actions: [] }],
    })).toThrow(/replaces "setup-tools"/)
    expect(() => registry.register({
      owner: 'toolpath',
      ribbonGroups: [{ id: 'x', workspace: 'toolpath', order: 1, captionKey: LABEL.caption, replaces: 'no-such-group', actions: [] }],
    })).toThrow(/replaces "no-such-group"/)
  })

  it('accepts a window that takes over a hosted window and refuses an unknown host', () => {
    const registry = fresh({ owner: 'tools', windows: [{ id: 'tool-library-2', Component: Stand('tl'), replaces: 'tool-library' }] })
    expect([...registry.replacedWindows()]).toEqual(['tool-library'])
    expect(() => registry.register({ owner: 'x', windows: [{ id: 'y', Component: Stand('y'), replaces: 'nope' as never }] })).toThrow(/nope/)
  })

  it('enters a mode with its own groups and Exit, and leaves it to the workspace ribbon', () => {
    const onExit = vi.fn()
    const registry = fresh({
      owner: 'model',
      modes: [{ id: 'form', workspace: 'model', labelKey: LABEL.nest, exitLabelKey: LABEL.exit, onExit }],
      ribbonGroups: [{ id: 'form-tools', workspace: 'model', order: 1, mode: 'form', captionKey: LABEL.caption, actions: [{ id: 'extrude', labelKey: LABEL.nest, run: () => {} }] }],
    })
    expect(ids(registry.ribbonGroups('model'))).toEqual(['project', 'model'])
    const seen = vi.fn()
    registry.subscribe(seen)
    registry.enterMode('form')
    expect(seen).toHaveBeenCalled()
    expect(registry.activeMode('model')?.id).toBe('form')
    expect(ids(registry.ribbonGroups('model'))).toEqual(['form-tools', 'exit'])
    expect(registry.activeMode('setup')).toBeUndefined()
    expect(ids(registry.ribbonGroups('setup'))).toEqual(['project', 'setup'])
    registry.ribbonGroups('model').at(-1)!.actions[0].run?.()
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(registry.activeMode('model')).toBeUndefined()
    expect(ids(registry.ribbonGroups('model'))).toEqual(['project', 'model'])
    expect(() => registry.enterMode('missing')).toThrow(/missing/)
  })

  it('collects the `registration` each lane folder exports, in path order, single or many', () => {
    const a: WorkspaceRegistration = { owner: 'a' }
    const b: WorkspaceRegistration = { owner: 'b' }
    const c: WorkspaceRegistration = { owner: 'c' }
    expect(collectRegistrations({
      '../c/registration.tsx': { registration: c },
      '../a/registration.ts': { registration: [a, b] },
      '../d/registration.ts': {},
    })).toEqual([a, b, c])
  })
})

describe('WO-3306 the shell reads the registry', () => {
  it('with nothing registered draws the hosted panels and no registry wrapper', () => {
    const { container } = shellWith(fresh())
    expect(screen.getByTestId('host-browser')).toBeTruthy()
    expect(screen.getByTestId('host-properties')).toBeTruthy()
    expect(screen.getByTestId('host-console')).toBeTruthy()
    expect(screen.getByTestId('host-windows').getAttribute('data-replaced')).toBe('')
    expect(container.querySelector('[data-registry]')).toBeNull()
    expect(ids([...screen.getByTestId('ui2-ribbon').querySelectorAll('[data-testid^="ui2-group-"]')].map(n => ({ id: n.getAttribute('data-testid')! })))).toEqual(['ui2-group-project', 'ui2-group-setup'])
  })

  it('draws a lane\'s ribbon group in its place and runs its action', () => {
    const run = vi.fn()
    shellWith(fresh({
      owner: 'lane',
      ribbonGroups: [{ id: 'mine', workspace: 'setup', order: 150, captionKey: LABEL.caption, actions: [{ id: 'go', labelKey: LABEL.nest, run }] }],
    }))
    const groups = [...screen.getByTestId('ui2-ribbon').querySelectorAll('[data-testid^="ui2-group-"]')].map(n => n.getAttribute('data-testid'))
    expect(groups).toEqual(['ui2-group-project', 'ui2-group-mine', 'ui2-group-setup'])
    fireEvent.click(screen.getByTestId('ui2-ribbon-go'))
    expect(run).toHaveBeenCalledTimes(1)
    // command search finds it too
    const fold = screen.queryByTestId('ui2-search-fold')
    if (fold) fireEvent.click(fold)
    fireEvent.change(within(screen.getByTestId('ui2-search-field')).getByRole('textbox'), { target: { value: 'Nest' } })
    expect(screen.getAllByTestId('ui2-search-result-go').length).toBe(1)
    fireEvent.click(screen.getByTestId('ui2-search-result-go'))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('runs a registered command from its ribbon button and its shortcut, and shows it unavailable when it is', () => {
    const run = vi.fn()
    const ghost = vi.fn()
    let ready = true
    shellWith(fresh({
      owner: 'lane',
      commands: [{
        id: 'lane.go', labelKey: LABEL.nest, place: 'setup', group: 'mine', kind: 'momentary', shortcut: 'Y',
        availability: () => (ready ? READY : { ready: false, reason: 'ui2-shell.wo3285:browserOpen' }), run,
      }],
      ribbonGroups: [{
        id: 'mine', workspace: 'setup', order: 150, captionKey: LABEL.caption,
        actions: [
          { id: 'go', labelKey: LABEL.nest, commandId: 'lane.go' },
          { id: 'ghost', labelKey: LABEL.machine, commandId: 'lane.notLanded', run: ghost },
          { id: 'hidden', labelKey: LABEL.machine, commandId: 'lane.notLanded' },
        ],
      }],
    }))
    expect(screen.queryByTestId('ui2-ribbon-hidden')).toBeNull()
    fireEvent.click(screen.getByTestId('ui2-ribbon-ghost'))
    expect(ghost).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('ui2-ribbon-go'))
    expect(run).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: 'Y' })
    expect(run).toHaveBeenCalledTimes(2)
    ready = false
    fireEvent.keyDown(document.body, { key: 'Y' })
    fireEvent.click(screen.getByTestId('ui2-ribbon-go'))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('shows a mode\'s groups and Exit while it is active', () => {
    const registry = fresh({
      owner: 'setup',
      modes: [{ id: 'nest', workspace: 'setup', labelKey: LABEL.nest, exitLabelKey: LABEL.exit }],
      ribbonGroups: [{ id: 'nest-tools', workspace: 'setup', order: 1, mode: 'nest', captionKey: LABEL.caption, actions: [{ id: 'pack', labelKey: LABEL.nest, run: () => {} }] }],
    })
    shellWith(registry)
    expect(screen.queryByTestId('ui2-ribbon-pack')).toBeNull()
    act(() => registry.enterMode('nest'))
    expect(screen.getByTestId('ui2-ribbon-pack')).toBeTruthy()
    expect(screen.queryByTestId('ui2-ribbon-new-setup')).toBeNull()
    fireEvent.click(screen.getByTestId('ui2-ribbon-exit'))
    expect(screen.queryByTestId('ui2-ribbon-pack')).toBeNull()
    expect(screen.getByTestId('ui2-ribbon-new-setup')).toBeTruthy()
  })

  it('swaps the hosted Browser for registered sections, in order, of that workspace only', () => {
    shellWith(fresh({
      owner: 'setup',
      browserSections: [
        { id: 'stock', workspace: 'setup', order: 20, titleKey: LABEL.machine, Component: Stand('sec-stock') },
        { id: 'parts', workspace: 'setup', order: 10, titleKey: LABEL.nest, Component: Stand('sec-parts') },
      ],
    }))
    expect(screen.queryByTestId('host-browser')).toBeNull()
    const order = [...screen.getByTestId('ui2-card-browser').querySelectorAll('[data-testid^="sec-"]')].map(n => n.getAttribute('data-testid'))
    expect(order).toEqual(['sec-parts', 'sec-stock'])
    fireEvent.click(screen.getByTestId('ui2-tab-toolpath'))
    expect(screen.getByTestId('host-browser')).toBeTruthy()
    expect(screen.queryByTestId('sec-parts')).toBeNull()
  })

  it('draws the Properties card for the selection and falls back to the hosted panel for the rest', () => {
    shellWith(fresh({
      owner: 'setup',
      propertiesCards: [
        { id: 'stock-card', workspace: 'setup', kind: 'stock', order: 1, matches: s => s.viewer.showStock, Component: Stand('card-stock') },
        { id: 'axes-card', workspace: 'setup', kind: 'axes', order: 2, matches: s => s.viewer.showAxes, Component: Stand('card-axes') },
      ],
    }))
    const set = (showStock: boolean, showAxes: boolean) => act(() => useCamStore.setState({ viewer: { ...useCamStore.getState().viewer, showStock, showAxes } }))
    set(true, true)
    expect(screen.getByTestId('card-stock')).toBeTruthy()
    expect(screen.queryByTestId('card-axes')).toBeNull()
    expect(screen.queryByTestId('host-properties')).toBeNull()
    set(false, true)
    expect(screen.getByTestId('card-axes')).toBeTruthy()
    set(false, false)
    expect(screen.getByTestId('host-properties')).toBeTruthy()
  })

  it('adds view overlays, Show rows and strip items, and Show rows act through the lane\'s toggle', () => {
    const toggle = vi.fn()
    shellWith(fresh({
      owner: 'lane',
      viewOverlays: [{ id: 'hud', workspace: 'setup', order: 1, placement: 'left', Component: Stand('overlay-hud') }],
      showRows: [{ id: 'extra', workspace: 'setup', order: 500, labelKey: 'ui2-shell.wo3285:actNewModel', isOn: s => s.viewer.showAxes, toggle }],
      stripItems: [{ id: 'tag', workspace: 'setup', order: 1, Component: Stand('strip-tag') }],
    }))
    expect(screen.getByTestId('overlay-hud')).toBeTruthy()
    expect(screen.getByTestId('strip-tag')).toBeTruthy()
    expect(screen.getByTestId('host-console')).toBeTruthy()
    const card = screen.getByTestId('ui2-showcard')
    fireEvent.click(within(card).getByRole('button', { expanded: false }))
    fireEvent.click(within(card).getByRole('checkbox', { name: /New model/ }))
    expect(toggle).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('ui2-tab-model'))
  })

  it('mounts registered windows and tells the hosted windows which ones a lane took over', () => {
    shellWith(fresh({ owner: 'tools', windows: [{ id: 'tl', Component: Stand('win-tools'), replaces: 'tool-library' }, { id: 'extra', Component: Stand('win-extra') }] }))
    expect(screen.getByTestId('win-tools')).toBeTruthy()
    expect(screen.getByTestId('win-extra')).toBeTruthy()
    expect(screen.getByTestId('host-windows').getAttribute('data-replaced')).toBe('tool-library')
  })

  it('puts the chosen theme and scale on the windows host, so a lane window follows Amber and Light', () => {
    shellWith(fresh({ owner: 'tools', windows: [{ id: 'probe', Component: Stand('win-probe') }] }))
    const probe = screen.getByTestId('win-probe')
    const scope = probe.closest('[data-ui2-theme]') as HTMLElement | null
    expect(scope?.getAttribute('data-ui2-theme')).toBe('dark')
    expect(scope?.hasAttribute('data-ui2')).toBe(true)
    const select = within(screen.getByTestId('ui2-theme-select')).getByRole('combobox') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'amber' } })
    expect((probe.closest('[data-ui2-theme]') as HTMLElement).getAttribute('data-ui2-theme')).toBe('amber')
    fireEvent.change(within(screen.getByTestId('ui2-scale-select')).getByRole('combobox'), { target: { value: '0.75' } })
    expect((probe.closest('[data-ui2-theme]') as HTMLElement).style.getPropertyValue('--ui2-scale')).toBe('0.75')
  })

  it('serves app bar items to the app bar by area, in order', () => {
    const registry = fresh({
      owner: 'lane',
      appBarItems: [
        { id: 'b', order: 20, area: 'actions', Component: Stand('item-b') },
        { id: 'a', order: 10, area: 'actions', Component: Stand('item-a') },
        { id: 's', order: 1, area: 'status', Component: Stand('item-s') },
      ],
    })
    function Probe() {
      const r = useWorkspaceRegistry()
      return <>{r.appBarItems('actions').map(i => <i.Component key={i.id} />)}</>
    }
    render(<WorkspaceRegistryProvider registry={registry}><Probe /></WorkspaceRegistryProvider>)
    expect(screen.getAllByTestId(/item-/).map(n => n.getAttribute('data-testid'))).toEqual(['item-a', 'item-b'])
    expect(createWorkspaceRegistry().appBarItems('actions')).toEqual([])
  })
})
