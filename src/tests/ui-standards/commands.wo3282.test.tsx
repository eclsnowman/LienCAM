// @vitest-environment jsdom
//
// WO-3282 (UI M2 W1-E): the command registry, the one shortcut manager and its keydown listener,
// command search and the dialog stack, built on the WO-3275 contracts in src/commands/types.ts.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindDeclaredShortcuts, camRemappedBindings, camShortcutSource, chordToShortcut, CommandSearch, createCommandRegistry, createDialogStack,
  createShortcutManager, installShortcutListener, normalizeShortcut, READY, searchCommands, shortcutText, useDialogEntry,
  type Availability, type CommandContext, type CommandId, type CommandSpec, type DialogStack, type Workspace,
} from '../../commands'
import { notices, type MessageKey } from '../../notices'

afterEach(cleanup)

const NOT_NOW: Availability = { ready: false, reason: 'app-shell-settings-menus:App.noGeometryLoaded' }
const at = (workspace: Workspace): CommandContext => ({ workspace })
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }

function command(id: CommandId, place: CommandSpec['place'], over: Partial<CommandSpec> = {}): CommandSpec {
  return {
    id, labelKey: `app-shell-settings-menus:${id}` as MessageKey, place, group: 'main', kind: 'momentary',
    availability: () => READY, run: vi.fn(), ...over,
  }
}

/** A stand-in catalogue: the label key's id part, in the language the test picks. */
const GERMAN: Record<string, string> = {
  'toolpath.generate': 'Werkzeugweg erzeugen', 'toolpath.generateAll': 'Alle Werkzeugwege erzeugen',
  'toolpath.newOperation': 'Neue Operation', 'toolpath.post': 'G-Code ausgeben', 'global.search': 'Befehle suchen',
}
const german = (key: MessageKey) => GERMAN[key.slice(key.indexOf(':') + 1)] ?? key

