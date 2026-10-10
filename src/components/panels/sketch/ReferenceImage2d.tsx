import './referenceImage2d.css'
import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { useCamStore } from '../../../store'
import { ReferenceImageInsertRow } from '../../model3d/referenceImage/ReferenceImageInsertRow'
import { ReferenceImagePanel } from '../../model3d/referenceImage/ReferenceImagePanel'
import { ReferenceImageEntriesLayer, type ReferenceImagePreview } from '../../model3d/referenceImage/ReferenceImageLayer'
import { ReferenceImageCalibration } from '../../model3d/referenceImage/ReferenceImageCalibration'
import { ReferenceImagePlacement } from '../../model3d/referenceImage/ReferenceImagePlacement'
import { decodeReferenceImage, referenceImageSize } from '../../model3d/referenceImage/referenceImageScene'
import { fileDataUrl } from '../../../referenceImage/imageData'
import { REFERENCE_IMAGE_2D_FRAME as frame, type ReferenceImagePayload } from '../../../referenceImage/referenceImage'
import type { ReferenceImageRuntime } from '../../../referenceImage/runtime'
import { resolveSketchEditorOffset } from '../../../lib/viewport/sketchEditorOffset'

type Host = { runtime: ReferenceImageRuntime; canvas: HTMLCanvasElement }
/** UI session only. Original bytes and every authored property live in Project. */
export const referenceImage2dUi = create<{ host: Host | null; id: string | null; calibrating: boolean; preview?: ReferenceImagePreview | null }>(() => ({ host: null, id: null, calibrating: false }))

