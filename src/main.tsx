import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { installJobWakeLock } from './lib/machine/jobWakeLock.ts'
import { requestStoragePersistence } from './lib/storagePersistence.ts'
import { installPersistedStateUnloadJournal } from './store/index.ts'
// WO-2319: the interface text lookup, initialised in English before first paint
// and switched to the remembered Settings > Language choice.
import './i18n/index.ts'

const disposeJobWakeLock = installJobWakeLock()
window.addEventListener('pagehide', disposeJobWakeLock, { once: true })
installPersistedStateUnloadJournal()
void requestStoragePersistence()

// cam3d dev route (?cam3dDev=1 dropGrid demo, ?cam3dDev=stock stock demo):
// mounts the standalone 3D-engine diagnostic page INSTEAD of the app.
// Lazy-imported so the normal bundle is untouched. See src/cam3d/dev/devPage.ts.
// WO UI-78: dev-only overlay ATTACH-GUARD. Behind `import.meta.env.DEV` so a
// production `vite build` strips the whole chain by dead-code elimination
// (AC6); a dev build carries it. Lazy dynamic import keeps it off the boot
// critical path. See src/devtools/overlayAttachGuardBootstrap.ts.
if (import.meta.env.DEV) {
  void import('./devtools/overlayAttachGuardBootstrap').then((m) => m.installDevOverlayAttachGuard())
}

const searchParams = new URLSearchParams(window.location.search)
const cam3dDevMode = searchParams.get('cam3dDev')
// 3D Lab (?lab3d=1): standalone real-geometry-worker viewport demo, off by
// default. See src/components/model3d/mountLab3DPage.ts.
const lab3dMode = searchParams.get('lab3d')
if (cam3dDevMode === '1' || cam3dDevMode === 'stock') {
  void import('./cam3d/dev/devPage').then(({ mountCam3dDevPage }) =>
    mountCam3dDevPage(document.getElementById('root')!),
  )
} else if (lab3dMode === '1') {
  void import('./components/model3d/mountLab3DPage').then(({ mountLab3DPage }) =>
    mountLab3DPage(document.getElementById('root')!),
  )
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}
