# LienCAM roadmap

<!-- generated from docs/roadmap/roadmap.json - edit that file -->

## Where we are

LienCAM combines design, CAM, simulation and machine control. Flat machining and control on one UCCNC machine are established; Form, relief, 3D finishing and probing remain alpha. GRBL, grblHAL and LinuxCNC control are simulator-tested only.

## Where we are aiming

First, stabilize alpha features and prove more controllers on real machines, starting with GRBL. Next come German translation and AI-assisted CAM, followed by rotary machining and better job checks. Requests help set priorities; follow each item below.

## How to read this

Status:

- **Idea** - Suggested; nobody has decided to build it yet.
- **Planned** - We intend to build it; work has not started or is only partly there.
- **In progress** - Being built now.
- **Alpha** - Works, still being proven on real parts and machines.
- **Experimental** - Tried on simulators or in early form; not yet proven in real use.
- **Done** - Built and shipped.
- **Declined** - Considered and not planned; the reason stays in the row.

Priority:

- **Next** - Next after the alpha release.
- **After that** - After the Next items.
- **Later** - Later, or on demand.

Have a request? Open an idea in [Discussions](https://github.com/eclsnowman/LienCAM/discussions); it gets a number (R-nnn) and a row here with the status Idea.

## Multi-axis (4th axis, wrap, projection)

| ID | Item | Goal | Status | Priority |
|---|---|---|---|---|
| R-001 | Indexed rotary setups | Cut several faces by turning a rotary table between setups; post one program | **Planned** - CAM and posting not started; rotary machine controls exist | After that |
| R-002 | Rotary centreline in the machine record | Tell the app where the rotary axis sits so CAM can use it | **Planned** - Rotary position not yet stored | After that |
| R-003 | Simulate and clear-check turned setups | Preview and holder/vise checks that follow the part as it turns | **Planned** - Not started | After that |
| R-004 | Cut on a tilted face (3+2) | Machine a face that is tilted or flipped, not just flat-up | **Planned** - Tilted setups not yet supported | Later |
| R-005 | Wrapped 4th-axis cutting | Cut while the rotary turns (cylindrical engraving, flutes) | **Planned** - Not started | Later |
| R-006 | Wrap a picture or text around a round part | Wrap lettering or patterns around a cylinder without a seam | **Planned** - Not started | Later |
| R-007 | Project a picture onto curved faces | Lay a picture or sketch onto a freeform surface along a chosen direction | **Planned** - Not started | Later |
| R-008 | Rotary on plain GRBL | Use a rotary table on a GRBL board by standing it in for an axis | **Planned** - Not started; firmware changes need approval | Later |

## Machining strategies

| ID | Item | Goal | Status | Priority |
|---|---|---|---|---|
| R-010 | Trochoidal transitions and terrace cleanup in 3D roughing | Handle heavy 3D roughing cuts and remove stepped terraces | **Planned** - 2D trochoidal cutting exists; heavy 3D side entries remain unsupported | After that |
| R-011 | Leftover-stock export | Save the shape left after cutting as an STL | **Done** | After that |
| R-012 | Compare cut result with the model | Colour the stock by how far it is from the part (corners left, gouges) | **Planned** - Not started; stock export exists | After that |
| R-013 | Automatic pockets, bosses and side holes | One button finds the features and offers them | **Planned** - Top-down holes detected; side holes, pockets and bosses pending | After that |
| R-014 | One-click machining plan | Recognise features, pick tools from your library, rough and finish them | **Planned** - Not started; saved recipes and hole detection exist | Later |
| R-015 | Smooth pocket corners and links | Offset pockets with rounded ring corners and tangent links, no dwell marks | **Planned** - Not started | Later |
| R-016 | Better tabs: auto-placed, and a clean-up pass for tab marks | Place tabs automatically away from short spans; optionally clean up their marks | **Planned** - Evenly spaced box and ramped tabs exist | After that |
| R-017 | Inward spiral for facing | One continuous spiral instead of passes | **Planned** - Not started | Later |
| R-018 | Rest boundary for Face | Face only what earlier cutters left | **Planned** - 3D rest exists; Face rest unavailable | Later |
| R-019 | Hollow tube and round-bar awareness | Round and tube stock treated as real shapes in 3D clearing | **Planned** - Round stock exists; tube and roughing behavior unverified | Later |

## Modeling and sketching

| ID | Item | Goal | Status | Priority |
|---|---|---|---|---|
| R-030 | Variable-radius fillets | Fillets whose radius changes along an edge | **Planned** - Not started | Later |
| R-031 | Thin-wall and surface extrude | Extrude a profile as a thin shell | **Planned** - Not started | Later |
| R-032 | Tapered-wall re-sectioning | Slice solids with tapered walls at depth | **Planned** - Not started; awaiting approval | Later |
| R-033 | More curve and constraint kinds | Bezier, conic, curvature-continuous and pierce constraints, links to model edges | **Planned** - Not started; status not re-verified | Later |
| R-034 | Linked sketch features | Offsets and derived sketches that stay linked to their source | **Planned** - Not started; status not re-verified | Later |
| R-035 | Everything exports in a standard format | Export every kind of user data in an open format | **Done** | Next |
| R-036 | Full DXF block support | Nested, scaled and mirrored blocks import correctly | **Planned** - Partial: blocks read; some are skipped with a note | Later |
| R-037 | Photo to relief with AI help | Turn a photo into a good relief | **Planned** - Not started | Later |
| R-038 | Locating parts, stock and workholding by mates | Snap models, stock and clamps together by faces | **Planned** - Proposal only | Later |

## Setup, stock and tools

| ID | Item | Goal | Status | Priority |
|---|---|---|---|---|
| R-040 | Project vs shared tool library | Keep tools with a project or in a shared library, clearly | **Planned** - Explored; not built | Later |
| R-041 | Ready-made definitions for the 10 most common hobby machines | Pick your machine from a list, no typing numbers | **Planned** - Sample machines exist; definitions need checking against manuals | Next |
| R-042 | First-run wizard | A guided first start: machine, units, tool library | **Planned** - Not started | After that |
| R-114 | Beds: several table loads in one project | Arrange several machine loads in one project. Each Bed has its own parts, stock, workholding, setups, program and job sheet. Share designs, tools and machine settings; move parts and machining between Beds. | **Planned** - Not started; after the alpha | After that |

## Machine control

| ID | Item | Goal | Status | Priority |
|---|---|---|---|---|
| R-050 | Keyboard shortcut editor and printable map | See and change every shortcut, conflicts flagged | **Planned** - A few fixed shortcuts exist; editor not started | Later |
| R-051 | Gamepad jogging | Jog with a handheld pad, with a dead-man safety | **Planned** - Not started | Later |
| R-052 | Diagonal jog and safe-height go-tos | Move XY diagonally and travel with automatic safe Z | **Planned** - Not started | After that |
| R-053 | Macros with variables and shortcuts | Macro buttons with named values and keys | **Planned** - Partial: macros exist, one variable | Later |
| R-054 | File insight on load | Feed range, spindle range, tools used and time shown when a program loads | **Planned** - Partial: tools and bounds shown, no feed/spindle range | After that |
| R-056 | Auto-detect firmware and auto-reconnect | Plug in and the app knows the board | **Planned** - Not started | Later |
| R-057 | Laser profile | Laser machines with test-fire safety | **Planned** - Not started; awaiting approval | Later |
| R-058 | Low-resource mode | A lighter Control screen for small PCs | **Planned** - Not started | Later |
| R-059 | Machine-side tool change on more boards | Guided or automatic tool change on each supported controller | **Planned** - Partial: guided M6 on UCCNC and GRBL | After that |

## Alpha to stable

| ID | Item | Goal | Status | Priority |
|---|---|---|---|---|
| R-060 | 3D machining to stable | Adaptive rough, parallel, waterline, scallop, steep/shallow and pencil you can trust on real parts | **Alpha** | Next |
| R-061 | Form (SubD modelling) to stable | Organic modelling with exact results, fully documented | **Alpha** | Next |
| R-062 | Relief from an image to stable | Raise, emboss and engrave from a picture, predictable results | **Alpha** | Next |
| R-063 | UCCNC on more machines | Control proven on several UC100/AXBB-E machines, not one | **Alpha** - One machine proven | Next |
| R-064 | GRBL control on real hardware | Run jobs from LienCAM on real GRBL boards | **Experimental** - Simulator only | Next |
| R-065 | grblHAL control on real hardware | Run jobs on grblHAL hardware, including multiple probe inputs and settings | **Experimental** - Not hardware-verified | Next |
| R-066 | LinuxCNC control on a real machine | Run jobs on a LinuxCNC machine | **Experimental** - Simulator only | After that |
| R-067 | Probing and tool setter to stable | Probe and set tools with confidence on several machines | **Alpha** | Next |
| R-068 | Rotated work offsets and Z surface map to stable | Angle and warp correction proven on hardware | **Alpha** - Rotation simulator-tested only | After that |
| R-069 | Mesh lab to stable | Edit and combine STL/OBJ/3MF reliably | **Experimental** | After that |
| R-070 | Nesting to stable | Nest parts on sheets with trusted results | **Experimental** | After that |
| R-071 | Phone pendant to stable | Jog and run from a phone, proven on more machines | **Alpha** - Tested on one machine | Next |

## Output and post-processing

| ID | Item | Goal | Status | Priority |
|---|---|---|---|---|
| R-080 | More post dialects on request | Posts for more controller families users ask for | **Planned** - Five dialects and vendor post import exist | After that |
| R-081 | User G-code at start, end, pause | Add your own lines at job events | **Planned** - Not started; awaiting approval | Later |
| R-082 | Post scripting | Express output the settings form cannot | **Planned** - Not started; settings form takes priority | Later |

## Platform and AI

| ID | Item | Goal | Status | Priority |
|---|---|---|---|---|
| R-090 | Agent read commands | An AI agent can read the project | **Done** | - |
| R-091 | MCP server, CAM planning first | An AI agent plans CAM in the project tree, with undo; desktop only, no machine motion | **Planned** - Designed; to be built after the alpha | Next |
| R-092 | MCP server, modeling tools | The same agent models parts | **Planned** - Designed, follows R-091 | After that |
| R-093 | Update check in the desktop app | Tell the user when a new version exists | **Planned** - Not started | After that |
| R-094 | Graphics fallback | Recover cleanly when the graphics card resets | **Planned** - Not started | Later |
| R-095 | Newest-build channel for the web app | A preview build for contributors | **Planned** - Not started; depends on contributor interest | Later |
| R-096 | Accessibility: text size | Larger text without breaking layouts | **Planned** - Not started | Later |
| R-097 | Custom layouts | Move, dock and save panel layouts | **Planned** - Main panels resize and collapse; consistent layouts in progress | After that |

## Languages

| ID | Item | Goal | Status | Priority |
|---|---|---|---|---|
| R-100 | Language plumbing and picker | Choose a language in Settings; English output unchanged | **Planned** - Waiting for the first public release | Next |
| R-101 | Translate every screen | Translate all menus, panels, dialogs and messages, including probing | **Planned** - Waiting for the first public release | Next |
| R-102 | Translatable Help | The 15 Help topics ready for translation | **Planned** - Waiting for the first public release | Next |
| R-103 | New-text guard | Keep new interface text translatable | **Planned** - Waiting for the first public release | Next |
| R-104 | CNC glossary and German pilot | Sourced CNC terms; German labelled machine-translated, corrections welcome | **Planned** - Waiting for the first public release | Next |
| R-105 | German layout check | Check that German text fits desktop layouts | **Planned** - Waiting for the first public release | Next |
| R-106 | More languages and community language packs | Spanish, French, Chinese and others; users can contribute | **Planned** - Not started; follows German pilot | After that |

## Community and public site

| ID | Item | Goal | Status | Priority |
|---|---|---|---|---|
| R-110 | Public roadmap kept current | Everyone sees goals and status of each future item | **Done** - Published with the alpha | Next |
| R-111 | Feature-request intake | Ideas and issues get an R-number and a status | **Planned** - Intake forms in progress | Next |
| R-112 | Promote machine families on user reports | A machine family moves to supported after independent successful runs | **Planned** - Rule written | Next |
| R-113 | Custom web address | A short domain for the site | **Planned** - Not started; GitHub Pages first | Later |

## Ideas

| ID | Item | Goal | Status | Priority |
|---|---|---|---|---|
| R-020 | Tool-holder and shank check to full fixtures | Warn about the holder hitting clamps and fixtures, not just the vise | **Idea** - Holder/vise checks exist; general fixtures pending | Idea |
| R-021 | Job preflight: fits the machine, no rapid into stock | Before posting or running, say if the job exceeds travel or a rapid enters stock | **Idea** - Travel and material-fit checks exist; combined preflight unverified | Idea |
| R-055 | Touch-test before probing | Check the probe circuit before every probe routine | **Idea** - Not started; awaiting approval | Idea |
