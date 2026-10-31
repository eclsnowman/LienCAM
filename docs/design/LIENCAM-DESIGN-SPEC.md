# LienCAM Design Spec v1

Status: **binding for new UI work once adopted** (WO-3095 milestone M1, design study).
Nothing in `src/` follows this spec yet; the app keeps its current design until
the implementation plan (M2) is approved. From then on, every screen, panel,
dialog and icon follows this document, and a change that cannot follow it
changes this document first, in the same review.

The reference implementation of every value below is in
`src/tests/evidence/WO-3095/m1/`:

| File | Contents |
|---|---|
| `tokens.mjs` | The token set |
| `icons.mjs` | The icon family |
| `kit.mjs` | The component builders |
| `contrast.mjs` | The contrast gate |
| `build.mjs` | The pictures |

Where this text and those files disagree, fix whichever is wrong in the same
change.

Words: **MUST** is a rule a review rejects; **SHOULD** is the default that
needs a written reason to break; **MAY** is allowed.

Contents:

1. Principles
2. Themes and colour
3. Type
4. Space, size and density
5. Layout
6. Components
7. States
8. Icons
9. Viewport
10. Accessibility
11. Motion
12. Words
13. Adding a feature without breaking uniformity
14. Identity: what is ours

---

## 1. Principles

1. **One source.** Every colour, size, gap, radius, weight and duration is a
   named token. A value without a name does not ship.
2. **The theme owns colour.** A theme sets every colour on screen, including
   the accent and every icon colour. No workspace, panel, feature or icon
   picks a hue of its own. The fixed exceptions are the viewport toolpath and
   axis colours and the safety red `--stop` (2.4), which no theme may change.
3. **One kit.** Cards, rows, controls, buttons, menus and windows come from the
   kit. A feature composes kit parts; it never draws its own frame, shadow,
   checkbox or button.
4. **Meaning by shape and place, colour by theme.** Users tell a sketch tool
   from a solid tool, and a toolpath from a check, by the icon's shape and by
   where it sits, never by a workspace colour.
5. **Front and centre without clutter.** What the operator needs in normal
   work is one click or one glance away. Rarely used options are folded, never
   removed, and folded sections show their values.
6. **The operator is not refused what the software can do** (LIENCAM.md rule
   11). The UI never greys out a command without saying why, and never hides a
   capability to make a screen look tidy.

## 2. Themes and colour

### 2.1 Roles

A theme is a complete set of the roles below. Adding a role is a spec change.
Every theme MUST fill every role.

| Group | Role (CSS variable) | Use | Never |
|---|---|---|---|
| Surface | `--app` | App bar, behind the document tabs | Card bodies |
| | `--panel` | Card body | |
| | `--head` | Card header and footer, tab row | Body rows |
| | `--view`, `--view-grid`, `--view-grid2` | Viewport ground and grid | Chrome |
| | `--ctl`, `--ctl-hover` | Control fields; hovered row or button | Card grounds |
| Border | `--b1` | Outer edge of a card or window | Inside a card |
| | `--b2` | Header, footer and tab-row rules | Rows |
| | `--b3` | Rows, sections, group dividers | Card edges |
| | `--ctl-bd` | Control outline | Containers |
| Text | `--tx` | Primary text, values | |
| | `--tx2` | Labels, meta, captions | Values the operator reads to act |
| | `--tx3` | Hints, prompts, disabled text, units | Anything the operator must read |
| Accent | `--acc` | Active-tool border, selected row edge, focus ring, primary button fill, checkbox fill, tab underline | Decoration, headings, numbers |
| | `--acc-soft` | Tinted ground of the active tool, selected row, active pick field, active segment | Large areas |
| | `--acc-ink` | Text on panel or soft ground in the accent (selected row name, active tab, pill text) | Body text |
| | `--on-acc` | Text and glyphs on an `--acc` fill | |
| Status | `--ok`, `--warn`, `--err` | Status dots, status pills, check results, destructive confirms; Control's Cycle start, Feed hold and Stop/Reset (control spec 3.5) | Accents, decoration, branding |
| | `--on-err` | Text and glyphs on an `--err` fill (dark text in the dark themes, white in Light) | |
| Safety | `--stop`, `--on-stop` | E-STOP and the ALARM state only. **Fixed: the same red in every theme; no theme may set it** (2.4) | Anything that is not a machine stop or alarm |
| Icon | `--ic-line`, `--ic-top`, `--ic-front`, `--ic-side`, `--ic-edge`, `--ic-acc`, `--ic-acc-fill`, `--ic-acc-fill2`, `--ic-acc-side`, `--ic-guide`, `--ic-bg` | Icons only (section 8) | Chrome |
| Model | `--m-top`, `--m-front`, `--m-side`, `--m-edge`, `--m-floor`, `--m-hole`, `--stock-top`, `--stock-front`, `--stock-side` | Shaded part and stock in pictures and viewport | Chrome |

Fixed across themes and reserved for the viewport, as `docs/ui-ux/COLOR-ROLES.md` already rules:

