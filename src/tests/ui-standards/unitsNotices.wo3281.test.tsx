// @vitest-environment jsdom
//
// WO-3281 (UI M2 Wave 1, lane D): the units and format service, the notice API with its one
// refusal route, the message catalogue in four languages and the Notice part.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fmtDim, FEED_DECIMALS } from '../../lib/ui/unitFormat'
import { createUnitsService, units, setUnitPrefsSource, NO_VALUE, DEFAULT_UNIT_PREFS, type UnitPrefs } from '../../lib/units'
import { connectAppUnitPrefs, decimalMarkFor } from '../../lib/units/format/appPrefs'
import { createNoticeApi, hasMessage, resolveMessage, NOTICE_LEVELS, type MessageKey, type NoticeLevel } from '../../notices'
import { Notice } from '../../notices/Notice'
import { LEVEL_LABEL, NOTICE_LOOK, UNIT_REASON } from '../../notices/catalogue'
import { applyLanguage } from '../../i18n'
import en from '../../i18n/locales/en/ui2-notices.wo3281'
import de from '../../i18n/locales/de/ui2-notices.wo3281'
import es from '../../i18n/locales/es/ui2-notices.wo3281'
import fr from '../../i18n/locales/fr/ui2-notices.wo3281'
import { THEMES, UI2_THEME_IDS, type ThemeTokens } from '../../theme/tokens'
import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'

const ROOT = join(__dirname, '..', '..', '..')
const MM: UnitPrefs = DEFAULT_UNIT_PREFS
const INCH: UnitPrefs = { ...DEFAULT_UNIT_PREFS, length: 'inch' }
const COMMA: UnitPrefs = { ...DEFAULT_UNIT_PREFS, decimalMark: ',' }
const NOT_NOW = { ready: false, reason: 'app-shell-settings-menus:App.noGeometryLoaded' } as const

afterEach(() => { cleanup(); setUnitPrefsSource(null) })

