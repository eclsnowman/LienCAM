import { useEffect, useRef, useMemo } from 'react'
import type { FeatureDag } from '../../../doc'
import { isReferenceImagePayload, referenceImageFrame } from '../../../referenceImage/referenceImage'
import type { ReferenceImageRuntime } from '../../../referenceImage/runtime'
import type { PlaneFrame } from '../../../sketch3d/planeMath'
import type { ReferenceImagePayload } from '../../../referenceImage/referenceImage'
import { applyReferenceImagePose, buildReferenceImage, decodeReferenceImage, disposeReferenceImage } from './referenceImageScene'
import type { ImagePoint } from '../../../referenceImage/calibrate'
import type { ImagePlacement } from '../../../referenceImage/place'

export type ReferenceImagePreview = { id: string; center: ImagePoint } & Partial<ImagePlacement>

export interface ReferenceImageEntry { id: string; payload: ReferenceImagePayload; frame: PlaneFrame }
export function ReferenceImageLayer({ dag, version, runtime, preview }: { dag: FeatureDag; version: number; runtime: ReferenceImageRuntime | null; preview?: ReferenceImagePreview | null }) {
  const entries = useMemo(() => dag.nodeIds().flatMap((id): ReferenceImageEntry[] => {
    const node = dag.getNode(id)!
    if (!isReferenceImagePayload(node.payload) || node.hidden || dag.isEffectivelySuppressed(id) || dag.isRolledBack(id)) return []
    const frame = referenceImageFrame(dag, node.payload)
    return frame ? [{ id, payload: node.payload, frame }] : []
  }), [dag, version])
  return <ReferenceImageEntriesLayer entries={entries} runtime={runtime} preview={preview} />
}

export function ReferenceImageEntriesLayer({ entries, runtime, preview }: {
  entries: ReferenceImageEntry[]; runtime: ReferenceImageRuntime | null; preview?: ReferenceImagePreview | null
}) {
  const rootsRef = useRef<ReturnType<typeof buildReferenceImage>[]>([])
  const previewRef = useRef(preview)
  previewRef.current = preview
  useEffect(() => {
    let appliedPose = false
    for (const root of rootsRef.current) {
      const id = root.userData.referenceImageId as string
      const payload = entries.find((entry) => entry.id === id)?.payload
      if (payload && isReferenceImagePayload(payload)) {
        applyReferenceImagePose(root.children[0], preview?.id === id ? { ...payload, ...preview } : payload)
        appliedPose = true
      }
    }
    // An empty underlay layer must not add a paint to every unrelated DAG edit.
    if (appliedPose) runtime?.requestRender()
  }, [entries, runtime, preview])
  useEffect(() => {
    if (runtime === null) return
    let disposed = false
    const roots: ReturnType<typeof buildReferenceImage>[] = []
    rootsRef.current = roots
    for (const { id, payload, frame } of entries) {
      void decodeReferenceImage(payload.image.dataUrl).then((image) => {
        if (disposed) return
        const root = buildReferenceImage(id, payload, frame, image)
        if (previewRef.current?.id === id) applyReferenceImagePose(root.children[0], { ...payload, ...previewRef.current })
        roots.push(root)
        runtime.addObject(root)
        runtime.requestRender()
      })
    }
    return () => {
      disposed = true
      for (const root of roots) {
        runtime.removeObject(root)
        disposeReferenceImage(root)
      }
      if (roots.length > 0) runtime.requestRender()
    }
  }, [entries, runtime])
  return null
}
