import { describe, expect, it } from 'vitest'
import { FeatureDag, ElementMap, RegenScheduler, CommandHistory, SetHiddenCommand } from '../../doc'
import { createDocumentArchive, loadDocumentArchive } from '../../doc/persist'
import { seedGenesisNodes } from '../../components/model3d/workbench/basePlanes'
import { bytesToDataUrl, dataUrlToBytes } from '../../referenceImage/imageData'
import { referenceImageInput } from '../../referenceImage/referenceImage'
import { makeDatumPlaneExecutor } from '../../sketch3d/datumPlane'

describe('WO-2302 reference image document', () => {
  it('archives original bytes, size, opacity and hidden state; regenerates without geometry or diagnostics', async () => {
    const dag = new FeatureDag()
    seedGenesisNodes(dag)
    const original = new Uint8Array(100_000).map((_, i) => i % 251)
    const xy = dag.nodeIds().find((id) => dag.getNode(id)?.payload.planeKind === 'base-plane' && (dag.getNode(id)?.payload.lastGoodFrame as { normal: { z: number } }).normal.z === 1)!
    dag.insertNode(referenceImageInput('reference-image:1', {
      datumType: 'reference-image', name: 'phone.jpg', planeNodeId: xy,
      image: { dataUrl: bytesToDataUrl(original, 'image/jpeg'), fileName: 'phone.jpg', widthPx: 4032, heightPx: 3024 },
      widthMm: 80, heightMm: 60, opacity: 0.3,
    }))
    const history = new CommandHistory(dag)
    history.execute(new SetHiddenCommand('reference-image:1', true))
    history.undo()
    expect(dag.getNode('reference-image:1')?.hidden).toBe(false)
    history.redo()
    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    const loaded = loadDocumentArchive(archive)
    const node = loaded.dag.getNode('reference-image:1')!
    expect(node.hidden).toBe(true)
    expect(node.payload).toMatchObject({ widthMm: 80, heightMm: 60, opacity: 0.3, planeNodeId: xy })
    const image = node.payload.image as { dataUrl: string }
    expect(dataUrlToBytes(image.dataUrl).bytes).toEqual(original)
    const scheduler = new RegenScheduler(loaded.dag, new ElementMap())
    scheduler.markDirty(node.id)
    await scheduler.run(makeDatumPlaneExecutor(loaded.dag, loaded.elementMap))
    expect(scheduler.statusOf(node.id)).toBe('ok')
    expect(scheduler.diagnosticsOf(node.id)).toEqual([])
    expect(node.kind).toBe('datum')
  })
})
