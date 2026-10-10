import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'

// ---------------------------------------------------------------------------
// WO-1687 - THE OUTER SEVEN, replacing the three MOTION/TRAVEL/WIRING groups.
// v2/SLICES.md T4: one bar, seven tabs - Overview | Machine | Spindle |
// Outputs & coolant | Probing | Controller | All settings. WO-1688..1694 gave
// each its body; WO-1720 deleted the temporary eighth "Legacy" door and the
// old three-group sub-navigation under it once All settings carried every
// field Legacy drew (Operator ruling 2026-09-19: "No legacy, and all means ALL").
// ---------------------------------------------------------------------------
export const DEF_GROUPS = [
  ['overview', 'Overview', 'A short summary of this machine.'],
  ['machine', 'Machine', 'Axes, travel, homing and the pins that wire them.'],
  ['spindle', 'Spindle', 'Drive, RPM range, direction and the VFD link.'],
  ['outputs', 'Outputs & coolant', 'Every output this machine switches, and what drives it.'],
  ['probing', 'Probing', 'Probe and tool-setter pins, and the feeds that use them.'],
  ['controller', 'Controller', "This computer's link, profile import/export, and the e-stop pin."],
  ['allSettings', 'All settings', 'Every setting this machine carries, with its value, searchable by name.'],
] as const

export type DefGroup = (typeof DEF_GROUPS)[number][0]

/** Which of the SEVEN areas OWNS a validation complaint, so the reorganised
 *  page can never hide a fault. TOTAL over everything
 *  `validateControllerDefinition` can emit today:
 *
 *    "Axis X is listed more than once."          -> machine (the axis list)
 *    "Homing order lists X more than once."       -> machine (home order)
 *    "Homing order lists X, which is not ..."      -> machine
 *    "... e-stop pin is ..." / "... claimed by ... e-stop ..." -> controller
 *      (T11 owns the e-stop pin)
 *    "... probe / probe 2 pin is ..." / "... claimed by ... probe ..."
 *      -> probing (T10 owns the probe and tool-setter pins)
 *    "... drive fault input N pin is ..." / "... claimed by ... drive fault
 *      input N ..." -> controller (WO-1729: DriveFaultInputsSection is mounted
 *      on the Controller tab, MachineDefinitionPanel.tsx:475)
 *    "... charge pump pin is ..." / "... claimed by ... charge pump ..."
 *      -> outputs (WO-1729: ChargePumpSection is mounted on Outputs,
 *      MachineDefinitionPanel.tsx:497)
 *    every other pin claim (an axis step/dir/home/limit/enable pin)
 *      -> machine (T7 owns the axis table and its per-axis pins)
 *
 *  A duplicate claim names two labels and `find` takes the FIRST in census
 *  order, which is the claimant that already holds the pin - so a pin shared
 *  by a drive-fault input and the charge pump badges Controller, and one
 *  shared with an axis pin still badges Machine. That precedence is the
 *  pre-WO-1729 behaviour and this repair keeps it.
 *
 *  EXPORTED so a test can prove the mapping is exhaustive instead of assuming
 *  it, the same way the pre-WO-1687 three-way mapping was proved. An
 *  unattributed problem would be a fault with no tab to announce it. */
export function definitionProblemGroup(problem: string, pinLabels: string[]): DefGroup {
  if (problem.startsWith('Homing order')) return 'machine'
  const matched = pinLabels.find((label) => problem.includes(label))
  if (matched === 'e-stop') return 'controller'
  if (matched === 'probe' || matched === 'probe 2') return 'probing'
  if (matched !== undefined && matched.startsWith('drive fault input')) return 'controller'
  if (matched === 'charge pump') return 'outputs'
  return 'machine'
}

// ---------------------------------------------------------------------------
// WO-1687 - THE OUTER BAR'S TAB ROW: the seven areas, one look, one keyboard
// model and one badge rule.
// ---------------------------------------------------------------------------
type DefinitionSectionNavProps =
  Pick<MachineDefinitionPanelState, 'section' | 'sectionProblemCount' | 'setSection'>

export function DefinitionSectionNav({ section, sectionProblemCount, setSection }: DefinitionSectionNavProps) {
  return (
    <div
      className="control-strip-nav"
      role="tablist"
      aria-label="Machine definition sections"
      data-testid="machine-def-tabs"
      style={{ flex: '0 0 auto' }}
    >
      {DEF_GROUPS.map(([key, label, description]) => {
        const count = sectionProblemCount[key]
        // WO-1713: the area's one-line description used to sit on its own row
        // below the tab strip (`machine-def-tab-caption`, removed). Operator's
        // card was about vertical space, not about losing the words, so it
        // moved to the tab's own hover text - the same `data-tooltip`
        // convention this page already uses everywhere else (Revert, Save,
        // Apply).
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={section === key}
            aria-label={count > 0 ? `${label}, ${count} to fix` : label}
            data-testid={`machine-def-tab-${key}`}
            data-problem-count={count > 0 ? String(count) : undefined}
            data-tooltip={description}
            className={`control-view-tab${section === key ? ' control-view-tab-active' : ''}`}
            onClick={() => setSection(key)}
          >
            {label}
            {count > 0 && (
              <span
                data-testid={`machine-def-tab-badge-${key}`}
                data-tooltip={`${count} thing${count === 1 ? '' : 's'} to fix in ${label}`}
                style={{
                  marginLeft: 6, padding: '0 5px', borderRadius: 8,
                  background: 'var(--accent-red)', color: 'var(--text-active)',
                  fontSize: 'var(--font-size-sm)', fontWeight: 600,
                }}
              >
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
