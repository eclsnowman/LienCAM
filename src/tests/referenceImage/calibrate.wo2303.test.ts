import { describe, expect, it } from 'vitest'
import { calibrateReferenceImage } from '../../referenceImage/calibrate'
import { referenceImageInput, type ReferenceImagePayload } from '../../referenceImage/referenceImage'
import { FeatureDag, CommandHistory } from '../../doc'
import { EditFeaturePayloadCommand } from '../../components/model3d/dialogs/EditFeaturePayloadCommand'
import { createDocumentArchive, loadDocumentArchive } from '../../doc/persist'

const picture: ReferenceImagePayload = { datumType: 'reference-image', name: 'ruler', planeNodeId: 'xy', image: { dataUrl: 'data:image/png;base64,AA==', fileName: 'ruler.png', widthPx: 1000, heightPx: 500 }, widthMm: 100, heightMm: 50, opacity: 0.5 }
describe('WO-2303 reference image calibration math', () => {
  it('scales uniformly around an offset first mark, including a previously shifted picture', () => {
    const shifted = { ...picture, center: { x: 20, y: 15 } }
    const first = { x: -20, y: 15 }, second = { x: 30, y: 15 }
    const next = calibrateReferenceImage(shifted, first, second, 250)
    expect(next.widthMm).toBe(500)
    expect(next.heightMm).toBe(250)
    expect(next.center).toEqual({ x: -20 + 40 * 5, y: 15 })
    expect(next.center!.x - next.widthMm * 0.4).toBe(first.x)
    expect(next.widthMm / next.heightMm).toBe(2)
  })
  it.each([0, -1, NaN, Infinity])('leaves the payload intact for distance %s', (distance) => {
    expect(calibrateReferenceImage(picture, { x: 0, y: 0 }, { x: 50, y: 0 }, distance)).toBe(picture)
  })
  it('holds the lock for every calibration call and survives an undoable edit and archive', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'xy', kind: 'datum', consumes: [], refs: [], payload: {} })
    dag.insertNode(referenceImageInput('reference-image:1', picture))
    const history = new CommandHistory(dag)
    const calibrated = calibrateReferenceImage(picture, { x: -40, y: 0 }, { x: 10, y: 0 }, 101.6)
    history.execute(new EditFeaturePayloadCommand('reference-image:1', calibrated))
    history.execute(new EditFeaturePayloadCommand('reference-image:1', { ...calibrated, scaleLocked: true }))
    const loaded = loadDocumentArchive(createDocumentArchive({ dag, elementMapDeltas: [] }))
    const locked = loaded.dag.getNode('reference-image:1')!.payload as ReferenceImagePayload
    expect(locked).toMatchObject({ widthMm: 203.2, scaleLocked: true, center: calibrated.center })
    expect(calibrateReferenceImage(locked, { x: -40, y: 0 }, { x: 61.6, y: 0 }, 120)).toBe(locked)
    history.undo(); expect(dag.getNode('reference-image:1')!.payload.scaleLocked).toBeUndefined()
    history.undo(); expect(dag.getNode('reference-image:1')!.payload.widthMm).toBe(100)
    history.redo(); expect(dag.getNode('reference-image:1')!.payload.widthMm).toBe(203.2)
    history.redo(); expect(dag.getNode('reference-image:1')!.payload.scaleLocked).toBe(true)
  })
})
