import { useText } from '../../../i18n'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import type { ReferenceImagePayload } from '../../../referenceImage/referenceImage'
import { calibrateReferenceImage, type ImagePoint } from '../../../referenceImage/calibrate'
import { imageContainsPoint } from '../../../referenceImage/place'
import { localToWorld, worldToLocal, type PlaneFrame } from '../../../sketch3d/planeMath'
import { fmtDim, parseDimToMm, unitLabel, type Units } from '../../../lib/ui/unitFormat'
import { useCamStore } from '../../../store'
import { referenceImagePoint, type ReferenceImageRuntime } from '../../../referenceImage/runtime'
import { makePlaneFrameGroup } from '../workbench/workbenchSketcherHost'
import { sketchSessionStore } from '../workbench/sketchSessionStore'
import { WorkbenchConfirmBar } from '../workbench/WorkbenchConfirmBar'
import { AnchoredValueEntry } from '../workbench/AnchoredValueEntry'

function selectedLine(frame: PlaneFrame): ImagePoint[] {
  const session = sketchSessionStore.getState()
  if (session.selectedIds.length !== 1 || !session.frame) return []
  const line = session.sketch?.entities.find((e) => e.id === session.selectedIds[0])
  if (line?.kind !== 'line') return []
  const world = [line.start, line.end].map((p) => localToWorld(session.frame!, p))
  // A line on another plane is not a measurement of this picture.
  if (world.some((p) => Math.abs((p.x - frame.origin.x) * frame.normal.x + (p.y - frame.origin.y) * frame.normal.y + (p.z - frame.origin.z) * frame.normal.z) > 0.001)) return []
  const ends = world.map((p) => worldToLocal(frame, p))
  return Math.hypot(ends[1].x - ends[0].x, ends[1].y - ends[0].y) > 0 ? ends : []
}

