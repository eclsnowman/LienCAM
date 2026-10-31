// WO-3285 (UI M2 W1-H): finds the samples the kit lanes export (see ./index.tsx for the convention).
import type { ComponentType } from 'react'
import { KIT_PARTS, type KitPart } from '../../components/kit'

interface GalleryModule { readonly gallery?: Partial<Record<KitPart, ComponentType>> }

const MODULES = import.meta.glob<GalleryModule>(
  ['../../components/kit/*/gallery.tsx', '../../notices/gallery.tsx'],
  { eager: true },
)

/** Every sample the kit lanes export, by part name. A part named twice keeps the first, in path order. */
export function gallerySamples(modules: Readonly<Record<string, GalleryModule>> = MODULES): Partial<Record<KitPart, ComponentType>> {
  const out: Partial<Record<KitPart, ComponentType>> = {}
  for (const path of Object.keys(modules).sort()) {
    const exported = modules[path].gallery
    if (!exported) continue
    for (const part of KIT_PARTS) {
      const sample = exported[part]
      if (sample && !out[part]) out[part] = sample
    }
  }
  return out
}
