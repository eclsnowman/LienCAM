// WO-3275 (UI M2 Wave 0): the shared behaviour contracts every Wave 1 lane builds on - command
// registry, shortcut manager, dialog stack, notice and refusal API, units service and the
// operation-parameter schema - each through its working stub.
import { describe, expect, it, vi } from 'vitest'
import {
  createCommandRegistry, createDialogStack, createShortcutManager, normalizeShortcut, READY,
  type Availability, type CommandContext, type CommandSpec,
} from '../../commands'
import { createNoticeApi, NOTICE_LEVELS } from '../../notices'
import { MESSAGE_KEY_PATTERN } from '../../notices/types'
import { createUnitsService, DEFAULT_UNIT_PREFS, type UnitPrefs } from '../../lib/units'
import { opSchema, type OpSchema } from '../../lib/opschema'

const ctx: CommandContext = { workspace: 'toolpath' }
const NOT_NOW: Availability = { ready: false, reason: 'app-shell-settings-menus:App.noGeometryLoaded' }

function command(id: `${string}.${string}`, availability: Availability, run = vi.fn()): CommandSpec {
  return { id, labelKey: 'app-shell-settings-menus:App.ready', place: 'toolpath', group: 'generate', kind: 'momentary', availability: () => availability, run }
}

describe('WO-3275 command registry', () => {
  it('runs a ready command and never runs an unavailable one', async () => {
    const reg = createCommandRegistry()
    const go = vi.fn(), stop = vi.fn()
    reg.register(command('toolpath.generate', READY, go))
    reg.register(command('toolpath.post', NOT_NOW, stop))
    expect(await reg.run('toolpath.generate', ctx)).toEqual({ ran: true })
    expect(go).toHaveBeenCalledOnce()
    expect(await reg.run('toolpath.post', ctx)).toEqual({ ran: false, availability: NOT_NOW })
    expect(stop).not.toHaveBeenCalled()
  })

  it('declares each command once and lists by place and group', () => {
    const reg = createCommandRegistry()
    const undo = reg.register(command('toolpath.generate', READY))
    expect(() => reg.register(command('toolpath.generate', READY))).toThrow(/already declared/)
    expect(reg.list({ place: 'toolpath', group: 'generate' }).map(c => c.id)).toEqual(['toolpath.generate'])
    expect(reg.list({ place: 'model' })).toEqual([])
    undo()
    expect(reg.get('toolpath.generate')).toBeUndefined()
    expect(() => reg.availability('toolpath.generate', ctx)).toThrow(/unknown command/)
  })

  it('searches ids and resolved labels', () => {
    const reg = createCommandRegistry()
    reg.register(command('toolpath.generate', READY))
    expect(reg.search('gener').map(c => c.id)).toEqual(['toolpath.generate'])
    expect(reg.search('ready', () => 'Ready').map(c => c.id)).toEqual(['toolpath.generate'])
    expect(reg.search('  ')).toEqual([])
  })
})