| Variable | Use |
|---|---|
| `--vp-cut` (`#00e5ff`) | Cut moves |
| `--vp-rapid` (`#ff4444`, dashed) | Rapid moves |
| `--vp-plunge` (`#ff44ff`) | Plunges |
| `--axis-x`, `--axis-y`, `--axis-z` | The axes |

No chrome element may use them. Live cyan stays the live-state marker for
Control as that document says.

### 2.2 Themes in v1

| Theme | Character | Accent |
|---|---|---|
| Default (dark) | Cool graphite, the viewport lighter than the cards | Blue |
| Amber (dark) | Warm graphite (today's Amber theme, carried over) | Amber, with dark text on the accent fill |
| Light | Paper white cards on a light grey ground | Deep blue |

A new theme is a new column in `tokens.mjs`; it MUST pass `contrast.mjs` and
render the kit sheet before it ships. A theme MAY also change the icon roles,
which recolours the whole family at once.

### 2.3 Accent rules

- The accent marks **place and focus**: the active workspace tab, the active
  tool, the selected row, the active pick field, the focused control, the
  primary button. Nothing else.
- One accent per theme. Workspaces do not get their own hues.
- Sketch mode is shown by its context tab and its Exit group (section 6.2),
  not by a colour.
- At most **one primary button** per card or window.
- Status colours never stand in for the accent, and the accent never stands in
  for a status.
- A status colour MUST sit at least 20° of hue from the theme's accent and from
  the other status colours. A warning must never read as a selection: in Amber,
  where the accent is amber, warn is orange and err a true red, never pink.
  `contrast.mjs` checks this.
- Control's run controls take status colours, not the accent: Stop/Reset with
  `--err`, Feed hold with `--warn`, Cycle start with `--ok`
  (`docs/design/control/CONTROL-LAYOUT.md` 3.5).

### 2.4 The safety token

- `--stop` (#e5484d) with `--on-stop` (#13161b) is the one colour no theme
  owns. It lives in `:root`, beside the fixed viewport colours, and a theme
  that sets it is a bug.
- It is worn by E-STOP (armed and latched) and by the ALARM state chip and
  lamp, and by nothing else. An operator who has seen E-STOP in one theme
  knows it in every theme.
- `--stop` is a **fill or an edge, never text**: a stop label is `--on-stop`
  on a solid `--stop` fill (E-STOP, the ALARM chip), or theme text `--tx`
  inside a `--stop` edge (the latched CLEAR control). That keeps one red that
  reads in Light, where red text on the pale ground falls below 4.5:1.
- Every theme's `--warn` MUST sit at least 20° of hue from `--stop`, so an
  orange warning seen alone (Feed hold, an edited or unsaved dot) never reads
  as a stop. `contrast.mjs` checks this together with the label (4.5:1) and
  the fill edge against the panel (3:1).

## 3. Type

Fonts: **DM Sans** for the interface and **JetBrains Mono** for numbers with
units, coordinates, G-code and key caps. Both already ship in `public/fonts`.
No other family.

| Token | Size | Weight | Use |
|---|---|---|---|
| `--f-display` | 28 | 500 mono | Machine position read-out (Control only) |
| `--f-title` | 14 | 600 | Card and window titles |
| `--f-val` | 13 | 400 to 500 mono | Read-out values in stat rows |
| `--f-body` | 12 | 400 | Body, labels, rows, control text |
| `--f-sec` | 11.5 | 600, small caps, +0.04em | Section captions |
| `--f-cap` | 11 | 400 | Ribbon labels, meta, captions, pills |
| `--f-micro` | 10 | 400 to 600 | Key caps, badges, tab key numbers |

Rules:

- Weight carries meaning:
  - 600 for titles, selected names, the active tool label and group rows;
  - 700 only on the primary button;
  - 500 for tabs and filled pick fields.
  - Never bold for emphasis inside a sentence.
- Every number with a unit is mono, tabular, with the unit in `--tx3` inside
  the field or after the value. Decimals are fixed per quantity: lengths 2,
  angles 2, feeds 0, times mm:ss.
- Sentence case everywhere. Small caps only for section captions and the strip
  label.
- No font size outside the table. Code that sets a numeric font size is
  rejected.

## 4. Space, size and density

| Kind | Values | Notes |
|---|---|---|
| Spacing ramp | 2, 4, 6, 8, 12, 16, 24 | Nothing between |
| Card inset | 12 | |
| Gap between related controls | 6 | |
| Gap between cards and from the window edge | 8 | |
| Radius `--r-sm` (4) | Checkbox, key cap, segment, badge | |
| Radius `--r-md` (6) | Every control, button, row highlight, chip | |
| Radius `--r-lg` (8) | Card, window, menu | |

Fixed heights:

| Element | Height |
|---|---|
| App bar | 36 |
| Ribbon tab row | 30 |
| Ribbon group band | 86 (big button 60, small button 20, caption 20) |
| Control | 26 |
| Row | 26 |
| Card header | 40 |
| Card footer | 48 |
| Strip | 44 |
| Navigation bar | 40 (buttons 32) |
| Button | 28 |

Fixed widths:

| Element | Width |
|---|---|
| Browser card | 264 (user-resizable 220 to 400) |
| Properties card | 316 (resizable 280 to 440) |
| Label column | 76, grows to fit the longest label in that card up to 112, never more than 40% of the card |

Density: one density in v1. Interface scale (the existing auto UI scale)
multiplies every size token together; nothing is scaled on its own.

## 5. Layout

![The five screens share one layout](../../src/tests/evidence/WO-3095/m1/png/4-toolpath-dark.png)

The window is one full-bleed viewport with floating cards over it. The parts
and their positions are the same in every workspace:

| Part | Place | Holds |
|---|---|---|
| App bar | Top, full width | Logo, home, save, undo, redo, document tabs, machine status pill, Tool library, settings, help |
| Ribbon card | Under the app bar, 8 from each side | Workspace tabs, command search, the active workspace's tool groups |
| Browser card | Left, under the ribbon, down to the strip | The tree of the active workspace (setups, sketch entities, bodies, operations) |
| Properties card | Right, same height as the browser | The running command or the current selection, never both |
| Strip | Bottom, full width | The workspace's sequence: setups, profiles, feature history with rollback marker, operations, playback |
| Navigation bar | Bottom centre of the view, above the strip | Orbit, pan, zoom, fit, view cube, grid, visibility |
| View cube | Lower left of the clear view, above the strip, beside the Browser card | View orientation; its button opens the View style flyout (shading, grid spacing, height planes, nest seed outline) |
| Show card | Bottom right of the clear view, beside the Properties card (Toolpath and Simulate); its header is the button and the list opens upward | What is drawn in the view (stock, model, fixtures, tool, grid, work origin) and the toolpath move colour key, one eye per row; folds to its header |
| Viewport overlays | Over the view, anchored to geometry | Dimensions, handles, cursor read-outs, labels |

Rules:

- Workspace tabs stay **flat and one click apart**, with number keys 1 to 7.
  This is where LienCAM is faster than a nested workspace menu, and it stays.
- Libraries (Tool library, machines) and Settings are **windows**, opened from
  the app bar, never workspace tabs.
- A card MAY be collapsed to its header or docked (a "docked" layout setting
  places the same cards edge to edge with the same anatomy). A card MUST NOT
  change its anatomy between floating and docked.
- Window sizes are governed by section 5.1.
- **One Sketch workspace for 2D and 3D.** There is no separate 2D-only
  workflow. Sketch carries every tool of the old 2D environment and of the
  3D sketch, and it is where DXF and SVG come in: an import is cleaned up
  (gaps closed, duplicates merged, the report shown) and becomes native sketch
  geometry, saved in the project's JSON. A part drawn only in 2D goes straight
  to Toolpath for flat stock; nobody has to model it. Sketch exports DXF as it
  does today.
- **Sketch geometry is an input like any other.** Every toolpath operation's
  Geometry section takes model faces and edges, or sketch curves and
  profiles, or both, picked the same way. The operation does not care which
  workspace made its input.
- Control uses the same frame (app bar, ribbon card, cards) with two
  deliberate departures, argued in `docs/design/control/CONTROL-LAYOUT.md` 2.1:
  - its ribbon band is a 46 px **machine bar** (connection, state chip, view tabs, layout) in place of the tool-group band;
  - it has **no bottom strip**, so the run controls and console keep the height.

  Its rules for modules that can be moved, hidden or turned off, locked parts
  (stops never move or hide), arrange mode and saved layouts are in that
  document's section 3, which extends this spec with the same MUST/SHOULD
  force.

### 5.1 Window sizes (binding, checked)

![Model at the six target sizes, drawn to the same pixel scale](../../src/tests/evidence/WO-3095/m1/png/sizes-model.png)

The layout MUST work at every target below. Sizes are logical px after
interface scale; the existing auto scale makes a 4K screen at 100 % system
scale the 2560 × 1440 target.

| Target | Typical screen | Class |
|---|---|---|
| 1024 × 600 | Machine-side touch panel | Compact, short |
| 1280 × 720 | Small laptop; 1080p at 150 % | Regular, short |
| 1366 × 768 | Common laptop | Regular |
| 1440 × 900 | Reference for every picture in this spec | Regular |
| 1920 × 1080 | Desktop monitor | Wide |
| 2560 × 1440 | QHD; 4K at auto scale 1.5 | Wide |

Classes come from the window, never from the screen being shown: **Compact**
under 1280 wide, **Regular** 1280 to 1919, **Wide** 1920 and up; **short**
under 760 tall. The values live in `LAYOUT` in `m1/tokens.mjs`.

What changes per class, and nothing else does:

| Class | Change |
|---|---|
| Wide | Browser 300, Properties 360 (still user-resizable). Every other extra pixel goes to the view. |
| Regular | Default widths (section 4). |
| Compact | Browser becomes a 44 px icon rail that opens over the view; Properties 280; command search folds to its icon. |
| short | Group captions hide (the band drops to 72); strip 36; chips 28. |

Folding order when the ribbon does not fit, applied one step at a time until
it fits: (1) small-button columns lose their labels, right to left; (2) whole
groups fold to one button (first icon, group name, menu chevron), right to
left. The group holding the primary or Exit button never folds.

Rules, each enforced by `m1/layout-check.mjs` at every target:

1. **No page scroll.** Card bodies scroll inside themselves; the window never does.
2. **Cards never overlap** each other and never leave the window.
3. **No text is cut off** unless it ends in an ellipsis with the full text in
   a tooltip, or sits inside a scrolling body.
4. **Hit targets** are at least 20 px in both directions.
5. **The ribbon fits** after folding.
6. **The view keeps its share:** the clear view between the side cards,
   under the ribbon and over the strip is at least 50 % of the window width
   and 55 % of its height.
7. **Control:** the preview is the largest region, extra space goes to the
   preview first, and E-STOP, Feed hold and Stop are fully shown and on top
   at every size, the preview never loses area as the window grows, and a size
   class never reorders modules: Jog stays at the top right unless the
   operator moves it
   (`docs/design/control/CONTROL-LAYOUT.md`). Every size picture is labelled
   with the clear view's or the preview's size in pixels.
8. **Interface scale** multiplies every size token together; nothing is
   scaled on its own, and classes are read after scaling. Scale runs from
   75 % to 150 % with Auto: below 100 % fits more on a small or
   low-resolution screen (at 80 % a 1024 x 600 panel lays out as 1280 x 750),
   and the 20 px hit-target floor is checked after scaling.

`node src/tests/evidence/WO-3095/m1/build.mjs sizes` renders every screen,
Control included, at every target, runs the check and writes `m1/LAYOUT-CHECK.md`; it exits 1 on
any failure. A layout change MUST pass it before review. M2 ports the same
rules into the app's own Playwright suite, so the shipped layout is held to
them too.

**Dense tools are windows.** The Tool library, machine definitions, post
processors, settings and other information-dense tools open as full-screen or
partial-screen windows (section 6.11) with their own navigation, instead of
being squeezed into the cards. They follow the same classes and rules.

**Tool profile.** A tool is drawn and simulated from its profile: steps from
the tip up, each with a lower diameter, an upper diameter and a length, so a
step with two diameters is a taper (a 1/4 in cutter on a 3/8 in shank). The
Tool library edits the steps the way it already edits holder segments. Today
the app stores holders as segments but tools only as shank diameter, shoulder
length and neck (with a transition angle for thread mills); the general tool
profile is an M2 data change.

## 6. Components

### 6.1 App bar
- 36 high, `--app` ground, `--b2` bottom rule.
- Icon buttons 26 square, monochrome glyphs in `--tx2`.
- The document tab sits on the bar's bottom edge in `--panel` with a `--b1` outline.
- The machine status pill shows the connection state with a status dot. It is the only place a connection state shows outside Control.

### 6.2 Ribbon

**Tab row (30).** Workspace tabs, each with its number key in `--f-micro`.
The active tab is `--acc-ink`, weight 600, with a 2 px `--acc` underline.
Command search sits at the right end, 22 high with a `/` key cap. Search runs
any command by name and shows its ribbon place.

**Group band (86).** Groups of tools, separated by `--b3` hairlines. Each group
has a caption row (20) with a ▾ that opens the group's full menu.

There are exactly two button forms:

| Form | Size | Icon | Label | Use |
|---|---|---|---|---|
| Big | 60 high, 54 to 76 wide | 32, above the label | Up to two lines, `--f-cap` | The most used tools of the group |
| Small | 20 high, stacked three to a column | 16, left of the label | One line | The rest |

- A tool with variants shows a small ▾ after its label; the variants open in a menu, and the last used variant becomes the button.
- **Active tool:** `--acc-soft` ground, 1 px `--acc` border, label in `--acc-ink` 600.
- **Primary command of a group** (Generate, New setup, Finish): label 600, no colour.

**Overflow, in this order:**
1. Big buttons narrow to their minimum.
2. Big buttons become small.
3. Whole groups fold into their caption button, which opens the full group.
4. Groups fold into a » menu at the right.

A tool is never dropped, and never greyed out to save room.

**Context mode (Sketch).** Entering a sketch swaps the band to sketch tools.
The Sketch tab shows "Editing Sketch 2" in the tab's own place. **Finish** and
**Cancel** are always the last group, captioned "Exit". The same pattern
applies to every other edit mode, each with its own Exit group. The v1 context
modes are:

| Mode | Where |
|---|---|
| Sketch | Model, Setup |
| Form | Model |
| Relief | Model |
| Drawing | Model; the sheet takes the view |
| Nest | Setup |
| Block edit | Inside Sketch |

Each is mapped in `docs/design/inventory/` (M08, M09, M10, M27).

A mode is not a tab: Exit returns to the workspace it was entered from. No
feature adds a workspace tab; `docs/design/MISFIT-HOMES.md` places every
misfit in Setup, Sketch, Model, Toolpath, Simulate, Control, a window or the
Home menu.

### 6.3 Card
- `--panel` ground, `--b1` 1 px outline, `--r-lg`, the theme's single shadow.
- Header (40), `--head` ground with a `--b2` rule below. Left to right:
  - command icon 20;
  - title (`--f-title` 600);
  - an optional status pill;
  - space;
  - the overflow menu (⋯);
  - close.
- Body: section list, no extra padding around sections.
- Footer (48), `--head` ground with a `--b2` rule above. Left to right:
  - at most one ghost action (Preview, Probe…, Reset);
  - space;
  - Cancel;
  - the one primary action.
- Cards never nest. A card inside a card is a section.

### 6.4 Sections
- Header row 26: chevron (down when open, right when closed), caption in
  `--f-sec` small caps `--tx2`, and at the right a one-line summary of the
  section's values in `--f-cap` `--tx3`.
- The summary is always shown, open or closed, so a folded section still tells
  its state ("helix 2°", "8 000 rpm · 1 600 mm/min").
- Body: inset 12 on the sides and bottom, 6 between rows. Sections are divided
  by `--b3`.
- Order inside an operation: **Tool, Geometry, Heights, Passes, Linking,
  Feeds**, then type-specific sections. Order inside a feature: **Input, Extent,
  Result**, then options. Rarely changed sections start folded.

### 6.5 Property row and controls
A property row is the label column plus one control, 26 high. Controls:

| Control | Anatomy | When |
|---|---|---|
| Number field | `--ctl` ground, `--ctl-bd` outline, `--r-md`, mono value left, unit right in `--tx3`. Accepts expressions and parameters. | Any quantity |
| Axis pair or trio | Two or three number fields, each with an X, Y or Z prefix in `--tx3` 700 | Coordinates, offsets |
| Select | Field with a chevron | More than four choices |
| Segmented | 2 to 4 options in one field; the active option is `--acc-soft` with an `--acc` inset line | 2 to 4 exclusive choices. **No radio buttons.** |
| Checkbox | 14 square, `--r-sm`; on = `--acc` fill with a `--on-acc` check. Two per row in dense sections. | Independent on/off |
| Pick field | See below | Any geometry input |
| Tool row | Tool icon, name (600), one line of meta, chevron | Tool choice in an operation |
| Figure slot | A `--head` ground, `--b3` outline, `--r-md` frame holding a small diagram | Heights, lead-in, tool shape |
| Stat row | Label `--tx2` left, value mono `--f-val` right, `--b3` divider | Read-only results |

**Pick field, three states:**

| State | Look | Meaning |
|---|---|---|
| Active | `--acc` border, `--acc-soft` ground, `--acc-ink` text, count badge on `--acc` | Waiting for picks now |
| Filled | `--ctl-hover` ground, neutral count badge, clear (×) button | Has picks, not active |
| Empty | `--ctl` ground, prompt in `--tx3` italic | Optional or not started |

Only one pick field is active at a time. Clicking a filled field makes it
active.

### 6.6 Buttons
| Kind | Look | Use |
|---|---|---|
| Primary | `--acc` fill, `--on-acc` text 700 | The one action that completes the card |
| Secondary | `--ctl` ground, `--ctl-bd` outline | Cancel, other complete actions |
| Ghost | No ground or border, `--tx2` | One side action in a footer, toolbar actions |
| Danger | `--err` text on secondary; confirm step | Delete, discard. Never for machine stops (Control spec) |
| Icon button | 26 square (32 in the navigation bar), monochrome | Header and toolbar actions |

All buttons are 28 high with `--r-md` corners and 12 side padding.

### 6.7 Browser rows
- 26 high, one font. Left to right:
  - indent 16 per level;
  - chevron;
  - icon 18;
  - name;
  - at the right, meta in `--f-cap` `--tx3`;
  - a 7 px status dot (`--ok`, `--warn`, `--err`, or none).
- Group rows: name 600, count as meta.
- Selected: `--acc-soft` ground with a 2 px `--acc` left edge, name in `--acc-ink` 600.
- Hover: `--ctl-hover` ground, and the row actions (visibility, ⋯) appear in place of part of the meta. **Row actions show only on hover or selection.**
- Suppressed or not yet run: name in `--tx3`.
- Names never wrap; they end with an ellipsis, and the full name shows in a tooltip.

### 6.8 Strip
- One card, 44 high.
- At the left, a small-caps label naming the sequence.
- Then chips: 32 high, `--r-md`, icon 20 with an optional label. The current chip uses the active-tool look.
- Feature history shows a 2 px `--acc` rollback marker after the last active feature; later features show at 45% opacity.
- Status pills and totals sit at the right.

### 6.9 Pills, badges, tooltips, menus
- **Pill:** 22 high, radius 11, `--f-cap` 600.
  - Neutral: `--b1` outline.
  - Accent: `--acc-soft` with `--acc-ink`.
  - Status: a status tint (16% of the status colour) with the status colour as text.
- **Badge:** `--f-micro` mono, 16 high, `--r-sm`.
- **Menus** are cards without header or footer: rows 26, `--b3` dividers between groups, key hints right-aligned in mono.
- **Tooltips:** `--panel`, `--b1`, `--r-md`, one line plus the shortcut, after 500 ms.

### 6.10 Control parts
Control adds kit parts specified in `docs/design/control/CONTROL-LAYOUT.md` 3.7:

- module header (32 high);
- machine bar;
- state chip;
- transport button;
- E-STOP (armed and latched);
- input lamp;
- DRO row (position in `--f-display`);
- jog pad;
- override stepper;
- the Arrange window;
- a set of monochrome machine glyphs.

They follow this section's anatomy and the tokens; nothing else uses them.

### 6.11 Windows and confirms
- Settings, the Tool library and the machine library are windows: a card at
  80% of the window, same header and footer, with a left navigation list in
  browser-row style.
- A confirm is a small card with a title, one sentence saying what will happen,
  Cancel, and the action named by its verb ("Delete 3 operations"), never "OK".

## 7. States

| State | Look | Rule |
|---|---|---|
| Hover | `--ctl-hover` ground | Never changes size or weight |
| Focus | 2 px `--acc-soft` ring outside a 1 px `--acc` border | Always visible for keyboard focus |
| Active tool, selected | `--acc-soft` + `--acc` edge + `--acc-ink` 600 | One look everywhere |
| Held (momentary, while pressed) | Solid `--acc` ground, `--on-acc` text and glyph, sunk 1 px with an inner shadow | Only while the press lasts; never left on |
| On (latched) | `--acc-soft` ground, `--acc` edge, `--acc-ink` text, and a lit lamp | Every latched control carries a lamp, hollow when off |
| Unavailable | No fill, dashed `--b1` edge, `--tx3` text; a lock glyph when an interlock holds it | Only when the software truly cannot run the command now. The tooltip MUST say why and what makes it available. Never only greyed out. |
| Running | Accent pill "running" in the header; strip shows progress | Live machine state follows the Control spec |
| Edited, unsaved | `--warn` status pill "edited"; `--warn` dot on the row | |
| Error | `--err` dot on the row; the section with the problem opens and names it in one line | Fix-it text says what the software did or needs, not what the user did wrong |
| Empty | One line in `--tx2` and the one command that fills it | No illustrations |
| Loading | The card keeps its anatomy; values show `—` in `--tx3` | No spinners over 300 ms without a label |

### 7.1 Action states (binding)

![Action states](../../src/tests/evidence/WO-3095/m1/png/states-dark.png)

Every control that acts is one of four kinds, and each kind looks the same
everywhere, on Control and in the workspaces:

- **Momentary** acts while pressed (a command, a jog key, Step, a macro). It
  is raised at rest and turns solid accent and sunk only while held.
- **Latched** stays on until pressed again (coolant, vacuum, Single Block, a
  panel toggle). It always shows a lamp: hollow when off, lit when on, so a
  toggle never looks like a command.
- **Choice** is one of several (jog step, units, spindle direction). The
  selected segment is its on state; it has no lamp.
- **Transport** keeps its status colours (start green, hold amber, stop red)
  and follows the same held and unavailable rules; Feed hold lights while the
  machine is held. E-STOP keeps its own rules (2.4).

A control never relies on colour alone: held also sinks, on also lights a
lamp, unavailable also dashes its edge. `src/tests/evidence/WO-3095/m1/states.mjs`
draws the sheet.

## 8. Icons

![The LienCAM icon family in three themes](../../src/tests/evidence/WO-3095/m1/png/icons.png)

### 8.1 The LienCAM icon grammar (v2)

Icons v2 replaced the M1 oblique family after the owner's review: M1 drew almost every solid as
the same thin plate, so fillet, extrude, revolve and the toolpaths did not say what they do.
`src/tests/evidence/WO-3095/m1/ICON-AUDIT.md` records, for every command, what it does, what M1
showed and what v2 shows.

| Rule | Value |
|---|---|
| Canvas | 48 units, rendered at 16, 20, 24 or 32 px |
| Two kinds | **Solid** (Setup, Model, Toolpath, most of Simulate) and **flat** (Sketch, Drawing, Post, transport, constraints) |
| Solid view | One **engineering view**: a front-dominant trimetric (x right and down 17 degrees, y receding left and down 46 degrees at 0.78). Not the symmetric isometric most icon sets use. Every solid is fitted to the same 39-unit live area, so a hole icon and a vise icon read at the same size |
| One light | Top `--ic-top` lightest, left `--ic-front`, right `--ic-side` darkest. Curved faces are faceted into the same three tones, never gradients |
| The result | What the command makes is a **pale accent solid with a dark accent edge**: `--ic-acc-top`, `--ic-acc-left`, `--ic-acc-right`, outlined in `--ic-acc-line`. Inputs are neutral, outlined in `--ic-line` |
| The machined edge | A 1.1-unit `--ic-edge` line just inside every visible top edge of a prism: the LienCAM signature, an edge that catches the light |
| Hero | **What the command creates or changes is the accent**; everything it works on is neutral. Fillet: only the round. Extrude: the new solid. Pocket: the pocket walls |
| Toolpaths | Drawn as 2.2-unit lines in `--ic-acc-side` on a neutral part (in `--ic-acc` when no part is drawn); a tool appears only when it explains the operation (drill, V-bit, ball, thread mill) |
| Outline | 1.3 units, round joins, on every solid (`--ic-line` neutral, `--ic-acc-line` accent); faceted surfaces get one silhouette outline |
| Action | At most one action arrow per icon: 2.6 units, round caps, `--ic-acc`, **open chevron** head |
| Flat strokes | 2.6 units in `--ic-acc` for the geometry the command makes; existing geometry in `--ic-front`; construction dashed in `--ic-guide` |
| Sketch vertices | Hollow **squares** (4.4 units) in `--ic-bg` outlined in `--ic-acc`; a filled square marks the point that matters |
| Constraints | Inside a rounded-square **badge** (radius 8) tinted with `--ic-acc-fill` |
| Tags | A round 15-unit tag at a corner: plus (new), check (confirm), in (import), calc (compute), eye (show), label (mark), send, play (simulate only); the remove tag is `--err` |
| Signal | `--err` only for remove, trim-away, stop and collision |
| Letters | Only where the standard symbol is a letter: G1, G2, R, the diameter sign, 2x, M0, fx, 2:1, PDF, a balloon number, sketch text |
| Documents and transport | A third register: filled sheet and playback glyphs (page with folded corner; play, step) drawn with the same outline and tags |
| Forbidden | Gradients, shadows, photographs, brand marks, fixed colours, isometric, oblique or perspective views |

### 8.2 Meaning by shape

| Family | Shape language |
|---|---|
| Setup | Workholding and stock drawn as real objects (vise jaws, strap clamps, fixture plate); the part or the thing being set in the accent |
| Sketch | Flat strokes with square vertices; constraints in badges |
| Model | A neutral body with the result in the accent (the round, the bevel, the new solid, the hole walls) |
| Toolpath | A neutral part, the cut region in the accent, the path in the dark accent; each operation has its own path shape (raster, offset rings, trochoid loops, level rings, spiral, helix) |
| Before and after | What the command removed or replaced is a dashed guide outline where it was (the sharp corner of a fillet or chamfer, the faced layer), so the change reads without an arrow |
| Flat tones | A result face is one tone: a round or bevel is a single flat accent face, never banded, so the icon holds at 16 px. Shading comes only from the one light (top, left, right) |
| Inspect | Plain instruments: a ruler for measure, the quartered centre-of-mass mark, a section plane |
| Simulate | Playback glyphs, display toggles, and checks (signal colour only when something is wrong) |
| Commands and windows | Monochrome glyphs (`currentColor`), 1.5 stroke on a 16 grid, for chrome only (close, search, chevrons, navigation) |

Because meaning lives in the shape, a theme recolours the whole family through
the `--ic-*` roles, and the same tool looks the same in every ribbon.

### 8.3 Adding an icon
1. Write its row in `icon-intent.mjs` first: what the command does, and what the icon will show.
2. Draw it from the helpers in `icons.mjs` only: `solid` (fit), `box`, `prismZ`, `prismX`,
   `prismY`, `lathe`, `tube`, `sink`, `sphere3` for solids; `path`, `arrow`, `chev`, `vx`,
   `badge`, `sheet`, `tag` for flat parts.
3. Check it at 24 px in all three themes on the icon sheet, then run `icon-audit.mjs`.
4. It MUST NOT reuse another command's drawing; each operation has its own icon.
5. Check it side by side with the nearest icon of any other CAD/CAM product. Take the intent
   (what a fillet icon must say), never the composition. If the shape, view and accent
   placement all match, redraw it.
6. A blind read decides: someone who has not seen the label names the command from the icon.

The icons that the inventory's proposals still need are listed in
`docs/design/inventory/FEATURE-INVENTORY.md` ("Icons the solutions need").
That list shrinks as `icons.mjs` gains them.

## 9. Viewport
- Ground `--view` with a 24 px minor and 120 px major grid. In dark themes the
  view is lighter than the cards so the model stands forward.
- Part shading uses the `--m-*` roles; stock uses the `--stock-*` roles.
  Selection and previews in the view use `--acc` and `--acc-soft`.
- Toolpath moves use the app's ten move roles (`MOVES` in `m1/tokens.mjs`:
  cut, rapid dashed, fast traverse, helix and ramp, plunge, retract, finish,
  stepover, wall follow, lead in and out), with a darker set on the light
  canvas. They are viewport colours only, never chrome.
- **Show card** (Toolpath and Simulate): object visibility, then the move
  colour key, one eye per row, a count of moves shown in its header. It sits
  at the bottom right of the view with its header as the button, opens
  upward, folds to its header and remembers its state. It is the one place visibility is
  set; ribbons and Properties do not repeat it.
- **Tool body** (Simulate and Control's preview): the tool is drawn
  see-through (alpha 0.55) so the cut stays visible as it moves along the
  toolpath. The flutes are green (`--tool-flutes`, may cut); the shank,
  collet, holder and spindle nose are red (`--tool-noncut`, must never
  touch), for collision review. Both are the app's own colours, fixed across
  themes, and viewport only. The Show card lists both with their swatches.
- **View cube** at the lower left of the view, with the **View style** button
  beside it: shading (with edges, shaded, wireframe, translucent), grid
  spacing, height planes with their colours, nest seed outline.
- On-view read-outs (dimension values, cursor length and angle) use a small
  card: `--panel`, `--b1`, `--r-md`, mono text.
- **Prompt bar** (one component for every pick prompt): one line at the top
  centre of the view, a small card with the prompt in `--tx`, an `Esc` key cap,
  then Cancel and Done. It replaces the separate confirm bars today
  (inventory M23).
- **Anchored value**: a number field in a small card beside the geometry it
  edits (extrude distance, hole depth), with the same anatomy as a Properties
  number field; Enter applies, Esc cancels. It mirrors the Properties field,
  never replaces it.
- Mode badges and duplicate machine labels over the view are removed; the
  active tab and the machine pill already say it (inventory M25).

## 10. Accessibility
- **Contrast floor, every theme:** text pairs at least 4.5:1, component
  boundaries and accent marks at least 3:1. Status hues are at least 20° from
  the accent and from each other, and every warn is at least 20° from the
  fixed stop red. `contrast.mjs` checks every theme and fails
  below the floor (all three v1 themes pass).
- Colour is never the only carrier: status dots pair with a word in the row's
  tooltip or meta; the active tool also has a border; errors also name the
  problem.
- Every command is reachable by keyboard:
  - number keys 1 to 7 switch workspaces;
  - `/` opens command search;
  - Tab moves through card controls in reading order;
  - Esc cancels the running command;
  - Enter runs the primary action.
  - Single-key sketch tools stay.
- Hit targets are at least 24 px; ribbon and navigation buttons are larger.
- Honour the system's reduce-motion setting.
- Interface scale (existing auto UI scale) scales all tokens together.

## 11. Motion

| Motion | Duration | Notes |
|---|---|---|
| Fold or unfold a section | 120 ms | Ease out |
| Card enter or exit | 160 ms | Fade plus 4 px slide |
| Ribbon band swap on a context change | 120 ms | Cross-fade |

- No looping animation in chrome.
- Progress indicators show a label and a value.

## 12. Words
- Labels name the thing, in sentence case and without a colon: "Step down",
  not "Step-Down:".
- Commands are verbs ("Generate", "Finish"); confirms name the result.
- Units always appear: in the field, in the summary and in the read-out.
- A refusal or warning follows LIENCAM.md rule 11: the software does what it
  can, says what it did in one line, and refuses only what it cannot do.

## 13. Adding a feature without breaking uniformity

Before any new UI ships, answer these in the change description:

1. **Where does it live?** One of:
   - a ribbon group;
   - a browser row type;
   - a Properties section;
   - a strip chip;
   - an app-bar item;
   - a window;
   - a viewport overlay.

   If none fits, the spec changes first (in the same review), and the
   inventory's "does not map" list (`docs/design/inventory/`) gains a row.
2. **Which kit parts?** Only parts from section 6. A new part is a spec
   change, with a kit-sheet render in all themes.
3. **Which tokens?** None new. If a value is needed, it is added to the token
   set with a role name and a row in section 2 or 4.
4. **Which icon?** Drawn by section 8.3. Never a stock icon set, never another
   product's icon.
5. **States?** Hover, focus, selected, disabled-with-reason, error, empty and
   loading, as section 7.
6. **Checks:**
   - the kit sheet and the affected screens rendered in every theme;
   - `contrast.mjs` passes;
   - no raw colour, font size or radius;
   - no raw control outside the kit.

   M2 decides how these checks become build gates.

## 14. Identity: what is ours

The reference design system the owner pointed to taught the **discipline**:

- named tokens;
- one kit with gates;
- one icon guide;
- a context ribbon;
- floating cards;
- folded sections.

LienCAM shares those principles and none of the look. What is ours:

| Area | Reference approach | LienCAM |
|---|---|---|
| Icon projection | Isometric | Oblique drafting view |
| Solid edge | Plain | Machined-edge chamfer band |
| Sketch vertices | Round | Hollow squares |
| Joins on solids | Round | Mitred |
| Direction marks | Filled heads | Open chevrons |
| Constraints | Bare glyphs | In badges |
| Colour of meaning | Fixed hues per category | Theme roles; meaning by shape |
| Workspace colour | Per-tab accent | One theme accent |
| Workspaces | Behind a menu | Flat one-click tabs with number keys |
| Fonts | Their own | DM Sans and JetBrains Mono |
| Palettes | Their own | Our Default, Amber and Light themes |

The side-by-side check of icons against the reference is kept outside the
repository; no reference asset is stored here.