describe('WO-3281 units service', () => {
  const svc = createUnitsService()
  const samples = [0, 1, -1, 0.0004, -0.0004, 12.5, 25.4, 101.6, 1234.5678, 0.125, 304.8, 9999.9995]

  it('shows the same text as today\'s screens for the same value, unit and precision', () => {
    for (const u of ['mm', 'inch'] as const) {
      const prefs = u === 'mm' ? MM : INCH
      for (const v of samples) {
        expect(svc.formatLength(v, { prefs, withUnit: false })).toBe(fmtDim(v, u))
        expect(svc.formatFeed(v, { prefs, withUnit: false, precision: FEED_DECIMALS[u] })).toBe(fmtDim(v, u, FEED_DECIMALS[u]))
      }
    }
    expect(svc.formatLength(25.4, { prefs: INCH })).toBe('1.0000 in')
    // defaults the Wave 0 contract pins (feed 1 place in both units, as today's screens show; angle 2)
    expect(svc.formatFeed(1500, { prefs: MM })).toBe('1500.0 mm/min')
    expect(svc.formatFeed(254, { prefs: INCH })).toBe('10.0 in/min')
    expect(svc.formatAngle(45)).toBe('45.00°')
    expect(svc.formatSpeed(12000.4)).toBe('12000 rpm')
    expect(svc.formatFeed(1500, { prefs: MM, precision: 1 })).toBe('1500.0 mm/min')
    expect(svc.formatSpeed(18000)).toBe('18000 rpm')
  })

  it('round-trips exactly at the stored precision, in both units and with both marks', () => {
    for (const prefs of [MM, INCH, COMMA, { ...INCH, decimalMark: ',' } as UnitPrefs]) {
      for (const v of samples) {
        const text = svc.formatLength(v, { prefs })
        const back = svc.parseLength(text, { prefs })
        expect(back.ok).toBe(true)
        if (back.ok) expect(svc.formatLength(back.value, { prefs })).toBe(text)
      }
    }
    expect(svc.parseLength('12.700 mm', { prefs: MM })).toEqual({ ok: true, value: 12.7 })
    expect(svc.parseLength('0.5000 in', { prefs: INCH })).toEqual({ ok: true, value: 12.7 })
    expect(svc.parseLength('12 in', { prefs: MM })).toEqual({ ok: true, value: 304.8 })
    expect(svc.parseLength('12,5', { prefs: COMMA })).toEqual({ ok: true, value: 12.5 })
    // independent literals: the parsed value is the original at the stored precision
    expect(svc.parseLength(svc.formatLength(9999.9996, { prefs: MM }), { prefs: MM })).toEqual({ ok: true, value: 10000 })
    expect(svc.parseLength('1.2345 in', { prefs: MM })).toEqual({ ok: true, value: 31.3563 })
    expect(svc.parseLength('1.2346 in', { prefs: MM })).toEqual({ ok: true, value: 31.35884 })
    expect(svc.formatLength(12.5, { prefs: COMMA, trim: true })).toBe('12,5 mm')
  })

  it('never shows negative zero and shows a dash for a value that is not a number', () => {
    expect(svc.formatLength(-0.0004, { prefs: MM, withUnit: false })).toBe('0.000')
    expect(svc.formatAngle(-0.001, { withUnit: false })).toBe('0.00')
    expect(svc.formatLength(Number.NaN, { withUnit: false })).toBe(NO_VALUE)
    expect(svc.formatFeed(Number.POSITIVE_INFINITY, { withUnit: false })).toBe(NO_VALUE)
  })

  it('never guesses a parse: it gives a catalogue reason that says what is wrong', () => {
    expect(svc.parseLength('1,000', { prefs: MM })).toEqual({ ok: false, reason: UNIT_REASON.wrongMark })
    expect(svc.parseLength('1.5', { prefs: COMMA })).toEqual({ ok: false, reason: UNIT_REASON.wrongMark })
    expect(svc.parseLength('abc')).toEqual({ ok: false, reason: UNIT_REASON.notANumber })
    expect(svc.parseLength('')).toEqual({ ok: false, reason: UNIT_REASON.notANumber })
    expect(svc.parseAngle('5 mm')).toEqual({ ok: false, reason: UNIT_REASON.wrongUnit })
    expect(svc.parse('speed', '12 mm')).toEqual({ ok: false, reason: UNIT_REASON.wrongUnit })
    expect(svc.parseAngle('45°')).toEqual({ ok: true, value: 45 })
    expect(svc.parseLength('1.')).toEqual({ ok: true, value: 1 })
    expect(svc.parseLength('.5')).toEqual({ ok: true, value: 0.5 })
    expect(svc.parseLength('1e3')).toEqual({ ok: false, reason: UNIT_REASON.notANumber })
    expect(svc.parseLength('1"', { prefs: MM })).toEqual({ ok: true, value: 25.4 })
    expect(svc.parseLength('2 MM', { prefs: INCH })).toEqual({ ok: true, value: 2 })
    expect(svc.parseLength('1 in/min')).toEqual({ ok: false, reason: UNIT_REASON.notANumber })
    expect(Object.is(svc.parseLength('-0').ok && (svc.parseLength('-0') as { value: number }).value, 0)).toBe(true)
    expect(svc.parseFeed('1 in/min', { prefs: MM })).toEqual({ ok: true, value: 25.4 })
    expect(svc.parse('percent', '50 %')).toEqual({ ok: true, value: 50 })
  })

  it('follows the live settings once connected: unit from Display units, mark from the language', async () => {
    expect(decimalMarkFor('en')).toBe('.')
    for (const l of ['de', 'es', 'fr']) expect(decimalMarkFor(l)).toBe(',')
    expect(units.formatLength(25.4)).toBe('25.400 mm') // not connected yet: defaults
    connectAppUnitPrefs()
    const before = useCamStore.getState().appSettings.displayUnits
    try {
      useCamStore.getState().setDisplayUnits('inch')
      expect(units.formatLength(25.4)).toBe('1.0000 in')
      useCamStore.getState().setDisplayUnits('mm')
      useUiPrefs.getState().setLanguage('de')
      expect(units.formatLength(25.4)).toBe('25,400 mm')
    } finally {
      useUiPrefs.getState().setLanguage('en')
      useCamStore.getState().setDisplayUnits(before)
    }
    await applyLanguage('en')
  })
})

describe('WO-3281 notice API', () => {
  it('posts, lists, dismisses and notifies at all four levels', () => {
    const api = createNoticeApi(() => 7)
    const seen: number[] = []
    const off = api.subscribe(list => seen.push(list.length))
    const ids = NOTICE_LEVELS.map(level => api.post({ level, key: LEVEL_LABEL[level] }))
    expect(api.list().map(n => n.level)).toEqual([...NOTICE_LEVELS])
    expect(api.list().every(n => n.at === 7)).toBe(true)
    api.dismiss(ids[1])
    api.dismiss(ids[1]) // already gone: no second notification
    expect(api.list().map(n => n.id)).toEqual([ids[0], ids[2], ids[3]])
    expect(seen).toEqual([1, 2, 3, 4, 3])
    off()
    api.post({ level: 'info', key: LEVEL_LABEL.info })
    expect(seen).toHaveLength(5)
  })

  it('refuses to post a level or a message key the catalogue does not have', () => {
    const api = createNoticeApi()
    expect(() => api.post({ level: 'fatal' as NoticeLevel, key: LEVEL_LABEL.info })).toThrow(/level/)
    expect(() => api.post({ level: 'info', key: 'ui2-notices.wo3281:no.such.key' as MessageKey })).toThrow(/catalogue/)
    expect(() => api.post({ level: 'info', key: 'ui2-notices.wo3281:levels' as MessageKey })).toThrow(/catalogue/) // a branch, not a message
    expect(() => api.post({ level: 'info', key: 'no-such-area:x' as MessageKey })).toThrow(/catalogue/)
    expect(hasMessage(UNIT_REASON.wrongUnit)).toBe(true)
    expect(api.list()).toEqual([])
  })

  it('refuse() posts a command\'s availability reason once and refuses nothing that is ready', () => {
    const api = createNoticeApi()
    expect(api.refuse('toolpath.post', { ready: true })).toBeNull()
    expect(api.list()).toEqual([])
    const id = api.refuse('toolpath.post', NOT_NOW)
    expect(id).not.toBeNull()
    expect(api.refuse('toolpath.post', NOT_NOW)).toBe(id)
    expect(api.list()).toHaveLength(1)
    expect(api.list()[0]).toMatchObject({ level: 'cannot-do-this', key: NOT_NOW.reason, commandId: 'toolpath.post' })
    expect(api.refuse('toolpath.generate', NOT_NOW)).not.toBe(id)
    api.dismiss(id as string)
    expect(api.refuse('toolpath.post', NOT_NOW)).not.toBe(id)
    expect(api.list()).toHaveLength(2)
  })
})

