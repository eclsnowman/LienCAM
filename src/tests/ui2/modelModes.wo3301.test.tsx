// @vitest-environment jsdom
//
// WO-3301 (UI M2 W2-8): Form, Relief and Drawing are modes inside Model. A Modes group in the Model
// ribbon enters each; the ribbon swaps to that mode's groups and Exit returns; there is no Form,
// Relief or Drawing tab; every tool the three sessions offer today is a command with a place in the
// mode's ribbon; the Drawings section lists, creates, opens and deletes drawings; every word is in
// four languages. The sessions are stood in for here (they live in the Model page); the live
// pictures are in the evidence folder.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { WORKSPACES, type CommandSpec } from '../../commands/types'
import { ENGLISH_CATALOG } from '../../i18n/catalogs'
import type { RailSection } from '../../components/model3d/workbench/WorkbenchToolRail'
import { formModePort } from '../../components/model3d/form/formModePort'
import { reliefModePort } from '../../components/model3d/relief/reliefModePort'
import { drawingEditorPort, drawingsModelPort, type DrawingEditorSession, type DrawingsModel } from '../../components/model3d/drawing/drawingModePort'
import type { FormSession } from '../../components/model3d/form/useFormSession'
import type { ReliefSession } from '../../components/model3d/relief/useReliefSession'
import { DrawingEntry } from '../../components/model3d/drawing/DrawingEntry'
import { createModePort } from '../../components/model3d/form/modePort'
import { registration } from '../../ui2/model-modes/registration'
import { createWorkspaceRegistry } from '../../ui2/registry'
import { ModeSync } from '../../ui2/model-modes/ModeSync'
import { GROUPS_BY_MODE, MODE_IDS } from '../../ui2/model-modes/toolTable'
import { WorkspaceRegistryProvider, type WorkspaceRegistry } from '../../ui2/registry'
import de from '../../i18n/locales/de/ui2-model-modes.wo3301'
import en from '../../i18n/locales/en/ui2-model-modes.wo3301'
import es from '../../i18n/locales/es/ui2-model-modes.wo3301'
import fr from '../../i18n/locales/fr/ui2-model-modes.wo3301'

afterEach(() => {
  cleanup()
  formModePort.update(null, 'gone')
  reliefModePort.update(null, 'gone')
  drawingEditorPort.update(null, 'gone')
  drawingsModelPort.update(null, 'gone')
})

const commands = (registration.commands ?? []) as readonly CommandSpec[]
const command = (id: string): CommandSpec => {
  const found = commands.find(c => c.id === id)
  expect(found, `command ${id} is registered`).toBeDefined()
  return found as CommandSpec
}
const CTX = { workspace: 'model' as const }

function resolves(key: string): boolean {
  const [area, path] = key.split(/:(.*)/s)
  let node: unknown = ENGLISH_CATALOG[area]
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return false
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string'
}

function railOf(prefix: 'form' | 'relief', tools: Array<{ id: string; active?: boolean; disabled?: boolean }>) {
  const onClick = vi.fn()
  const sections: RailSection[] = [{
    id: `${prefix}-all`, title: 'x',
    tools: tools.map(t => ({ testId: `${prefix}-${t.id}`, label: t.id, icon: (() => null) as never, onClick: () => onClick(t.id), active: t.active, disabled: t.disabled })),
  }]
  return { sections, onClick }
}