export function ReferenceImageCalibration({ payload, frame, runtime, canvas, units, initialPoints, onCommit, onCancel }: {
  payload: ReferenceImagePayload; frame: PlaneFrame; runtime: ReferenceImageRuntime; canvas: HTMLCanvasElement; units: Units
  initialPoints?: ImagePoint[]
  onCommit(payload: ReferenceImagePayload): void; onCancel(): void
}) {
  const workbenchText = useText('sketch-and-model-workbench')
  const [points, setPoints] = useState<ImagePoint[]>(() => initialPoints ?? selectedLine(frame))
  const [entryVersion, setEntryVersion] = useState(0)
  const [distance, setDistance] = useState<number | null>(null)
  const releasedPointer = useRef<{ x: number; y: number } | null>(null)
  const measured = points.length === 2 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0
  const container = canvas.parentElement!
  const resetInvalidDistance = (draft: string): boolean => {
    const value = parseDimToMm(draft, units)
    if (value > 0 && Number.isFinite(value)) return false
    useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'input', message: workbenchText('ReferenceImageCalibration.realDistanceSetTo', { draft: String(draft), value2: String(fmtDim(measured, units)), value3: String(unitLabel(units)) }) })
    setDistance(measured); setEntryVersion((v) => v + 1)
    return true
  }

  useEffect(() => {
    const block = (e: Event) => { e.stopImmediatePropagation(); e.preventDefault() }
    const pick = (e: MouseEvent) => {
      block(e)
      if (e.button !== 0 || points.length === 2) return
      // Browser click MouseEvents round client coordinates to whole CSS pixels;
      // PointerEvents retain the subpixel position of the released mark.
      const at = releasedPointer.current ?? { x: e.clientX, y: e.clientY }
      releasedPointer.current = null
      const point = referenceImagePoint(runtime, canvas, frame, at.x, at.y)
      if (!imageContainsPoint(payload, point)) return
      if (points[0] && Math.hypot(point.x - points[0].x, point.y - points[0].y) < 1e-9) return
      setPoints([...points, point])
    }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { block(e); onCancel() } }
    const release = (e: PointerEvent) => { releasedPointer.current = { x: e.clientX, y: e.clientY }; block(e) }
    for (const type of ['pointerdown', 'pointermove', 'dblclick']) canvas.addEventListener(type, block, true)
    canvas.addEventListener('pointerup', release, true)
    canvas.addEventListener('click', pick, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      for (const type of ['pointerdown', 'pointermove', 'dblclick']) canvas.removeEventListener(type, block, true)
      canvas.removeEventListener('pointerup', release, true)
      canvas.removeEventListener('click', pick, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [canvas, container, frame, onCancel, payload, points, runtime])

  useEffect(() => {
    const root = makePlaneFrameGroup(frame)
    root.name = 'reference-image-calibration'
    // The picture is transparent; draw these in the same pass, after its quad.
    const material = new THREE.LineBasicMaterial({ color: 0x22b8cf, depthTest: false, transparent: true })
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x22b8cf, depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide })
    const markerOutline = new THREE.MeshBasicMaterial({ color: 0x10151b, depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide })
    if (points.length === 2) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p.x, p.y, 0))), material)
      line.renderOrder = 100
      root.add(line)
    }
    for (const point of points) {
      const size = Math.min(payload.widthMm, payload.heightMm) * 0.012
      const mark = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(point.x - size, point.y, 0), new THREE.Vector3(point.x + size, point.y, 0),
        new THREE.Vector3(point.x, point.y - size, 0), new THREE.Vector3(point.x, point.y + size, 0),
      ]), material)
      mark.renderOrder = 100
      root.add(mark)
      // A solid, outlined ring stays legible over the photograph's ruler ticks.
      for (const [inner, outer, ink, order] of [[0.55, 1.25, markerOutline, 101], [0.7, 1, markerMaterial, 102]] as const) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(size * inner, size * outer, 32), ink)
        ring.name = order === 102 ? 'reference-image-calibration-mark' : 'reference-image-calibration-mark-outline'
        ring.position.set(point.x, point.y, 0)
        ring.renderOrder = order
        root.add(ring)
      }
    }
    runtime.addObject(root); runtime.requestRender()
    return () => { runtime.removeObject(root); root.traverse((o) => { if (o instanceof THREE.Line || o instanceof THREE.Mesh) o.geometry.dispose() }); material.dispose(); markerMaterial.dispose(); markerOutline.dispose(); runtime.requestRender() }
  }, [frame, payload.heightMm, payload.widthMm, points, runtime])

  if (payload.scaleLocked) return null
  return createPortal(<>
    {points.length < 2 && <WorkbenchConfirmBar testId="reference-image-calibration-prompt"
      message={points.length === 0 ? workbenchText('ReferenceImageCalibration.pickTheFirstMarkOnThePicture') : workbenchText('ReferenceImageCalibration.pickTheSecondMarkOnThePicture')}
      actions={[{ testId: 'reference-image-calibration-cancel', label: workbenchText('ReferenceImageCalibration.cancel'), onClick: onCancel }]} />}
    {points.length === 2 && <AnchoredValueEntry key={entryVersion} testId="reference-image-distance-entry"
      anchorWorldPoint={localToWorld(frame, { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 })}
      projectToCanvas={(p) => runtime.projectToCanvas(p)} title={workbenchText('ReferenceImageCalibration.calibrateReferenceImage')}
      currentValueLabel="Current distance" currentValueText={`${fmtDim(measured, units)} ${unitLabel(units)}`}
      valueLabel="Real distance" deltaLabel="Scale" initialDraft={fmtDim(distance ?? measured, units)}
      numeric={{ valueMm: parseDimToMm(fmtDim(distance ?? measured, units), units), units, onBlurDraft: resetInvalidDistance }} unitSuffix={unitLabel(units)}
      validate={() => ({ ok: true, deltaText: 'Uniform' })} onCancel={onCancel}
      onApply={async (draft) => {
        const value = parseDimToMm(draft, units)
        if (resetInvalidDistance(draft)) return undefined
        onCommit(calibrateReferenceImage(payload, points[0], points[1], value))
        onCancel()
        return undefined
      }} />}
  </>, container)
}