describe('WO-3282 command registry', () => {
  it('declares each command once, refuses a bad declaration, and lists by place and group in order', () => {
    const reg = createCommandRegistry()
    reg.register(command('toolpath.generate', 'toolpath', { group: 'generate' }))
    reg.register(command('toolpath.post', 'toolpath', { group: 'post' }))
    reg.register(command('global.search', 'global'))
    expect(() => reg.register(command('toolpath.generate', 'toolpath'))).toThrow(/already declared/)
    expect(() => reg.register(command('toolpath.bad', 'cam' as Workspace))).toThrow(/place/)
    expect(() => reg.register(command('toolpath.nokind', 'toolpath', { kind: 'toggle' as never }))).toThrow(/kind/)
    expect(reg.list().map(c => c.id)).toEqual(['toolpath.generate', 'toolpath.post', 'global.search'])
    expect(reg.list({ place: 'toolpath', group: 'post' }).map(c => c.id)).toEqual(['toolpath.post'])
    const seen = vi.fn()
    const off = reg.subscribe(seen)
    const undo = reg.register(command('model.extrude', 'model'))
    expect(seen).toHaveBeenCalledTimes(1)
    undo()
    expect(seen).toHaveBeenCalledTimes(2)
    off()
  })

  it('takes the reason only from availability(), and a check that throws is an error, never a refusal', async () => {
    const reg = createCommandRegistry()
    const run = vi.fn()
    reg.register(command('toolpath.post', 'toolpath', { availability: () => NOT_NOW, run }))
    reg.register(command('toolpath.broken', 'toolpath', { availability: () => { throw new Error('bad check') }, run }))
    expect(await reg.run('toolpath.post', at('toolpath'))).toEqual({ ran: false, availability: NOT_NOW })
    await expect(reg.run('toolpath.broken', at('toolpath'))).rejects.toThrow('bad check')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('WO-3282 shortcut manager', () => {
  it('spells Mod+Plus the same whether the layout needs Shift for plus, and leaves Shift on letters and Space', () => {
    expect(normalizeShortcut('Mod+Shift+Plus')).toBe('Mod+Plus')
    expect(normalizeShortcut('shift+?')).toBe('?')
    expect(normalizeShortcut('Shift+g')).toBe('Shift+G')
    expect(normalizeShortcut('Shift+Space')).toBe('Shift+Space')
    expect(chordToShortcut({ key: '+', ctrlKey: true, shiftKey: true }, false)).toBe('Mod+Plus')
    expect(chordToShortcut({ key: '1', shiftKey: true }, false)).toBe('1')
    expect(chordToShortcut({ key: 'G', shiftKey: true }, false)).toBe('Shift+G')
    expect(chordToShortcut({ key: 'k', metaKey: true, ctrlKey: true }, true)).toBe('Mod+Ctrl+K')
    const reg = createCommandRegistry()
    reg.register(command('global.zoomIn', 'global'))
    const keys = createShortcutManager({ registry: reg, dialogs: createDialogStack(), context: () => at('model') })
    keys.bind('Mod+Plus', 'global.zoomIn')
    expect(keys.lookup({ key: '+', ctrlKey: true, shiftKey: true })).toBe('global.zoomIn')
    expect(keys.lookup({ key: '+', ctrlKey: true })).toBe('global.zoomIn')
    expect(shortcutText('Mod+Shift+G', false)).toBe('Ctrl+Shift+G')
    expect(shortcutText('Mod+Plus', true)).toBe('Cmd++')
  })

  it('runs a command only in its own workspace or everywhere when global, and nothing behind an open dialog', async () => {
    const reg = createCommandRegistry()
    const generate = vi.fn(), search = vi.fn()
    reg.register(command('toolpath.generate', 'toolpath', { run: generate }))
    reg.register(command('global.search', 'global', { run: search }))
    let ws: Workspace = 'model'
    const dialogs = createDialogStack()
    const keys = createShortcutManager({ registry: reg, dialogs, context: () => at(ws) })
    keys.bind('G', 'toolpath.generate')
    keys.bind('/', 'global.search')
    expect(keys.handle({ key: 'g' })).toBe(false)
    expect(keys.handle({ key: '/' })).toBe(true)
    ws = 'toolpath'
    expect(keys.handle({ key: 'g' })).toBe(true)
    const close = dialogs.push('settings', vi.fn())
    expect(keys.handle({ key: 'g' })).toBe(false)
    expect(keys.handle({ key: '/' })).toBe(false)
    close()
    await flush()
    expect(generate).toHaveBeenCalledOnce()
    expect(search).toHaveBeenCalledOnce()
  })

  it('posts an unavailable command\'s own reason through the one refusal route', async () => {
    const reg = createCommandRegistry()
    reg.register(command('toolpath.post', 'toolpath', { availability: () => NOT_NOW }))
    const keys = createShortcutManager({ registry: reg, dialogs: createDialogStack(), context: () => at('toolpath') })
    keys.bind('P', 'toolpath.post')
    expect(keys.handle({ key: 'p' })).toBe(true)
    await flush()
    const refusal = notices.list().find(n => n.commandId === 'toolpath.post')
    expect(refusal).toMatchObject({ level: 'cannot-do-this', key: NOT_NOW.reason })
    notices.dismiss(refusal!.id)
  })

  it('contains a command that fails, a check that throws and an error handler that throws', async () => {
    const reg = createCommandRegistry()
    reg.register(command('toolpath.sync', 'toolpath', { run: () => { throw new Error('sync') } }))
    reg.register(command('toolpath.async', 'toolpath', { run: () => Promise.reject(new Error('async')) }))
    reg.register(command('toolpath.check', 'toolpath', { availability: () => { throw new Error('check') } }))
    const failed: string[] = []
    const keys = createShortcutManager({
      registry: reg, dialogs: createDialogStack(), context: () => at('toolpath'),
      onError: (id, e) => { failed.push(`${id}:${(e as Error).message}`); throw new Error('handler') },
    })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    keys.bind('A', 'toolpath.sync'); keys.bind('B', 'toolpath.async'); keys.bind('C', 'toolpath.check')
    expect([keys.handle({ key: 'a' }), keys.handle({ key: 'b' }), keys.handle({ key: 'c' })]).toEqual([true, true, true])
    await flush()
    expect(failed.sort()).toEqual(['toolpath.async:async', 'toolpath.check:check', 'toolpath.sync:sync'])
    expect(quiet).toHaveBeenCalled()
    quiet.mockRestore()
  })

  it('reads the remappable CAM rows from their one store at key time, and binds every other declared shortcut', async () => {
    const reg = createCommandRegistry()
    const one = vi.fn(), all = vi.fn(), add = vi.fn(), post = vi.fn()
    reg.register(command('toolpath.generate', 'toolpath', { shortcut: 'G', run: one }))
    reg.register(command('toolpath.generateAll', 'toolpath', { shortcut: 'Shift+G', run: all }))
    reg.register(command('toolpath.newOperation', 'toolpath', { shortcut: 'N', run: add }))
    reg.register(command('toolpath.post', 'toolpath', { shortcut: 'Mod+Shift+P', run: post }))
    const rows = { computeOperationToolpath: 'toolpath.generate', computeAllToolpaths: 'toolpath.generateAll', 'openModal:new-operation': 'toolpath.newOperation' } as const
    let stored: unknown = null
    const keys = createShortcutManager({
      registry: reg, dialogs: createDialogStack(), context: () => at('toolpath'), remapped: () => camRemappedBindings(rows, stored),
    })
    bindDeclaredShortcuts(keys, reg, new Set(Object.values(rows)))
    expect(keys.lookup({ key: 'G', shiftKey: true })).toBe('toolpath.generateAll')
    stored = { version: 1, bindings: { computeAllToolpaths: { key: 'd', shift: true }, 'openModal:new-operation': null } }
    expect(keys.lookup({ key: 'G', shiftKey: true })).toBeUndefined()
    expect(keys.lookup({ key: 'n' })).toBeUndefined()
    expect(keys.handle({ key: 'D', shiftKey: true })).toBe(true)
    expect(keys.handle({ key: 'g' })).toBe(true)
    expect(keys.handle({ key: 'P', ctrlKey: true, shiftKey: true })).toBe(true)
    await flush()
    expect([one, all, add, post].map(f => f.mock.calls.length)).toEqual([1, 1, 0, 1])
    expect(Object.fromEntries(keys.bindings())).toEqual({ G: 'toolpath.generate', 'Shift+D': 'toolpath.generateAll', 'Mod+Shift+P': 'toolpath.post' })
  })
})

describe('WO-3282 the one keydown listener', () => {
  it('runs bound keys from the page, not plain keys typed into a field, never on key repeat or AltGr typing', async () => {
    const reg = createCommandRegistry()
    const go = vi.fn(), find = vi.fn()
    reg.register(command('toolpath.generate', 'toolpath', { run: go }))
    reg.register(command('global.search', 'global', { run: find }))
    const keys = createShortcutManager({ registry: reg, dialogs: createDialogStack(), context: () => at('toolpath') })
    keys.bind('G', 'toolpath.generate')
    keys.bind('Mod+Alt+Q', 'global.search')
    document.body.innerHTML = '<input id="name" type="text"><input id="flag" type="checkbox">'
    const uninstall = installShortcutListener(window, keys)
    expect(() => installShortcutListener(document, keys)).toThrow(/already installed/)
    const press = (target: EventTarget, init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      target.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(press(document.body, { key: 'g' })).toBe(true)
    expect(press(document.getElementById('name')!, { key: 'g' })).toBe(false)
    expect(press(document.getElementById('flag')!, { key: 'g' })).toBe(true)
    expect(press(document.body, { key: 'g', repeat: true })).toBe(true)
    const altGr = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'q', ctrlKey: true, altKey: true })
    Object.defineProperty(altGr, 'getModifierState', { value: (k: string) => k === 'AltGraph' })
    document.getElementById('name')!.dispatchEvent(altGr)
    expect(altGr.defaultPrevented).toBe(false)
    uninstall()
    expect(press(document.body, { key: 'g' })).toBe(false)
    const again = installShortcutListener(document, keys)
    again()
    document.body.innerHTML = ''
    await flush()
    expect(go).toHaveBeenCalledTimes(2)
    expect(find).not.toHaveBeenCalled()
  })
})

describe('WO-3282 command search', () => {
  it('finds by label in the operator\'s language and by shortcut, listing unavailable commands with their reason', () => {
    const reg = createCommandRegistry()
    reg.register(command('toolpath.generate', 'toolpath', { group: 'generate' }))
    reg.register(command('toolpath.post', 'toolpath', { group: 'post', availability: () => NOT_NOW }))
    reg.register(command('toolpath.generateAll', 'toolpath', { group: 'generate' }))
    const shortcuts = new Map([['Shift+G', 'toolpath.generateAll' as CommandId], ['Mod+Shift+P', 'toolpath.post' as CommandId]])
    const opts = { context: at('toolpath'), resolve: german, shortcuts }
    expect(searchCommands(reg, 'werkzeugweg', opts).map(r => r.id)).toEqual(['toolpath.generate', 'toolpath.generateAll'])
    expect(searchCommands(reg, 'generate', { ...opts, resolve: (k: MessageKey) => k }).length).toBeGreaterThan(0)
    expect(searchCommands(reg, 'alle', opts).map(r => r.id)).toEqual(['toolpath.generateAll'])
    expect(searchCommands(reg, 'shift+g', opts).map(r => r.id)).toEqual(['toolpath.generateAll'])
    const [post] = searchCommands(reg, 'g-code', opts)
    expect(post).toMatchObject({ id: 'toolpath.post', label: 'G-Code ausgeben', place: 'toolpath', group: 'post', shortcut: 'Mod+Shift+P', availability: NOT_NOW })
    expect(post!.reason).toBe(german(NOT_NOW.reason as MessageKey))
    expect(searchCommands(reg, '   ', opts)).toEqual([])
    expect(reg.search('ausgeben', german).map(c => c.id)).toEqual(['toolpath.post'])
  })

  it('opens on the dialog stack, runs the chosen ready command, shows a reason instead of running, and closes on Escape', async () => {
    const reg = createCommandRegistry()
    const go = vi.fn()
    reg.register(command('toolpath.generate', 'toolpath', { run: go }))
    reg.register(command('toolpath.post', 'toolpath', { availability: () => NOT_NOW }))
    const dialogs = createDialogStack()
    const keys = createShortcutManager({ registry: reg, dialogs, context: () => at('toolpath') })
    function Host() {
      const [open, setOpen] = useState(true)
      return <CommandSearch open={open} onClose={() => setOpen(false)} registry={reg} context={() => at('toolpath')}
        resolve={german} dialogs={dialogs} testId="search" />
    }
    render(<Host />)
    expect(dialogs.top()).toBe('command-search')
    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: 'ausgeben' } })
    const row = screen.getByRole('option')
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).toContain(german(NOT_NOW.reason as MessageKey))
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(dialogs.top()).toBe('command-search')
    fireEvent.change(field, { target: { value: 'erzeugen' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await act(flush)
    expect(go).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('search')).toBeNull()
    expect(dialogs.size).toBe(0)
    render(<Host />)
    act(() => { keys.handle({ key: 'Escape', editable: true }) })
    expect(screen.queryByTestId('search')).toBeNull()
  })
})

describe('WO-3282 dialog stack', () => {
  it('opens and closes in order, takes Escape only at the top, contains a failing close and tells subscribers', () => {
    const dialogs = createDialogStack()
    const seen = vi.fn()
    dialogs.subscribe(seen)
    const a = vi.fn(), c = vi.fn()
    dialogs.push('a', a)
    const closeB = dialogs.push('b', () => { throw new Error('close failed') })
    dialogs.push('c', c)
    expect(dialogs.ids()).toEqual(['a', 'b', 'c'])
    closeB(); closeB()
    expect(dialogs.ids()).toEqual(['a', 'c'])
    expect(dialogs.handleEscape()).toBe(true)
    expect(c).toHaveBeenCalledOnce()
    expect(a).not.toHaveBeenCalled()
    expect(seen).toHaveBeenCalledTimes(4)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = createDialogStack()
    failing.push('x', () => { throw new Error('close failed') })
    expect(failing.handleEscape()).toBe(true)
    expect(quiet).toHaveBeenCalled()
    quiet.mockRestore()
  })

  it('keeps an older dialog under a newer one when the older re-renders with a new handler', () => {
    const dialogs: DialogStack & { ids(): readonly string[] } = createDialogStack()
    const older = vi.fn(), newer = vi.fn()
    function Entry({ id, onEscape, n }: { id: string; onEscape: () => void; n: number }) {
      useDialogEntry(true, id, () => { onEscape(); return n }, dialogs)
      return null
    }
    const view = render(<><Entry id="older" onEscape={older} n={1} /><Entry id="newer" onEscape={newer} n={1} /></>)
    view.rerender(<><Entry id="older" onEscape={older} n={2} /><Entry id="newer" onEscape={newer} n={1} /></>)
    expect(dialogs.ids()).toEqual(['older', 'newer'])
    dialogs.handleEscape()
    expect(newer).toHaveBeenCalledOnce()
    expect(older).not.toHaveBeenCalled()
    view.unmount()
    expect(dialogs.size).toBe(0)
  })
})

describe('WO-3282 pre-READY audit fixes', () => {
  it('finds a command by the shortcut as the operator reads it on each platform', () => {
    const reg = createCommandRegistry()
    reg.register(command('toolpath.generate', 'toolpath'))
    reg.register(command('toolpath.post', 'toolpath'))
    const shortcuts = new Map([['G', 'toolpath.generate' as CommandId], ['Mod+G', 'toolpath.post' as CommandId]])
    const base = { context: at('toolpath'), resolve: german, shortcuts }
    expect(searchCommands(reg, 'Ctrl+G', { ...base, isMac: false }).map(r => r.id)).toEqual(['toolpath.post'])
    expect(searchCommands(reg, 'cmd+g', { ...base, isMac: true }).map(r => r.id)).toEqual(['toolpath.post'])
    expect(searchCommands(reg, 'ctrl+', { ...base, isMac: false }).map(r => r.id)).toEqual(['toolpath.post'])
  })

  it('refuses a declared Shift on a digit or punctuation key, whose character differs by layout; Plus keeps working', () => {
    const reg = createCommandRegistry()
    reg.register(command('global.one', 'global'))
    const keys = createShortcutManager({ registry: reg, dialogs: createDialogStack(), context: () => at('model') })
    expect(() => keys.bind('Shift+1', 'global.one')).toThrow(/character/)
    expect(() => keys.bind('Mod+Shift+/', 'global.one')).toThrow(/character/)
    expect(() => keys.bind('Mod+Shift+Plus', 'global.one')).not.toThrow()
  })

  it('lets a declared command keep its key in its own workspace when a remapped CAM row uses the same key', async () => {
    const reg = createCommandRegistry()
    const line = vi.fn(), all = vi.fn()
    reg.register(command('sketch.line', 'sketch', { shortcut: 'H', run: line }))
    reg.register(command('toolpath.generateAll', 'toolpath', { run: all }))
    let ws: Workspace = 'sketch'
    const stored = { version: 1, bindings: { computeAllToolpaths: { key: 'h', shift: false } } }
    const keys = createShortcutManager({
      registry: reg, dialogs: createDialogStack(), context: () => at(ws),
      ...camShortcutSource({ computeAllToolpaths: 'toolpath.generateAll' }, () => stored),
    })
    keys.bind('H', 'sketch.line')
    expect(keys.handle({ key: 'h' })).toBe(true)
    ws = 'toolpath'
    expect(keys.handle({ key: 'h' })).toBe(true)
    await flush()
    expect([line.mock.calls.length, all.mock.calls.length]).toEqual([1, 1])
  })

  it('never runs a CAM row the operator unassigned, even through its declared default', async () => {
    const reg = createCommandRegistry()
    const add = vi.fn()
    reg.register(command('toolpath.newOperation', 'toolpath', { shortcut: 'N', run: add }))
    const keys = createShortcutManager({
      registry: reg, dialogs: createDialogStack(), context: () => at('toolpath'),
      ...camShortcutSource({ 'openModal:new-operation': 'toolpath.newOperation' }, () => ({ version: 1, bindings: { 'openModal:new-operation': null } })),
    })
    bindDeclaredShortcuts(keys, reg)
    expect(keys.handle({ key: 'n' })).toBe(false)
    await flush()
    expect(add).not.toHaveBeenCalled()
  })

  it('keeps a held key and Space on a focused button to their own job', () => {
    const reg = createCommandRegistry()
    const zoom = vi.fn(), play = vi.fn()
    reg.register(command('global.zoomIn', 'global', { run: zoom }))
    reg.register(command('simulate.play', 'global', { run: play }))
    const dialogs = createDialogStack()
    const keys = createShortcutManager({ registry: reg, dialogs, context: () => at('simulate') })
    keys.bind('Mod+Plus', 'global.zoomIn')
    keys.bind('Space', 'simulate.play')
    document.body.innerHTML = '<button id="b">ok</button>'
    const uninstall = installShortcutListener(window, keys)
    const press = (target: EventTarget, init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      target.dispatchEvent(e)
      return e.defaultPrevented
    }
    const close = dialogs.push('settings', vi.fn())
    expect(press(document.body, { key: '+', ctrlKey: true, repeat: true })).toBe(false)
    close()
    expect(press(document.getElementById('b')!, { key: ' ' })).toBe(false)
    expect(press(document.body, { key: ' ' })).toBe(true)
    uninstall()
    document.body.innerHTML = ''
    expect(zoom).not.toHaveBeenCalled()
  })

  it('does not run a command on the Enter that commits typed composition', () => {
    const reg = createCommandRegistry()
    const go = vi.fn()
    reg.register(command('toolpath.generate', 'toolpath', { run: go }))
    render(<CommandSearch open onClose={() => {}} registry={reg} context={() => at('toolpath')} resolve={german} dialogs={createDialogStack()} />)
    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: 'erzeugen' } })
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field, { key: 'Process' })
    expect(go).not.toHaveBeenCalled()
  })
})

