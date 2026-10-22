// WO-3012 (WO-2750 Slice F part 1): the sheet scene as a static R2000 DXF.
//
// Design section 5 "DXF": sheet-space lines, arcs and circles plus outlined
// annotation glyphs on named layers (VISIBLE, HIDDEN, CENTER, DIMENSION, TEXT,
// and FRAME for the sheet border and title block). Dimensions are exploded
// geometry; the file carries no DIMENSION entities and no LienCAM association,
// and says so by being plain geometry. $INSUNITS=4 (mm): the units are SHEET
// millimetres, so a 100 mm edge at 1:2 is a 50-unit line. DXF Y points up, so
// the scene's Y-down sheet is flipped about the sheet height here.
//
// Outlined text has no TEXT entity, so the logical string rides on the first
// outline of each text item as XDATA (APPID LIENCAM, 1000 "text:<string>").
//
// Branding is never dropped silently: 'companion' writes an IMAGE that points
// at a relative file returned in `companions`; 'vector-only' draws a labelled
// empty frame where the logo goes and says so in `notes`.

import { textItem, type Pt, type SceneImage, type SceneItem, type SceneLayer, type SheetScene } from './scene'

export interface DxfExportOptions {
  /** default 'vector-only' */
  branding?: 'companion' | 'vector-only'
  /** folder-name stem for the companion bundle (`<stem>-assets/<file>`); default 'drawing' */
  fileStem?: string
  fontFamily?: string
}

export interface DxfCompanion {
  /** relative to the DXF file */
  path: string
  contentType: string
  bytes: Uint8Array
}

export interface DxfExportResult {
  dxf: string
  companions: DxfCompanion[]
  /** what the DXF does not carry, in plain sentences */
  notes: string[]
}

const LAYER_STYLE: Record<SceneLayer, { color: number; ltype: string; weight: number }> = {
  FRAME: { color: 7, ltype: 'Continuous', weight: 50 },
  VISIBLE: { color: 7, ltype: 'Continuous', weight: 35 },
  HIDDEN: { color: 8, ltype: 'HIDDEN', weight: 18 },
  CENTER: { color: 1, ltype: 'CENTER', weight: 18 },
  DIMENSION: { color: 3, ltype: 'Continuous', weight: 18 },
  TEXT: { color: 7, ltype: 'Continuous', weight: 25 },
}
const LAYER_ORDER: SceneLayer[] = ['FRAME', 'VISIBLE', 'HIDDEN', 'CENTER', 'DIMENSION', 'TEXT']

function num(v: number): string {
  const s = v.toFixed(6)
  const t = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
  return t === '-0' ? '0' : t
}

/** DXF strings are single-line and codepage-bound: control characters and anything above ASCII become \U+XXXX. */
function str(s: string, max = Infinity): string {
  let out = ''
  for (const ch of Array.from(s).slice(0, max)) {
    // \U+ takes four hex digits, so characters above U+FFFF go out as their two UTF-16 units; a backslash is escaped too
    for (let i = 0; i < ch.length; i++) {
      const c = ch.charCodeAt(i)
      out += c < 32 || c > 126 || c === 92 ? `\\U+${c.toString(16).toUpperCase().padStart(4, '0')}` : ch[i]
    }
  }
  return out
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '')
  return cleaned || 'logo'
}

class Writer {
  private lines: string[] = []
  private nextHandle = 0x20
  raw(text: string): void { if (text) for (const l of text.replace(/\r\n$/, '').split('\r\n')) this.lines.push(l) }
  code(c: number, v: string | number): void { this.lines.push(String(c), typeof v === 'number' ? num(v) : v) }
  handle(): string { return (this.nextHandle++).toString(16).toUpperCase() }
  get seed(): string { return this.nextHandle.toString(16).toUpperCase() }
  text(): string { return this.lines.length ? this.lines.join('\r\n') + '\r\n' : '' }
}

