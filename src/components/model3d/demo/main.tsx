// WO UI-4 evidence harness entry point. Served directly by the Vite dev
// server at this file's own path (mirrors tree/demo/main.tsx's precedent);
// NOT part of the production build.

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
// Same global stylesheets App.tsx loads (read-only import -- this WO never
// edits either file) so the demo's --surface-*/--status-*/.modal-* tokens
// and classes resolve identically to the real app for an honest idiom-match
// screenshot.
import '../../../theme/tokens.css'
import '../../../styles/app.css'
import { UI4Demo } from './UI4Demo'

const root = document.getElementById('root')
if (root) createRoot(root).render(createElement(UI4Demo))