describe('WO-3275 shortcut manager and dialog stack', () => {
  it('Escape closes only the top dialog, and nothing when none is open', () => {
    const dialogs = createDialogStack()
    const a = vi.fn(), b = vi.fn()
    const closeA = dialogs.push('a', a)
    const closeB = dialogs.push('b', b)
    expect(dialogs.top()).toBe('b')
    expect(dialogs.handleEscape()).toBe(true)
    expect(b).toHaveBeenCalledOnce()
    expect(a).not.toHaveBeenCalled()
    closeB(); closeB()
    expect(dialogs.top()).toBe('a')
    closeA()
    expect(dialogs.size).toBe(0)
    expect(dialogs.handleEscape()).toBe(false)
  })

  it('binds one portable spelling per chord and runs through the registry', async () => {
    const reg = createCommandRegistry()
    const go = vi.fn()
    reg.register(command('toolpath.generate', READY, go))
    reg.register(command('toolpath.post', NOT_NOW))
    const refused = vi.fn()
    const dialogs = createDialogStack()
    const keys = createShortcutManager({ registry: reg, dialogs, context: () => ctx, isMac: true, onRefused: refused })
    expect(normalizeShortcut('shift+mod+g')).toBe('Mod+Shift+G')
    keys.bind('Mod+G', 'toolpath.generate')
    keys.bind('P', 'toolpath.post')
    expect(() => keys.bind('mod+g', 'toolpath.post')).toThrow(/already bound/)
    expect(keys.lookup({ key: 'g', metaKey: true })).toBe('toolpath.generate')
    expect(keys.lookup({ key: 'g', ctrlKey: true })).toBeUndefined()
    expect(keys.handle({ key: 'g', metaKey: true })).toBe(true)
    expect(keys.handle({ key: 'p' })).toBe(true)
    await Promise.resolve(); await Promise.resolve()
    expect(go).toHaveBeenCalledOnce()
    expect(refused).toHaveBeenCalledWith('toolpath.post', NOT_NOW)
    const close = vi.fn()
    dialogs.push('settings', close)
    expect(keys.handle({ key: 'Escape' })).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    expect(keys.handle({ key: 'x' })).toBe(false)
  })

  it('spells Space and Plus, ignores plain keys typed into a field, and contains a failing command', async () => {
    expect(normalizeShortcut('mod++')).toBe('Mod+Plus')
    expect(normalizeShortcut('space')).toBe('Space')
    const reg = createCommandRegistry()
    const boom = new Error('boom')
    reg.register(command('toolpath.generate', READY, vi.fn(() => { throw boom })))
    reg.register(command('toolpath.post', READY))
    const failed = vi.fn()
    const keys = createShortcutManager({ registry: reg, dialogs: createDialogStack(), context: () => ctx, onError: failed })
    keys.bind('Space', 'toolpath.generate')
    keys.bind('Mod+Plus', 'toolpath.post')
    keys.bind('G', 'model.missing')
    expect(keys.lookup({ key: ' ' })).toBe('toolpath.generate')
    expect(keys.lookup({ key: '+', ctrlKey: true })).toBe('toolpath.post')
    expect(keys.handle({ key: ' ', editable: true })).toBe(false)
    expect(keys.handle({ key: 'g' })).toBe(false)
    expect(keys.handle({ key: ' ' })).toBe(true)
    await Promise.resolve(); await Promise.resolve()
    expect(failed).toHaveBeenCalledWith('toolpath.generate', boom)
    expect(keys.handle({ key: '+', ctrlKey: true, editable: true })).toBe(true)
  })
})

describe('WO-3275 notice and refusal API', () => {
  it('has the four levels and refuses only what is not ready, with the availability reason', () => {
    expect([...NOTICE_LEVELS]).toEqual(['info', 'warning', 'cannot-do-this', 'error'])
    const api = createNoticeApi(() => 42)
    expect(api.refuse('toolpath.generate', READY)).toBeNull()
    expect(api.list()).toEqual([])
    const id = api.refuse('toolpath.post', { ...NOT_NOW, params: { n: 2 } })
    expect(api.list()).toEqual([{ id, level: 'cannot-do-this', key: NOT_NOW.reason, params: { n: 2 }, commandId: 'toolpath.post', at: 42 }])
    expect(api.refuse('toolpath.post', { ...NOT_NOW, params: { n: 2 } })).toBe(id)
    expect(api.list()).toHaveLength(1)
    const seen = vi.fn()
    const off = api.subscribe(seen)
    api.dismiss(id!)
    expect(seen).toHaveBeenCalledWith([])
    off()
  })
})

