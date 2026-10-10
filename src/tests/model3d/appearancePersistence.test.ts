// WO UI-4 acceptance #5's persistence check: appearance state rides along in
// the document's existing generic `parameters` bag (src/doc/persist/
// format.ts's DocumentSaveInput.parameters: Record<string, JsonValue>) --
// the sanctioned piggyback point per this WO's report interfaceConcerns
// (no src/doc/** schema change; parameters is already a catch-all JSON blob,
// same precedent as camBindings riding in the same envelope).

import { describe, it, expect } from 'vitest'
import { FeatureDag } from '../../doc'
import { createDocumentArchive, loadDocumentArchive, type DocumentSaveInput, type JsonValue } from '../../doc/persist'
import { AppearanceStore, APPEARANCE_PARAMETERS_KEY } from '../../components/model3d/appearance'

describe('AppearanceStore riding in the document parameters bag', () => {
  it('round-trips through createDocumentArchive/loadDocumentArchive', () => {
    const store = new AppearanceStore()
    store.setFaceColor('F1:BOX:zmax', [1, 0, 0])
    store.setBodyColor('bodyA', [0, 0.4, 0.8])

    const dag = new FeatureDag()
    const input: DocumentSaveInput = {
      dag,
      elementMapDeltas: [],
      parameters: { [APPEARANCE_PARAMETERS_KEY]: store.serialize() as unknown as JsonValue },
    }
    const archive = createDocumentArchive(input)
    const loaded = loadDocumentArchive(archive)

    const restored = new AppearanceStore()
    restored.restore(loaded.parameters[APPEARANCE_PARAMETERS_KEY])
    expect(restored.faceColor('F1:BOX:zmax')).toEqual([1, 0, 0])
    expect(restored.bodyColor('bodyA')).toEqual([0, 0.4, 0.8])
  })
})
