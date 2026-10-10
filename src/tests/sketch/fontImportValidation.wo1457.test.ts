// WO-1457 (Codex audit BUG-503, family K6): importFontFile trusted
// `FontLoader.parse` NOT throwing as proof a typeface JSON was usable.
// FontLoader.parse only wraps the given JSON (`this.data = json`) -- it
// performs no structural validation, so a bare `{}` "parsed" fine, was
// registered, persisted and selected as the active font, and only crashed
// the viewport the first time the operator actually placed a glyph
// (textOutline.ts's generateShapes reads `data.boundingBox.yMax`
// unconditionally, throwing on the missing metadata).
//
// The fix exercises generateShapes on a cap letter and the outline
// registry's missing-glyph fallback ('?', textOutline.ts) inside
// importFontFile itself, so a typeface that cannot render is rejected at
// import time through the SAME path an unsupported extension already uses.
//
// These tests drive the real import path at two levels: the isolated
// adapter (importFontFile) directly, and the store action that wires it
// (importSketchFont) -- proving a rejected import never reaches
// registerFont or the persisted importedFonts list, per BUG-503's finding.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import helvetikerData from 'three/examples/fonts/helvetiker_regular.typeface.json'
import { importFontFile } from '../../lib/sketch/fontImport'
import { fontDisplayName } from '../../lib/sketch/textOutline'

// WO-1052 precedent (see textFontPicker.test.ts): stub Worker before the
// store module loads so any lazily-referenced browser global resolves.
class NoopWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
;(globalThis as { Worker?: unknown }).Worker = NoopWorker

const VALID_FAMILY = (helvetikerData as { familyName: string }).familyName

function jsonFile(name: string, data: unknown): File {
  return new File([JSON.stringify(data)], name, { type: 'application/json' })
}

describe('WO-1457: importFontFile rejects a typeface that cannot render', () => {
  it('a bare {} throws instead of returning a usable record (fails on main before the fix)', async () => {
    await expect(importFontFile(jsonFile('empty.json', {})))
      .rejects.toThrow(/does not render usable glyphs/i)
  })

  it('a typeface with glyph data but no bounding box still throws', async () => {
    await expect(importFontFile(jsonFile('no-bbox.json', { glyphs: {}, resolution: 1000 })))
      .rejects.toThrow(/does not render usable glyphs/i)
  })

  it('a genuinely valid typeface.json still imports normally', async () => {
    const rec = await importFontFile(jsonFile('helvetiker.json', helvetikerData))
    expect(rec.family).toBe(VALID_FAMILY)
    // Not a full deep-equal: rendering a glyph to validate it (generateShapes)
    // caches an `_cachedOutline` onto the glyph data in place, by design --
    // so compare the data that matters (resolution + the glyph set) rather
    // than every key.
    const typeface = rec.typeface as { resolution: number; glyphs: Record<string, unknown> }
    const original = helvetikerData as unknown as { resolution: number; glyphs: Record<string, unknown> }
    expect(typeface.resolution).toBe(original.resolution)
    expect(Object.keys(typeface.glyphs).sort()).toEqual(Object.keys(original.glyphs).sort())
  })

  it('a face with no H and no ? glyph still imports when its own glyphs render (rule 11)', async () => {
    const original = JSON.parse(JSON.stringify(helvetikerData)) as { glyphs: Record<string, unknown> }
    const symbolOnly = { ...original, glyphs: { A: original.glyphs.A } }
    const rec = await importFontFile(jsonFile('symbol-only.json', symbolOnly))
    expect(Object.keys((rec.typeface as { glyphs: Record<string, unknown> }).glyphs)).toEqual(['A'])
  })

  it('an unsupported extension is still rejected the same way it always was', async () => {
    await expect(importFontFile(new File(['x'], 'font.txt')))
      .rejects.toThrow(/unsupported font file/i)
  })
})

describe('WO-1457: importSketchFont never registers or persists a rejected import', () => {
  let useCamStore: typeof import('../../store').useCamStore

  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
  })

  beforeEach(() => {
    useCamStore.setState({
      importedFonts: [],
      sketchTextFontFamily: 'Rounded Mplus 1c',
      sketchTextStyle: 'single-line',
      consoleEvents: [],
      consoleReadThroughId: 0,
    } as never)
  })

  it('an empty-typeface import: no registration, no persistence, active font/style unchanged', async () => {
    await useCamStore.getState().importSketchFont(jsonFile('empty.json', {}))

    const s = useCamStore.getState()
    expect(s.importedFonts).toHaveLength(0)
    expect(s.sketchTextFontFamily).toBe('Rounded Mplus 1c')
    expect(s.sketchTextStyle).toBe('single-line')
    expect(s.sketchFontFamilies()).not.toContain('empty')

    const events = s.consoleEvents
    expect(events.some((e) =>
      e.severity === 'error' && /font import failed/i.test(e.message),
    )).toBe(true)
  })

  it('a genuinely valid import still registers, persists, and selects', async () => {
    await useCamStore.getState().importSketchFont(jsonFile('helvetiker-import.json', helvetikerData))

    const s = useCamStore.getState()
    expect(s.importedFonts.map((f) => f.family)).toContain(VALID_FAMILY)
    expect(s.sketchTextStyle).toBe('outline')
    // WO-1456: an imported face is selected by its content-addressed registry
    // key; its display name is still the family.
    expect(fontDisplayName(s.sketchTextFontFamily)).toBe(VALID_FAMILY)
    expect(s.sketchFontFamilies()).toContain(s.sketchTextFontFamily)
  })
})