describe('WO-3301 registration', () => {
  it('registers Form, Relief and Drawing as modes of Model, each with its own Exit words', () => {
    const modes = registration.modes ?? []
    expect(modes.map(m => m.id)).toEqual(['form', 'relief', 'drawing'])
    for (const m of modes) {
      expect(m.workspace).toBe('model')
      expect(m.labelKey).toBe(`ui2-model-modes.wo3301:mode${m.id[0].toUpperCase()}${m.id.slice(1)}`)
      expect(m.exitLabelKey).toBe(`ui2-model-modes.wo3301:exit${m.id[0].toUpperCase()}${m.id.slice(1)}`)
      expect(typeof m.onExit).toBe('function')
    }
  })

  it('puts a Modes group in the Model ribbon that enters each mode by command id', () => {
    const modes = (registration.ribbonGroups ?? []).filter(g => g.mode === undefined)
    expect(modes).toHaveLength(1)
    expect(modes[0]).toMatchObject({ id: 'modes', workspace: 'model', captionKey: 'ui2-model-modes.wo3301:groupModes' })
    expect(modes[0].actions.map(a => a.commandId)).toEqual(['model.enterMode.form', 'model.enterMode.relief', 'model.enterMode.drawing'])
    for (const id of modes[0].actions.map(a => a.commandId as string)) expect(command(id).place).toBe('model')
  })

  it('has no Form, Relief or Drawing tab', () => {
    for (const id of MODE_IDS) expect(WORKSPACES as readonly string[]).not.toContain(id)
    expect(registration.ribbonGroups?.every(g => g.workspace === 'model')).toBe(true)
  })

  it('gives each mode its groups, and Drawing the Dimension, Annotate, Sheet and Export groups', () => {
    const groups = registration.ribbonGroups ?? []
    for (const mode of MODE_IDS) {
      const mine = groups.filter(g => g.mode === mode)
      expect(mine.map(g => g.id)).toEqual(GROUPS_BY_MODE[mode].map(g => `${mode}-${g.id}`).concat(mode === 'drawing' ? [] : [`${mode}-finish`]))
      expect(mine.length).toBeGreaterThan(0)
    }
    const drawing = groups.filter(g => g.mode === 'drawing').map(g => g.captionKey)
    for (const word of ['groupDimension', 'groupAnnotate', 'groupSheet', 'groupExport']) expect(drawing).toContain(`ui2-model-modes.wo3301:${word}`)
  })

  it('makes every tool of the shipped Form, Relief and Drawing screens a command with a place', () => {
    const placed = new Set((registration.ribbonGroups ?? []).flatMap(g => g.actions.map(a => a.commandId)))
    for (const mode of MODE_IDS) {
      for (const group of GROUPS_BY_MODE[mode]) {
        for (const tool of group.tools.filter(t => t.offered !== false)) {
          const id = `model.${mode}.${tool.id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}`
          expect(placed.has(id as never), id).toBe(true)
          expect(command(id).labelKey).toBe(tool.labelKey)
        }
      }
    }
    // the sources: every rail test id a session builds is in the table (a new tool added later fails here)
    const rails = [['form', 'components/model3d/form/useFormSession.ts'], ['relief', 'components/model3d/relief/useReliefSession.ts']] as const
    for (const [prefix, path] of rails) {
      const source = readFileSync(`src/${path}`, 'utf8')
      const literal = [...source.matchAll(new RegExp(`testId: '(${prefix}-[a-z-]+)'`, 'g'))].map(m => m[1])
      const templated = [...source.matchAll(new RegExp('testId: `(' + prefix + '-[a-z-]+)\\$\\{', 'g'))].map(m => m[1])
      const known = GROUPS_BY_MODE[prefix].flatMap(g => g.tools.map(t => t.testId))
      expect(literal.length).toBeGreaterThan(0)
      for (const id of literal) expect(known, id).toContain(id)
      for (const stem of templated) expect(known.some(id => id?.startsWith(stem)), stem).toBe(true)
    }
  })

  it('resolves every label, caption and reason in English and has the same words in de, es and fr', () => {
    const keys = new Set<string>()
    for (const g of registration.ribbonGroups ?? []) { keys.add(g.captionKey); g.actions.forEach(a => keys.add(a.labelKey)) }
    for (const m of registration.modes ?? []) { keys.add(m.labelKey); keys.add(m.exitLabelKey) }
    for (const c of commands) keys.add(c.labelKey)
    expect(keys.size).toBeGreaterThan(60)
    for (const key of keys) expect(resolves(key), key).toBe(true)
    const english = Object.keys(en).sort()
    for (const other of [de, es, fr]) expect(Object.keys(other).sort()).toEqual(english)
  })
})

