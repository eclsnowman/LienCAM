// WO-2328: what the hard-coded English guard lets stay literal.
// See docs/testing/I18N-HARDCODED-ENGLISH-GUARD.md for when to add an entry.
//
// LITERAL_TOKENS: words that stay English in any text (the owner 2026-10-01:
// G-code, posted files, controller messages, dialect names, file extensions
// and keyboard shortcut letters stay English). A text whose every word of two
// or more letters matches one of these is not reported. Each pattern matches
// one whole word.
//
// RESIDUAL_TEXT: hard-coded English that was already in the tree when the
// guard landed (2026-10-13, after WO-2320..WO-2327). Listed per file and
// counted, so it may stay but a new copy or a new sentence fails. Remove a
// line when its text moves to the catalog.

export type LiteralToken = { pattern: RegExp; reason: string }
export type ResidualText = { file: string; reason: string; texts: string[] }

export const LITERAL_TOKENS: LiteralToken[] = [
  { pattern: /^[GMTSFHDNOPQRLEXYZABCIJKUVW]\d+$/, reason: 'G-code words (G0, M6, T1, S12000) are posted text and stay English' },
  { pattern: /^(IJK|XYZ|XY|XZ|YZ|ABC|UVW|WCS|MCS|MDI|DRO|TLO|RPM|IPM|PWM|VFD|MPG|THC|RFH|PID|CW|CCW)$/, reason: 'axis groups and controller/G-code abbreviations are shown as the controller names them' },
  { pattern: /^(mm|cm|um|in|inch|deg|rad|rpm|ipm|min|sec|ms|s|Hz|kHz|V|mA|kW|W|px|pt|kg|g)$/, reason: 'units and symbols stay as written; numbers keep the "." decimal' },
  { pattern: /^(UCCNC|LinuxCNC|GRBL|grblHAL|Mach3|Mach4|Fusion|FluidNC|Marlin|Modbus|CNCdrive|UC100|UC300|UC400ETH|AXBB)$/, reason: 'dialect, controller and product names are proper names' },
  { pattern: /^(STL|STEP|STP|DXF|SVG|IGES|IGS|NC|TAP|NGC|GCODE|JSON|PNG|JPG|JPEG|OBJ|3MF|PDF|CSV|INI|XML)$/, reason: 'file format names stay English' },
  { pattern: /^\.[A-Za-z0-9]+$/, reason: 'file extensions (.nc, .camproject) stay English' },
  { pattern: /^(Esc|Ctrl|Shift|Alt|Cmd|Del|Backspace|PgUp|PgDn|F([1-9]|1[0-2]))$/, reason: 'keyboard key names, like shortcut letters, match the keycap' },
  { pattern: /^(LienCAM|LienCNC)$/, reason: 'product name' },
]

const RESIDUAL = 'present before the guard; outside the WO-2320..2327 extraction; catalog move owed by a follow-up order'
const WO2725 = 'added by WO-2725 (Open window) after the residual list was taken; catalog move owed by a later i18n order'
const SCANNER = 'present before the guard, hidden by a scanner limit the audit found; catalog move owed by a later i18n order'
const WO2724 ='added by WO-2724 (About on the toolbar) after the residual list was taken; catalog move owed by a later i18n order'
const ALPHA2 = 'added by alpha.2 orders (WO-2669, 2759, 2773, 2802, 2804, 2810) after the residual list was taken; listed at the alpha.2 freeze (WO-2849, no product source edits); catalog move owed by an i18n order after the release'

