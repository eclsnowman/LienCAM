// Image relief - the Model-history feature an applied relief becomes, and the
// kernel request it replays through (docs/design/IMAGE-RELIEF-PLAN.md
// section 3, route (b), and 3a: the exact face, never above 256 control
// points per side).
//
// Apply commits ONE feature (opType 'relief') that consumes the body it was
// laid on, like Push/Pull. Its payload holds everything a replay needs: the
// picture itself (inside the project - Operator's default, plan section 6 q1), the
// face frame it was placed on, every control's value and Auto's choices. The
// heights are recomputed from those on replay, the same way the palette
// computes them, so the preview, the built face and a reopened project agree.

import { dataUrlToBytes } from '../referenceImage/imageData'
export { bytesToDataUrl, dataUrlToBytes } from '../referenceImage/imageData'
import type { AutoParams } from './adjust'
import { decodePicture, capPicture, type Picture } from './picture'
import { adjustedFor, isMeshRelief, reliefDetailGrid, reliefFrame, reliefSurface, type FaceFrame, type ReliefFrame, type ReliefSettings } from './reliefHeights'
import { workingGridSize, type HeightGrid } from './heightGrid'
import { MANUAL_ADJUST } from './adjust'
import type { ReliefPoles } from './reliefStep'

export interface ReliefImage {
  /** the picture file, as a data: URL (stored inside the project) */
  dataUrl: string
  fileName: string
  cols: number
  rows: number
  bitDepth: 8 | 16
}

export interface ReliefFeaturePayload {
  opType: 'relief'
  name: string
  /** the body the relief was laid on (the node consumes it) */
  ownerId: string
  image: ReliefImage
  face: FaceFrame
  settings: ReliefSettings
  autoParams: AutoParams
}

export function isReliefFeaturePayload(payload: Record<string, unknown>): payload is ReliefFeaturePayload & Record<string, unknown> {
  const image = payload.image as ReliefImage | undefined
  const settings = payload.settings as ReliefSettings | undefined
  const face = payload.face as FaceFrame | undefined
  return payload.opType === 'relief'
    && typeof payload.ownerId === 'string'
    && typeof image === 'object' && image !== null && typeof image.dataUrl === 'string'
    && typeof settings === 'object' && settings !== null && Number.isFinite(settings.widthMm) && Number.isFinite(settings.depthMm)
    && typeof face === 'object' && face !== null && typeof face.normal === 'object'
    && typeof payload.autoParams === 'object' && payload.autoParams !== null
}

/** The kernel's part of a relief: where the face goes and its control points (engine: ReliefEditRequest). */
export interface ReliefKernelFields {
  frame: ReliefFrame
  poles: ReliefPoles
  /** WO-2200: a mesh relief's working grid - the relief face is meshed from it at full detail */
  detail?: HeightGrid
}

/** WO-2200: the tree row says so (IMAGE-RELIEF-PLAN.md section 3: 'says so in the tree row ("mesh relief")'). */
const MESH_RELIEF_ROW = ' (mesh relief)'

/** The name a relief's tree row shows: its own name, "(mesh relief)" after it for a mesh relief. */
export function reliefRowName(name: string, settings: Pick<ReliefSettings, 'widthMm' | 'heightMm'>): string {
  const base = reliefBaseName(name)
  return isMeshRelief(workingGridSize(settings.widthMm, settings.heightMm)) ? `${base}${MESH_RELIEF_ROW}` : base
}

/** The relief's own name, without what its tree row adds. */
export function reliefBaseName(name: string): string {
  return name.endsWith(MESH_RELIEF_ROW) ? name.slice(0, -MESH_RELIEF_ROW.length) : name
}

/** Decoded pictures by data URL: a replay after an unrelated edit does not decode the picture again. */
const pictureCache = new Map<string, Promise<Picture>>()

export function pictureOf(image: ReliefImage): Promise<Picture> {
  let p = pictureCache.get(image.dataUrl)
  if (p === undefined) {
    const { bytes, mime } = dataUrlToBytes(image.dataUrl)
    p = decodePicture(bytes, mime).then((pic) => capPicture(pic))
    p.catch(() => pictureCache.delete(image.dataUrl))
    if (pictureCache.size > 8) pictureCache.delete(pictureCache.keys().next().value as string)
    pictureCache.set(image.dataUrl, p)
  }
  return p
}

/** The frame and poles a payload builds - the same numbers the palette previewed - and a mesh relief's working grid. */
export function reliefKernelFields(picture: Picture, payload: Pick<ReliefFeaturePayload, 'face' | 'settings' | 'autoParams'>): ReliefKernelFields {
  const adjusted = adjustedFor(picture, payload.autoParams, MANUAL_ADJUST, payload.settings)
  const { grid, poles } = reliefSurface(adjusted, picture, payload.settings)
  const frame = reliefFrame(payload.face, payload.settings)
  return isMeshRelief(grid) ? { frame, poles, detail: reliefDetailGrid(adjusted, picture, payload.settings) } : { frame, poles }
}
