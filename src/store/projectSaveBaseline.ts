// WO-2698: does the open project hold work that has not been saved to a file?
//
// 2026-10-09 (newcomer journey D2): New replaced an unsaved project without asking. New now asks
// Save / Discard / Cancel when the answer here is not "clean".
//
// The question is answered from what Save would WRITE, not from a flag every
// edit must remember to set: the same snapshot builder packageProjectToFile
// uses (buildProjectFileSnapshot in store/index.ts) is fingerprinted when the
// project is opened, started or saved (the baseline) and again when New is
// clicked. Model documents are covered by their edit count (documentHolder),
// because their archives are not part of that synchronous snapshot.
//
// Deliberately NOT persisted: after a reload or a startup recovery there is no
// baseline, and an unknown answer asks.

/** How packageProjectToFile ended: written, cancelled in the Save dialog, or
 *  refused (the reason is already on the existing error surface). */
export type ProjectSaveOutcome = 'saved' | 'cancelled' | 'failed'

export type ProjectSaveState = 'clean' | 'unsaved' | 'unknown'

// Pure clock / storage-pointer fields: they change without the operator
// changing anything (createdAt/updatedAt stamps, a nest's in-flight timer, the
// model autosave revision counter, which the model edit count covers).
const NON_CONTENT_FIELDS = new Set(['createdAt', 'updatedAt', 'computeStartedAt', 'documentRevision'])

/** A compact fingerprint of a file snapshot, ignoring clock fields. */
export function fingerprintProjectFileSnapshot(snapshot: object): string {
  const text = JSON.stringify(snapshot, (key, value) => (NON_CONTENT_FIELDS.has(key) ? undefined : value))
  // cyrb53-style 2 x 32-bit hash plus length: holds no copy of a large project.
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${text.length}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`
}

interface ProjectSaveBaseline {
  projectId: string
  fingerprint: string
  modelEdits: number
}

let baseline: ProjectSaveBaseline | null = null

/** Record what is on disk (or what a fresh project holds) for this project. */
export function setProjectSaveBaseline(projectId: string, snapshot: object, modelEdits: number): void {
  baseline = { projectId, fingerprint: fingerprintProjectFileSnapshot(snapshot), modelEdits }
}

/** Forget the baseline: the next question answers "unknown". */
export function clearProjectSaveBaseline(): void {
  baseline = null
}

/** Compare the live project against its baseline. `snapshot` is built only
 *  when the cheap checks cannot answer. */
export function projectSaveState(projectId: string, snapshot: () => object, modelEdits: number): ProjectSaveState {
  if (baseline === null || baseline.projectId !== projectId) return 'unknown'
  if (baseline.modelEdits !== modelEdits) return 'unsaved'
  return fingerprintProjectFileSnapshot(snapshot()) === baseline.fingerprint ? 'clean' : 'unsaved'
}
