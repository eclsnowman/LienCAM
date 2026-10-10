// WO UI-3 evidence harness entry point. Served directly by the Vite dev
// server at this file's own path (no index.html/main.tsx/vite.config.ts edit
// needed -- Vite serves any HTML file in the project by path in dev mode);
// NOT part of the production build (unreferenced by the app's own
// index.html, so `npm run build`'s default single-entry config never touches
// it). Mirrors mountLab3DPage.ts's minimal createRoot bootstrap.

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
// Same global stylesheets App.tsx loads (read-only import -- this WO never
// edits either file) so the demo's --surface-*/--status-*/.modal-* tokens
// and classes resolve identically to the real app for an honest idiom-match
// screenshot.
import '../../../../theme/tokens.css'
import '../../../../styles/app.css'
import { ChassisDemo } from './ChassisDemo'

const root = document.getElementById('root')
if (root) createRoot(root).render(createElement(ChassisDemo))