describe('WO-3275 units service', () => {
  const inch: UnitPrefs = { ...DEFAULT_UNIT_PREFS, length: 'inch' }
  const comma: UnitPrefs = { ...DEFAULT_UNIT_PREFS, decimalMark: ',' }
  const units = createUnitsService()

  it('formats lengths, angles and feeds in the operator unit and decimal mark', () => {
    expect(units.formatLength(12.5)).toBe('12.500 mm')
    expect(units.formatLength(25.4, { prefs: inch })).toBe('1.0000 in')
    expect(units.formatLength(12.5, { prefs: comma, trim: true })).toBe('12,5 mm')
    expect(units.formatLength(-0.0001, { precision: 2, withUnit: false })).toBe('0.00')
    expect(units.formatAngle(2)).toBe('2.00°')
    expect(units.formatLength(Number.NaN)).toBe('— mm')
    expect(units.formatLength(1, { precision: 500, withUnit: false })).toBe('1.000000000000')
    expect(units.formatFeed(1600)).toBe('1600.0 mm/min')
    expect(units.formatFeed(254, { prefs: inch })).toBe('10.0 in/min')
    expect(units.unitLabel('feed', inch)).toBe('in/min')
  })

  it('parses to stored units; text carrying its own unit wins; bad text gives a reason', () => {
    expect(units.parseLength('1 in')).toEqual({ ok: true, value: 25.4 })
    expect(units.parseLength('2', { prefs: inch })).toEqual({ ok: true, value: 50.8 })
    expect(units.parseLength('3,5', { prefs: comma })).toEqual({ ok: true, value: 3.5 })
    expect(units.parseLength('12 in')).toEqual({ ok: true, value: 304.8 })
    expect(units.parseLength('1,000').ok).toBe(false)
    expect(units.parseLength('3.5', { prefs: comma }).ok).toBe(false)
    expect(units.parseFeed('10 in/min')).toEqual({ ok: true, value: 254 })
    expect(units.parseAngle('45°')).toEqual({ ok: true, value: 45 })
    const bad = units.parseLength('ten')
    expect(bad.ok).toBe(false)
    expect(bad.ok ? '' : bad.reason).toMatch(MESSAGE_KEY_PATTERN)
  })
})

describe('WO-3275 operation-parameter schema', () => {
  const pocket: OpSchema = {
    opType: 'pocket',
    params: [
      { key: 'stepdown', type: 'number', quantity: 'length', default: 1, labelKey: 'app-shell-settings-menus:App.ready', group: 'passes' },
      { key: 'rampAngle', type: 'number', quantity: 'angle', default: 2, labelKey: 'app-shell-settings-menus:App.ready', group: 'linking', visible: v => v.ramp === true },
      { key: 'ramp', type: 'boolean', default: false, labelKey: 'app-shell-settings-menus:App.ready', group: 'linking' },
      { key: 'tool', type: 'tool', default: null, labelKey: 'app-shell-settings-menus:App.ready', group: 'tool' },
      { key: 'passes', type: 'integer', default: 1, labelKey: 'app-shell-settings-menus:App.ready', group: 'custom:finish' },
      { key: 'note', type: 'text', default: '', labelKey: 'app-shell-settings-menus:App.ready', group: 'options' },
      { key: 'steps', type: 'list', default: [{ d: 6 }], labelKey: 'app-shell-settings-menus:App.ready', group: 'tool' },
    ],
  }

  it('gives defaults, visibility and spec 6.4 group order from one declaration', () => {
    const values = opSchema.defaultsOf(pocket)
    expect(values).toEqual({ stepdown: 1, rampAngle: 2, ramp: false, tool: null, passes: 1, note: '', steps: [{ d: 6 }] })
    expect(values.steps).not.toBe(pocket.params[6].default)
    expect(opSchema.visibleParams(pocket, values).map(p => p.key)).toEqual(['stepdown', 'ramp', 'tool', 'passes', 'note', 'steps'])
    expect(opSchema.groupsOf(pocket, { ...values, ramp: true }).map(g => g.group)).toEqual(['tool', 'passes', 'linking', 'custom:finish', 'options'])
  })

  it('flags only numbers that are not numbers', () => {
    expect(opSchema.validate(pocket, { ...opSchema.defaultsOf(pocket), stepdown: 'x', passes: 1.5 }).map(i => i.key)).toEqual(['stepdown', 'passes'])
    expect(opSchema.validate(pocket, opSchema.defaultsOf(pocket))).toEqual([])
  })
})