describe('WO-3301 Form and Relief through the ribbon', () => {
  const formSession = (rail: ReturnType<typeof railOf>, extra: Partial<FormSession> = {}): FormSession => ({
    active: true, open: vi.fn(), finish: vi.fn(), cancel: vi.fn(), undo: vi.fn(), redo: vi.fn(), canUndo: false, canRedo: false, railSections: rail.sections, ...extra,
  })

  it('runs a Form rail tool from its command and shows its lamp', () => {
    const rail = railOf('form', [{ id: 'flatten' }, { id: 'starter-box', active: true }])
    formModePort.update(formSession(rail), 'a')
    expect(command('model.form.flatten').availability(CTX)).toEqual({ ready: true })
    void command('model.form.flatten').run(CTX)
    expect(rail.onClick).toHaveBeenCalledWith('flatten')
    expect(command('model.form.starterBox').isOn?.(CTX)).toBe(true)
    expect(command('model.form.flatten').isOn?.(CTX) ?? false).toBe(false)
  })

  it('says why a tool is not there: the model is loading, or nothing to undo', () => {
    expect(command('model.form.flatten').availability(CTX)).toMatchObject({ ready: false, reason: 'app-shell-settings-menus:App.loadingModel' })
    formModePort.update(formSession(railOf('form', [{ id: 'flatten' }])), 'b')
    expect(command('model.form.undo').availability(CTX)).toMatchObject({ ready: false, reason: 'ui2-model-modes.wo3301:nothingToUndo' })
  })

  it('Finish Form finishes the session', () => {
    const session = formSession(railOf('form', []))
    formModePort.update(session, 'c')
    void command('model.form.finish').run(CTX)
    expect(session.finish).toHaveBeenCalledTimes(1)
  })

  it('enters Form and Relief by opening the session; a disabled Relief tool is unavailable with the existing reason', () => {
    const form = formSession(railOf('form', []), { active: false })
    formModePort.update(form, 'd')
    void command('model.enterMode.form').run(CTX)
    expect(form.open).toHaveBeenCalledTimes(1)
    const rail = railOf('relief', [{ id: 'fit', disabled: true }, { id: 'raise' }])
    const relief = { active: false, open: vi.fn(), apply: vi.fn(), cancel: vi.fn(), railSections: rail.sections } as unknown as ReliefSession
    reliefModePort.update(relief, 'e')
    void command('model.enterMode.relief').run(CTX)
    expect(relief.open).toHaveBeenCalledTimes(1)
    expect(command('model.relief.fit').availability(CTX)).toMatchObject({ ready: false, reason: 'sketch-and-model-workbench:useReliefSession.clickAFlatFaceOnThePartToLay' })
    expect(command('model.relief.raise').availability(CTX)).toEqual({ ready: true })
  })

  it('Exit cancels an active session and does nothing when it is already closed', () => {
    const exit = (id: string) => registration.modes?.find(m => m.id === id)?.onExit?.()
    const form = formSession(railOf('form', []))
    formModePort.update(form, 'f')
    exit('form')
    expect(form.cancel).toHaveBeenCalledTimes(1)
    const closed = formSession(railOf('form', []), { active: false })
    formModePort.update(closed, 'g')
    exit('form')
    expect(closed.cancel).not.toHaveBeenCalled()
  })
})

describe('WO-3301 Drawing mode and the Drawings section', () => {
  const model = (over: Partial<DrawingsModel> = {}): DrawingsModel => ({
    modelItemId: 'item', drawings: [{ id: 'D1', name: 'Bracket sheet', sourceGone: false }, { id: 'D2', name: 'Old sheet', sourceGone: true }],
    openId: null, canCreate: true, creating: false, bodyCount: 1, removedName: null, notice: null,
    create: vi.fn(), open: vi.fn(), close: vi.fn(), remove: vi.fn(), undoRemove: vi.fn(), ...over,
  })
  const editor = (over: Partial<DrawingEditorSession> = {}): DrawingEditorSession => ({
    modelItemId: 'item', drawingId: 'D1', tool: null, sheetChoice: 'letter', hasSheet: true, hasLogo: false, canUndo: false, canRedo: true,
    chooseTool: vi.fn(), changeSize: vi.fn(), exportSheet: vi.fn(async () => {}), undo: vi.fn(), redo: vi.fn(), ...over,
  })

  it('enters Drawing: opens the first drawing, else creates one from the body, else says a body is needed', () => {
    const withDrawings = model()
    drawingsModelPort.update(withDrawings, 'a')
    void command('model.enterMode.drawing').run(CTX)
    expect(withDrawings.open).toHaveBeenCalledWith('D1')
    const empty = model({ drawings: [] })
    drawingsModelPort.update(empty, 'b')
    void command('model.enterMode.drawing').run(CTX)
    expect(empty.create).toHaveBeenCalledTimes(1)
    drawingsModelPort.update(model({ drawings: [], canCreate: false }), 'c')
    expect(command('model.enterMode.drawing').availability(CTX)).toMatchObject({ ready: false, reason: 'technical-drawings:entry.createNeedsBody' })
  })

  it('drives the sheet editor: tools with their lamp, size, export and undo', () => {
    const session = editor({ tool: 'linear' })
    drawingEditorPort.update(session, 'a')
    void command('model.drawing.angle').run(CTX)
    expect(session.chooseTool).toHaveBeenCalledWith('angle')
    expect(command('model.drawing.linear').isOn?.(CTX)).toBe(true)
    expect(command('model.drawing.sizeLetter').isOn?.(CTX)).toBe(true)
    void command('model.drawing.sizeLetter').run(CTX)
    expect(session.changeSize).not.toHaveBeenCalled()
    void command('model.drawing.sizeA4').run(CTX)
    expect(session.changeSize).toHaveBeenCalledWith('a4')
    void command('model.drawing.exportPdf').run(CTX)
    expect(session.exportSheet).toHaveBeenCalledWith('pdf')
    expect(command('model.drawing.exportDxfLogo').availability(CTX)).toEqual({ ready: true })
    expect(command('model.drawing.undo').availability(CTX)).toMatchObject({ ready: false, reason: 'ui2-model-modes.wo3301:nothingToUndo' })
    void command('model.drawing.redo').run(CTX)
    expect(session.redo).toHaveBeenCalledTimes(1)
  })

  it('Exit closes the open drawing', () => {
    const m = model({ openId: 'D1' })
    drawingsModelPort.update(m, 'x')
    registration.modes?.find(x => x.id === 'drawing')?.onExit?.()
    expect(m.close).toHaveBeenCalledTimes(1)
  })

  it('lists the drawings in a Drawings Browser section: create, open, delete, undo the delete', () => {
    const section = registration.browserSections?.find(s => s.id === 'drawings')
    expect(section).toMatchObject({ workspace: 'model', titleKey: 'technical-drawings:entry.section' })
    const Section = section!.Component
    const m = model({ removedName: 'Gone sheet' })
    drawingsModelPort.update(m, 'a')
    render(createElement(Section))
    expect(screen.getByText('Bracket sheet')).toBeTruthy()
    fireEvent.click(screen.getByText('Bracket sheet'))
    expect(m.open).toHaveBeenCalledWith('D1')
    fireEvent.click(screen.getByTestId('ui2-drawing-remove-D2'))
    expect(m.remove).toHaveBeenCalledWith('D2')
    fireEvent.click(screen.getByTestId('ui2-drawing-create'))
    expect(m.create).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('ui2-drawing-undo-remove'))
    expect(m.undoRemove).toHaveBeenCalledTimes(1)
  })
})

