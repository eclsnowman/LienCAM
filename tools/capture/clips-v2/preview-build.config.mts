// WO-2653: a production bundle the rehearsal scripts can still read back.
// NODE_ENV stays production (minified production React, no StrictMode double
// effects, no dev-server dependency optimizer). Only import.meta.env.DEV is
// flipped so the read-only probes the scripts assert against (__camStore,
// __geo23MatrixProbe, ...) are installed, exactly as on the dev server.
// NODE_ENV=production node node_modules/vite/bin/vite.js build \
//   --config tools/capture/clips-v2/preview-build.config.mts --outDir <dir outside repo> --emptyOutDir
import base from '../../../vite.config.mts'

export default { ...base, define: { ...base.define, 'import.meta.env.DEV': 'true' } }
