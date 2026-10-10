// WO-1540: operator notices from deep inside the adaptive-clearing engine.
//
// processFeature and emitFeature are synchronous and thousands of lines deep; threading a
// callback through every helper that can leave something out would touch every signature
// for no behavioural gain. Instead the entry (index.ts) opens a sink around each synchronous
// call and the sites that change what the operator receives say so here. The sink is
// restored in a finally, and because nothing inside it awaits, two generations can never
// interleave their notices.
//
// A notice is a short plain-language sentence for the app console: what the generator did
// instead of what was asked (substituted, fell back, left out, stopped early). Developer
// diagnostics (coordinates, gate numbers, routing choices) stay on console.warn.

type NoticeSink = (message: string) => void

let activeSink: NoticeSink | undefined

/** Run `fn` with `notify` receiving every operatorNotice raised inside it. */
export function withOperatorNotices<T>(notify: NoticeSink | undefined, fn: () => T): T {
  const previous = activeSink
  activeSink = notify
  try {
    return fn()
  } finally {
    activeSink = previous
  }
}

/** Report something the operator receives but did not ask for. No-op outside a sink. */
export function operatorNotice(message: string): void {
  activeSink?.(message)
}
