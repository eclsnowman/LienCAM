// cam3d L0: handle lifetime discipline.
//
// Every kernel resource (WASM mesh, cutter, KD-tree...) is tracked by a
// DisposalRegistry. The emscripten heap does not garbage-collect: a handle
// that is never delete()d is a leak, and a handle used after delete() is
// heap corruption. This project treats silent fallbacks as defects, so both
// misuses THROW here instead of limping (MISSION.md rule 4).
//
// Fully unit-testable without WASM: the registry only orchestrates ids and
// destroy callbacks; the resource type is generic.

/** Fires the destroy callback for a tracked resource. */
type Entry<T> = {
  resource: T;
  kind: string;
  destroy: (resource: T) => void;
  /** Weak ref to the optional owner watched by the finalization backstop. */
  ownerRef?: WeakRef<object>;
};

let warnFn: (message: string) => void = (message) => console.warn(message);

/**
 * Test hook: replace the leak-warning sink. Returns the previous sink.
 * (Leak warnings must be observable in tests without spying on console.)
 */
export function setLeakWarnHandler(fn: (message: string) => void): (message: string) => void {
  const prev = warnFn;
  warnFn = fn;
  return prev;
}

export class DisposalRegistry<T> {
  private nextId = 1;
  private readonly live = new Map<number, Entry<T>>();
  /** Ids that were once live and are now disposed -- distinguishes
   *  double-dispose from a handle this registry never issued. */
  private readonly retired = new Set<number>();
  private readonly finalizer: FinalizationRegistry<number> | undefined;

  constructor() {
    // Backstop only -- correctness never depends on GC timing. If an owner
    // object is collected while its handle is still live, someone forgot to
    // dispose(): warn loudly in dev so the leak is found before the WASM
    // heap grows unbounded.
    this.finalizer =
      typeof FinalizationRegistry === 'function'
        ? new FinalizationRegistry<number>((id) => {
            const entry = this.live.get(id);
            if (entry !== undefined) {
              warnFn(
                `cam3d DisposalRegistry: leaked ${entry.kind} handle #${id} -- ` +
                  `owner was garbage-collected without dispose(). ` +
                  `Every kernel handle must be released (try/finally or 'using').`,
              );
            }
          })
        : undefined;
  }

  /**
   * Track a resource. `destroy` is invoked exactly once, on dispose.
   * `owner`, if given, is watched by the FinalizationRegistry backstop:
   * if it is GC'd while the handle is live, a leak warning fires.
   * Returns the numeric handle id.
   */
  register(resource: T, destroy: (resource: T) => void, kind = 'resource', owner?: object): number {
    const id = this.nextId;
    this.nextId += 1;
    const entry: Entry<T> = { resource, kind, destroy };
    if (owner !== undefined && this.finalizer !== undefined) {
      entry.ownerRef = new WeakRef(owner);
      this.finalizer.register(owner, id, owner);
    }
    this.live.set(id, entry);
    return id;
  }

  /** Fetch a live resource. Throws on unknown id and on use-after-dispose. */
  lookup(id: number): T {
    const entry = this.live.get(id);
    if (entry === undefined) {
      if (this.retired.has(id)) {
        throw new Error(`cam3d DisposalRegistry: use-after-dispose of handle #${id}`);
      }
      throw new Error(`cam3d DisposalRegistry: unknown handle #${id} (never registered here)`);
    }
    return entry.resource;
  }

  /** True if the id refers to a live (registered, not yet disposed) handle. */
  isLive(id: number): boolean {
    return this.live.has(id);
  }

  /** Number of live handles (leak assertions in tests). */
  get liveCount(): number {
    return this.live.size;
  }

  /** Destroy one handle. Throws on double-dispose and on unknown id. */
  dispose(id: number): void {
    const entry = this.live.get(id);
    if (entry === undefined) {
      if (this.retired.has(id)) {
        throw new Error(`cam3d DisposalRegistry: double-dispose of handle #${id}`);
      }
      throw new Error(`cam3d DisposalRegistry: cannot dispose unknown handle #${id}`);
    }
    // Retire BEFORE destroy so a throwing destroy callback cannot leave the
    // entry in a half-disposed state that would allow a second destroy call.
    this.live.delete(id);
    this.retired.add(id);
    const owner = entry.ownerRef?.deref();
    if (owner !== undefined && this.finalizer !== undefined) {
      this.finalizer.unregister(owner);
    }
    entry.destroy(entry.resource);
  }

  /**
   * Destroy every live handle in registration (id) order -- fixed iteration
   * order, per the project determinism rule. Safe to call when empty.
   */
  disposeAll(): void {
    const ids = [...this.live.keys()].sort((a, b) => a - b);
    for (const id of ids) this.dispose(id);
  }
}