function fakeRegistry() {
  let active: string | undefined
  const enterMode = vi.fn((id: string) => { active = id })
  const exitMode = vi.fn(() => { active = undefined })
  const undoRegister = vi.fn()
  const register = vi.fn(() => undoRegister)
  const registry = { enterMode, exitMode, register, activeMode: () => (active === undefined ? undefined : { id: active }) } as unknown as WorkspaceRegistry
  return { registry, enterMode, exitMode, register, undoRegister }
}

describe('WO-3301 in the real registry', () => {
  it('the registration is accepted by the app registry, every command id obeys its id rule, and each ribbon action finds its command', () => {
    const registry = createWorkspaceRegistry()
    expect(() => registry.register(registration)).not.toThrow()
    const ids = (registration.commands ?? []).map(c => c.id)
    for (const id of ids) expect(id, id).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/)
    for (const group of registration.ribbonGroups ?? []) {
      for (const action of group.actions) expect(ids, `${group.id}/${action.id}`).toContain(action.commandId)
    }
    registry.enterMode('drawing')
    expect(registry.ribbonGroups('model').map(g => g.id)).toContain('drawing-export')
  })
})

describe('WO-3301 ribbon refresh', () => {
  it('tells the shell to redraw the ribbon when a session changes what a button shows', () => {
    const registry = createWorkspaceRegistry()
    registry.register(registration)
    render(createElement(WorkspaceRegistryProvider, { registry, children: createElement(ModeSync) }))
    const rail = railOf('form', [{ id: 'undo', disabled: true }])
    const before = registry.version()
    act(() => formModePort.update({ active: false, open: vi.fn(), finish: vi.fn(), cancel: vi.fn(), undo: vi.fn(), redo: vi.fn(), canUndo: false, canRedo: false, railSections: rail.sections }, 'a'))
    const afterOpen = registry.version()
    expect(afterOpen).toBeGreaterThan(before)
    act(() => formModePort.update({ active: false, open: vi.fn(), finish: vi.fn(), cancel: vi.fn(), undo: vi.fn(), redo: vi.fn(), canUndo: true, canRedo: false, railSections: rail.sections }, 'b'))
    expect(registry.version()).toBeGreaterThan(afterOpen)
  })
})

