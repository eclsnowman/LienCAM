// CAM-BINDING Stage 2: resolveModelReferenceFrame - the single named seam
// composing placementRegistry + resolveModelItemPlacement, per the
// coordinator MANDATE (coordination/work-orders/CAM-BINDING.md). This test
// drives it directly (mirrors modelItemPlacement.test.ts's own convention),
// and includes a static import-boundary census proving the four pre-existing
// direct-composition call sites now route through it instead of inlining
// placementRegistry+resolveModelItemPlacement themselves.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveModelReferenceFrame } from '../../lib/cam/modelReferenceFrame'
import { ModelItemPlacementResolutionError, type ModelItemPlacementRegistryEntry } from '../../lib/cam/modelItemPlacement'

describe('CAM-BINDING Stage 2: resolveModelReferenceFrame', () => {
  it('resolves a whole-item Placement record by modelItemId', () => {
    const records: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-a', position: { x: 10, y: -5, z: 0 }, rotation: { x: 0, y: 0, z: 45 } },
    ]
    expect(resolveModelReferenceFrame(records, 'item-a')).toEqual({
      position: { x: 10, y: -5, z: 0 },
      rotation: { x: 0, y: 0, z: 45 },
    })
  })

  it('prefers a body-filtered record over the whole-item record when both exist', () => {
    const records: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-a', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      { modelItemId: 'item-a', bodyId: 'body-1', position: { x: 3, y: 4, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ]
    expect(resolveModelReferenceFrame(records, 'item-a', 'body-1')).toEqual({
      position: { x: 3, y: 4, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    })
  })

  it('falls back to the whole-item record when no body-filtered record exists for that bodyId', () => {
    const records: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-a', position: { x: 1, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ]
    expect(resolveModelReferenceFrame(records, 'item-a', 'some-other-body')).toEqual({
      position: { x: 1, y: 2, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    })
  })

  it('fails loud (ADR-0003) for a modelItemId with no Placement record at all - mutation-provable: swap the throw for a silent identity default and this goes RED', () => {
    expect(() => resolveModelReferenceFrame([], 'unknown-item')).toThrow(
      ModelItemPlacementResolutionError,
    )
  })

  it('is a pure passthrough - identical records + identical args resolve identically on repeat calls (no hidden state)', () => {
    const records: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-a', position: { x: 7, y: 7, z: 7 }, rotation: { x: 0, y: 0, z: 0 } },
    ]
    const a = resolveModelReferenceFrame(records, 'item-a')
    const b = resolveModelReferenceFrame(records, 'item-a')
    expect(a).toEqual(b)
  })
})

describe('CAM-BINDING Stage 2: resolveModelReferenceFrame consumer census (shared-resolver rule)', () => {
  // Walks src/ (excluding tests) and asserts that every file which resolves a
  // model body's world pose does so through resolveModelReferenceFrame, not
  // by inlining placementRegistry(...) + resolveModelItemPlacement(...)
  // itself - the repo's shared-resolver rule (a duplicate composition of a
  // shared seam is a defect). Mirrors modelOrigin.camBindingStage1.test.ts's
  // own static-census convention.
  const SRC_ROOT = join(__dirname, '..', '..')

  function productionFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'tests') continue
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) productionFiles(full, out)
      else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
        out.push(full)
      }
    }
    return out
  }

  it('no production file (other than modelReferenceFrame.ts itself) calls placementRegistry+resolveModelItemPlacement directly - resolveModelReferenceFrame is the one seam', () => {
    const files = productionFiles(SRC_ROOT)
    const offenders: string[] = []
    for (const file of files) {
      if (file.endsWith(join('lib', 'cam', 'modelReferenceFrame.ts'))) continue
      if (file.endsWith(join('lib', 'cam', 'modelItemPlacement.ts'))) continue
      const text = readFileSync(file, 'utf8')
      const importsBothDirectly =
        /\bplacementRegistry\b/.test(text) && /\bresolveModelItemPlacement\b/.test(text) &&
        /from ['"].*modelItemPlacement['"]/.test(text)
      if (importsBothDirectly) offenders.push(file.slice(SRC_ROOT.length))
    }
    expect(offenders).toEqual([])
  })
})
