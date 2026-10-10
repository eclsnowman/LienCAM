import { strFromU8, strToU8 } from 'fflate'
import type { BinaryDocumentStorage } from './storage'

export interface AutosaveControllerOptions {
  storage: BinaryDocumentStorage
  documentId: string
  debounceMs: number
  save: () => Promise<Uint8Array>
  onFlushed?: (revision: number) => void
  /** Optional cross-controller/direct-write serializer for this document key. */
  serializeWrite?: <T>(task: () => Promise<T>) => Promise<T>
}

export interface AutosaveRecovery {
  documentId: string
  revision: number
  bytes: Uint8Array
}

export interface AutosaveState {
  unclean: boolean
  revision: number
}

export interface AutosaveSnapshot {
  revision: number
  unclean: boolean
  bytes: Uint8Array
}

export class AutosaveController {
  private readonly storage: BinaryDocumentStorage
  private readonly documentId: string
  private readonly debounceMs: number
  private readonly save: () => Promise<Uint8Array>
  private readonly serializeWrite?: <T>(task: () => Promise<T>) => Promise<T>
  private onFlushed?: (revision: number) => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private revision = 0
  private pendingFlush: Promise<void> | undefined
  private disposed = false
  // Monotonic edit generation. INVARIANT (R2, Architect circuit-breaker
  // 2026-07-08): a markDirty() newer than a markClean()'s entry observation
  // must SURVIVE that markClean — clean-marking only applies to the state the
  // manual save actually captured, never to edits that raced in afterward.
  private dirtyGen = 0
  // TOTAL WRITE ORDER (R3, 2026-07-08): every autosave data/state write goes
  // through this chain, in enqueue order. The R2 audit REPRODUCED a delayed
  // clean-state write landing AFTER a newer flush's unclean write and
  // clobbering it (recovery lost). Storage gives no ordering guarantee, so
  // the controller must: writes are serialized here, and the clean write
  // re-checks the generation INSIDE its turn (see markClean).
  private writeChain: Promise<void> = Promise.resolve()

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const run = this.writeChain.then(() =>
      this.serializeWrite ? this.serializeWrite(task) : task())
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  constructor(options: AutosaveControllerOptions) {
    this.storage = options.storage
    this.documentId = options.documentId
    this.debounceMs = options.debounceMs
    this.save = options.save
    this.onFlushed = options.onFlushed
    this.serializeWrite = options.serializeWrite
  }

  markDirty(): void {
    if (this.disposed) return
    this.dirty = true
    this.dirtyGen += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush().catch(() => undefined)
    }, this.debounceMs)
  }

  setOnFlushed(onFlushed?: (revision: number) => void): void {
    this.onFlushed = onFlushed
  }

  async flush(): Promise<void> {
    if (this.disposed) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.pendingFlush) {
      await this.pendingFlush
      return
    }
    this.pendingFlush = this.flushLoop()
    try {
      await this.pendingFlush
    } finally {
      this.pendingFlush = undefined
    }
  }

  async markClean(): Promise<void> {
    if (this.disposed) return
    // Snapshot the edit generation this manual save captured. Everything
    // below only acts if NO newer markDirty has arrived (gen unchanged) —
    // otherwise the newer edits keep their dirty state, timer, and flush,
    // and this markClean becomes a no-op (the R1 audit's lost-update race:
    // force-clearing dirty across the awaits erased mid-wait edits and a
    // crash then offered no recovery for them).
    const gen = this.dirtyGen
    if (this.dirtyGen === gen && this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.dirtyGen === gen) this.dirty = false
    while (this.pendingFlush) {
      await this.pendingFlush
    }
    if (this.dirtyGen !== gen) return
    this.dirty = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.enqueueWrite(async () => {
      // Re-check INSIDE the serialized turn: any newer edit's flush write is
      // queued behind or after us in the chain — if a newer generation
      // exists by the time our turn runs, the flush owns the state; writing
      // unclean:false here would be the R2 clobber. Skip.
      if (this.dirtyGen !== gen) return
      await writeState(this.storage, this.documentId, { unclean: false, revision: this.revision })
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private async flushLoop(): Promise<void> {
    while (this.dirty) {
      this.dirty = false
      const bytes = await this.save()
      // A project close/reopen may dispose this controller while save() is
      // awaiting. Never enqueue those stale bytes after the replacement
      // document's authoritative write has already entered the shared queue.
      if (this.disposed) return
      this.revision += 1
      const revision = this.revision
      await this.enqueueWrite(async () => {
        if (this.disposed) return
        await this.storage.write(autosaveDataKey(this.documentId), new Uint8Array(bytes))
        await writeState(this.storage, this.documentId, { unclean: true, revision })
        this.onFlushed?.(revision)
      })
    }
  }
}

export async function recoverAutosave(storage: BinaryDocumentStorage, documentId: string): Promise<AutosaveRecovery | undefined> {
  const snapshot = await readAutosaveSnapshot(storage, documentId)
  if (!snapshot?.unclean) return undefined
  return { documentId, revision: snapshot.revision, bytes: snapshot.bytes }
}

/** Read the last durable bytes whether the session is clean or unclean.
 * Recovery only offers unclean snapshots; Model Item cold-start hydration
 * needs the last known-good archive in both cases. */
export async function readAutosaveSnapshot(
  storage: BinaryDocumentStorage,
  documentId: string,
): Promise<AutosaveSnapshot | undefined> {
  const stateBytes = await storage.read(autosaveStateKey(documentId))
  if (!stateBytes) return undefined
  const state = JSON.parse(strFromU8(stateBytes)) as AutosaveState
  if (
    typeof state?.revision !== 'number' ||
    !Number.isInteger(state.revision) ||
    state.revision < 0 ||
    typeof state.unclean !== 'boolean'
  ) {
    throw new Error(`Autosave state for "${documentId}" is invalid.`)
  }
  const bytes = await storage.read(autosaveDataKey(documentId))
  if (!bytes) return undefined
  return { revision: state.revision, unclean: state.unclean, bytes }
}

export async function removeAutosaveSnapshot(
  storage: BinaryDocumentStorage,
  documentId: string,
): Promise<void> {
  await storage.remove(autosaveDataKey(documentId))
  await storage.remove(autosaveStateKey(documentId))
}

export async function writeAutosaveSnapshot(
  storage: BinaryDocumentStorage,
  documentId: string,
  bytes: Uint8Array,
  revision: number = 1,
): Promise<void> {
  await storage.write(autosaveDataKey(documentId), new Uint8Array(bytes))
  await writeState(storage, documentId, { unclean: false, revision })
}

export function autosaveDataKey(documentId: string): string {
  return 'autosave-' + encodeURIComponent(documentId) + '.zip'
}

export function autosaveStateKey(documentId: string): string {
  return 'autosave-' + encodeURIComponent(documentId) + '.json'
}

async function writeState(storage: BinaryDocumentStorage, documentId: string, state: AutosaveState): Promise<void> {
  await storage.write(autosaveStateKey(documentId), strToU8(JSON.stringify(state)))
}
