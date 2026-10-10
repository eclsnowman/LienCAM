// CAM-DRILL-D2: production window.__solidsWorkbenchHooks smoke test.
//
// The drill-from-model adapter (modelBodyHoleRecognition.ts) uses an
// injectable test seam, so no existing test would catch a rename of
// the PRODUCTION window hook. This test goes through the production
// path, not the seam.
//
// HOW IT CAN FAIL (mutation-proof):
// 1. Rename __solidsWorkbenchHooks in modelBodyHoleRecognition.ts ->
//    the happy-path test below turns RED because window.__solidsWorkbenchHooks
//    no longer matches what the renamed source reads.
// 2. Reword the "no 3D model to read" refusal message ->
//    the refusal test below turns RED because the regex won't match.
// 3. Bypass the production path (always inject a recognizer or skip
//    the hook) -> the getBodyHandle/recognizeFeatures spies never fire
//    and the test turns RED.

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import {
  readModelBodyFaceFacts,
  recognizeModelBodyHoles,
  setModelBodyHoleRecognizer,
  setModelBodyFaceSnapshotReader,
} from '../../lib/cam/modelBodyHoleRecognition'
import type { FeatureVerdict } from '../../geom/geom-service'

describe('recognizeModelBodyHoles production window.__solidsWorkbenchHooks (CAM-DRILL-D2)', () => {
  afterEach(() => {
    // Ensure no test-leaked recognizer injection and that
    // window.__solidsWorkbenchHooks is cleaned between tests.
    setModelBodyHoleRecognizer(null)
    setModelBodyFaceSnapshotReader(null)
    if (typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>)
        .__solidsWorkbenchHooks
    }
  })

  afterAll(() => {
    setModelBodyHoleRecognizer(null)
    setModelBodyFaceSnapshotReader(null)
    vi.unstubAllGlobals()
  })

  it('uses the production window.__solidsWorkbenchHooks path', async () => {
    setModelBodyHoleRecognizer(null)

    const handle = Symbol('body-handle-sync')
    const verdicts: FeatureVerdict[] = [
      {
        featureKey: 'hole:10:10:10:0:0:1:3',
        featureClass: 'throughHole',
        removable: true,
        effect: 'add',
        faceIds: [],
        neighbourIds: [],
        params: {
          diameter: 6,
          depth: 10,
          axisX: 0,
          axisY: 0,
          axisZ: 1,
          centerX: 10,
          centerY: 10,
          centerZ: 10,
        },
      },
    ]

    const getBodyHandle = vi.fn().mockReturnValue(handle)
    const recognizeFeatures = vi.fn().mockResolvedValue(verdicts)

    vi.stubGlobal('window', {
      __solidsWorkbenchHooks: {
        getBodyHandle,
        client: { recognizeFeatures },
      },
    })

    const result = await recognizeModelBodyHoles('body-sync')

    expect(getBodyHandle).toHaveBeenCalledWith('body-sync')
    expect(recognizeFeatures).toHaveBeenCalledWith(handle)
    expect(result).toEqual(verdicts)
  })

  it('refuses with typed message when window.__solidsWorkbenchHooks is absent and no document is stashed', async () => {
    setModelBodyHoleRecognizer(null)
    vi.stubGlobal('window', {})

    // WO-335: hooks absent no longer means an immediate errand refusal -- this
    // module now mounts its own transient kernel and replays the document
    // (see boreZeroKernelMount.wo335.test.ts). With no document ever stashed
    // in this test process, that headless path has nothing to replay, so it
    // refuses by name instead of "open the Model tab".
    await expect(recognizeModelBodyHoles('body-refuse')).rejects.toThrow(
      /no 3D model to read/,
    )
  })

  it('reads the selected face snapshot and hole verdicts from one live body handle', async () => {
    setModelBodyHoleRecognizer(null)
    setModelBodyFaceSnapshotReader(null)
    const handle = Symbol('body-handle-bore')
    const verdicts: FeatureVerdict[] = [{
      featureKey: 'hole:0:0:10:0:0:1:2', featureClass: 'blindHole', removable: true,
      effect: 'add', faceIds: ['wall'], neighbourIds: [],
      params: { diameter: 4, depth: 5, axisX: 0, axisY: 0, axisZ: 1 },
    }]
    const wall = {
      type: 'cylinder', centroid: [0, 0, 7.5], normal: [1, 0, 0], area: 60,
      axis: [0, 0, 1], axisPoint: [0, 0, 0], radius: 2,
    }
    const getBodyHandle = vi.fn().mockReturnValue(handle)
    const recognizeFeatures = vi.fn().mockResolvedValue(verdicts)
    const snapshotsFor = vi.fn().mockResolvedValue({ wall })
    vi.stubGlobal('window', {
      __solidsWorkbenchHooks: {
        getBodyHandle,
        client: { recognizeFeatures, snapshotsFor },
      },
    })

    const result = await readModelBodyFaceFacts('body-bore', 'wall')

    expect(getBodyHandle).toHaveBeenCalledWith('body-bore')
    expect(snapshotsFor).toHaveBeenCalledWith(handle)
    expect(result).toEqual({ snapshot: wall, verdicts })
  })
})
