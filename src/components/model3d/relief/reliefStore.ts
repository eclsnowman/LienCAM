// Relief - the state of relief mode inside the Model screen (WO-2171, image
// relief stage 1b). One session at a time: the face it is laid on, the
// picture, every control's value. The numbers made from them (heights,
// poles, the status line) live in src/relief/; this store only holds what the
// operator chose, so the palette, the rail and the preview all read one place.

import { create } from 'zustand'
import { autoAdjust, MANUAL_PICTURE_ADJUST, type AutoParams, type PictureAdjust } from '../../../relief/adjust'
import type { Picture } from '../../../relief/picture'
import { DEFAULT_STEPS, defaultSettings, type FaceFrame, type ReliefSettings, type StepDowns } from '../../../relief/reliefHeights'
import type { ReliefImage } from '../../../relief/reliefFeature'

/** WO-2174: 'image' is the picture as opened (before), 'adjusted' after the adjustments, 'compare' the two side by side. */
export type ReliefMapView = 'image' | 'adjusted' | 'compare' | 'height' | 'shaded'

export interface ReliefFaceTarget {
  ownerId: string
  faceId: string
  face: FaceFrame
  /** the owner body's name, for the palette */
  bodyName: string
}

export interface ReliefState {
  active: boolean
  /** the relief feature being edited, or null for a new one */
  featureId: string | null
  name: string
  target: ReliefFaceTarget | null
  image: ReliefImage | null
  picture: Picture | null
  autoParams: AutoParams | null
  /** WO-2174: Auto's choices as adjustment values (the values Auto puts back) */
  autoAdjust: PictureAdjust | null
  settings: ReliefSettings | null
  mapView: ReliefMapView
  /** a one-line note from the last action (picked a curved face, ...) */
  notice: string | null
  /** S12: size, highest point, steepest wall, grid - information only */
  status: string | null
  /** what Auto did, in one line */
  autoLine: string | null
  /** Apply is running in the kernel */
  applying: boolean
  /** bumps each time the applied-surface preview settles (the 2D map redraws) */
  settledVersion: number
  openSession(init: { featureId: string | null; name: string; target?: ReliefFaceTarget | null; image?: ReliefImage | null; picture?: Picture | null; autoParams?: AutoParams | null; settings?: ReliefSettings | null }): void
  closeSession(): void
  /** a new face: the placement refits to it when a picture is open */
  setTarget(target: ReliefFaceTarget): void
  /** a newly opened picture: the standard's defaults with no other click (Auto included) */
  setPicture(image: ReliefImage, picture: Picture, autoParams: AutoParams, autoAdjust?: PictureAdjust): void
  /** change controls; with keep proportions on, width and height follow each other */
  setSettings(patch: Partial<ReliefSettings>): void
  /** fit the picture inside the face again (S1), keeping depth and the rest */
  fitToFace(): void
  /** switch Auto off (the picture as it is) or back on (what Auto chose) */
  setAuto(on: boolean): void
  /** WO-2174: change picture adjustments - they become the operator's own, so Auto switches off (one click puts Auto's back) */
  setAdjust(patch: Partial<PictureAdjust>): void
  /** WO-2174: change the step-downs */
  setSteps(patch: Partial<StepDowns>): void
  setName(name: string): void
  setMapView(view: ReliefMapView): void
  setNotice(notice: string | null): void
  setStatus(status: string | null, autoLine?: string | null): void
  setApplying(applying: boolean): void
  bumpSettled(): void
}

const CLOSED = {
  active: false,
  featureId: null,
  name: 'Relief',
  target: null,
  image: null,
  picture: null,
  autoParams: null,
  autoAdjust: null,
  settings: null,
  notice: null,
  status: null,
  autoLine: null,
  applying: false,
} as const