export const RESIDUAL_TEXT: ResidualText[] = [
  {
    file: 'src/components/ErrorBoundary.tsx',
    reason: RESIDUAL,
    texts: [
      'LienCAM encountered an error',
      'Something went wrong while rendering. Your saved project has not been touched -- reloading is usually all that is needed.',
      'Reload',
      'Still broken after reloading? Last resort: clears everything the app has saved -- the current project, your tool library, holder library, machine library, app settings and imported fonts -- and cannot be undone. Only use it if a plain reload keeps hitting the same error.',
      'Reset Project Data &amp; Reload (last resort)',
    ],
  },
  {
    file: 'src/components/machine/ControlPage.tsx',
    reason: RESIDUAL,
    texts: [
      'Connecting...',
      'Connecting...',
    ],
  },
  {
    file: 'src/components/machine/ControlTransportBar.tsx',
    reason: RESIDUAL,
    texts: [
      'Reconnecting...',
    ],
  },
  {
    file: 'src/components/machine/CycleLogPanel.tsx',
    reason: RESIDUAL,
    texts: [
      '(unnamed)',
    ],
  },
  {
    file: 'src/components/machine/GrblSettingsTable.tsx',
    reason: RESIDUAL,
    texts: [
      'sending',
    ],
  },
  {
    file: 'src/components/machine/JogPanel.tsx',
    reason: RESIDUAL,
    texts: [
      'Homing...',
    ],
  },
  {
    file: 'src/components/machine/MachineDefinitionPanel.tsx',
    reason: RESIDUAL,
    texts: [
      'Applying...',
    ],
  },
  {
    file: 'src/components/machine/MacroEditor.tsx',
    reason: 'the placeholder is a macro-language code example (line(\'M7\')), which stays as written',
    texts: [
      'line(\'M7\')',
    ],
  },
  {
    file: 'src/components/machine/PendantPanel.tsx',
    reason: RESIDUAL,
    texts: [
      'Starting...',
      'Stopping...',
    ],
  },
  {
    file: 'src/components/machine/ProbeRoutineEditor.tsx',
    reason: RESIDUAL,
    texts: [
      '(unsaved)',
    ],
  },
  {
    file: 'src/components/machine/ProgramDivider.tsx',
    reason: RESIDUAL,
    texts: [
      '{}% preview, {}% G-code list',
    ],
  },
  {
    file: 'src/components/machine/ToolsProbePanel.tsx',
    reason: RESIDUAL,
    texts: [
      'measured',
      'typed',
    ],
  },
  {
    file: 'src/components/machine/definition/ApplyDefinitionSection.tsx',
    reason: RESIDUAL,
    texts: [
      'Saves first, then writes this definition to the connected controller',
      'Applying...',
    ],
  },
  {
    file: 'src/components/machine/definition/AutomationSection.tsx',
    reason: RESIDUAL,
    texts: [
      'Automatic macros, digitizing output, laser engraving and RFH',
      '48 controller slots; configured actions stay in view',
      'Axes, output file and numeric format recorded by the plugin',
      'Workpiece, scan and feed settings',
      'Controller-recorded spindle and initial-move behavior',
    ],
  },
  {
    file: 'src/components/machine/definition/BuiltinCommandsSection.tsx',
    reason: RESIDUAL,
    texts: [
      'What each stock spindle and coolant button sends{}.',
    ],
  },
  {
    file: 'src/components/machine/definition/ControllerArea.tsx',
    reason: RESIDUAL,
    texts: [
      'Which CNCdrive board this machine\'s definition declares',
      'Which input this machine names as its e-stop',
      '{} of {} fault inputs enabled',
      'Path blending and lookahead',
    ],
  },
  {
    file: 'src/components/machine/definition/ControllerSetupSection.tsx',
    reason: RESIDUAL,
    texts: [
      'Building...',
      'Building...',
      'Starting...',
      'Restarting...',
      'unknown',
      'yes',
      'no',
    ],
  },
  {
    file: 'src/components/machine/definition/DefinitionFields.tsx',
    reason: RESIDUAL,
    texts: [
      '{}definition.',
    ],
  },
  {
    file: 'src/components/machine/definition/DriveSignalsSection.tsx',
    reason: RESIDUAL,
    texts: [
      'none stated',
      '{} input{} stated',
      'not stated',
    ],
  },
  {
    file: 'src/components/machine/definition/GeneralSection.tsx',
    reason: RESIDUAL,
    texts: [
      'Path blending, lookahead, tolerances and controller buffering',
      'File loading, tool changes, canned cycles and unknown codes',
      'Profile-level controller presentation and startup behavior',
    ],
  },
  {
    file: 'src/components/machine/definition/ImportIssuesSection.tsx',
    reason: RESIDUAL,
    texts: [
      '{} thing{} the import could not take verbatim',
    ],
  },
  {
    file: 'src/components/machine/definition/MachineArea.tsx',
    reason: RESIDUAL,
    texts: [
      '{} enabled of {}',
    ],
  },
  {
    file: 'src/components/machine/definition/ModbusSection.tsx',
    reason: RESIDUAL,
    texts: [
      'UCCNC plugin, serial connection and four function records',
      'Plugin commands, telemetry selection and speed range',
      'Shared transport and retry policy for the four function slots',
    ],
  },
  {
    file: 'src/components/machine/definition/MotionSection.tsx',
    reason: RESIDUAL,
    texts: [
      '{} enabled of {}',
    ],
  },
  {
    file: 'src/components/machine/definition/OutputsSection.tsx',
    reason: RESIDUAL,
    texts: [
      'none defined',
    ],
  },
  {
    file: 'src/components/machine/definition/SpindleArea.tsx',
    reason: RESIDUAL,
    texts: [
      'The RPM mapping sent through the same spindle commands as a Modbus drive',
      'Drive, RPM range, direction and the VFD link',
    ],
  },
  {
    file: 'src/components/machine/definition/SpindleLinkSection.tsx',
    reason: RESIDUAL,
    texts: [
      'How the bridge reaches the inverter, and how long it waits',
      'This link cannot set them and cannot check them - they are yours to enter on the keypad',
      'The register this drive reports faults in. Empty: it has none, and the fault is read from the operating-state word',
      'What each value read from the operating-state register means',
      'This machine\'s editable inverter definition',
      'Which definition the bridge is running, and where it came from',
      'Function codes, and which half of a two-register value goes first',
      'Where each value lives on the inverter, how many registers it spans (the setpoint is 1 for a 16-bit drive, 2 for a 32-bit one) and how the setpoint is scaled',
      'What the bridge writes to run and to stop',
      'What clearing a fault writes, and how long it waits between steps',
      'Which words of the status block become which reading',
      'What counts as a fault, and the named numbers the scales may use',
      'What the definition\'s author wrote about this inverter',
    ],
  },
  {
    file: 'src/components/machine/definition/SpindleSection.tsx',
    reason: RESIDUAL,
    texts: [
      'The Modbus link, then speed command, encoder, pulleys and PID - relays are rows on the Outputs list',
      'PWM and step/direction settings from this machine\'s profile',
      'Quadrature input and scale',
      'Closed-loop spindle tuning',
    ],
  },
  {
    file: 'src/components/machine/definition/TravelHomingSection.tsx',
    reason: RESIDUAL,
    texts: [
      'Homing policy',
      'Nothing on this tab for this controller',
      'Machine-wide requirements and soft-limit policy',
    ],
  },
  {
    file: 'src/components/machine/definition/WiringSection.tsx',
    reason: RESIDUAL,
    texts: [
      'e-stop {} / probe {}',
      'e-stop {} / probe {} / probe 2 {}',
      'Debounce values for machine, home, torch and probe signals',
      'Outputs, timing signals and the spindle index input',
      'Arc feedback, torch corrections and anti-dive signals',
      'Manual pulse generator and analog override channels',
      '10 outputs that switch in step with controller motion',
      '6 encoder input pairs and their recorded scale',
      'External signals that can command or reflect controller actions',
      '15 fault input rows from this machine\'s profile',
    ],
  },
  {
    file: 'src/components/machine/definition/setup/steps/Step7CheckAndSave.tsx',
    reason: RESIDUAL,
    texts: [
      'Applying...',
    ],
  },
  {
    file: 'src/components/modals/AboutModal.tsx',
    reason: RESIDUAL,
    texts: [
      'About',
      'Credits',
      'Licence texts',
      'About LienCAM',
      'Close About LienCAM',
      'About LienCAM sections',
      'Version',
      'Build commit',
      'Build date',
      'Apache-2.0 for LienCAM\'s own code; the adaptive-clearing engine is a separate LGPL-2.1-or-later module',
      'Copyright (c) 2026 Eric Lien and LienCAM contributors',
      'See Credits for the people and projects LienCAM stands on, and Licence texts for the bundled licences.',
      'Loading licence texts...',
      'Could not load',
      'Retry licence texts',
      'Close',
    ],
  },
  {
    file: 'src/components/modals/DemoExamplePickerModal.tsx',
    reason: RESIDUAL,
    texts: [
      'Try an example',
      'Close example picker',
      'Open a real part to explore LienCAM. Each example uses the sample hobby router.',
      'Opening...',
      'You can try again or choose another example.',
      'Start with an empty project',
    ],
  },
  {
    file: 'src/components/modals/ExportModal.tsx',
    reason: RESIDUAL,
    texts: [
      'Could not save {}: {}',
      'Export',
      'Close',
      '{} format',
      'Save',
    ],
  },
  {
    file: 'src/components/modals/NewOperationModalBody.tsx',
    reason: RESIDUAL,
    texts: [
      'Machine actions',
      'Macro',
      'Choose a macro',
      'Only shown macros with program-callable M-codes are listed. M6 also changes tools.',
      'This machine has no callable macros.',
    ],
  },
  {
    file: 'src/components/modals/PostProcessModal.tsx',
    reason: 'the placeholder is post template syntax (M6 T{tool}), posted text that stays English',
    texts: [
      'M6 T{tool}',
    ],
  },
  {
    file: 'src/components/model3d/SolidsWorkbenchPage.tsx',
    reason: RESIDUAL,
    texts: [
      'Diameter',
      'Depth',
    ],
  },
  {
    file: 'src/components/panels/DesignTree.tsx',
    reason: RESIDUAL,
    texts: [
      'Suppress operation',
      'Unsuppress operation',
      'Delete',
    ],
  },
  {
    file: 'src/components/panels/PropertiesPanel.tsx',
    reason: RESIDUAL,
    texts: [
      'Type',
      'Macro',
      'Choose a macro',
      'Selected macro is unavailable',
      'Only shown macros with program-callable M-codes are listed. M6 also changes tools.',
      'Park',
      'No park position on this machine - stops at safe height',
      'Park',
      '(machine)',
      'Delete',
    ],
  },
  {
    file: 'src/components/panels/SetupPanel.tsx',
    reason: RESIDUAL,
    texts: [
      'Holding method',
      'Holding method',
      'None',
      'Setup notes',
      'Setup notes',
    ],
  },
  {
    file: 'src/lib/import/importGeometryFile.ts',
    reason: 'import console messages; src/lib/import was outside WO-2326\'s file list; catalog move owed by a follow-up order',
    texts: [
      'Import failed for "{}": {}',
      'Imported "{}" (IGES -- {})',
      '"{}" imported, but its offline cache copy could not be written{} — it will need re-import after a full reload.',
      '"{}" imported, but its offline cache copy could not be written{} — it will need re-import after a full reload.',
      '"{}" imported, but its offline cache copy could not be written{} — it will need re-import after a full reload.',
      'Imported "{}" ({}{})',
      'Import failed for "{}": {}',
    ],
  },
  {
    file: 'src/lib/machine/machineSession.ts',
    reason: 'control-session console lines built in src/lib/machine; no extraction order covered src/lib/machine; catalog move owed by a follow-up order',
    texts: [
      'Cycle Start: "{}" goes back on the board once the machine is at Idle after the MDI line - press CYCLE START then. Nothing moved.',
      '"{}": its LienCAM setup information does not match the program, so it is loaded without it.',
      'Cycle Start: refused - {} is still waiting for the machine to confirm it, so the spindle was not started and "{}" was not started. Press CYCLE START again once the machine has answered.',
      'Cycle Start: refused - the machine has not confirmed a {} Z work zero since the tool change, so the spindle was not started and "{}" was not started. Set the {} Z zero for {}, then press CYCLE START.',
      'Spindle at speed; "{}" waits until the machine confirms the work offsets it is still writing. Stop, Feed Hold and E-STOP all work while it waits.',
      'Cycle Start: cancelled - the controller reopened while the spindle was coming up to speed and has not confirmed the {} work offset since, so the spindle was stopped and "{}" was not started. Set the {} Z zero for {}, then press CYCLE START.',
      'Cycle Start: refused - {}',
      '{} - home {} again before moving to machine coordinates.',
      'The machine would not set the {} work offset - {}.',
      'The alarm cleared "{}" from the controller before it started, {}.',
      'Macro "{}" (M{}) has ended without reaching its tool change - the tool change to T{} follows.',
      'Macro "{}" (M{}) has finished - press CYCLE START to run the rest of the program.',
      'Macro "{}" (M6) has ended - the tool change on line {} follows.',
      'Macro "{}" (M6) has ended - the tool change on line {} follows: fit T{}, set its Z zero, then press CYCLE START to run the rest.',
      'M{} on line {}: toolChange({}) names no whole tool number - the file\'s own tool is used.',
      'M{} on line {} runs the tool change. The spindle is stopped and the tool is where the file left it: fit {}, set its Z zero, then press CYCLE START to run the rest.',
      '{} could not park because this machine has no park macro marked for this; make one in the Macros panel (Edit macros). The program stays held so you can park and screw down the material yourself.',
      'M{} on line {} cannot run the fixed-pad tool change because no reference tool has been measured. Fit T{}, set its Z work zero, then press CYCLE START; the program remains held.',
      'M{} on line {}: {}',
      'M{} on line {}: moving to "{}". Fit T{}; Continue will probe it, apply its measured length and resume the program.',
      '{} is selected and the tool is clear - running "{}" in {}.',
      'Line {}: {} - the spindle is stopped before the next move.',
      'Line {}: {} - the file stops the spindle here, and this machine has no link to stop it. Stop it at the machine.',
      'Line {}: {} - {}',
      'Line {}: {} - the spindle is commanded at {} RPM {}, and the next move waits for it.',
      'Line {}: {} - the file runs the next moves at {} RPM {}, and this machine has no link to start the spindle. Running on with the spindle you started.',
      'Line {}: the file switches {} here, and this machine states no such output - switch it at the machine.',
      'Line {}: the file switches {} here - sent as {}.',
      'Line {}: the file switches {} here, and it could not be sent ({}) - switch it at the machine.',
      'Line {}: the file switches {} with {}, and no pin is assigned to it - set {}, or switch it at the machine.',
      'Line {}: {} was refused: {}',
      'Line {}: the file switches {}.',
      'Line {}: the file switches its listed outputs here - sent as {}.',
      'Line {}: the file switches its listed outputs here, and {} could not be sent ({}) - switch them at the machine.',
      'Line {}: {} was refused: {}',
      'Line {}: {}.',
      '{} ({}) started.',
      'A program is running - MDI is locked out.',
      'Motion waits {} ms for the output on-delay the machine definition sets.',
      'The motion held for the output on-delay was not released.',
      'MDI {}: not sent - {} is still running, its last lift included. Nothing was sent or queued; send the line again once it has finished.',
      'GRBL settings read: {} rows; this machine has no stored copy yet.',
      'GRBL settings read: {} rows; the stored copy agrees.',
      'GRBL settings read: {} rows; {} stored setting{} differ. Nothing was sent.',
      '${} differs - controller {}, stored {}.',
      'GRBL setting ${} was not applied: {}',
      '{} rotation not changed - {}',
      '{} rotation cleared.',
      '{} rotation: {} It may have changed; the controller\'s next report shows it.',
      '{} rotation not changed - {}',
      'This bridge did not check its cached settings against the profile (older build) - values on the board may not be the profile\'s.',
      'Bridge start-up check: cached settings agree with the profile on every key.',
      'Bridge start-up check: {} cached settings differ from the profile - {} kept, {} sent back to the profile\'s value.',
      '--- connected to {}{} at {} ---',
      '{}: {} sent as {} (the work origin the board reported is at {}{}).',
      'Homed - machine coordinates set.',
      'Homed {} - machine coordinates set for those axes.',
      'the controller clamped the {} override to {}% (asked for {}%)',
      'Work zeros could not be restored after the controller reopened: {}',
      'Alarm{}: {}{}',
      '{} finished.',
      'Path check evidence saved as {}.',
      'Home All: refused - {}',
      'Home {}: refused - {}',
      '{}: refused - {}',
      '{}: refused - {}',
      '{}: refused - {}',
      'Cycle Start: refused - {}',
      'Cycle Start: this hold\'s macro is still running - Stop it, or let it finish.',
      'Cycle Start: the M6 tool change is waiting for the cutter to be fitted and Continue to run the fixed-pad probe.',
      'Single block step: refused - {}',
      'Gantry skew {} sent to the bridge - it is applied once, after the next homing cycle, to the slaved axis.',
      'Gantry skew was NOT sent - {}. Homing will square the gantry exactly as it does today and nothing will be compensated.',
      'Gantry skew could not be sent: {}',
      'Machine datum remains revoked after reconnect - home again in LienCAM before moving.',
      'Gantry skew could not be sent: {}',
      'GRBL settings could not be read: {}',
      'Work zero restored from this computer{}: {} {} - not re-established on this machine this session.',
      'Work zero was not restored: {} - {}.',
      'Work zero restore skipped - an offset write is already waiting for the bridge to confirm.',
      'Work zero was not restored: {} - {}.',
      '{} and this software has no stored zero for {} - set or zero the axis before cutting.',
      '{} on the bridge was {}; sending this software\'s {}.',
      'Work zero adopted from profile: {} {}.',
      'Work zero taken from the bridge: {} {}.',
      'Work zero agrees: {} {}.',
      'Control switched to {} of {} - same machine and controller, so the connection and the loaded program stay.',
      '{} uses the same controller on the same port, so the connection and the loaded program stay. Control keeps {}\'s settings until you disconnect; {} takes over at the next connect.',
      'Machine switch to {} did not complete: disconnect failed - {}. Control remains on {}; connection is {}.',
      'Control stays on {} until you disconnect - the CAM setup moved to {}.',
      'M6 on line {} is answered. The file\'s M0/M1 on that line now holds; press CYCLE START to run the rest.',
      'Surface mesh applied to {}: {} x {} points measured.',
      'Load of "{}" waits for the MDI line to finish.',
      'The MDI line finished; loading "{}".',
      '"{}": the tool change on line {} (T{}) measures the new tool against a reference tool, and none is measured yet. Measure a reference tool on the setter first (Tools / Probe panel).',
      'Cycle Start: no reference tool is measured yet for the tool change on line {} (T{}) - measure a reference tool on the setter before the program reaches it (see the load line).',
      'Reference tool measured - the tool change on line {} (T{}) will measure against it.',
      '"{}" was not loaded: {}',
      '"{}" is loaded and waits for {} ({}). Setting {} reads it against that work zero; nothing else is needed.',
      '{}: the paused program did not come to a clean stop, so nothing was sent - check the machine.',
      'The program is stopped, but the controller did not say which line it was on, so CYCLE START runs it from the start.',
      'Stopped at line {} so you can move; {}',
      'Cycle Start: the M6 tool change is waiting for the cutter to be fitted and Continue to run the fixed-pad probe.',
      'Cycle Start: the machine is still moving - press CYCLE START again once it reads Idle. Nothing moved.',
      'Line {} is the start of the program, so CYCLE START runs it from the start.',
      'Cycle Start: the stop at line {} cannot be resumed - {} Nothing moved.',
      'Line {} is not one plain move, so CYCLE START runs it again from its start.',
      'Cycle Start: {} Nothing moved.',
      'Cycle Start answered the tool change: {}. Once the machine reads Idle, {}',
      'The machine would not set work zero for {}.{}',
      'The machine did not confirm work zero - {}.',
      'Work zero was set on the machine for {}, but this bridge version does not report the resulting offset, so this computer will not remember it - update the bridge.',
      'Goto work XY zero: refused - {}',
      'Goto work XY zero: refused - {}',
      'Goto work XY zero: refused - {}',
      'Cycle Start: refused - {}',
      'Cycle Start: refused - {}',
      'A program is running - MDI is locked out.',
      'Spindle: refused - {}',
      'M{}: {} was refused: {}',
      '{}: no contact - ended at {}.',
      'Measure tool: the controller did not take the guarded approach ({}); the fast probe searches down from {} instead.',
      'Surface mesh measured: {} x {} points. Confirm applies it to {}.',
      '{} probe: this controller has no G38.3 probe move that stops on contact, so it probes from the height where the probe stands now - {}no descent.',
      'Probe routine: refused - {}',
      '{}: {} - this controller has no G38.3 probe move that stops on contact, so it does not descend; the routine carries on from the height where the probe stands.',
      '{}: touched at {}, above its target {} - backing off {} and carrying on.',
      '{}: {} - this controller has no G38.3 probe move that stops on contact, so it does not make this move; the routine carries on from where the probe stands.',
      '{}: touched at {}, before its target {} - backing off {} along its path and carrying on.',
      'Measure tool: nothing was recorded. {}',
      'Park "{}": already there (machine coordinates) - nothing to move.',
      'Park "{}": {} (machine coordinates).',
      '{} was not measured; {}. Retry measure is on the tool-change card.',
      'Retry measure did not run: {}',
      'T{} is fitted and measured. {}',
      'T{} is fitted and measured; its length offset is applied.',
    ],
  },

  // Landed on main after the residual list above was taken (2026-10-10..13),
  // grouped by the order that added them. Same standing: may stay, catalog
  // move owed by a later i18n order.

  // WO-2725: shared Open window (project picker, recents, previews).
  {
    file: 'src/components/modals/DemoExamplePickerModal.tsx',
    reason: WO2725,
    texts: [
      'Open a project',
      'Close project picker',
      'Project sections',
      'Recent',
      'Examples',
      'Browse...',
      'Recent projects',
      'Loading recent projects...',
      'Your projects will appear here after you open or save them. Browse for a file, or explore an example below.',
      'File moved or missing',
      'Last opened {}',
      'Remove {} from list',
      'Remove from list',
      'Examples',
      'Hide examples',
      'Show examples',
      'Real projects to explore, using the sample hobby router. Start with Full Suite for a tour of LienCAM.',
      'Always go straight to the file browser',
      'Close',
      'No preview yet',
    ],
  },
  {
    file: 'src/components/modals/HelpCenterModal.tsx',
    reason: WO2725,
    texts: [
      'Open an example project',
      'Open an example project',
    ],
  },
  {
    file: 'src/components/modals/SettingsModal.tsx',
    reason: WO2725,
    texts: [
      'Opening projects',
      'Always go straight to the file browser',
    ],
  },
  {
    file: 'src/lib/projectOpen/actions.ts',
    reason: WO2725,
    texts: [
      'Project opened, but its recent entry could not be saved.',
    ],
  },
  {
    file: 'src/store/index.ts',
    reason: WO2725,
    texts: [
      'Project saved, but its recent entry could not be saved.',
    ],
  },

  // Already in the tree, first seen when the guard learned to read template
  // substitutions, one-word console lines and lowercase summaries (audit NOTES).
  {
    file: 'src/components/machine/definition/DriveSignalsSection.tsx',
    reason: SCANNER,
    texts: ['on', 'off'],
  },
  {
    file: 'src/components/machine/definition/MachineArea.tsx',
    reason: SCANNER,
    texts: ['none'],
  },
  {
    file: 'src/components/machine/definition/MotionSection.tsx',
    reason: SCANNER,
    texts: ['none'],
  },
  {
    file: 'src/components/machine/MacroPanel.tsx',
    reason: SCANNER,
    texts: ['holding', 'running'],
  },
  {
    file: 'src/lib/machine/machineSession.ts',
    reason: SCANNER,
    texts: [
      'Nothing on this line was sent.',
      'did not report it',
      'the controller did not answer.',
      'the controller did not say why.',
      'Machine position may be lost - home again before moving.',
      'No re-home needed - the position readout shows where the machine is now.',
      'Program',
      'the receipt failed',
      'the typed tool change stays open',
      'the program stays at the M6 on line {}',
    ],
  },

  // WO-2724: About button on the top toolbar.
  {
    file: 'src/components/toolbar/TopToolbar.tsx',
    reason: WO2724,
    texts: [
      'About LienCAM',
      'About',
    ],
  },

  // WO-2849: alpha.2 orders' text found by public CI at the freeze.
  {
    file: 'src/components/model3d/dialogs/MoveHoleEntry.tsx',
    reason: ALPHA2,
    texts: ['Delta {}'],
  },
  {
    file: 'src/components/model3d/workbench/useStlToolSession.ts',
    reason: ALPHA2,
    texts: ['Type the new chamfer distance.'],
  },
  {
    file: 'src/lib/diagnostics/index.ts',
    reason: ALPHA2,
    texts: ['Previous session ended unexpectedly. Help > Report a problem can save available details.'],
  },
  {
    file: 'src/lib/machine/machineSession.ts',
    reason: ALPHA2,
    texts: [
      'Rapid {}%: the board kept the loaded program at {}% - {}',
      'Rapid {}%: every G0 not yet sent to the board {}; cutting moves keep their feed.{}',
      '{}: the Park + clamp card continues this program - screw down the material, then press Continue on the card.',
      'Run from line {}: moving to "{}" for the T{} change. Fit T{}; Continue measures it and arms line {}.',
    ],
  },
]