export function exportDrawingDxf(scene: SheetScene, opts: DxfExportOptions = {}): DxfExportResult {
  const H = scene.sizeMm[1]
  const W = scene.sizeMm[0]
  const notes: string[] = []
  const companions: DxfCompanion[] = []
  const branding = opts.branding ?? 'vector-only'
  const stem = safeFileName(opts.fileStem ?? 'drawing')

  const items: SceneItem[] = [...scene.items]
  const images: Array<{ img: SceneImage; path: string }> = []
  const usedPaths = new Set<string>()
  for (const img of scene.images) {
    if (branding === 'companion') {
      let file = safeFileName(img.name)
      const ext = img.kind === 'png' ? '.png' : '.jpg'
      if (!/\.(png|jpe?g)$/i.test(file)) file += ext
      while (usedPaths.has(file.toLowerCase())) file = `${img.id.replace(/[^A-Za-z0-9]/g, '')}-${file}`
      usedPaths.add(file.toLowerCase())
      const path = `${stem}-assets/${file}`
      companions.push({ path, contentType: img.contentType, bytes: img.bytes })
      images.push({ img, path })
    } else {
      const [x, y, w, h] = img.rectMm
      items.push({ kind: 'polyline', layer: 'FRAME', points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true })
      items.push(textItem('TEXT', 'LOGO OMITTED', [x + 1.5, y + h / 2], 2.2, { fontFamily: opts.fontFamily, ownerId: img.id }))
      notes.push(`Branding "${img.name}" is not in this vector-only DXF; an empty frame marks where it goes. Export with the companion image bundle to keep it.`)
    }
  }

  const flip = (p: Pt): Pt => [p[0], H - p[1]]

  // -- sections built first so $HANDSEED and extents are known -------------------
  const ents = new Writer()
  const handles = new Writer() // shared handle counter for everything
  const msRecord = '1F'
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity
  const grow = (p: Pt) => { xmin = Math.min(xmin, p[0]); ymin = Math.min(ymin, p[1]); xmax = Math.max(xmax, p[0]); ymax = Math.max(ymax, p[1]) }
  const header = (type: string, layer: string, sub: string) => {
    ents.code(0, type)
    ents.code(5, handles.handle())
    ents.code(330, msRecord)
    ents.code(100, 'AcDbEntity')
    ents.code(8, layer)
    ents.code(100, sub)
  }
  const poly = (layer: string, pts: Pt[], closed: boolean, text?: { text: string; owner?: string }) => {
    if (pts.length < 2) return
    const p = pts.map(flip)
    p.forEach(grow)
    if (p.length === 2 && !closed) {
      header('LINE', layer, 'AcDbLine')
      ents.code(10, p[0][0]); ents.code(20, p[0][1]); ents.code(30, 0)
      ents.code(11, p[1][0]); ents.code(21, p[1][1]); ents.code(31, 0)
    } else {
      header('LWPOLYLINE', layer, 'AcDbPolyline')
      ents.code(90, p.length)
      ents.code(70, closed ? 1 : 0)
      for (const v of p) { ents.code(10, v[0]); ents.code(20, v[1]) }
    }
    if (text) {
      ents.code(1001, 'LIENCAM')
      ents.code(1000, `text:${str(text.text, 60)}`)
      if (text.owner) ents.code(1000, `owner:${str(text.owner, 60)}`)
    }
  }
  for (const item of items) {
    switch (item.kind) {
      case 'polyline': poly(item.layer, item.points, item.closed); break
      case 'circle': {
        const c = flip(item.center)
        grow([c[0] - item.radiusMm, c[1] - item.radiusMm]); grow([c[0] + item.radiusMm, c[1] + item.radiusMm])
        header('CIRCLE', item.layer, 'AcDbCircle')
        ents.code(10, c[0]); ents.code(20, c[1]); ents.code(30, 0); ents.code(40, item.radiusMm)
        break
      }
      case 'arc': {
        const c = flip(item.center)
        grow([c[0] - item.radiusMm, c[1] - item.radiusMm]); grow([c[0] + item.radiusMm, c[1] + item.radiusMm])
        header('ARC', item.layer, 'AcDbCircle')
        ents.code(10, c[0]); ents.code(20, c[1]); ents.code(30, 0); ents.code(40, item.radiusMm)
        ents.code(100, 'AcDbArc'); ents.code(50, ((item.startDeg % 360) + 360) % 360); ents.code(51, ((item.endDeg % 360) + 360) % 360)
        break
      }
      case 'text': {
        let first = true
        for (const ring of item.rings) { poly(item.layer, ring, true, first ? { text: item.text, owner: item.ownerId } : undefined); first = false }
        for (const s of item.strokes) { poly(item.layer, s, false, first ? { text: item.text, owner: item.ownerId } : undefined); first = false }
        break
      }
    }
  }

  // -- IMAGE objects (companion bundle) -------------------------------------------
  const dictRoot = 'C'
  const imageDict = handles.handle()
  const imageDefs: Array<{ imgHandle: string; defHandle: string; reactor: string; img: SceneImage; path: string }> = []
  for (const { img, path } of images) {
    const [x, y, w, h] = img.rectMm
    const imgHandle = handles.handle(), defHandle = handles.handle(), reactor = handles.handle()
    imageDefs.push({ imgHandle, defHandle, reactor, img, path })
    const ll = flip([x, y + h])
    grow(ll); grow([ll[0] + w, ll[1] + h])
    ents.code(0, 'IMAGE'); ents.code(5, imgHandle); ents.code(330, msRecord)
    ents.code(100, 'AcDbEntity'); ents.code(8, 'FRAME'); ents.code(100, 'AcDbRasterImage'); ents.code(90, 0)
    ents.code(10, ll[0]); ents.code(20, ll[1]); ents.code(30, 0)
    ents.code(11, w / img.widthPx); ents.code(21, 0); ents.code(31, 0)
    ents.code(12, 0); ents.code(22, h / img.heightPx); ents.code(32, 0)
    ents.code(13, img.widthPx); ents.code(23, img.heightPx)
    ents.code(340, defHandle); ents.code(70, 3); ents.code(280, 0); ents.code(281, 50); ents.code(282, 50); ents.code(283, 0)
    ents.code(360, reactor); ents.code(71, 1); ents.code(91, 2)
    ents.code(14, -0.5); ents.code(24, -0.5); ents.code(14, img.widthPx - 0.5); ents.code(24, img.heightPx - 0.5)
  }

  // -- assemble ------------------------------------------------------------------------
  const out = new Writer()
  const sec = (name: string) => { out.code(0, 'SECTION'); out.code(2, name) }
  const endsec = () => out.code(0, 'ENDSEC')
  if (!Number.isFinite(xmin)) { xmin = 0; ymin = 0; xmax = W; ymax = H }

  if (imageDefs.length > 0) {
    sec('CLASSES')
    for (const [name, cpp, flags, proxy] of [['IMAGE', 'AcDbRasterImage', 127, 1], ['IMAGEDEF', 'AcDbRasterImageDef', 0, 1], ['IMAGEDEF_REACTOR', 'AcDbRasterImageDefReactor', 1, 1]] as const) {
      out.code(0, 'CLASS'); out.code(1, name); out.code(2, cpp); out.code(3, 'ISM'); out.code(90, flags); out.code(91, proxy); out.code(280, 0); out.code(281, 1)
    }
    endsec()
  }

  sec('TABLES')
  const table = (name: string, handle: string, count: number, body: () => void) => {
    out.code(0, 'TABLE'); out.code(2, name); out.code(5, handle); out.code(330, 0); out.code(100, 'AcDbSymbolTable'); out.code(70, count)
    body()
    out.code(0, 'ENDTAB')
  }
  const rec = (type: string, owner: string, sub: string, handle = handles.handle()) => {
    out.code(0, type); out.code(5, handle); out.code(330, owner); out.code(100, 'AcDbSymbolTableRecord'); out.code(100, sub)
  }
  table('VPORT', '8', 1, () => {
    rec('VPORT', '8', 'AcDbViewportTableRecord')
    out.code(2, '*Active'); out.code(70, 0)
    out.code(10, 0); out.code(20, 0); out.code(11, 1); out.code(21, 1)
    out.code(12, W / 2); out.code(22, H / 2); out.code(40, H * 1.1); out.code(41, W / H)
  })
  table('LTYPE', '5', 5, () => {
    for (const [name, desc, pattern] of [['ByBlock', '', []], ['ByLayer', '', []], ['Continuous', 'Solid line', []], ['HIDDEN', 'Hidden __ __ __', [2, -1]], ['CENTER', 'Center ____ _ ____ _', [8, -1.5, 1.5, -1.5]]] as Array<[string, string, number[]]>) {
      rec('LTYPE', '5', 'AcDbLinetypeTableRecord')
      out.code(2, name); out.code(70, 0); out.code(3, desc); out.code(72, 65); out.code(73, pattern.length)
      out.code(40, pattern.reduce((s, v) => s + Math.abs(v), 0))
      for (const p of pattern) { out.code(49, p); out.code(74, 0) }
    }
  })
  table('LAYER', '2', LAYER_ORDER.length + 1, () => {
    rec('LAYER', '2', 'AcDbLayerTableRecord'); out.code(2, '0'); out.code(70, 0); out.code(62, 7); out.code(6, 'Continuous'); out.code(370, 25)
    for (const l of LAYER_ORDER) {
      const st = LAYER_STYLE[l]
      rec('LAYER', '2', 'AcDbLayerTableRecord'); out.code(2, l); out.code(70, 0); out.code(62, st.color); out.code(6, st.ltype); out.code(370, st.weight)
    }
  })
  table('STYLE', '3', 1, () => { rec('STYLE', '3', 'AcDbTextStyleTableRecord'); out.code(2, 'Standard'); out.code(70, 0); out.code(40, 0); out.code(41, 1); out.code(50, 0); out.code(71, 0); out.code(42, 2.5); out.code(3, 'txt'); out.code(4, '') })
  table('VIEW', '6', 0, () => {})
  table('UCS', '7', 0, () => {})
  table('APPID', '9', 2, () => {
    rec('APPID', '9', 'AcDbRegAppTableRecord'); out.code(2, 'ACAD'); out.code(70, 0)
    rec('APPID', '9', 'AcDbRegAppTableRecord'); out.code(2, 'LIENCAM'); out.code(70, 0)
  })
  table('DIMSTYLE', 'A', 0, () => {})
  table('BLOCK_RECORD', '1', 2, () => {
    rec('BLOCK_RECORD', '1', 'AcDbBlockTableRecord', msRecord); out.code(2, '*Model_Space')
    rec('BLOCK_RECORD', '1', 'AcDbBlockTableRecord', '1B'); out.code(2, '*Paper_Space')
  })
  endsec()

  sec('BLOCKS')
  for (const [name, record] of [['*Model_Space', msRecord], ['*Paper_Space', '1B']] as const) {
    out.code(0, 'BLOCK'); out.code(5, handles.handle()); out.code(330, record); out.code(100, 'AcDbEntity'); out.code(8, '0'); out.code(100, 'AcDbBlockBegin')
    out.code(2, name); out.code(70, 0); out.code(10, 0); out.code(20, 0); out.code(30, 0); out.code(3, name); out.code(1, '')
    out.code(0, 'ENDBLK'); out.code(5, handles.handle()); out.code(330, record); out.code(100, 'AcDbEntity'); out.code(8, '0'); out.code(100, 'AcDbBlockEnd')
  }
  endsec()

  sec('ENTITIES')
  out.raw(ents.text())
  endsec()

  sec('OBJECTS')
  if (imageDefs.length > 0) {
    out.code(0, 'DICTIONARY'); out.code(5, dictRoot); out.code(330, 0); out.code(100, 'AcDbDictionary'); out.code(281, 1)
    out.code(3, 'ACAD_IMAGE_DICT'); out.code(350, imageDict)
    out.code(0, 'DICTIONARY'); out.code(5, imageDict); out.code(330, dictRoot); out.code(100, 'AcDbDictionary'); out.code(281, 1)
    imageDefs.forEach(d => { out.code(3, `LIENCAM_${d.defHandle}`); out.code(350, d.defHandle) })
    for (const d of imageDefs) {
      out.code(0, 'IMAGEDEF'); out.code(5, d.defHandle); out.code(102, '{ACAD_REACTORS'); out.code(330, d.reactor); out.code(102, '}')
      out.code(330, imageDict); out.code(100, 'AcDbRasterImageDef'); out.code(90, 0)
      out.code(1, str(d.path)); out.code(10, d.img.widthPx); out.code(20, d.img.heightPx); out.code(11, 1); out.code(21, 1); out.code(280, 1); out.code(281, 0)
      out.code(0, 'IMAGEDEF_REACTOR'); out.code(5, d.reactor); out.code(330, d.imgHandle); out.code(100, 'AcDbRasterImageDefReactor'); out.code(90, 2)
    }
  } else {
    out.code(0, 'DICTIONARY'); out.code(5, dictRoot); out.code(330, 0); out.code(100, 'AcDbDictionary'); out.code(281, 1)
  }
  endsec()
  out.code(0, 'EOF')

  const head = new Writer()
  {
    const out = head
    const sec = (name: string) => { out.code(0, 'SECTION'); out.code(2, name) }
    const endsec = () => out.code(0, 'ENDSEC')
  sec('HEADER')
  out.code(9, '$ACADVER'); out.code(1, 'AC1015')
  out.code(9, '$DWGCODEPAGE'); out.code(3, 'ANSI_1252')
  out.code(9, '$INSBASE'); out.code(10, 0); out.code(20, 0); out.code(30, 0)
  out.code(9, '$EXTMIN'); out.code(10, xmin); out.code(20, ymin); out.code(30, 0)
  out.code(9, '$EXTMAX'); out.code(10, xmax); out.code(20, ymax); out.code(30, 0)
  out.code(9, '$LIMMIN'); out.code(10, 0); out.code(20, 0)
  out.code(9, '$LIMMAX'); out.code(10, W); out.code(20, H)
  out.code(9, '$LTSCALE'); out.code(40, 1)
  out.code(9, '$MEASUREMENT'); out.code(70, 1)
  out.code(9, '$INSUNITS'); out.code(70, 4)
  out.code(9, '$LUNITS'); out.code(70, 2)
  out.code(9, '$LWDISPLAY'); out.code(290, 1)
  out.code(9, '$PROJECTNAME'); out.code(1, str(scene.revision))
  out.code(9, '$HANDSEED'); out.code(5, handles.seed)
  endsec()

  }
  return { dxf: head.text() + out.text(), companions, notes }
}
