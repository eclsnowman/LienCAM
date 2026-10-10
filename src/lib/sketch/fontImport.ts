// ADD-YOUR-OWN font import (sketch outline text). Converts a user-picked font
// file into three.js typeface JSON so it can join the outline-text registry
// (textOutline.ts registerFont) exactly like a built-in face.
//
// NO NEW NPM DEPENDENCY: a .ttf/.otf is parsed by three.js's own TTFLoader
// (which vendors opentype.module.js under three/examples), and an already-
// converted typeface .json is validated by FontLoader.parse. Both run in the
// browser off an ArrayBuffer; the heavy TTFLoader/opentype import is isolated
// in THIS module so the headless textOutline core stays lean.

import { TTFLoader } from 'three/examples/jsm/loaders/TTFLoader.js'
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js'
import { originalFileFromBytes, type OriginalFile } from '../import/originalFile'

/** The store embeds/clones the typeface verbatim, but projects only its family
 * and typeface fields. Namespaced metadata therefore travels through BOTH the
 * imported-font registry and project save/open without changing store routing. */
const ORIGINAL_FILE_KEY = '_liencamOriginalFile'
export function fontOriginalFile(asset: Pick<ProjectFontAsset, 'typeface'>): OriginalFile | undefined {
  const value = (asset.typeface as Record<string, unknown> | null)?.[ORIGINAL_FILE_KEY] as Partial<OriginalFile> | undefined
  return value && typeof value.fileName === 'string' && typeof value.dataUrl === 'string'
    ? value as OriginalFile : undefined
}

function withOriginal(typeface: unknown, file: File, bytes: ArrayBuffer): unknown {
  return { ...(typeface as Record<string, unknown>), [ORIGINAL_FILE_KEY]: originalFileFromBytes(file, bytes) }
}

/** A converted, registry-ready font: the family name + its typeface JSON.
 *  Persisted verbatim so imported-font text survives reload. */
export interface ImportedFontRecord {
  /** SHA-256 (hex) of the picked file's bytes: the face's content identity. */
  id: string
  family: string
  /** three.js typeface JSON (FontLoader.parse input). */
  typeface: unknown
}

/** WO-1456: an imported face the PROJECT owns, keyed by content id in
 *  Project.fonts. It rides in the same project object as the text that uses
 *  it -- saved into the .camproject and persisted with the active project -- so
 *  no file or reload can carry the text without the face it was drawn with. */
export interface ProjectFontAsset {
  family: string
  typeface: unknown
}
export type ProjectFontAssets = Record<string, ProjectFontAsset>

declare module '../../types' {
  interface Project {
    /** WO-1456: embedded imported typefaces, keyed by content id. Absent on
     *  projects that never imported a font. */
    fonts?: ProjectFontAssets
  }
}

/** True for a structurally usable embedded font asset. */
export function isProjectFontAsset(value: unknown): value is ProjectFontAsset {
  const v = value as Partial<ProjectFontAsset> | null
  return typeof v === 'object' && v !== null && typeof v.family === 'string'
    && typeof v.typeface === 'object' && v.typeface !== null
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Deep copy of typeface JSON (validation renders glyphs, which caches outlines
 *  onto the glyph data in place; the record keeps the untouched face). */
export function cloneTypeface<T>(typeface: T): T {
  return JSON.parse(JSON.stringify(typeface)) as T
}

/** Derive a family name: prefer the typeface's own familyName, else the file
 *  name without extension. */
function familyOf(typeface: unknown, fileName: string): string {
  const fam = (typeface as { familyName?: unknown } | null)?.familyName
  if (typeof fam === 'string' && fam.trim().length > 0) return fam.trim()
  return fileName.replace(/\.[^.]+$/, '') || 'Imported font'
}

/** Prove a parsed typeface actually renders before it is trusted: FontLoader.parse
 *  only wraps the given JSON (`this.data = json`) with no structural check, so a
 *  bare `{}` "parses" fine and only blows up later, in the viewport, the first time
 *  the operator places a glyph. Render one of the face's OWN glyphs right here so a
 *  bad import is rejected at the import step instead of at placement time.
 *  Any glyph that draws is enough (rule 11): a symbol, icon or non-Latin face with
 *  no 'H' or '?' still renders its own characters, and text layout already skips a
 *  missing glyph (textOutline.ts), so only a face that can draw nothing is refused. */
const GLYPH_PROBE_LIMIT = 64
function assertRendersUsableGlyphs(font: ReturnType<FontLoader['parse']>): void {
  const glyphs = (font.data as { glyphs?: unknown } | undefined)?.glyphs
  const chars = glyphs && typeof glyphs === 'object'
    ? Object.keys(glyphs).filter((ch) => ch.trim() !== '').slice(0, GLYPH_PROBE_LIMIT)
    : []
  let detail = ''
  for (const ch of chars) {
    try {
      const shapes = font.generateShapes(ch, 100)
      if (Array.isArray(shapes) && shapes.length > 0) return
    } catch (err) {
      detail = ` (${(err as Error).message})`
    }
  }
  throw new Error(`font does not render usable glyphs${detail}`)
}

/**
 * Read a user-picked font FILE and convert it to a registry-ready record.
 * - .ttf / .otf : parsed by TTFLoader.parse (synchronous, -> typeface JSON).
 * - .json       : parsed as an existing typeface.
 * Either path is then proven usable by actually rendering glyphs with it
 * (assertRendersUsableGlyphs) -- FontLoader.parse alone only wraps the JSON
 * and does not validate it. Rejects (throws) on an unsupported extension, a
 * parse failure, or a typeface that cannot render, so the caller can surface
 * a named notice.
 */
export async function importFontFile(file: File): Promise<ImportedFontRecord> {
  const buf = await file.arrayBuffer()
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.json')) {
    const typeface = JSON.parse(new TextDecoder().decode(buf))
    const pristine = cloneTypeface(typeface)
    const font = new FontLoader().parse(typeface as unknown as Parameters<FontLoader['parse']>[0])
    assertRendersUsableGlyphs(font)
    return { id: await sha256Hex(buf), family: familyOf(typeface, file.name), typeface: withOriginal(pristine, file, buf) }
  }
  if (lower.endsWith('.ttf') || lower.endsWith('.otf')) {
    const id = await sha256Hex(buf)
    const typeface = new TTFLoader().parse(buf) as unknown
    const pristine = cloneTypeface(typeface)
    const font = new FontLoader().parse(typeface as unknown as Parameters<FontLoader['parse']>[0])
    assertRendersUsableGlyphs(font)
    return { id, family: familyOf(typeface, file.name), typeface: withOriginal(pristine, file, buf) }
  }
  throw new Error(`Unsupported font file "${file.name}" (use .ttf, .otf or .json)`)
}
