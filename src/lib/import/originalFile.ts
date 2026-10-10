import type { ImportedGeometry } from '../../types'
import { bytesToDataUrl, dataUrlToBytes } from '../../referenceImage/imageData'
import { loadCachedSTL } from '../stlCache'
import { loadCachedStep } from '../stepCache'
import { saveFile } from '../saveFile'

/** Source bytes, independent of parsed geometry, edits and display resampling. */
export interface OriginalFile {
  fileName: string
  dataUrl: string
}

declare module '../../types' {
  interface ImportedGeometry {
    originalFile?: OriginalFile
  }
}

export function originalFileFromBytes(file: Pick<File, 'name' | 'type'>, bytes: ArrayBuffer): OriginalFile {
  return { fileName: file.name, dataUrl: bytesToDataUrl(new Uint8Array(bytes), file.type || 'application/octet-stream') }
}

export async function saveOriginalFile(original: OriginalFile): Promise<string | null> {
  // Image crash-recovery metadata can briefly precede hydration of its bytes.
  // Missing bytes must never be written as a successful empty original.
  if (!original.dataUrl) return null
  const { bytes, mime } = dataUrlToBytes(original.dataUrl)
  return saveFile(original.fileName, new Blob([bytes.slice().buffer], { type: mime }), mime)
}

/** Existing STL/STEP projects already own exact bytes in their portable caches.
 * Never regenerate an "original" from edited loops or a tessellated display. */
export async function saveGeometryOriginal(geo: ImportedGeometry): Promise<string | null> {
  if (geo.originalFile) return saveOriginalFile(geo.originalFile)
  // Older IGES imports retained only converted STEP, never the picked IGES.
  if (/\.(igs|iges)$/i.test(geo.filename)) return null
  const bytes = geo.format === 'stl' ? await loadCachedSTL(geo.id)
    : geo.format === 'step' ? await loadCachedStep(geo.id) : null
  return bytes ? saveOriginalFile(originalFileFromBytes({ name: geo.filename, type: '' }, bytes)) : null
}
