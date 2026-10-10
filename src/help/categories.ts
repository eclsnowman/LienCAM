import { helpCategoryLabel } from './topics/catalog'
// Help index tree - category order is the user's LEARNING PATH, not the
// alphabet (plan section 3). The modal renders these as collapsible groups.

import type { HelpCategoryId } from './types'

export interface HelpCategory {
  id: HelpCategoryId
  label: string
}

const englishCategories: HelpCategory[] = [
  { id: 'getting-started', label: 'Getting started' },
  { id: 'workspaces-viewport', label: 'Workspaces and viewport' },
  { id: 'import-geometry', label: 'Import and geometry' },
  { id: 'sketching', label: 'Sketching' },
  { id: 'modeling', label: 'Modeling' },
  { id: 'setups-stock-wcs', label: 'Setups, stock and coordinates' },
  { id: 'cam-operations', label: 'CAM operations' },
  { id: 'tools-holders', label: 'Tools and holders' },
  { id: 'nesting', label: 'Nesting' },
  { id: 'simulation', label: 'Simulation' },
  { id: 'posting-gcode', label: 'Posting and G-code' },
  { id: 'machine', label: 'Machine' },
  { id: 'settings', label: 'Settings' },
  { id: 'troubleshooting', label: 'Troubleshooting' },
]

const labels = new Map(englishCategories.map(category => [category.id, helpCategoryLabel(category.id, category.label)]))
export const HELP_CATEGORIES: HelpCategory[] = englishCategories.map(category => ({
  id: category.id,
  get label() { return labels.get(category.id)!() },
}))
