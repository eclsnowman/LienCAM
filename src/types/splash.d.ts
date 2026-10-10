// Global typing for the app-shell splash bridge.
//
// The splash is plain HTML/JS that paints from index.html BEFORE the React
// bundle loads (so the boot script can't import anything from the app). It
// exposes a tiny window API the React app calls once it is interactive:
//
//   window.LienSplash.ready()                 - app signals it is loaded; lets
//                                               the splash dismiss (idempotent).
//   window.LienSplash.setProgress(pct, label) - optional real-progress hook;
//                                               NOT wired yet (the bar runs its
//                                               own timed fill by default).
//
// `LienSplash` may be undefined if the boot script removed the splash node up
// front (showSplash === false) or after dismissal — callers must use `?.`.
export {}

declare global {
  interface LienSplashApi {
    ready(): void
    setProgress(pct: number, label?: string): void
  }

  interface Window {
    LienSplash?: LienSplashApi
  }
}
