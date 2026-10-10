import { localizeHelpIndex } from './topics/catalog'
// EAGER help index - the always-bundled searchable projection of every topic
// (a few KB). Bodies live in per-category chunks loaded on demand by
// registry.ts. Each category's entries live beside its topics in
// topics/<category>/entries.ts; the help census test asserts they match the
// topic modules FIELD FOR FIELD - drift fails CI, so edit both together.

import type { HelpIndexEntry } from './types'
import { entries as gettingStarted } from './topics/getting-started/entries'
import { entries as workspacesViewport } from './topics/workspaces-viewport/entries'
import { entries as importGeometry } from './topics/import-geometry/entries'
import { entries as sketching } from './topics/sketching/entries'
import { entries as modeling } from './topics/modeling/entries'
import { entries as form } from './topics/form/entries'
import { entries as setupsStockWcs } from './topics/setups-stock-wcs/entries'
import { entries as camOperations } from './topics/cam-operations/entries'
import { entries as toolsHolders } from './topics/tools-holders/entries'
import { entries as nesting } from './topics/nesting/entries'
import { entries as simulation } from './topics/simulation/entries'
import { entries as postingGcode } from './topics/posting-gcode/entries'
import { entries as machine } from './topics/machine/entries'
import { entries as settings } from './topics/settings/entries'
import { entries as troubleshooting } from './topics/troubleshooting/entries'

export const HELP_INDEX: HelpIndexEntry[] = localizeHelpIndex([
  ...gettingStarted,
  ...workspacesViewport,
  ...importGeometry,
  ...sketching,
  ...modeling,
  ...form,
  ...setupsStockWcs,
  ...camOperations,
  ...toolsHolders,
  ...nesting,
  ...simulation,
  ...postingGcode,
  ...machine,
  ...settings,
  ...troubleshooting,
])
