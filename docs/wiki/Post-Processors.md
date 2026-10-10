# Post-processors

A post-processor (a "post") turns LienCAM's computed toolpaths into the G-code dialect your controller reads. LienCAM has five built-in dialects. Posting them is **supported**.

Your machine's Controller field ([Set up your machine](Set-Up-Your-Machine)) picks the post that Post Process starts on. You can change it in the dialog. See [Post-Process](Post-Process) for the dialog itself.

## The five dialects

### UCCNC

- File extension `.nc`.
- Comments in parentheses.
- Program header `G90 G94 G17 G21 G64` (`G20` when you export in inches).
- Tool change is `T<n> M6`; the M6 itself is the stop, so no extra `M0` is written.
- Dwell `G4` in milliseconds. Work offsets G54 to G59. Home command `G28`.
- Arcs as `G2`/`G3` with I/J centre offsets.

### GRBL

- File extension `.gcode`.
- Comments in parentheses.
- Program header `G90 G94 G17 G21`, with no path-blending word.
- GRBL has no tool-change command, so a tool change is a "change tool" comment and an `M0` pause.
- Dwell `G4` in seconds. Work offsets G54 to G59. Home command `$H`.
- Arcs as `G2`/`G3` with I/J centre offsets. Lines kept within 80 characters.

### grblHAL

- File extension `.nc`.
- Identical to GRBL except for one extra comment at the top of the file, `( grblHAL )`, so the program records which firmware it targets.

### LinuxCNC

- File extension `.ngc`.
- Comments start with a semicolon and run to the end of the line.
- Program header `G90 G94 G17 G21 G64`.
- Tool change is `T<n> M6`; the M6 itself is the stop, so no extra `M0` is written.
- Dwell `G4` in seconds. Work offsets G54 to G59. Home command `G28`.
- Arcs as `G2`/`G3` with I/J centre offsets.

### Generic (linear only)

- Despite the name, it writes arcs unless you turn them off.
- File extension `.nc`.
- The neutral dialect: no dialect-specific header, comments in parentheses, arcs as `G2`/`G3` with I/J (turn off "Emit arcs" for lines only), tool change `T<n> M6` with no extra `M0`, dwell in milliseconds.
- Use it when your controller has no matching built-in dialect, then adjust it in the dialog.

## Your own posts

In the Post Process dialog, "New / Save Post As..." keeps an edited copy under Saved posts, "Share Post..." saves it as a `.lienpost.json` file, and "Import Post..." loads one. Import Post also reads post files from other CAM programs (`.pp`, `.cps`, `.scpost`, `.pst`) as text, without running them. The "About this post" tab shows exactly what the selected post does before you export.

Always read the posted G-code before you run it on a real machine, and keep a hand near the E-STOP.

If something goes wrong, see [Reporting a bug](Reporting-a-Bug).
