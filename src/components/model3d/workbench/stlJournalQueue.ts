// WO-2803: CommandHistory requests are synchronous, but journal writes await
// cache reads and bounds refreshes. Ordering belongs to the part, not to a
// command instance or port adapter: create and replace must share it.
const pendingByPart = new Map<string, Promise<void>>()

export function enqueueStlJournalMutation<T>(geoId: string, mutation: () => Promise<T>): Promise<T> {
  const result = (pendingByPart.get(geoId) ?? Promise.resolve()).then(mutation)
  // A failed write reports through its caller. It must not poison subsequent
  // history requests, and an idle part must not retain its promise chain.
  const settled = result.then(() => {}, () => {})
  pendingByPart.set(geoId, settled)
  void settled.then(() => {
    if (pendingByPart.get(geoId) === settled) pendingByPart.delete(geoId)
  })
  return result
}