export const useReliefStore = create<ReliefState>()((set, get) => ({
  ...CLOSED,
  mapView: 'height',
  settledVersion: 0,
  openSession: (init) => set({
    ...CLOSED,
    active: true,
    featureId: init.featureId,
    name: init.name,
    target: init.target ?? null,
    image: init.image ?? null,
    picture: init.picture ?? null,
    autoParams: init.autoParams ?? null,
    settings: init.settings ?? null,
  }),
  closeSession: () => set({ ...CLOSED }),
  setTarget: (target) => {
    const { picture, autoParams, settings } = get()
    if (picture === null) { set({ target, notice: null }); return }
    if (settings === null) {
      // the picture came first: the face picked now gets the defaults setPicture would have made
      const auto = autoAdjustOf(get())
      set({ target, notice: null, settings: { ...defaultSettings(picture, target.face, autoParams), ...(auto === null ? {} : { adjust: auto }) } })
      return
    }
    const fresh = defaultSettings(picture, target.face, settings.auto ? autoParams : null)
    // a new face refits the picture (S1); the height controls the operator set stay
    set({ target, notice: null, settings: { ...settings, widthMm: fresh.widthMm, heightMm: fresh.heightMm, offsetXMm: 0, offsetYMm: 0 } })
  },
  setPicture: (image, picture, autoParams, adjust) => {
    const { target } = get()
    const auto = adjust ?? autoAdjust(picture, autoParams)
    // WO-2174: Auto's choices show as the adjustment controls' values
    const settings = target === null ? null : { ...defaultSettings(picture, target.face, autoParams), adjust: auto }
    set({ image, picture, autoParams, autoAdjust: auto, settings, notice: null })
  },
  setSettings: (patch) => {
    const s = get().settings
    if (s === null) return
    const next: ReliefSettings = { ...s, ...patch }
    if (s.keepProportions && s.widthMm > 0 && s.heightMm > 0) {
      if (patch.widthMm !== undefined && patch.heightMm === undefined) next.heightMm = round3((patch.widthMm * s.heightMm) / s.widthMm)
      if (patch.heightMm !== undefined && patch.widthMm === undefined) next.widthMm = round3((patch.heightMm * s.widthMm) / s.heightMm)
    }
    next.widthMm = Math.max(next.widthMm, 1)
    next.heightMm = Math.max(next.heightMm, 1)
    next.zeroPlane = Math.min(Math.max(next.zeroPlane, 0), 0.99)
    next.depthMm = Math.max(next.depthMm, 0.05)
    next.baseMm = Math.max(next.baseMm, 0)
    set({ settings: next })
  },
  fitToFace: () => {
    const { picture, target, settings } = get()
    if (picture === null || target === null || settings === null) return
    const fresh = defaultSettings(picture, target.face, null)
    set({ settings: { ...settings, widthMm: fresh.widthMm, heightMm: fresh.heightMm, offsetXMm: 0, offsetYMm: 0, rotationDeg: 0 } })
  },
  setAuto: (on) => {
    const { settings, autoParams } = get()
    if (settings === null) return
    const adjust = on ? autoAdjustOf(get()) : MANUAL_PICTURE_ADJUST
    set({
      settings: {
        ...settings, auto: on, invert: on ? (autoParams?.invert ?? false) : false, zeroPlane: on ? (autoParams?.zeroPlane ?? 0) : 0,
        ...(adjust !== null ? { adjust } : {}),
      },
    })
  },
  setAdjust: (patch) => {
    const st = get()
    const s = st.settings
    if (s === null) return
    const current = s.adjust ?? (s.auto ? autoAdjustOf(st) : MANUAL_PICTURE_ADJUST)
    if (current === null) return
    const next: PictureAdjust = { ...current, ...patch }
    // a smoothing size set by the operator is in mm; Auto's pixel size for a height map gives way to it
    if (patch.smoothMm !== undefined) delete next.smoothPx
    next.black = Math.min(Math.max(next.black, 0), 1)
    next.white = Math.min(Math.max(next.white, 0), 1)
    if (next.white <= next.black) {
      if (patch.black !== undefined) next.black = Math.max(0, next.white - 1 / 255)
      else next.white = Math.min(1, next.black + 1 / 255)
    }
    next.midtones = Math.min(Math.max(next.midtones, 0.3), 3)
    next.contrast = Math.min(Math.max(next.contrast, -100), 100)
    next.brightness = Math.min(Math.max(next.brightness, -100), 100)
    next.denoisePx = Math.min(Math.max(Math.round(next.denoisePx), 0), 5)
    next.smoothMm = Math.min(Math.max(next.smoothMm, 0), 5)
    next.edgeSmoothMm = Math.min(Math.max(next.edgeSmoothMm, 0), 3)
    next.edgeRange = Math.min(Math.max(next.edgeRange, 0), 0.3)
    set({ settings: { ...s, auto: false, adjust: next } })
  },
  setSteps: (patch) => {
    const s = get().settings
    if (s === null) return
    const next: StepDowns = { ...(s.steps ?? DEFAULT_STEPS), ...patch }
    next.levels = Math.min(Math.max(Math.round(next.levels), 1), 50)
    next.stepMm = Math.max(next.stepMm, 0.01)
    next.wallDeg = Math.min(Math.max(next.wallDeg, 5), 90)
    set({ settings: { ...s, steps: next } })
  },
  setName: (name) => set({ name }),
  setMapView: (mapView) => set({ mapView }),
  setNotice: (notice) => set({ notice }),
  setStatus: (status, autoLine) => set(autoLine === undefined ? { status } : { status, autoLine }),
  setApplying: (applying) => set({ applying }),
  bumpSettled: () => set((st) => ({ settledVersion: st.settledVersion + 1 })),
}))

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

/** Auto's adjustment values, measured from the picture when the session did not bring them (a reopened relief). */
function autoAdjustOf(st: Pick<ReliefState, 'autoAdjust' | 'autoParams' | 'picture'>): PictureAdjust | null {
  if (st.autoAdjust !== null) return st.autoAdjust
  if (st.picture === null || st.autoParams === null) return null
  const a = autoAdjust(st.picture, st.autoParams)
  useReliefStore.setState({ autoAdjust: a })
  return a
}

/** The adjustment values the controls show: the settings' own, else what Auto (or the manual default) filters with. No side effects (read while rendering). */
export function currentAdjust(st: Pick<ReliefState, 'settings' | 'autoAdjust'>): PictureAdjust | null {
  const s = st.settings
  if (s === null) return null
  return s.adjust ?? (s.auto ? st.autoAdjust : MANUAL_PICTURE_ADJUST)
}