describe('WO-3281 message catalogue', () => {
  const flat = (tree: unknown, prefix = ''): string[] =>
    Object.entries(tree as Record<string, unknown>).flatMap(([k, v]) => typeof v === 'string' ? [prefix + k] : flat(v, prefix + k + '.'))

  it('has the same keys in all four languages, and every key the code names exists', () => {
    const keys = flat(en).sort()
    for (const other of [de, es, fr]) expect(flat(other).sort()).toEqual(keys)
    const named = [...Object.values(UNIT_REASON), ...Object.values(LEVEL_LABEL)].filter(k => k.startsWith('ui2-notices.wo3281:'))
    expect(named.length).toBeGreaterThan(4)
    for (const key of named) expect(keys).toContain(key.slice(key.indexOf(':') + 1))
    for (const key of Object.values(UNIT_REASON)) expect(hasMessage(key), key).toBe(true)
    expect(Object.keys(LEVEL_LABEL).sort()).toEqual([...NOTICE_LEVELS].sort())
  })

  it('resolves a key in the operator\'s language and falls back to English for no other', async () => {
    expect(resolveMessage(UNIT_REASON.wrongUnit)).toBe(en.units.wrongUnit)
    await applyLanguage('de')
    try {
      expect(resolveMessage(UNIT_REASON.wrongUnit)).toBe(de.units?.wrongUnit)
      expect(resolveMessage(LEVEL_LABEL.error)).toBe(de.levels?.error)
    } finally { await applyLanguage('en') }
  })
})

describe('WO-3281 Notice part', () => {
  it('renders each level with its catalogue text, level word and a dismiss button', () => {
    const dismissed: string[] = []
    for (const level of NOTICE_LEVELS) {
      const { unmount } = render(
        <Notice notice={{ id: 'n1', level, key: UNIT_REASON.notANumber, at: 0 }} closeLabel="Close" onDismiss={id => dismissed.push(id)} testId={`n-${level}`} />,
      )
      const el = screen.getByTestId(`n-${level}`)
      expect(el.getAttribute('data-level')).toBe(level)
      expect(el.getAttribute('role')).toBe(level === 'info' ? 'status' : 'alert')
      expect(el.textContent).toContain(resolveMessage(UNIT_REASON.notANumber))
      expect(el.textContent).toContain(resolveMessage(LEVEL_LABEL[level]))
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      unmount()
    }
    expect(dismissed).toEqual(['n1', 'n1', 'n1', 'n1'])
  })

  const lum = (hex: string) => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

  it('is readable in all three M1 themes: text and level word 4.5:1 on the ground, edge 3:1, only theme roles', () => {
    for (const id of UI2_THEME_IDS) {
      const t = THEMES[id] as unknown as Record<string, string>
      for (const level of NOTICE_LEVELS) {
        const look = NOTICE_LOOK[level]
        expect(contrast(t[look.ink], t[look.ground]), `${id} ${level} text`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(t[look.label], t[look.ground]), `${id} ${level} label`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(t[look.edge], t[look.ground]), `${id} ${level} edge`).toBeGreaterThanOrEqual(3)
      }
    }
    const roles = Object.keys(THEMES.dark).filter(k => k !== 'name') as (keyof ThemeTokens)[]
    for (const look of Object.values(NOTICE_LOOK)) for (const role of Object.values(look)) expect(roles).toContain(role)
    const css = readFileSync(join(ROOT, 'src/notices/catalogue/notice.css'), 'utf8')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
    expect(css).not.toMatch(/var\(--stop\)/) // the safety red is for E-STOP only
  })
})
