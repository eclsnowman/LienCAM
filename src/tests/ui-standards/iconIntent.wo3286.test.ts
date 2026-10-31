// WO-3286 (UI M2 W1-I): every New UI icon has an intent row, draws only from theme roles, and a
// blind read of the whole set is on record (standard 4, M2-PLAN section 3). The owner judges the
// icons in the test drive, so the read's fail count is recorded, not gated.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Ui2Icon, UI2_ICON_FAMILY, UI2_ICON_IDS, UI2_ICON_INTENT, ui2IconSvg } from '../../components/icons/ui2'
import { roleVar, THEMES } from '../../theme/tokens'

const BLIND = JSON.parse(readFileSync(new URL('../evidence/WO-3286/blind-read.json', import.meta.url), 'utf8')) as {
  protocol: string; tiles: number; pass: number; near: number; fail: number
  results: { id: string; said: string; verdict: 'PASS' | 'NEAR' | 'FAIL' }[]
}
const ROLE_VARS = new Set(['--err', '--on-acc', '--on-err', '--sans', '--mono', ...Object.keys(THEMES.dark).filter(k => k !== 'name').map(k => roleVar(k as never))])
// icons the owner's notes and the round-4 list name; each must exist, drawn by this set
const NAMED = ['shell', 'offset', 'fillet', 'fillet2d', 'draft', 'measure', 'engrave', 'vcarve', 'section', 'compare', 'deviation',
  'zebra', 'form', 'relief', 'form-crease', 'form-loop', 'form-flatten', 'form-mirror', 'detail-view', 'fit-arcs', 'c-collinear']

describe('WO-3286 icon set', () => {
  it('holds the whole M1 family with a family for each icon', () => {
    expect(UI2_ICON_IDS.length).toBe(151)
    expect(new Set(UI2_ICON_IDS).size).toBe(UI2_ICON_IDS.length)
    for (const id of NAMED) expect(UI2_ICON_IDS, id).toContain(id)
    for (const id of UI2_ICON_IDS) expect(UI2_ICON_FAMILY[id], id).toBeTruthy()
  })

  it('refuses an icon without an intent row, and an intent row without an icon', () => {
    for (const id of UI2_ICON_IDS) {
      const row = UI2_ICON_INTENT[id]
      expect(row, `intent row for ${id}`).toBeDefined()
      expect(row.does.length, `${id} does`).toBeGreaterThan(8)
      expect(row.shows.length, `${id} shows`).toBeGreaterThan(2)
      for (const other of row.notConfusedWith) {
        expect(UI2_ICON_IDS, `${id} names unknown ${other}`).toContain(other)
        expect(other).not.toBe(id)
      }
    }
    expect(Object.keys(UI2_ICON_INTENT).sort()).toEqual([...UI2_ICON_IDS].sort())
  })

  it('draws every icon on the 48 grid, only from theme roles', () => {
    for (const id of UI2_ICON_IDS) {
      const svg = ui2IconSvg(id)
      expect(svg.length, id).toBeGreaterThan(40)
      for (const m of svg.matchAll(/(?:fill|stroke|stop-color|color)="([^"]*)"/g)) {
        expect(m[1] === 'none' || /^var\(--[a-z0-9-]+\)$/.test(m[1]), `${id} paints with ${m[1]}`).toBe(true)
      }
      expect(svg, `${id} inline style paint`).not.toMatch(/style="[^"]*(?:fill|stroke|color)\s*:/)
      // the only reference allowed is a clip path with an ic- id (identical wherever the icon repeats)
      expect(svg.replace(/url\(#ic-[a-z-]+\)/g, ''), `${id} gradient or filter`).not.toMatch(/url\(#/)
      for (const m of svg.matchAll(/var\((--[a-z0-9-]+)\)/g)) expect(ROLE_VARS.has(m[1]), `${id} uses ${m[1]}`).toBe(true)
      for (const m of svg.replace(/font-weight="\d+"/g, '').matchAll(/-?\d+(?:\.\d+)?/g)) expect(Math.abs(+m[0]), `${id} coordinate ${m[0]}`).toBeLessThan(200)
    }
  })

  it('renders an icon component at the asked size and nothing for an unknown id', () => {
    const html = renderToStaticMarkup(createElement(Ui2Icon, { id: 'fillet', size: 32 }))
    expect(html).toContain('viewBox="0 0 48 48"')
    expect(html).toContain('width="32"')
    expect(html).toContain(ui2IconSvg('fillet'))
    expect(renderToStaticMarkup(createElement(Ui2Icon, { id: 'no-such-icon' }))).not.toContain('<path')
  })

  it('names no owner in any intent word or drawing', () => {
    const owner = atob('ZXJpYw==')
    const words = JSON.stringify(UI2_ICON_INTENT) + UI2_ICON_IDS.map(ui2IconSvg).join('')
    expect(words.toLowerCase()).not.toContain(owner)
    for (const id of UI2_ICON_IDS) expect(UI2_ICON_INTENT[id].shows, id).not.toBe(UI2_ICON_INTENT[id].does)
  })

  it('keeps a blind read on record that covers every icon and adds up', () => {
    expect(BLIND.protocol).toBe('menu-match')
    expect(BLIND.results.map(r => r.id).sort()).toEqual([...UI2_ICON_IDS].sort())
    expect(BLIND.tiles).toBe(UI2_ICON_IDS.length)
    expect(BLIND.pass + BLIND.near + BLIND.fail).toBe(BLIND.tiles)
    for (const v of ['PASS', 'NEAR', 'FAIL'] as const) expect(BLIND.results.filter(r => r.verdict === v).length).toBe(BLIND[v.toLowerCase() as 'pass' | 'near' | 'fail'])
  })
})
