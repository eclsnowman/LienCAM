import type { Command } from '../../../doc'
import type { MeshEditRecord } from '../../../mesh/edit'
import type { StlMeshEditPort } from './stlFeatureEdits'
import { enqueueStlJournalMutation } from './stlJournalQueue'

/** Rewrite a journal tail through the store's own invalidation, bounds,
 * stock and persistence paths. Stable IDs survive replacement and undo. */
export function rewriteStlJournalTail(
  port: StlMeshEditPort, geoId: string,
  before: readonly MeshEditRecord[], after: readonly MeshEditRecord[],
): Promise<void> {
  return enqueueStlJournalMutation(geoId, async () => {
    for (const record of [...before].reverse()) await port.removeMeshEdit(geoId, record.id)
    const added: MeshEditRecord[] = []
    try {
      for (const record of after) added.push(await port.addMeshEdit(geoId, record))
    } catch (error) {
      for (const record of [...added].reverse()) await port.removeMeshEdit(geoId, record.id)
      for (const record of before) await port.addMeshEdit(geoId, record)
      throw error
    }
  })
}

export class RewriteStlMeshEditCommand implements Command {
  readonly label = 'stlMeshEdit'
  private applied = true
  private readonly port: StlMeshEditPort
  private readonly geoId: string
  private readonly before: readonly MeshEditRecord[]
  private readonly after: readonly MeshEditRecord[]
  constructor(port: StlMeshEditPort, geoId: string,
    before: readonly MeshEditRecord[], after: readonly MeshEditRecord[]) {
    this.port = port
    this.geoId = geoId
    this.before = before
    this.after = after
  }
  do(): void {
    if (this.applied) return
    this.applied = true
    this.enqueue(this.before, this.after)
  }
  undo(): void {
    if (!this.applied) return
    this.applied = false
    this.enqueue(this.after, this.before)
  }
  private enqueue(before: readonly MeshEditRecord[], after: readonly MeshEditRecord[]): void {
    void rewriteStlJournalTail(this.port, this.geoId, before, after)
      .catch((error: unknown) => this.port.fail(String(error instanceof Error ? error.message : error)))
  }
  serialize(): unknown { return { kind: 'rewriteStlMeshEdit', geoId: this.geoId, before: this.before, after: this.after } }
}