describe('WO-3282 audit fix round 1: search follows the current availability', () => {
  it('shows and acts on availability() as it is now while the search stays open, both ways', async () => {
    const reg = createCommandRegistry()
    const go = vi.fn()
    let ready = false
    const listeners = new Set<() => void>()
    const changes = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
    const changed = () => act(() => { for (const l of listeners) l() })
    reg.register(command('toolpath.post', 'toolpath', { availability: () => (ready ? READY : NOT_NOW), run: go }))
    const dialogs = createDialogStack()
    function Host() {
      const [open, setOpen] = useState(true)
      return <CommandSearch open={open} onClose={() => setOpen(false)} registry={reg} context={() => at('toolpath')}
        resolve={german} dialogs={dialogs} changes={changes} testId="search" />
    }
    render(<Host />)
    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: 'ausgeben' } })
    expect(screen.getByRole('option').getAttribute('aria-disabled')).toBe('true')

    // ready -> unavailable without a redraw: the stale ready row must not run; it now shows the reason
    ready = true
    changed()
    expect(screen.getByRole('option').getAttribute('aria-disabled')).toBe('false')
    ready = false
    fireEvent.keyDown(field, { key: 'Enter' })
    await act(flush)
    expect(go).not.toHaveBeenCalled()
    expect(screen.getByRole('option').textContent).toContain(german(NOT_NOW.reason as MessageKey))

    // unavailable -> ready without a redraw: selecting the stale unavailable row runs it
    ready = true
    fireEvent.keyDown(field, { key: 'Enter' })
    await act(flush)
    expect(go).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('search')).toBeNull()
  })
})
