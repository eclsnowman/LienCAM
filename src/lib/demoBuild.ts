/** Release builders opt in; a URL or an ordinary browser session is not a demo build. */
export function isDemoBuild(): boolean {
  return import.meta.env.VITE_DEMO_BUILD === 'true'
}

/** The installed desktop app: electron/preload.cjs exposes liencamHost before the bundle runs. */
export function isDesktopHost(): boolean {
  return (globalThis as typeof globalThis & { liencamHost?: unknown }).liencamHost != null
}

/** WO-2532: the desktop app offers the shipped examples at first start, as the browser demo does. */
export function offersStartupExamples(): boolean {
  return isDemoBuild() || isDesktopHost()
}