export function ReferenceImage2dInsert({ onInserted }: { onInserted(): void }) {
  const host = referenceImage2dUi((s) => s.host)
  const insert = async (file: File) => {
    if (!host) return
    const projectId = useCamStore.getState().project.id
    const dataUrl = await fileDataUrl(file, new Uint8Array(await file.arrayBuffer()), file.type || (/\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg'))
    const image = await decodeReferenceImage(dataUrl)
    // The native file picker may outlive the project or the sketch tab.
    if (useCamStore.getState().project.id !== projectId || useCamStore.getState().viewer.mode !== 'sketch') return
    const id = `reference-image:2d:${crypto.randomUUID()}`
    useCamStore.getState().insertReferenceImage2d({ id, payload: {
      datumType: 'reference-image', name: file.name, planeNodeId: 'cam:xy',
      image: { dataUrl, fileName: file.name, widthPx: image.naturalWidth, heightPx: image.naturalHeight },
      ...referenceImageSize(host.runtime.camera, frame, image.naturalWidth / image.naturalHeight), opacity: 0.5,
    } })
    referenceImage2dUi.setState({ id, calibrating: false })
    onInserted()
  }
  return <ReferenceImageInsertRow onInsert={insert} choiceLabel="Reference image (tracing underlay)" />
}

export function ReferenceImage2dControls() {
  const images = useCamStore((s) => s.project.referenceImages2d)
  const units = useCamStore((s) => s.appSettings.displayUnits)
  const { id, preview } = referenceImage2dUi()
  const selected = images?.find((image) => image.id === id)
  const patch = (value: Partial<ReferenceImagePayload>) => {
    if (selected) useCamStore.getState().updateReferenceImage2d(selected.id, { payload: { ...selected.payload, ...value } })
  }
  if (!images?.length) return null
  return <aside style={{ position: 'fixed' }} className="reference-image2d-controls" aria-label="Reference image controls">
    <label className="reference-image2d-picker">Edit image
      <select aria-label="Edit reference image" value={selected?.id ?? ''} onChange={(e) => referenceImage2dUi.setState({ id: e.target.value || null, calibrating: false })}>
        <option value="">Choose image...</option>
        {images?.map((image) => <option key={image.id} value={image.id}>{image.payload.name}</option>)}
      </select>
    </label>
    {selected && <ReferenceImagePanel embedded payload={preview?.id === selected.id ? { ...selected.payload, ...preview } : selected.payload} units={units}
      visibility={<label className="relief-row"><input type="checkbox" data-testid="reference-image-visible" checked={!selected.hidden}
        onChange={() => { referenceImage2dUi.setState({ calibrating: false }); useCamStore.getState().updateReferenceImage2d(selected.id, { hidden: !selected.hidden }) }} />Show image</label>}
      onPlace={patch} onOpacity={(opacity) => patch({ opacity })} onRename={(name) => patch({ name })}
      onCalibrate={() => referenceImage2dUi.setState({ calibrating: true })}
      onToggleLock={() => { referenceImage2dUi.setState({ calibrating: false }); patch({ scaleLocked: !selected.payload.scaleLocked }) }}
      onClose={() => referenceImage2dUi.setState({ id: null, calibrating: false })} />}
  </aside>
}

export function ReferenceImage2dScene({ host, active }: { host: Host | null; active: boolean }) {
  const images = useCamStore((s) => s.project.referenceImages2d)
  const units = useCamStore((s) => s.appSettings.displayUnits)
  const sketch = useCamStore((s) => s.activeSketch)
  const selectedIds = useCamStore((s) => s.sketchSelectedIds)
  const { id, calibrating } = referenceImage2dUi()
  const [preview, setPreview] = useState<ReferenceImagePreview | null>(null)
  const previewPlacement = (value: ReferenceImagePreview | null) => { setPreview(value); referenceImage2dUi.setState({ preview: value }) }
  const selected = images?.find((image) => image.id === id && !image.hidden && image.payload.image.dataUrl)
  const entries = useMemo(() => (images ?? []).filter((image) => !image.hidden && image.payload.image.dataUrl).map((image) => ({ id: image.id, payload: image.payload, frame })), [images])
  useEffect(() => {
    referenceImage2dUi.setState({ host })
    return () => { referenceImage2dUi.setState({ host: null, id: null, calibrating: false }) }
  }, [host])
  useEffect(() => {
    if (!active) referenceImage2dUi.setState({ id: null, calibrating: false })
  }, [active])
  const line = selectedIds.length === 1 ? sketch?.entities.find((entity) => entity.id === selectedIds[0]) : undefined
  const offset = sketch ? resolveSketchEditorOffset(useCamStore.getState().project.geometry, sketch.layerId) : undefined
  const angle = (offset?.rotationDeg ?? 0) * Math.PI / 180
  const initialPoints = line?.kind === 'line' ? [line.start, line.end].map((point) => ({
    x: (offset?.x ?? 0) + point.x * Math.cos(angle) - point.y * Math.sin(angle),
    y: (offset?.y ?? 0) + point.x * Math.sin(angle) + point.y * Math.cos(angle),
  })) : []
  const cancel = () => referenceImage2dUi.setState({ calibrating: false })
  return <>
    <ReferenceImageEntriesLayer entries={entries} runtime={host?.runtime ?? null} preview={preview} />
    {active && host && selected && (calibrating && !selected.payload.scaleLocked
      ? <ReferenceImageCalibration key={selected.id} payload={selected.payload} frame={frame} runtime={host.runtime} canvas={host.canvas} units={units} initialPoints={initialPoints}
        onCancel={cancel} onCommit={(payload) => useCamStore.getState().updateReferenceImage2d(selected.id, { payload })} />
      : <ReferenceImagePlacement key={selected.id} payload={selected.payload} frame={frame} runtime={host.runtime} canvas={host.canvas}
        onPreview={(center) => previewPlacement(center ? { id: selected.id, center } : null)}
        onScalePreview={(placement) => previewPlacement(placement?.center ? { id: selected.id, ...placement, center: placement.center } : null)}
        onScaleCommit={(placement) => useCamStore.getState().updateReferenceImage2d(selected.id, { payload: { ...selected.payload, ...placement } })}
        onCommit={(center) => useCamStore.getState().updateReferenceImage2d(selected.id, { payload: { ...selected.payload, center } })} />)}
  </>
}
