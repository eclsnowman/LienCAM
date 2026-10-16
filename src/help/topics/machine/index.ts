import { localizeHelpTopics } from '../catalog'
import type { HelpTopic } from '../../types'

export const topics: HelpTopic[] = localizeHelpTopics([
  {
    id: 'control-tab-overview',
    title: 'The Control tab',
    category: 'machine',
    summary: 'Control turns the app into a machine sender: the toolpath preview stays the biggest element, surrounded by connection, jog, program, and safety panels.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The Control tab drives your machine through a USB serial connection to a GRBL-family board, the native UCCNC bridge for a UC100 or AXBB-E controller, or the LinuxCNC gateway. The center shows the program preview and listing. The highlighted line and current move follow the move the controller is executing, rather than the last line it accepted. The progress count and section header follow that same move and stay at the stopped program position during a kept pause, commands in that pause, and the return.',
      },
      {
        kind: 'steps',
        steps: [
          'Connect to the machine at the top (see "Connecting to the machine").',
          'Load a program: post the selected setup straight into the sender, or open a G-code file from disk.',
          'The safety bar is always visible: E-STOP, Feed Hold (decelerate to a controlled stop), CYCLE START (start or resume), and Stop/Reset (end the cycle). CYCLE START, Feed Hold and Stop/Reset fit side by side at the default panel width. Follow the status sentence for the next action; a tool-change card has its own Continue button. That card appears where the program has an M6. A GRBL post has no M6 - it writes the change as a comment and an M0 - so no card appears: the program holds, the status sentence names the tool to fit, and CYCLE START resumes it.',
        ],
      },
      {
        kind: 'warning',
        text: 'The E-STOP button in the app depends on a working controller link. Keep your physical E-stop in reach.',
      },
      {
        kind: 'paragraph',
        text: 'Program moves are color coded by default: rapid, feed, arc, tool-change and M-code rows use distinct colors, and comments are dimmed. Settings > Theme > Color code program moves turns move colors off or on. Colors describe the listing only; they do not change G-code or establish that a move is safe.',
      },
      { kind: 'image', slot: 'control-overview' },
    ],
    images: [
      {
        slot: 'control-overview',
        file: 'control-overview.webp',
        alt: 'The Control tab with the program preview centered and panels around it',
        captureNotes: 'Control tab with a posted program loaded: preview dominant in the center, DRO showing coordinates, safety bar visible, several panels expanded.',
        status: 'done',
      },
    ],
    keywords: 'control tab sender machine grbl uccnc uc100 bridge panels preview dro safety estop feed hold cycle start layout',
    contextKeys: ['workspace:control'],
    relatedTopicIds: ['control-connect', 'control-run-job', 'machine-library'],
    sinceVersion: '0.35.0',
  },
  {
    id: 'control-connect',
    title: 'Connecting to the machine',
    category: 'machine',
    summary: 'The sender connects over Web Serial for a GRBL-family board, through the local UCCNC/UC100 bridge, or to LinuxCNC through its gateway: pick the port, keep the default baud unless your controller differs, and watch the status readout.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Choose the connection for your controller, then click Connect. For GRBL, pick the serial port from the browser prompt; permitted ports are remembered. UCCNC uses its local bridge, and LinuxCNC uses its gateway instead of a serial port.',
          'For a serial GRBL-family controller the Baud rate defaults to the standard GRBL speed - change it only if your controller is configured differently.',
          'Watch the status readout: Idle means ready, Alarm means the controller is locked (fresh power-up or a limit hit), Hold means a feed hold is active.',
          'From an Alarm state: press Home All if your machine has home switches, or press Unlock to clear the alarm lock after confirming the position is safe. (On GRBL these are $H and $X.)',
          'Right after you connect, the E-STOP button reads CLEAR and the status says "The software stop is latched. Press CLEAR to reset it." This is normal on every connect: nothing has confirmed the stop since the link opened, so jog, macros and CYCLE START wait. Press CLEAR. It asks the controller for its state; once the controller reports it is stopped, CLEAR returns it to idle, releases the stop, and the button reads E-STOP again. CLEAR moves nothing. If it is refused, the line under it says why - for example, the physical E-stop is still pressed.',
        ],
      },
      {
        kind: 'tip',
        text: 'Running LinuxCNC? It connects through its own gateway program, not a serial port - see "Connecting to LinuxCNC".',
      },
      {
        kind: 'tip',
        text: 'Web Serial needs a Chromium-based browser. If Connect is unavailable, the browser itself is the limitation - the app will say so rather than fail silently.',
      },
      { kind: 'image', slot: 'connect-flow' },
    ],
    images: [
      {
        slot: 'connect-flow',
        file: 'connect-flow.webp',
        alt: 'The connection controls with port, baud rate, and machine status',
        captureNotes: 'Top of the Control tab: Connect control, baud field, and the status readout visible; connected state preferred, otherwise the ready-to-connect state.',
        status: 'done',
      },
    ],
    keywords: 'connect serial port usb baud grbl uccnc linuxcnc gateway uc100 bridge status idle alarm hold homing h x unlock web serial browser clear software stop latched e-stop estop first connect',
    contextKeys: ['workspace:control'],
    relatedTopicIds: ['control-tab-overview', 'control-jog-zero', 'connect-linuxcnc'],
    sinceVersion: '0.35.0',
  },
  {
    id: 'moving-to-a-new-pc',
    title: 'Moving LienCAM to a new or rebuilt PC',
    category: 'machine',
    summary: "Install LienCAM and UCCNC, copy your UCCNC profile, then use Settings > User Data > Inspect backup... > Confirm restore: your shop data and this machine's connection settings come back from the backup, with no file to hand-edit. Two things a backup cannot carry are listed here, with why.",
    sections: [
      {
        kind: 'paragraph',
        text: 'Everything LienCAM keeps travels in one backup file: your active project, machines, tool libraries, preferences, and this computer\'s machine connection settings - the UCCNC install folder, profile, board, spindle definition file and Bridge port. Nothing needs hand-editing: no .bat file and no environment variable. Make the backup on the old PC first with Settings > User Data > Download backup (see "Backing up your data"), and keep it on another drive.',
      },
      {
        kind: 'steps',
        steps: [
          'On the new PC, run the LienCAM installer. It adds LienCAM to the desktop and the Start menu; always open LienCAM from one of those.',
          'Install UCCNC 1.2115 with its own installer. That puts the controller\'s driver files where LienCAM\'s machine connection finds them.',
          'Copy your UCCNC profile (.pro file) from the old PC\'s UCCNC Profiles folder, for example C:\\UCCNC12115\\Profiles, into the same folder on the new PC.',
          'Open LienCAM and go to Settings > User Data. Click Inspect backup... and pick your backup file, check the list of changes, then click Confirm restore. LienCAM reloads with your data and your machine connection settings.',
          'On the Control tab, click Connect. The first time, LienCAM builds its machine connection from the UCCNC files on this PC, which takes a few seconds.',
          'If UCCNC or your profile is in a different folder than on the old PC, open Machine > Definition > Controller and choose the Install folder or Profile there, then connect again.',
        ],
      },
      { kind: 'heading', text: 'What a backup cannot carry, and why', anchor: 'cannot-carry' },
      {
        kind: 'paragraph',
        text: 'UCCNC itself, its controller driver files, and its .pro profile. They are another company\'s licensed software, put in place by its own installer in its own folder; LienCAM uses them but cannot install them. The backup remembers which folder, profile and board you chose, but it does not keep a copy of the .pro file, so copy that yourself. If the old .pro is lost, select the restored machine in the Machine Library and click Export .pro to write it as a UCCNC profile.',
      },
      {
        kind: 'paragraph',
        text: 'An antivirus exclusion. A Windows Security (Defender) exclusion is an administrator setting of Windows itself, and no app can grant itself one. If Windows Security removes LienCAM\'s machine connection - the Machine page then says its executable is missing - add a folder exclusion for %APPDATA%\\LienCAM\\machine-bridge in Windows Security > Virus & threat protection > Manage settings > Add or remove exclusions > Add an exclusion > Folder, then click Connect again.',
      },
      {
        kind: 'tip',
        text: 'A shortcut or .bat file of your own that sets LIENCAM_BRIDGE_EXECUTABLE or LIENCAM_BRIDGE_ARGS_JSON is a developer override: it replaces the connection settings saved on the Machine page. Remove it and open LienCAM from the shortcut its installer made.',
      },
    ],
    images: [],
    keywords: 'new pc rebuilt reinstall move migrate computer failure disaster backup restore bundle uccnc install profile pro driver dll defender antivirus exclusion shortcut bat environment variable bridge port board install folder',
    contextKeys: ['workspace:control', 'modal:settings'],
    relatedTopicIds: ['settings-user-data', 'control-connect', 'machine-library'],
    sinceVersion: '0.35.0',
  },
  {
    id: 'connect-linuxcnc',
    title: 'Connecting to LinuxCNC',
    category: 'machine',
    summary: 'Run the small LienCAM gateway on the LinuxCNC PC, type that PC\'s address on Machine > Definition > Controller, then Connect - on the same PC or across your network.',
    sections: [
      {
        kind: 'paragraph',
        text: 'LienCAM does not talk to LinuxCNC directly. A small program called the gateway runs on the LinuxCNC PC and passes messages between the two. Your LinuxCNC setup (INI and HAL files) stays exactly as it is, and LinuxCNC keeps running with its own screen (Axis, gmoccapy and so on).',
      },
      { kind: 'heading', text: '1. On the LinuxCNC PC', anchor: 'linuxcnc-pc' },
      {
        kind: 'steps',
        steps: [
          'Get the gateway: gateway.py, from the LienCAM release download (or from pendant/linuxcnc-gateway in the repository). Copy it to the LinuxCNC PC.',
          'It needs nothing else installed. It uses only Python 3.9 or newer (the python3 that ships with LinuxCNC) and LinuxCNC\'s own Python module.',
        ],
      },
      { kind: 'heading', text: '2. Start LinuxCNC, then the gateway', anchor: 'linuxcnc-start' },
      {
        kind: 'steps',
        steps: [
          'Start LinuxCNC first. The gateway needs it running.',
          'LienCAM on the same PC: open a terminal and run  python3 gateway.py',
          'LienCAM on another PC: run  python3 gateway.py --host 0.0.0.0  so the gateway accepts connections from your network.',
          'The gateway listens on port 8327. Use --port to change it, and --program-dir to choose where it writes programs (the default is ~/liencam-programs).',
          'It prints one line when it is listening. Leave that terminal open.',
          'On a network: both PCs must be on the same network, and port 8327 must be open in the LinuxCNC PC\'s firewall if it has one. Note the LinuxCNC PC\'s address - you type it into LienCAM next.',
        ],
      },
      {
        kind: 'tip',
        text: 'Optional: to start the gateway at login, add a desktop autostart entry on the LinuxCNC PC (for example a file in ~/.config/autostart that runs python3 /path/to/gateway.py --host 0.0.0.0). Start LinuxCNC before it needs to answer.',
      },
      { kind: 'heading', text: '3. In LienCAM', anchor: 'linuxcnc-in-liencam' },
      {
        kind: 'paragraph',
        text: 'Use the LienCAM desktop app, or LienCAM opened on the LinuxCNC PC itself. The hosted browser demo cannot reach the gateway: it is an https page, the gateway is a plain ws:// connection, and the gateway refuses web pages from other addresses.',
      },
      {
        kind: 'steps',
        steps: [
          'Pick or add your machine in the Machine Library and set its Controller to LinuxCNC. (On the Control tab, Machine > Definition has the same Controller choice in its top bar.)',
          'On Control > Machine > Definition, open the Controller tab. In "LinuxCNC PC address" type the LinuxCNC PC\'s address as host or host:port (for example 192.0.2.10 or 192.0.2.10:8327). Leave it blank when LinuxCNC is on this PC.',
          'Go to Control > Main, choose "LinuxCNC gateway" as the connection, and click Connect.',
          'When it is connected, the Controller area stops saying "Not connected to LinuxCNC" and shows what LinuxCNC reported: its version, the INI file, the joints, the spindle and whether the link is read-only. Those come from LinuxCNC itself - LienCAM stores nothing to show instead.',
        ],
      },
      { kind: 'heading', text: '4. What is different from UCCNC and GRBL', anchor: 'linuxcnc-different' },
      {
        kind: 'steps',
        steps: [
          'LinuxCNC owns the spindle, homing and tool changes. A tool change is LinuxCNC\'s own M6.',
          'At a program tool change, LienCAM shows the tool-change card when LinuxCNC reports the stop. Follow the card to fit the requested tool and continue; Stop program ends the program.',
          'Probing runs through LinuxCNC\'s G38 probe move.',
          'If a network session goes silent (a pulled cable, a sleeping PC), the gateway drops it and the program stops.',
        ],
      },
      { kind: 'heading', text: '5. What has been tested', anchor: 'linuxcnc-tested' },
      {
        kind: 'warning',
        text: 'What has been tested on real hardware. I\'ve tested LienCAM on my own router, which runs UCCNC with an AXBB-E controller. I don\'t own a GRBL, grblHAL or LinuxCNC machine, so those routes have only been tested against simulators (grbl-sim and the LinuxCNC simulator), not on real hardware yet. If you run one of those machines, your test reports are exactly what we need - and once people have confirmed them on real machines, this note comes off.',
      },
    ],
    images: [],
    keywords: 'linuxcnc gateway network connect python3 gateway.py host 0.0.0.0 port 8327 firewall address another pc axis gmoccapy ini hal link watch probe g38 tool change m6 simulator hardware tested',
    contextKeys: ['workspace:control'],
    relatedTopicIds: ['control-connect', 'control-tab-overview', 'control-run-job'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'control-jog-zero',
    title: 'Jogging and setting zero',
    category: 'machine',
    summary: 'The Jog panel moves the machine in steps or continuously, and the Work offsets panel sets X0/Y0/Z0 - by button, or through the probe pad for Z.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Jog with the axis cluster: pick a step size, then click the direction buttons. The DRO shows both work and machine coordinates live.',
          'Home All homes the machine; the individual axis home buttons request that axis when the controller supports it. A controller that only offers a whole-machine homing cycle says so. The Console reports the homing result.',
          'Position the tool over your work zero and use the Zero buttons in the Work offsets panel to set X0, Y0, or Z0 for the active work coordinate system.',
          '"Goto XY0" moves the tool over work X0 Y0 without moving Z.',
          'For Z with a touch pad: pick "A plate held against it" beside Probe work Z0, jog the tool over the pad, then run the probe - it probes down and sets work Z0 through the pad thickness. With "The probe touches the part" it sets work Z0 at the contact.',
        ],
      },
      {
        kind: 'warning',
        text: 'Park moves first raise Z to a machine-coordinate height you set yourself. Where Z zero sits differs per machine, so there is no safe default - park refuses to run until you have set that height.',
      },
      {
        kind: 'paragraph',
        text: 'Home starts the homing cycle, including when an axis is already on its home switch. Follow the connected controller status; there is no preliminary instruction to jog off the switch.',
      },
      {
        kind: 'paragraph',
        text: 'Control\'s Offsets tab shows the quick work offsets beside the Work offset setup table. The table keeps, for this machine, a fixture name and X, Y and Z for each of G54 to G59. A value typed there is stored with an amber border (not sent yet) - it reaches the controller only when you press Push on its row. Push changed (N) sends every row whose stored values differ from the controller; N is how many rows that is. Set from position makes the machine\'s current position that row\'s zero and sends it. Rotation is held in the controller and is sent as you type it. Push and Set from position wait while a program runs or is held, and until the machine is idle.',
      },
      { kind: 'image', slot: 'jog-zero' },
      { kind: 'image', slot: 'offsets-typed' },
    ],
    images: [
      {
        "slot": "offsets-typed",
        "file": "offsets-typed.webp",
        "alt": "Offsets tab: G55 is named Vise jaw and X 120.50 is typed but not sent; Push changed (1) shows one changed row.",
        "captureNotes": "Offsets tab: G55 is named Vise jaw and X 120.50 is typed but not sent; Push changed (1) shows one changed row. WO-2714; architect-accepted production candidate.",
        "status": "done"
      },
      {
        slot: 'jog-zero',
        file: 'jog-zero.webp',
        alt: 'The jog cluster and work offset zero buttons with the position readout',
        captureNotes: 'Jog panel with step sizes and axis buttons plus the Work offsets panel with Zero buttons, DRO visible in frame.',
        status: 'done',
      },
    ],
    keywords: 'jog step continuous zero x0 y0 z0 work offset probe pad touch plate park position dro machine coordinates offsets tab push changed set from position fixture name rotation g54 g59 not sent',
    contextKeys: ['workspace:control'],
    relatedTopicIds: ['control-connect', 'control-run-job', 'work-offsets'],
    sinceVersion: '0.35.0',
  },
  {
    id: 'control-run-job',
    title: 'Running a job',
    category: 'machine',
    summary: 'Post a setup straight into the sender or load a file, trace the job outline first if you want, then run with hold, resume, and live overrides.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'In the Program panel, post the selected setup (the active machine\'s controller dialect) directly into the sender, or load a G-code file from disk. Recent programs are kept in the browser.',
          'Before cutting, the material-fit trace outlines the job at safe Z so you can confirm the stock and clamps are where the program thinks they are.',
          'Press CYCLE START to run. Feed Hold decelerates to a controlled stop; CYCLE START resumes. The Overrides panel adjusts feed, rapid, and spindle speed live.',
          'To start at a chosen file line, enter its number in From line and press Plan. This also works for a setup posted to UCCNC. Review the tool, resume position, preparation moves and cautions. The plan tells you to press CYCLE START to run from the chosen line, or Cancel to go back. Plan arms the run without moving the machine; line 1 arms it from the top. Cancel restores the whole program.',
          'Every M0 in a file holds, including one beside or after a tool change or before a macro. CYCLE START releases the M0; an M6 tool-change card is a separate stop. While held at an M0, MDI stays locked until the hold ends or you press Stop/Reset. A GRBL post has no M6: it writes a tool change as a "( change tool to T2 )" comment and an M0. Held there, the status reads "Held for a tool change - fit T2, then press CYCLE START."',
          'At a program tool-change card, follow the instructions and press Continue. If LienCAM cannot switch the spindle, the same card tells you to start it by hand, including on a run from a line. Stop program ends the program; a manual tool change outside a program still has Cancel.',
          'Stop/Reset at an M0 or a program tool-change hold ends the program. CYCLE START then starts from the top; From line and Plan let you choose another starting line. After a completed run, CYCLE START arms the loaded program from line 1 and runs it again. The Console reports the program finished once per run.',
          'The top-right chip reads amber Held at an M0, during controller Feed Hold, and while waiting at a stationary tool-change card. Feed Hold pressed between program parts is a separate case: that chip indication is not yet updated.',
          'A plain MDI move or a probing routine is not a program. Its status names the move or routine, without a Cycle complete program message. An MDI move leaves a loaded program header in place; with no loaded program it creates no program header or progress bar.',
          'The listing numbers are the original file line numbers. A loaded file shows every source line exactly as written, including comments and output words such as M7 and M9. At an M0 hold, the highlight sits on the M0 line. A stop-only section adds no motion row or move count, and a kept pause does not show a program-end row. A plain file header leads with the file name; a posted setup program names its sections. Earlier section-start announcements remain in the Console.',
          'When a kept pause lets you jog or send MDI, the header and progress keep the stopped program position. The status names the command running in the pause, then the return to the stopped line. A typed T number selects the tool for a later bare M6; a typed M6 opens the guided tool-change card, even with no loaded program. On the built-in simulator, typing T19 M6 also runs the guided change.',
          'After a connected MDI command is handed to the controller, the input clears. The Console retains the command and its result.',
          'The Cycle log records every run with its outcome; the Console shows the raw controller conversation.',
        ],
      },
      {
        kind: 'warning',
        text: 'Stop/Reset ends the current run. Use Feed Hold when you intend to resume it; restarting from a line is a new run whose plan you must review.',
      },
      {
        kind: 'paragraph',
        text: 'When the chosen line expects a different tool from the last known spindle tool, or that tool is unknown, a pop-up names both before anything moves. Choose Run the tool change for T<n> first, then start from line <N>, or Start from line <N> now; Cancel sends nothing. Starting part-way through is your call: Start now uses whatever tool is fitted and adds no tool change. Choosing the tool change uses the guided change and then arms the chosen line for CYCLE START. A matching tool needs no pop-up.',
      },
      {
        kind: 'paragraph',
        text: 'Re-arm from start appears in the transport bar when a text file is loaded. It arms the program from line 1, exactly as if you had just opened it: the controller is first brought back to a known idle, and nothing moves until you press CYCLE START. You can use it to prepare a fresh run without starting motion. After a completed run, after resolving a failed run, or whenever the loaded program is not armed, CYCLE START itself arms the program from line 1 and runs it; the Console says "Armed from line 1." You do not need to press Re-arm first. From line and Plan preserve your chosen starting line instead. Re-arm is greyed while the program runs or is held (press Feed Hold, then Stop/Reset first) and during an alarm; the reason shows under it. A setup posted from the project or a file the controller takes as moves has no Re-arm button: CYCLE START also arms that loaded program from line 1 when it can; the status names any problem that needs resolving.',
      },
      {
        kind: 'paragraph',
        text: 'If only a typed MDI move is running, Load waits for that line to finish and the controller to report idle, then loads the replacement without starting it. The Console names the waiting Load. A stop, fault, changed connection or a 30-second wait cancels the request and reports why; another Load replaces the waiting request. A running or held program still needs to be stopped before loading another program.',
      },
      {
        kind: 'paragraph',
        text: 'When Control > Load posts a setup from the open project, the console and tool-change card name the tool that uses each number in that program, including numbers chosen in Post Process. A file opened from disk uses the library lookup for its tool names; the open project\'s per-program choices do not rename that file\'s tools.',
      },
      {
        kind: 'paragraph',
        text: 'A freshly posted setup loaded from the same project reads current, with its Intended stock tied to that project. A refused replacement preserves an accepted program that is still ready or held. After a completed or failed run, a new file refused for a machine-side reason replaces that finished file; the status names the new refusal, and CYCLE START cannot run the old file. The Console prints the refusal reason once; a later CYCLE START or Re-arm attempt reports its own result. After resolving a refused start, reconnecting or clearing E-STOP, CYCLE START can arm the loaded program from line 1. If a connection lost your chosen starting line or kept stop, choose the line again, load or Re-arm before starting.',
      },
      {
        kind: 'paragraph',
        text: 'Est. remaining is a time estimate, not a count of moves. While held at an M0, a tool change or Feed Hold, it uses the time to execute the moves still left: their lengths at their feeds, the machine rapid rate for rapids, and any remaining dwell. While running, a current post\'s estimate counts down; if it runs out with motion still to come, the moves left decide. Without a current post, the estimate follows the remaining motion. If no estimate can be made, it reads unavailable.',
      },
      {
        kind: 'paragraph',
        text: 'Single Block ON means each CYCLE START or Step runs one line. Single Block OFF means CYCLE START runs the whole program. The short hint under the transport buttons shows the current mode.',
      },
      {
        kind: 'paragraph',
        text: 'After Stop/Reset during a macro or MDI move, Control follows the controller\'s reported state. When the controller is idle, Control returns to Ready/Idle and MDI, jog and macros are available after that one press.',
      },
      {
        kind: 'paragraph',
        text: 'Type a feed or spindle override percentage and press Enter to request that value. UCCNC sends the exact percentage in one command; GRBL uses its reset and steps. Quick feed override clicks that reach their requested values print no clamp warning; a confirmed different value still gets a clamp message.',
      },
      {
        kind: 'paragraph',
        text: 'The Vacuum button lights from the controller\'s reported output state, whether a button, MDI, a program or a macro switched it. It goes dark when the reported output is off. A program output line in the Console names the configured output and its M word, for example "Line 5: Vacuum on (M7, port 3 pin 16)."',
      },
      {
        kind: 'paragraph',
        text: 'In Edit macros, Drives output is optional and starts at none. Choose an output from the machine definition and Save to keep the choice with the macro. A macro button assigned to an output lights when the connected controller reports that output on, including changes made outside the macro. It is unlit when readback is off or unavailable; an unlit button alone does not prove the physical output is off. Choosing an output does not add commands to the macro.',
      },
      {
        kind: 'paragraph',
        text: 'The Control 3D view keeps your zoom and pan through MDI moves, work offset changes (including probing Confirm) and WCS changes. Load re-fits the program, even for the same file; Fit trace and the view buttons still fit on demand. Before you adjust the view, automatic framing continues.',
      },
      {
        kind: 'paragraph',
        text: 'The built-in simulator can load and run a plain X/Y/Z file on the shipped sample GRBL router. Its path check uses a nonzero tolerance and follows the commanded path, including the approach to the first move. A genuinely unavailable axis is still reported.',
      },
      {
        kind: 'paragraph',
        text: 'For posts that support canned drilling, including UCCNC and LinuxCNC, the built-in simulator runs G81, G82 dwell and G83 peck cycles, modal X/Y hole repeats and G80 cancel. G98 retracts to the initial Z for that hole; G99 retracts to the R plane. The position, progress and path check follow the expanded moves. Incremental G91 or rotary canned cycles are not modelled. The simulator follows the program\'s G54-G59 changes, and Path check names the program\'s work offset, for example G56, even if you had selected G54 before the run.',
      },
      {
        kind: 'paragraph',
        text: 'At the end of a run, Path check reports matched positions within the threshold as stayed on the commanded path. A brief jump over the threshold gets a warning with its size, position and duration; a sustained departure gets the red left-the-path message. If too few positions can be matched, the check says it cannot assess the run.',
      },
      {
        kind: 'paragraph',
        text: 'If an axis has no stated travel limits, the load note says travel was not checked. Enter both limits on the Definition page to check it. If the simulator refuses a program outside declared travel and its work zero is unset, the message names that work offset (for example G57). Set its zero on the Offsets tab, then press CYCLE START.',
      },
      {
        kind: 'paragraph',
        text: 'To change the loaded program, right-click a line in the program listing. Run from here plans a start at that line - the same plan the From line box makes. Insert line opens a field under the line; what you type is staged and marked in the listing, and nothing reaches the machine until you press Apply (Discard drops it). Find / Replace and Go to line open the editor over the preview at that line, with Ctrl+F, Ctrl+H, Ctrl+G, Ctrl+Z and Ctrl+Y. Apply loads the edited text exactly as opening a file does: the listing, 3D view, tool list, run-from-line and tool-change stops all follow it, and the console says what changed. Save to file writes the edited program to disk. While a program runs or is held at a stop or tool change, the editor is read-only - press Stop/Reset first.',
      },
      { kind: 'image', slot: 'run-job' },
      { kind: 'image', slot: 'm6-tool-change' },
      {
        kind: 'paragraph',
        text: 'On UCCNC, Rapid % sends each G0 at that percentage of the machine rapid rate; G1, G2 and G3 keep their programmed cutting feeds. Feed % still applies on top. A change during a run affects moves not yet sent to the board; moves already sent keep their sent speed. Changing Rapid % before starting re-stages the loaded program, and a refused re-stage leaves the displayed percentage at the value accepted before it.',
      },
      {
        kind: 'paragraph',
        text: 'If Load refuses a file for a machine-side reason with no active accepted program, the file stays available, including after MDI or after the previous program finished. Fix the named cause, then press CYCLE START: it runs the full Load checks again and arms that file from line 1 only if they pass. MDI used to fix the cause does not discard the file. This also applies when Load waited for a moving MDI line to finish.',
      },
      {
        kind: 'paragraph',
        text: 'Continue is the action on both the guided tool-change card and the Park + clamp card. At the clamp card CYCLE START is disabled and its hint names Continue; follow the card and press Continue to proceed.',
      },
      {
        kind: 'paragraph',
        text: 'The shipped sample router on the built-in simulator reports its default work zero for that connection, so Load checks the program against declared travel using that zero. A move outside travel is still refused; stored work offsets and other machines keep their own zeros.',
      },
    ],
    images: [
      {
        "slot": "m6-tool-change",
        "file": "m6-tool-change.webp",
        "alt": "The simulator is held at M6: insert T3, then press CYCLE START. The yellow setup and stock chips show a mismatch with the open project, not a normal setup state.",
        "captureNotes": "The simulator is held at M6: insert T3, then press CYCLE START. The yellow setup and stock chips show a mismatch with the open project, not a normal setup state. WO-2714; architect-accepted production candidate.",
        "status": "done"
      },
      {
        slot: 'run-job',
        file: 'run-job.webp',
        alt: 'A job running: program progress, preview with live position, overrides at hand',
        captureNotes: 'Control tab mid-job or ready-to-run: program loaded with progress/line list, preview showing the path, override sliders visible.',
        status: 'done',
      },
    ],
    keywords: 'run job send program post setup gcode file cycle start feed hold resume override feed spindle mid-program start line fit trace outline cycle log console edit program insert line m0 pause apply discard find replace run from here right-click single block stop reset est remaining time refused load canned drilling g81 g82 g83 g98 g99 vacuum output readback path check brief jump travel unset work zero zoom pan re-arm from start rearm line 1 tool change change tool grbl fit tool',
    contextKeys: ['workspace:control'],
    relatedTopicIds: ['control-tab-overview', 'post-basics', 'control-jog-zero'],
    sinceVersion: '0.35.0',
  },
  {
    id: 'machine-choice',
    title: 'The machine prompt when opening a project',
    category: 'machine',
    summary: 'A project saved with a machine this installation does not have asks you to choose - the app never switches your machine silently.',
    sections: [
      {
        kind: 'paragraph',
        text: 'When a project has no machine, uses the sample placeholder, or references a machine that is not in your library, the prompt lists your available machines. Your Default machine is first and already selected; choose another if needed, then press Use this machine. No machine-change announcement is made before you confirm. A project using a known library machine keeps it without this prompt. On a fresh install with only the sample machine, there is no choice to make and no prompt. Feeds, travel limits and the posting dialect follow the chosen machine.',
      },
      { kind: 'image', slot: 'machine-prompt' },
    ],
    images: [
      {
        slot: 'machine-prompt',
        file: 'machine-prompt.webp',
        alt: 'The machine choice prompt shown when opening a project with an unknown machine',
        captureNotes: 'MachineChoiceModal open on project load: the project machine and library options both visible.',
        status: 'done',
      },
    ],
    keywords: 'machine prompt choice load open project unknown default first selected library dialect no silent switch',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['machine-library', 'post-basics'],
    sinceVersion: '0.35.0',
  },
  {
    id: 'machine-definition-catalog',
    title: 'The Machine definition page',
    category: 'machine',
    summary: 'Control > Machine > Machine definition holds the wiring, homing and controller-specific settings a homebuilt machine needs - grouped into catalog sections you can filter down to only what you use.',
    sections: [
      {
        kind: 'paragraph',
        text: 'This page is the CONTROL half of a machine record - pin assignments, steps per unit, homing direction and speeds, backlash, and every setting your controller catalogues - separate from the CAM half (travel, spindle, feed caps) edited in the Machine Library modal. Both write the same machine record, so nothing here disturbs the other.',
      },
      {
        kind: 'paragraph',
        text: 'The All settings section lists every setting the machine carries. Its Show list (Everything, Stated by the profile, Changed by me) and the "Only settings LienCAM uses" box narrow the list.',
      },
      {
        kind: 'tip',
        text: 'Named machine hardware (an axis you have wired, a spindle you have configured) has its own controls and is never filtered. The Show list and the box only narrow the All settings table; set Show back to Everything and clear the box to see every setting again.',
      },
      { kind: 'image', slot: 'uccnc-controller' },
    ],
    images: [
      {
        "slot": "uccnc-controller",
        "file": "uccnc-controller.webp",
        "alt": "Machine > Definition > Controller with UCCNC selected and the install folder typed; the controller is not connected.",
        "captureNotes": "Machine > Definition > Controller with UCCNC selected and the install folder typed; the controller is not connected. WO-2714; architect-accepted production candidate.",
        "status": "done"
      },
    ],
    keywords: 'machine definition page catalog group used only show everything hide empty classify wiring homing backlash steps per unit controller settings',
    contextKeys: ['workspace:control'],
    relatedTopicIds: ['machine-library', 'control-tab-overview'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'probing-tab',
    title: 'The Probing tab',
    category: 'machine',
    summary: 'Probing finds edges, corners, bores, bosses, surfaces and tool lengths with a touch probe and shows the plan on a diagram. Z0 writes immediately; Tool Z records its measurement immediately. Review other results before applying them.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The Probing tab is the workpiece probing station. Pick what you are measuring in the Routine panel (Z0, Edge, Outside corner, Inside corner, Angle, Bore, Boss, Rect pocket, Rect boss, Z surface, Tool Z, Calibrate), fill in its setup panel (for example "Outside corner setup": which work offset, the approach side, the rough size), and the picture beside it draws the moves and touches in order before anything moves.',
      },
      { kind: 'image', slot: 'probing-outside-corner' },
      {
        kind: 'paragraph',
        text: 'The Console below the picture is shared with Main. Its compact view shows the latest line; expand it for history and MDI. Switching between Main and Probing keeps the same history and unsent MDI text. The picture gives brief step guidance; open More about this step for the detail.',
      },
      {
        kind: 'paragraph',
        text: 'An early tool-setter touch shows no separate warning. After a successful fine touch, the short result gives the early contact, its difference from the tool-table prediction, the retract and the measured tool length that replaces the table value. An early contact by itself is not a completed measurement; a failed fine touch or retract leaves the previous tool length in place.',
      },
      {
        kind: 'paragraph',
        text: 'On connection, the built-in simulator places a fixed tool setter at the machine record\'s stated X/Y. If the reference tool has a recorded measured contact below the stated setter Z, that contact sets the simulated surface; otherwise the stated Z is used. A downward probe can touch it during Measure tool or a guided tool change, alongside any simulated part or probe pad. A machine with no stated setter gets none. This models the setter in the simulator only; real-controller measurement stays the same.',
      },
      {
        kind: 'steps',
        steps: [
          'Setup panel: define the feature - work offset, axis and side, approximate size, search distance. The picture updates as you type; nothing moves.',
          'Run: jog to the labeled start shown in the picture, read the motion plan and feeds, make sure the path is clear, then press Start probing - it moves straight away, with no further confirmation. An approach toward a face to be touched is itself a probe seek at Search speed, followed by a back-off and a slow touch at Probe speed. Clear-area moves use the Clear positioning setting. A missed seek stops where it is, without an automatic retract.',
          'Result: Z0 writes the active work Z0 during the successful cycle. Tool Z immediately records the measured Setter Z for the active tool, or holds it as the active tool length if no tool number is active. Neither has a separate Confirm. Feature offsets show "Would write G54 ... after confirmation" and use Confirm to apply them. Z surface and Calibrate also use Confirm. Angle reports the measured angle and offers Rotate to apply a nonzero change to the work offset rotation.',
          'While probing runs, Pause stops the current move and becomes Resume. Resume continues toward the same endpoint. Stop ends only probing, from running or paused, and a stopped routine writes no result. Start probing starts it afresh. These buttons preserve a loaded program; probing cannot start while that program is running or held.',
          'When paused with the probing screen\'s Pause, the status line points to that screen\'s Resume and Stop. Other held routines, such as Measure tool, still use CYCLE START and Stop/Reset as their status sentence says.',
          'Save probing settings under Control > Machine > Definition > Probing and the next routine uses them without reconnecting, including Search speed, Probe speed, clearance and search bounds. Settings that must be written to the controller still need its receipt; this change applies to probing values used by LienCAM.',
          'The diagram keeps the probe in its labeled start zone before Start. When the reported probe position is within the pictured feature and its margin, Front and Right show its reported depth; its sideways place stays tied to the plan. Outside that area, or without a known position, the diagram keeps the planned picture.',
          'PROBE shows the touch input; PROBING shows that a probe cycle is in process. The Control, Probing, Tools and tool-change surfaces share the same probe reading. If the controller does not report it, the lamp says so; PROBE is not read while the spindle turns.',
          'A refused probe start keeps the current preview. A failed or stopped probe cycle shows Stopped (and the failed step when known); a refused start shows Did not start. The picture gives a brief reason; expand the Console to read the full diagnostic. A new stop or refused start replaces the previous reason. The message states what happened, without guessing a cause. If a tool-setter measurement fails on a tool-change card, Retry measure repeats the measurement without visiting the park again. The failure names the setter and the touch result; Cancel on a manual tool change reports the cancellation and keeps the recorded spindle tool.',
          'When the reference tool is measured again, the Console reports its reading change and the actual work Z offset change sent to the controller. Those can differ on a controller that stores tool length in the work offset.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Top tells you where a feature routine gets its top reference. Edge, Outside corner and Angle use "Touch it first". Bore, Rect pocket and Inside corner use "Use work Z0": set work Z0 at the stock top before running them. Boss and Rect boss let you choose either, starting with "Touch it first"; set work Z0 first if you choose "Use work Z0". Calibrate touches the top for an outside reference and uses work Z0 for an inside reference.',
      },
      { kind: 'image', slot: 'probing-result-confirm' },
      {
        kind: 'paragraph',
        text: 'The Routines tab on Control (next to Probing) holds the probing sequences as data - factory ones, yours, imported ones - with an editor and a Check that previews a routine on THIS machine before anything runs. See "Probe routines".',
      },
      {
        kind: 'warning',
        text: 'A probe move needs a homed machine and a valid probe setup (feeds, travel limit, tip radius). If the banner at the top says the machine is not ready, the buttons say why and stay disabled.',
      },
      { kind: 'image', slot: 'routine-chooser' },
      { kind: 'image', slot: 'z-surface-setup' },
      { kind: 'image', slot: 'calibrate-plan' },
      {
        kind: 'paragraph',
        text: 'Feature probing on the simulator with a UCCNC machine definition follows the same plan as native UCCNC: approach from above, then step out and down as pictured. A controller that cannot run that plan says what it lacks and moves nothing. Tool Z and custom probe routines on that simulator also include the native route\'s guarded steps. These route corrections are simulator/desk proven; they are not new hardware verification.',
      },
      {
        kind: 'paragraph',
        text: 'The built-in simulator touches the part with the probe tip radius of the tool in the spindle, resolved the same way as the Probing screen. Bore, Boss, Edge and Corner compensation then reads the simulated part size. This changes simulated part contact only; tool-setter contact and real-controller probing keep their existing behavior.',
      },
    ],
    images: [
      {
        "slot": "routine-chooser",
        "file": "routine-chooser.webp",
        "alt": "The twelve Probing routine pictures at their initial setup state. Z surface reads Load a program to derive the mesh grid; this tile has no grid preview yet.",
        "captureNotes": "The twelve Probing routine pictures at their initial setup state. Z surface reads Load a program to derive the mesh grid; this tile has no grid preview yet. WO-2714; architect-accepted production candidate.",
        "status": "done"
      },
      {
        "slot": "z-surface-setup",
        "file": "z-surface-setup.webp",
        "alt": "Z surface setup before probing, with a loaded program, a 3 by 3 grid preview, margin and fade settings; no surface has been measured.",
        "captureNotes": "Z surface setup before probing, with a loaded program, a 3 by 3 grid preview, margin and fade settings; no surface has been measured. WO-2714; architect-accepted production candidate.",
        "status": "done"
      },
      {
        "slot": "calibrate-plan",
        "file": "calibrate-plan.webp",
        "alt": "Calibrate setup with a 25 mm gauge pin and the BEFORE START preview; no calibration result has been measured or applied.",
        "captureNotes": "Calibrate setup with a 25 mm gauge pin and the BEFORE START preview; no calibration result has been measured or applied. WO-2714; architect-accepted production candidate.",
        "status": "done"
      },
      {
        slot: 'probing-outside-corner',
        file: 'probing-outside-corner.webp',
        alt: 'Outside corner front-right setup before Start probing, with the front and top previews, Picture key, brief step guidance and expanded shared Console with history and MDI',
        captureNotes: 'WO-2755 current capture at 1dfa75f9cc426b95b2ebc72b8496553ca7c22ff1, built-in GRBL-dialect simulator only. Outside corner, front-right, BEFORE START, expanded shared Console and MDI; no probing cycle. PNG and six empty error arrays in src/tests/evidence/WO-2755/outside-corner-01/.',
        status: 'done',
      },
      {
        slot: 'probing-result-confirm',
        file: 'probing-result-confirm.webp',
        alt: 'An Outside corner run finished on the simulator: the touches marked in the pictures, the corner position, and Confirm. For Outside corner nothing is written until Confirm is pressed',
        captureNotes: 'Same route as probing-outside-corner, after Start probing: the run finished, result step with Confirm, before Confirm. Route: node tools/capture/wiki-gaps/desktop.mjs --only=G02 (WO-2709).',
        status: 'done',
      },
    ],
    keywords: 'probing probe tab edge corner bore boss rectangle angle z surface tool length touch probe tip radius compensation work offset confirm diagram guided cycle manual touch path clear stopped reason did not start refused',
    contextKeys: ['workspace:control'],
    relatedTopicIds: ['probe-routines', 'control-jog-zero', 'work-offsets'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'probe-routines',
    title: 'Probe routines',
    category: 'machine',
    summary: 'A probe routine is a small data file - inputs, moves, touches, arithmetic and proposals - that LienCAM previews with real machine numbers before anything moves.',
    sections: [
      {
        kind: 'heading',
        text: 'What a routine is',
        anchor: 'what-is',
      },
      {
        kind: 'paragraph',
        text: 'The Routines tab on Control (next to Probing) holds every probing sequence the app knows: the factory ones that ship inside LienCAM, your own, and any you imported from a file. A routine is NOT a program. It is a short description, in a closed vocabulary, of what the user must type in first (inputs), the moves and touches in order (steps), the arithmetic over what was measured (calculations), and what the routine would LIKE to happen with the answer (proposals). LienCAM reads it, places it on your machine, shows you the whole plan with real numbers, and only then - after you have looked and ticked that the path is clear - does the same probing runner the Probing tab already uses move anything.',
      },
      {
        kind: 'paragraph',
        text: 'A routine can never reset, home, unlock, start, hold, stop, pick a tool, run the spindle, write an offset or a tool length, or carry G-code of its own. It can only ask; the buttons that act are outside the routine, and every endpoint it would drive to is checked against the machine envelope before the first command is sent.',
      },
      {
        kind: 'heading',
        text: 'Inputs',
        anchor: 'inputs',
      },
      {
        kind: 'paragraph',
        text: 'Inputs are the numbers and choices you type before a routine runs: a bore diameter "about", which side of the part, how far to search. Every length, angle and count input carries a min, a max and a default; a choice input lists its options. Bounds are compulsory so the preview can promise where the machine will go. Type the values in the Value column; a blank uses the default.',
      },
      {
        kind: 'heading',
        text: 'Steps - move, touch, calc, check, branch',
        anchor: 'steps',
      },
      {
        kind: 'table',
        columns: ['Step', 'What it does'],
        rows: [
          {
            cells: [
              'move',
              'Go to a point (X, Y and/or Z) at the profile positioning feed. Positions are written relative to where you parked the probe (or, for experts, as absolute machine coordinates). A rapid is allowed only at or above the routine safe Z.',
            ],
          },
          {
            cells: [
              'touch',
              'Probe along one axis in one direction until contact: a search pass, a retract, a slow final pass, read the contact, back off. Feeds come from the machine profile; a routine may only ask for a FRACTION of them.',
            ],
          },
          {
            cells: [
              'calc',
              'Name a number computed from inputs and touches, for example centre = (left + right) / 2. No motion.',
            ],
          },
          {
            cells: ['check', 'Stop the routine with a plain sentence if a condition is false. No motion.'],
          },
          {
            cells: [
              'branch',
              'Run one list of steps or another depending on a condition. No loops; at most two levels deep.',
            ],
          },
        ],
      },
      {
        kind: 'paragraph',
        text: 'Each step reads as a sentence in the editor (Probe toward X- up to 20 mm), and expressions are typed as text like input.diameter / 2 or touch.left.x. A step result is referred to by kind and name - touch.left, calc.centre - so step names must be unique and can only be used AFTER their step.',
      },
      {
        kind: 'heading',
        text: 'Check, and the preview',
        anchor: 'check-preview',
      },
      {
        kind: 'paragraph',
        text: 'Check does two things. First it validates the routine itself - every problem is listed as a sentence that names the step, and is also shown inline under the field it belongs to. Then it EXPANDS the routine against the live machine: it binds your input values, turns every position into an absolute machine coordinate, looks up every feed in the machine profile and clamps it, and checks every endpoint - including the far end of every search - against the signed machine envelope and the probe travel limit. The Preview column then lists the numbered steps with real numbers ("4. move to machine X -303.5 at 1000 mm/min") and the diagram draws the path. Any edit, input change or move of the machine makes the preview stale; press Check again.',
      },
      {
        kind: 'warning',
        text: 'Run stays disabled until the preview is current, has no problems, and you have ticked that the path is clear. Clear the path for real - the preview is the plan, not a guarantee that nothing is in the way.',
      },
      {
        kind: 'heading',
        text: 'Proposals and the Confirm button',
        anchor: 'proposals',
      },
      {
        kind: 'paragraph',
        text: 'A routine can PROPOSE three things and perform none of them: a work offset ("Would write G54 X= Y= after confirmation"), a tool length ("Would record T3 length"), or a report (a measured diameter, position or angle, read-only). When a routine on the Routines tab finishes, its proposals appear under the result with a Confirm button. Nothing is written until you press it; Cancel discards the proposal and the machine keeps its offsets. The Probing tab\'s Z0 and Tool Z cycles are separate: they write or record their results immediately.',
      },
      {
        kind: 'heading',
        text: 'Where routines come from - factory, yours, imported',
        anchor: 'provenance',
      },
      {
        kind: 'table',
        columns: ['Badge', 'Meaning'],
        rows: [
          {
            cells: [
              'FACTORY',
              'Shipped inside LienCAM as data. Read-only - Duplicate makes a copy you can edit. Always available: Restore factory routines cannot fail because it reads nothing from disk.',
            ],
          },
          {
            cells: [
              'USER',
              'A copy of a factory routine, or one you made with New, edited here. Saved in this browser with your other machine settings.',
            ],
          },
          {
            cells: [
              'IMPORTED',
              'Loaded from a file. It can be previewed at once but runs only after you have reviewed its expanded preview once for that exact file content ("reviewed" badge). Editing it makes it yours.',
            ],
          },
        ],
      },
      {
        kind: 'paragraph',
        text: 'A stored routine that no longer validates (for example after a format change) is QUARANTINED: listed with its reasons, not runnable, and removable. Nothing is silently dropped, and the factory set is always underneath.',
      },
      {
        kind: 'heading',
        text: 'Import and export',
        anchor: 'import-export',
      },
      {
        kind: 'paragraph',
        text: 'Export writes the selected routine to a <name>.liencam-probe.json file; Import reads such a file. Only the routine definition travels - id, name, version, description, requirements, inputs, steps, outputs. Feeds in mm/min, machine profile values, envelopes, offsets, tool tables, measured results and start positions never travel; a file that carries them is refused by name. On import every routine becomes IMPORTED regardless of what the file claims; an id that collides with a factory routine is refused, and one that collides with a routine of yours asks Replace / Keep both / Skip.',
      },
      {
        kind: 'heading',
        text: 'Restore factory routines',
        anchor: 'restore-factory',
      },
      {
        kind: 'paragraph',
        text: 'Restore factory routines brings back every factory routine exactly as shipped and un-hides any you hid. It never touches your own or imported routines, so it is always safe to press. If you broke a copy of a factory routine, either Duplicate the original again or delete your copy.',
      },
      {
        kind: 'heading',
        text: 'What the errors mean',
        anchor: 'errors',
      },
      {
        kind: 'paragraph',
        text: 'Every problem is one sentence that names where it lives - "Step 4 (touch \'right\'): ..." or "Routine \'bore\': ..." - with numbers in your display units. The code on each row below is the part in the error list; click the ? next to a sentence to land on its row here.',
      },
      {
        kind: 'table',
        columns: ['Code', 'Where', 'In plain words'],
        rows: [
          {
            cells: [
              'E_SCHEMA_MISSING',
              'Routine file',
              'The file does not say which routine format it uses (schemaVersion is missing or not a whole number). Add "schemaVersion": 1 at the top level.',
            ],
            anchor: 'error-e-schema-missing',
          },
          {
            cells: [
              'E_SCHEMA_NEWER',
              'Routine file',
              'The file was saved by a newer LienCAM than this one and is refused whole - nothing is half-loaded. Update LienCAM, or ask for the routine in format 1.',
            ],
            anchor: 'error-e-schema-newer',
          },
          {
            cells: [
              'E_UNKNOWN_FIELD',
              'Routine file',
              'The file carries a key LienCAM does not know. Unknown keys are never ignored - typos and smuggled settings (feeds, offsets, tool tables) both land here. Remove the key.',
            ],
            anchor: 'error-e-unknown-field',
          },
          {
            cells: [
              'E_ID_RESERVED',
              'Routine file',
              'The id begins with "factory.", which only the routines shipped inside LienCAM may use. Pick another id.',
            ],
            anchor: 'error-e-id-reserved',
          },
          {
            cells: [
              'E_INPUT_UNBOUNDED',
              'Input',
              'A number input has no min and max (or min is above max). Without bounds the preview cannot promise where the machine will go. Give every length, angle and count input a min and a max.',
            ],
            anchor: 'error-e-input-unbounded',
          },
          {
            cells: [
              'E_INPUT_DEFAULT_OUT_OF_RANGE',
              'Input',
              'An input default is missing, not a number, or outside its own min and max (for a choice input: not one of its options).',
            ],
            anchor: 'error-e-input-default-out-of-range',
          },
          {
            cells: [
              'E_STEP_KIND',
              'Step',
              'A step has no kind, or a kind outside the closed vocabulary (move, touch, calc, check, branch). Unknown steps are refused, never skipped.',
            ],
            anchor: 'error-e-step-kind',
          },
          {
            cells: [
              'E_STEP_NAME_DUPLICATE',
              'Step',
              'Two steps share a name. Names are how later steps refer to a result (touch.left, calc.centre), so they must be unique.',
            ],
            anchor: 'error-e-step-name-duplicate',
          },
          {
            cells: [
              'E_TOUCH_DIRECTION',
              'Step',
              'A touch names an axis or direction that is not X, Y, Z with + or -, or uses a direction the probe cannot take. Check the axis and direction fields.',
            ],
            anchor: 'error-e-touch-direction',
          },
          {
            cells: [
              'E_FEED_ABOVE_PROFILE',
              'Step',
              'A touch asks for a feed fraction above 1. A routine can only SLOW DOWN relative to the machine profile, never speed up.',
            ],
            anchor: 'error-e-feed-above-profile',
          },
          {
            cells: [
              'E_EXPR_UNBOUNDED',
              'Expression',
              'An expression uses something whose range cannot be known before running (an unbounded function such as abs, a name without bounds), so the preview cannot promise a safe path. Use bounded inputs and measured results only.',
            ],
            anchor: 'error-e-expr-unbounded',
          },
          {
            cells: [
              'E_EXPR_UNKNOWN_NAME',
              'Expression',
              'An expression refers to a name that does not exist: an input this routine does not declare, or a step that is not in the routine. Check the spelling against the inputs and step names.',
            ],
            anchor: 'error-e-expr-unknown-name',
          },
          {
            cells: [
              'E_EXPR_FORWARD_REFERENCE',
              'Expression',
              'An expression uses the result of a step that comes LATER. Results only exist once their step has run; reorder the steps.',
            ],
            anchor: 'error-e-expr-forward-reference',
          },
          {
            cells: [
              'E_EXPR_ENUM_IN_ARITHMETIC',
              'Expression',
              'A choice (enum) input is used in arithmetic. A choice is a word, not a number; compare it (== "left") in a check or branch instead.',
            ],
            anchor: 'error-e-expr-enum-in-arithmetic',
          },
          {
            cells: [
              'E_BRANCH_DEPTH',
              'Step',
              'Branches nest deeper than two levels. A routine has no loops and at most two nested if/else levels so the preview can show every path.',
            ],
            anchor: 'error-e-branch-depth',
          },
          {
            cells: [
              'E_REQUIRES_HOMED',
              'Routine file',
              'The requires block is missing or wrong, or a routine that moves claims it does not need homing. Every routine that moves or touches must require a homed machine.',
            ],
            anchor: 'error-e-requires-homed',
          },
          {
            cells: [
              'E_GCODE_IN_ROUTINE',
              'Routine file',
              'A text field contains G-code or a controller command. A routine is data: it cannot carry G-code, $-commands, or realtime characters anywhere, not even in a label.',
            ],
            anchor: 'error-e-gcode-in-routine',
          },
          {
            cells: [
              'E_OUTPUT_KIND',
              'Output',
              'An output proposal has no kind, or a kind other than workOffset, toolLength or report. A routine can only PROPOSE these three things.',
            ],
            anchor: 'error-e-output-kind',
          },
          {
            cells: [
              'E_TOO_MANY_STEPS',
              'Routine file',
              'The routine has more steps than the limit allows. Split it into two routines.',
            ],
            anchor: 'error-e-too-many-steps',
          },
          {
            cells: [
              'E_CALC_NOT_FINITE',
              'Calculation',
              'A calculation cannot produce a number: at Check time it divides by something that is always zero; at preview time the real numbers produced infinity or not-a-number. Look at the divisor.',
            ],
            anchor: 'error-e-calc-not-finite',
          },
          {
            cells: [
              'E_FIELD_INVALID',
              'Routine file',
              'A required field is missing, has the wrong type, or is outside its allowed shape (a bad name, a version that is not "1.0.0"-style, a list where an object belongs). The sentence names the field.',
            ],
            anchor: 'error-e-field-invalid',
          },
          {
            cells: [
              'E_ENVELOPE_INCOMPLETE',
              'Check / preview',
              'The machine envelope is not fully known (the machine has no datum, or its declaration has no travel or home convention), so no position can be proved safe. With home switches, home the machine first; without them, set the machine position. Complete its declaration in the Machine library.',
            ],
            anchor: 'error-e-envelope-incomplete',
          },
          {
            cells: [
              'E_ENDPOINT_OUTSIDE_ENVELOPE',
              'Check / preview',
              'A move, or the far end of a touch search, lands outside the table. The sentence names the step and the machine coordinate that leaves the envelope. Move the probe, change the input, or shorten the search.',
            ],
            anchor: 'error-e-endpoint-outside-envelope',
          },
          {
            cells: [
              'E_SEARCH_OVER_MAX_TRAVEL',
              'Check / preview',
              'A touch searches further than the probe travel limit in the machine profile allows. Shorten the search distance or raise the limit in the profile (not in the routine).',
            ],
            anchor: 'error-e-search-over-max-travel',
          },
          {
            cells: [
              'E_RAPID_NOT_AT_SAFE_Z',
              'Check / preview',
              'A step asks for a rapid move below the routine safe Z. Rapids are allowed only at or above safe Z; everything lower moves at the positioning feed.',
            ],
            anchor: 'error-e-rapid-not-at-safe-z',
          },
          {
            cells: [
              'E_INPUT_OUT_OF_RANGE',
              'Check / preview',
              'A value you typed for an input is below its min or above its max (or is not one of the choices). Fix the value in the input field.',
            ],
            anchor: 'error-e-input-out-of-range',
          },
          {
            cells: [
              'E_PROBE_CONFIG_INVALID',
              'Check / preview',
              'The probe settings in the machine profile are not usable (a feed of zero, a missing travel limit, a tip radius that is not a number). Fix them on the Probing tab / machine profile, not in the routine.',
            ],
            anchor: 'error-e-probe-config-invalid',
          },
          {
            cells: [
              'E_NOT_HOMED',
              'Run',
              'The machine is not homed. A routine that moves never runs against an unhomed machine - home first.',
            ],
            anchor: 'error-e-not-homed',
          },
          {
            cells: [
              'E_NOT_IDLE',
              'Run',
              'The controller is not idle (running, held, in alarm or jogging). Wait for Idle, or clear the alarm, then Run.',
            ],
            anchor: 'error-e-not-idle',
          },
          {
            cells: [
              'E_ESTOP',
              'Run',
              'The emergency stop is active. Nothing runs until it is released and the controller reset.',
            ],
            anchor: 'error-e-estop',
          },
          {
            cells: [
              'E_PATH_NOT_CONFIRMED',
              'Run',
              'The "path is clear" box is not ticked. Look at the numbered preview on the diagram, clear the path, then tick it.',
            ],
            anchor: 'error-e-path-not-confirmed',
          },
          {
            cells: [
              'E_PREVIEW_STALE',
              'Run',
              'The routine, an input or the start position changed since the preview was made. Press Check again and look at the new numbers.',
            ],
            anchor: 'error-e-preview-stale',
          },
          {
            cells: [
              'E_IMPORTED_NOT_REVIEWED',
              'Run',
              'An imported routine has not yet been reviewed: its expanded preview must be looked at once for this exact file content before it may run. Press Check, read the steps, then Run.',
            ],
            anchor: 'error-e-imported-not-reviewed',
          },
          {
            cells: [
              'E_TOUCH_MISSED',
              'Run',
              'A probe search reached its distance without touching anything. The routine stops where it is; jog closer and run again from the start.',
            ],
            anchor: 'error-e-touch-missed',
          },
          {
            cells: [
              'E_CONTROLLER_REFUSED',
              'Run',
              'The controller rejected a line. The routine stops at that step and names it; the machine stays put.',
            ],
            anchor: 'error-e-controller-refused',
          },
        ],
      },
    ],
    images: [],
    keywords: 'probe routine routines custom probing edit inputs steps move touch calc check branch preview expand proposal confirm work offset tool length report factory user imported reviewed quarantined import export restore factory json liencam-probe errors E_ codes envelope stale',
    contextKeys: ['workspace:control'],
    relatedTopicIds: ['probing-tab', 'control-jog-zero', 'control-tab-overview'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'mesh-viewer',
    title: 'Surface mesh flatness viewer',
    category: 'machine',
    summary: 'Click the Mesh chip in Control to see the probed surface as a turnable shape, colored low to high, with the flatness range in numbers.',
    keywords: 'mesh viewer flatness plane surface map bed mesh visualization chip modal range min max exaggerated orbit heatmap probed points',
    contextKeys: ['workspace:control', 'modal:mesh-viewer'],
    relatedTopicIds: ['probing-tab'],
    sinceVersion: '0.36.0',
    images: [],
    sections: [
      {
        kind: 'paragraph',
        text: 'After a surface mesh grid has been probed, a small Mesh chip appears in the Control program row (for example "Mesh 3x3"). Click it and this viewer opens: the probed surface drawn as a shape you can turn with the mouse (drag to orbit, wheel to zoom), colored from low to high across the measured range. The up-and-down of the surface is exaggerated so a bow of a few hundredths of a millimetre is visible; the factor is labeled in the readouts (for example 20x).',
      },
      {
        kind: 'heading',
        text: 'The numbers',
        anchor: 'numbers',
      },
      {
        kind: 'paragraph',
        text: 'Points is the probed grid size. Min Z and Max Z are the lowest and highest measured machine heights. Range (flatness) is the difference between them - how far from flat the surface really is. Reference Z is the height of the first probed point, which the mesh compensation treats as zero. Closing the viewer changes nothing; it is a picture of the measurement, not a control.',
      },
    ],
  },
  {
    id: 'program-context',
    title: 'Setup information on a loaded program',
    category: 'machine',
    summary: 'The chip next to the program name and the Intended stock card say which setup a program was posted from, and whether that is still true.',
    sections: [
      {
        kind: 'heading',
        text: 'When the preview refuses to draw',
        anchor: 'preview-refusal',
      },
      {
        kind: 'paragraph',
        text: 'A loaded program is drawn only if every word in it can be read. If the file uses something the preview cannot model - a tool length offset it has no tool table for, a machine-frame move, a plane it does not support, or flow control - it refuses the whole program by name, saying which line and which word stopped it, and draws nothing. It does not draw the parts it understood and skip the rest. The reason is that a partly drawn program is a confident picture of a DIFFERENT program, and you would be judging whether to cut from it.',
      },
      {
        kind: 'paragraph',
        text: 'A word that cannot move the tool never causes a refusal. Vacuum, coolant, spindle and vendor-specific M-codes are noted and passed over, because reading one wrongly cannot put the tool anywhere unexpected. So a refusal always names something that could have changed the path.',
      },
      {
        kind: 'paragraph',
        text: 'A refused program is not an empty one. The travel and soft-limit checks are told that the program could not be read, rather than being handed nothing to check - they say they cannot judge instead of going quiet.',
      },
      {
        kind: 'paragraph',
        text: 'When you post a setup straight into the sender, or open a file LienCAM exported with its context block, the program carries a frozen snapshot of the setup it came from: the setup name, the stock and its size and material, the work coordinate system (G54-G59), and the list of operations in emitted order. Control shows it in two places - the chip beside the program name in the Program panel, and the Intended stock card on the preview - and keeps comparing it with the open project. It is advisory: it explains, it never changes a line, arms, starts or stops anything.',
      },
      {
        kind: 'heading',
        text: 'What the chip says',
        anchor: 'chip',
      },
      {
        kind: 'table',
        columns: ['Chip', 'Meaning'],
        rows: [
          {
            cells: [
              'Setup: X (G54)',
              'The program is bound to the setup it was posted from and the project still matches it. X is the setup name, G54 its work offset. CURRENT on the stock card.',
            ],
          },
          {
            cells: [
              'Setup changed since post',
              'The project changed after this program was posted (stock, WCS, operations). The card shows the stock AS POSTED, not the live setup. Reload from the setup to refresh. STALE on the card for an edit to the same project. If the unchanged program came from a different project, the Intended stock badge says "other project" and its details explain that the stock is from that project as posted. The program chip keeps saying "Setup changed since post".',
            ],
          },
          {
            cells: [
              'Program changed since post',
              'The program text no longer matches its posted context. STALE on the card; reload from the setup.',
            ],
          },
          {
            cells: [
              'No setup information',
              'The program was loaded from a file with no LienCAM context block (a foreign file, or one exported with the block switched off). The app cannot tell which project or setup it came from. NONE on the card.',
            ],
          },
          {
            cells: [
              'Cannot verify against project',
              'The comparison itself failed (an internal error, written to the console). The card shows the stock AS POSTED; do not trust it as current. UNVERIFIED on the card.',
            ],
          },
        ],
      },
      {
        kind: 'heading',
        text: 'The context block that travels with an exported file',
        anchor: 'travelling-block',
      },
      {
        kind: 'paragraph',
        text: 'Post Process can write the same snapshot after M30 as comment lines (the "Include LienCAM context" toggle). A file opened later in Control is checked - the block must match the program bytes and its own digest - before the setup information is trusted; anything that does not verify is treated as "No setup information", never guessed.',
      },
      {
        kind: 'tip',
        text: 'The stock drawn on the preview comes from the snapshot, not from the live project, so a later edit to the project can never move it under a running program.',
      },
    ],
    images: [],
    keywords: 'program context setup chip intended stock card current stale none unverified setup changed program changed no setup information cannot verify g54 lcx1 context block exported file control program panel',
    contextKeys: ['workspace:control'],
    relatedTopicIds: ['control-run-job', 'post-include-context', 'control-tab-overview'],
    sinceVersion: '0.36.0',
  },
  {
  "id": "control-simulator",
  "title": "The in-app machine simulator",
  "category": "machine",
  "summary": "Choose Simulate followed by your machine name in Control to practice running programs, jogging and probing against a virtual machine using the selected machine settings.",
  "keywords": "simulator simulation virtual machine practice dry run offline no hardware in-app simulated part drill canned cycles g81 g82 g83 g98 g99 tool setter",
  "contextKeys": [
    "workspace:control",
    "controller:simulator"
  ],
  "sections": [
    {
      "kind": "steps",
      "steps": [
        "Open Control with the machine you want to practice on selected. Choose Simulate followed by your machine name in the connection selector and click Connect. This connection runs inside LienCAM and moves no physical machine.",
        "Press CLEAR to release the software stop after connecting, then home or set the datum as the status sentence asks. Load a G-code file or post your setup into Control, and use CYCLE START, Feed Hold and Stop/Reset as you would for a connected machine.",
        "For probing practice, open Diagnostics and find Simulated part. Place under probe moves the virtual part beneath the current probe position; Reset restores its default placement. Neither action moves the tool."
      ]
    },
    {
      "kind": "paragraph",
      "text": "The simulator takes its travel, enabled axes, homing convention, motion, spindle and output settings from the selected machine. It interprets the program using that machine's declared controller dialect. G81, G82 and G83 drilling cycles use their R and Z levels, dwell or pecks, and G98/G99 return heights. The Control program preview and live position follow the simulated moves."
    },
    {
      "kind": "paragraph",
      "text": "A machine with a stated fixed tool setter also has a virtual setter at that machine XY position. Its contact height uses the measured reference-tool contact when it is below the stated setter Z, otherwise the stated Z. A machine with no stated setter has none. Measure tool can touch this virtual setter; see \"The fixed tool setter\" for the measurement and reference workflow."
    },
    {
      "kind": "paragraph",
      "text": "On a fresh shipped Sample hobby router (GRBL), home is the back-right top, with machine zero at the maximum end of each axis. When G54 has no stored axes, the simulator starts its work zero at the default virtual part's front-left top. Any saved G54 axis, even an explicit zero, takes precedence; this default is not saved and applies only to the shipped sample. If you change work offsets after Load, the simulator reads the staged program against the offsets in force when you press CYCLE START."
    },
    {
      "kind": "tip",
      "text": "The Control simulator practices the machine sender and probing. The Simulate tab is a separate toolpath and stock preview. Simulator results do not verify physical wiring, clearances or a real tool setter."
    },
      { kind: 'image', slot: 'simulated-part-full' },
      { kind: 'image', slot: 'simulated-part' },
  ],
  "images": [
      {
        "slot": "simulated-part-full",
        "file": "simulated-part-full.webp",
        "alt": "The simulator's Diagnostics page, where you can place a virtual part for probing practice.",
        "captureNotes": "Machine > Diagnostics on the simulator, with the Simulated part card below the drive links. WO-2714; architect-accepted production candidate.",
        "status": "done"
      },
      {
        "slot": "simulated-part",
        "file": "simulated-part.webp",
        "alt": "Simulated part at the sample router default: machine X -253.00, Y -243.00, top Z -60.25 mm; size, bow, bore, boss, Place under probe and Reset are shown.",
        "captureNotes": "Simulated part at the sample router default: machine X -253.00, Y -243.00, top Z -60.25 mm; size, bow, bore, boss, Place under probe and Reset are shown. WO-2714; architect-accepted production candidate.",
        "status": "done"
      },
    ],
  "relatedTopicIds": [
    "control-connect",
    "control-run-job",
    "probing-tab",
    "control-tool-setter"
  ],
  "sinceVersion": "0.35.0"
},
  {
  "id": "control-tool-setter",
  "title": "The fixed tool setter",
  "category": "machine",
  "summary": "A fixed setter measures a tool at a known machine position; the tool table keeps the contact and compares it with a measured reference tool to apply length.",
  "keywords": "tool setter fixed probe touch off tool length measure tool measure tn reference ref tool table apply length tlo g43.1 calibration probing simulator virtual setter",
  "contextKeys": [
    "workspace:control",
    "panel:tools"
  ],
  "sections": [
    {
      "kind": "paragraph",
      "text": "The fixed tool setter is separate from the touch plate or part surface used for work Z0. Its machine X/Y/Z position and probing settings belong to the selected machine under Control > Machine > Definition > Probing. The setter routine uses those settings for the approach, search, back-off and fine contact."
    },
    {
      "kind": "steps",
      "steps": [
        "On Control > Tools, use the tool table to select the tool you have loaded. Measure Tn probes the setter and records its fine contact as machine Z for that tool on this machine. Measure tool also works without a numbered tool when a setter is stated: the contact is retained as an available measurement that can be attached to a tool row.",
        "Choose a reference tool with Ref and measure it on the same setter. Setting work Z0 on a plate or part does not supply the reference tool's setter reading.",
        "After measuring the current tool, Apply length compares its setter contact with the reference tool's setter contact. The status shows the difference and the controller command applied. A missing reference measurement tells you which tool to measure.",
        "During a guided tool change, follow the card to fit and measure the requested tool, then Continue when the card offers it. Retry measure repeats the measurement without visiting the park again."
      ]
    },
    {
      "kind": "paragraph",
      "text": "With Simulator connected, the selected machine's fixed setter is a virtual contact surface. Measure tool touches it using the same routine. If the stored reference contact is below the stated setter Z, that contact supplies the simulated top height. This lets you practice the workflow without a physical controller."
    },
    {
      "kind": "tip",
      "text": "Keep the approach and setter position clear on the real machine, and inspect the routine preview before running it. A simulated touch is practice, not a calibration of the physical setter."
    },
      { kind: 'image', slot: 'tools-setter' },
      { kind: 'image', slot: 'tools-setter-apply' },
  ],
  "images": [
      {
        "slot": "tools-setter",
        "file": "tools-setter.webp",
        "alt": "The Tools tab after measuring T2 on the simulated setter, with T1 as the reference tool. Apply length is unavailable in this state.",
        "captureNotes": "Tools table and probe card after the simulator measured T2 at machine Z -40.00 mm; T1 is the reference tool and Apply length is disabled. WO-2714; architect-accepted production candidate.",
        "status": "done"
      },
      {
        "slot": "tools-setter-apply",
        "file": "tools-setter-apply.webp",
        "alt": "The full Tools tab after measuring T2 on the simulated setter. The result is recorded for T2; Apply length is disabled and no length application is shown.",
        "captureNotes": "The full Tools tab after measuring T2 on the simulated setter. The result is recorded for T2; Apply length is disabled and no length application is shown. WO-2714; architect-accepted production candidate.",
        "status": "done"
      },
    ],
  "relatedTopicIds": [
    "probing-tab",
    "probe-routines",
    "control-jog-zero",
    "control-simulator"
  ],
  "sinceVersion": "0.35.0"
},
])