describe('WO-3301 DXF + logo', () => {
  const sheet = (hasLogo: boolean): DrawingEditorSession => ({ modelItemId: 'i', drawingId: 'D', tool: null, sheetChoice: 'letter', hasSheet: true, hasLogo, canUndo: false, canRedo: false, chooseTool: vi.fn(), changeSize: vi.fn(), exportSheet: vi.fn(async () => {}), undo: vi.fn(), redo: vi.fn() })
  const ribbonCommandIds = (ribbon: readonly { actions: readonly { commandId?: string }[] }[] | undefined) => (ribbon ?? []).flatMap(g => g.actions.map(a => a.commandId))

  it('the Export group never carries DXF + logo itself, and no refusal sentence exists for it', () => {
    const drawing = (registration.ribbonGroups ?? []).filter(g => g.mode === 'drawing')
    expect(ribbonCommandIds(drawing)).not.toContain('model.drawing.exportDxfLogo')
    expect(ribbonCommandIds(drawing)).toContain('model.drawing.exportDxf')
    for (const locale of [en, de, es, fr]) expect(Object.keys(locale)).not.toContain('noLogo')
  })

  it('shows DXF + logo only while the sheet has a logo', () => {
    const { registry, register, undoRegister } = fakeRegistry()
    render(createElement(WorkspaceRegistryProvider, { registry, children: createElement(ModeSync) }))
    const logoCalls = () => register.mock.calls.map(c => (c as unknown as [{ owner: string; ribbonGroups?: { mode?: string; actions: { commandId?: string }[] }[] }])[0]).filter(r => r.owner === 'model-modes-logo')
    act(() => drawingEditorPort.update(sheet(false), 'no-logo'))
    expect(logoCalls()).toHaveLength(0)
    act(() => drawingEditorPort.update(sheet(true), 'logo'))
    expect(logoCalls()).toHaveLength(1)
    const added = logoCalls()[0].ribbonGroups ?? []
    expect(added.map(g => g.mode)).toEqual(['drawing'])
    expect(ribbonCommandIds(added)).toEqual(['model.drawing.exportDxfLogo'])
    act(() => drawingEditorPort.update(sheet(false), 'no-logo-again'))
    expect(undoRegister).toHaveBeenCalled()
  })
})

describe('WO-3301 mode sync', () => {
  it('enters the ribbon mode while a session is open and leaves it when the session closes', () => {
    const { registry, enterMode, exitMode } = fakeRegistry()
    render(createElement(WorkspaceRegistryProvider, { registry, children: createElement(ModeSync) }))
    const rail = railOf('form', [])
    const open = { active: true, open: vi.fn(), finish: vi.fn(), cancel: vi.fn(), undo: vi.fn(), redo: vi.fn(), canUndo: false, canRedo: false, railSections: rail.sections }
    act(() => formModePort.update(open, 'open'))
    expect(enterMode).toHaveBeenCalledWith('form')
    act(() => formModePort.update({ ...open, active: false }, 'closed'))
    expect(exitMode).toHaveBeenCalledWith('model')
    act(() => drawingEditorPort.update({ modelItemId: 'i', drawingId: 'D', tool: null, sheetChoice: null, hasSheet: true, hasLogo: false, canUndo: false, canRedo: false, chooseTool: vi.fn(), changeSize: vi.fn(), exportSheet: vi.fn(async () => {}), undo: vi.fn(), redo: vi.fn() }, 'dr'))
    expect(enterMode).toHaveBeenCalledWith('drawing')
  })
})

describe('WO-3301 ports', () => {
  it('a gone instance clears the port only when it is still the publisher', () => {
    const port = createModePort<{ n: number }>()
    const a = {}, b = {}
    port.update({ n: 1 }, 'a', a)
    port.update({ n: 2 }, 'b', b)
    port.release(a)
    expect(port.get()).toEqual({ n: 2 })
    port.release(b)
    expect(port.get()).toBeNull()
  })

  it('notifies only when the signature changes, and always hands out the newest session', () => {
    const port = createModePort<{ n: number }>()
    const listener = vi.fn()
    port.subscribe(listener)
    port.update({ n: 1 }, 'same')
    port.update({ n: 2 }, 'same')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(port.get()).toEqual({ n: 2 })
  })

  it('the shipped Drawings section publishes its list and actions, and withdraws them when it goes', () => {
    const { unmount } = render(createElement(DrawingEntry, {
      modelItemId: 'item-1', documentId: 'doc-1', bodies: [{ bodyId: 'B1', name: 'Part' }], selectedId: 'B1',
      getClient: () => null, getBodyHandle: () => undefined, sourceStatus: () => 'present' as const,
    }))
    const model = drawingsModelPort.get()
    expect(model).toMatchObject({ modelItemId: 'item-1', canCreate: true, creating: false, bodyCount: 1, openId: null })
    expect(model?.drawings).toEqual([])
    unmount()
    expect(drawingsModelPort.get()).toBeNull()
  })
})
