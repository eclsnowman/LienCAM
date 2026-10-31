// WO-3199: wording only. This inventory also supplies the offline Help tables.
export const engraveVcarveFields = [
  {
    "id": "name",
    "label": "Name",
    "text": "Names this operation in the tree and posted program.",
    "scope": "both"
  },
  {
    "id": "tool",
    "label": "Tool / tool search",
    "text": "Chooses the cutter; its diameter, tip angle and flute length determine the cut it can make.",
    "scope": "both"
  },
  {
    "id": "angle",
    "label": "Tip angle",
    "text": "The included angle is twice the angle from the tool axis; a narrower V-bit reaches deeper for the same groove width.",
    "scope": "both"
  },
  {
    "id": "geometry",
    "label": "Geometry / curves / Pick edges",
    "text": "Chooses the drawing curves or model edges to cut; V-Carve needs closed outlines and Engrave can also follow open paths.",
    "scope": "both"
  },
  {
    "id": "loops",
    "label": "All loops / None / loop selection",
    "text": "Includes or removes individual curves from this operation without changing the drawing.",
    "scope": "both"
  },
  {
    "id": "mode",
    "label": "Mode / Trace / V-engrave",
    "text": "Trace follows a curve at the entered depth; V-engrave can work out depth from the requested line width and bit shape.",
    "scope": "engrave"
  },
  {
    "id": "style",
    "label": "Style",
    "text": "Plain follows the line once per depth pass; Trochoidal uses overlapping circular cuts to make a wider slot.",
    "scope": "engrave"
  },
  {
    "id": "slotWidth",
    "label": "Slot width",
    "text": "Sets the total width of the trochoidal slot, including the cutter diameter.",
    "scope": "engrave"
  },
  {
    "id": "advance",
    "label": "Advance per orbit",
    "text": "Sets how far each trochoidal circle advances along the line; smaller values overlap more.",
    "scope": "engrave"
  },
  {
    "id": "widthDepth",
    "label": "Depth from line width",
    "text": "Calculates engraving depth from Target line width and the selected bit angle and tip flat instead of an entered depth.",
    "scope": "engrave"
  },
  {
    "id": "lineWidth",
    "label": "Target line width",
    "text": "Sets the desired groove width at the surface; a wider groove makes the same V-bit cut deeper.",
    "scope": "engrave"
  },
  {
    "id": "depth",
    "label": "Engraving depth",
    "text": "Sets how far the tip cuts below the chosen datum in Flat depth or below the modeled part surface in Follow the surface.",
    "scope": "engrave"
  },
  {
    "id": "engraveFlat",
    "label": "Flat depth (Engrave)",
    "text": "Keeps the cut at one Z below the selected reference plane, rather than following a curved part.",
    "scope": "engrave"
  },
  {
    "id": "follow",
    "label": "Follow the surface",
    "text": "Samples the modeled part under the selected curves and cuts the entered depth below it; it does not sample stock or remaining material.",
    "scope": "engrave"
  },
  {
    "id": "stepdown",
    "label": "Stepdown",
    "text": "Limits the depth added by each pass; V-Carve also accepts 0 for a single depth pass.",
    "scope": "both"
  },
  {
    "id": "axial",
    "label": "Axial offset",
    "text": "Shifts the engraving cut along Z; a positive offset raises it and a negative offset lowers it.",
    "scope": "engrave"
  },
  {
    "id": "open",
    "label": "Open paths",
    "text": "Includes curves whose ends do not meet, such as single-stroke lettering.",
    "scope": "engrave"
  },
  {
    "id": "closed",
    "label": "Closed loops",
    "text": "Includes curves whose ends meet.",
    "scope": "engrave"
  },
  {
    "id": "side",
    "label": "On the line / Left / Right",
    "text": "Places the tool centre on the curve or on its left or right side, measured along the curve direction.",
    "scope": "engrave"
  },
  {
    "id": "sideOffset",
    "label": "Side offset",
    "text": "Sets the sideways distance of the tool centre from the curve when Left or Right is selected.",
    "scope": "engrave"
  },
  {
    "id": "direction",
    "label": "As drawn / Climb / Conventional",
    "text": "Uses the drawn curve direction or chooses the cutting direction for climb or conventional milling.",
    "scope": "engrave"
  },
  {
    "id": "leadIn",
    "label": "Lead-in radius",
    "text": "Sets the radius of the arc that joins the engraving curve; 0 removes the entry arc.",
    "scope": "engrave"
  },
  {
    "id": "leadOut",
    "label": "Lead-out radius",
    "text": "Sets the radius of the arc that leaves the engraving curve; 0 removes the exit arc.",
    "scope": "engrave"
  },
  {
    "id": "bitLimit",
    "label": "Bit's own limit",
    "text": "Limits V-Carve depth to the depth supported by the bit diameter, angle, tip flat and flute length.",
    "scope": "vcarve"
  },
  {
    "id": "flatDepth",
    "label": "Flat depth (V-Carve)",
    "text": "Limits tip depth below Material Start and leaves a flat floor where the outline is too wide for that depth.",
    "scope": "vcarve"
  },
  {
    "id": "startDepth",
    "label": "Start depth",
    "text": "Starts carving this far below the chosen datum, for example at the bottom of an existing pocket.",
    "scope": "vcarve"
  },
  {
    "id": "clearBit",
    "label": "Clear with this bit",
    "text": "Uses the V-bit to clear the flat floors, with the spacing set by Floor stepover.",
    "scope": "vcarve"
  },
  {
    "id": "clearTool",
    "label": "Separate end mill / Clearing tool",
    "text": "Creates a separate flat-clearing operation with the chosen milling tool and keeps it before the V-carve.",
    "scope": "vcarve"
  },
  {
    "id": "leave",
    "label": "Leave floors",
    "text": "Cuts the V-shaped detail and leaves the broad flat floors uncleared.",
    "scope": "vcarve"
  },
  {
    "id": "floorStep",
    "label": "Floor stepover",
    "text": "Sets the sideways spacing between adjacent flat-floor clearing cuts; smaller spacing makes more cuts.",
    "scope": "vcarve"
  },
  {
    "id": "allowance",
    "label": "Allowance",
    "text": "Offsets the outlines before carving: positive grows the carved region and negative shrinks it.",
    "scope": "vcarve"
  },
  {
    "id": "tolerance",
    "label": "Tolerance",
    "text": "Sets how closely the calculated path follows the outline; a smaller value allows less geometric error.",
    "scope": "both"
  },
  {
    "id": "shank",
    "label": "Shank clearance",
    "text": "Sets the gap kept between the part or remaining stock and the non-cutting neck, shank or holder.",
    "scope": "both"
  },
  {
    "id": "clearance",
    "label": "Clearance Height",
    "text": "Sets the high reference used for initial positioning and final exit; it is not a promise about every link move.",
    "scope": "both"
  },
  {
    "id": "retract",
    "label": "Retract Height",
    "text": "Sets the reference height for approach and retract moves between cuts; actual links depend on the operation.",
    "scope": "both"
  },
  {
    "id": "feedHeight",
    "label": "Feed Height",
    "text": "Sets the reference where approach changes from rapid travel to cutting feed; it is not a local surface air gap.",
    "scope": "both"
  },
  {
    "id": "top",
    "label": "Top Height / Material Start",
    "text": "Shows the resolved start of material for the selected depth policy; expand the row to see its source.",
    "scope": "both"
  },
  {
    "id": "bottom",
    "label": "Bottom Height / Target End",
    "text": "Shows the resolved deepest cut for the selected depth policy; curved engraving can cut at many Z values.",
    "scope": "both"
  },
  {
    "id": "reference",
    "label": "Reference plane / height source",
    "text": "Chooses the datum from which the displayed height or depth is measured, such as stock top, model top or WCS zero.",
    "scope": "both"
  },
  {
    "id": "offset",
    "label": "Z offset from plane / height offset",
    "text": "Adds a signed Z distance to the selected reference: positive is above it and negative is below it.",
    "scope": "both"
  },
  {
    "id": "minimize",
    "label": "Minimize Z travel",
    "text": "Lets the path use shorter vertical links where the operation can do so instead of always rising to the full retract reference.",
    "scope": "both"
  },
  {
    "id": "override",
    "label": "Override tool feeds & speeds for this operation",
    "text": "Uses the feed and spindle values entered here for this operation instead of the tool library defaults.",
    "scope": "both"
  },
  {
    "id": "rpm",
    "label": "Spindle speed",
    "text": "Sets cutter revolutions per minute for this operation.",
    "scope": "both"
  },
  {
    "id": "cutFeed",
    "label": "Cutting feed",
    "text": "Sets how fast the tool travels while making ordinary cutting moves.",
    "scope": "both"
  },
  {
    "id": "plunge",
    "label": "Plunge feed",
    "text": "Sets how fast the tool feeds down into material.",
    "scope": "both"
  },
  {
    "id": "ramp",
    "label": "Ramp feed",
    "text": "Sets the feed for a sloping entry where the operation uses one.",
    "scope": "both"
  },
  {
    "id": "leadInFeed",
    "label": "Lead-in feed",
    "text": "Sets the feed along entry moves that join the cut.",
    "scope": "both"
  },
  {
    "id": "leadOutFeed",
    "label": "Lead-out feed",
    "text": "Sets the feed along exit moves that leave the cut.",
    "scope": "both"
  },
  {
    "id": "traverse",
    "label": "Fast traverse feed",
    "text": "Sets the feed for non-cutting feed moves, capped by the machine rapid rate.",
    "scope": "both"
  },
  {
    "id": "finish",
    "label": "Finish feed",
    "text": "Sets the feed for moves marked as finishing cuts where the operation produces them.",
    "scope": "both"
  },
  {
    "id": "entry",
    "label": "Entry type / Plunge / Ramp / Helix",
    "text": "Plunge enters directly; Ramp can use a helical entry for a trochoidal slot when the orbit is large enough, otherwise engraving plunges.",
    "scope": "engrave"
  },
  {
    "id": "rampAngle",
    "label": "Ramp angle",
    "text": "Sets the slope of a supported ramp entry; a smaller angle takes longer to reach depth.",
    "scope": "engrave"
  },
  {
    "id": "rampDiameter",
    "label": "Helix diameter",
    "text": "Sets the diameter of a supported helical entry.",
    "scope": "engrave"
  },
  {
    "id": "edit",
    "label": "Edit depth settings / Edit carve settings",
    "text": "Opens the operation dialog to edit the depth policy and its related fields.",
    "scope": "both"
  },
  {
    "id": "toolSearch",
    "label": "Search tools",
    "text": "Filters the tool list by name, tool number, type or diameter.",
    "scope": "both"
  },
  {
    "id": "toolLibrary",
    "label": "Tool library",
    "text": "Shows tools from the selected library without changing the chosen cutter.",
    "scope": "both"
  },
  {
    "id": "toolUsed",
    "label": "Used in project",
    "text": "Filters the list to tools already used by an operation in this project.",
    "scope": "both"
  },
  {
    "id": "tabs",
    "label": "Hold the part with tabs / Tab width / Tab height / Tab count / Tab shape",
    "text": "These contour holding-tab settings (width, height, count and shape) are shown here but do not change an Engrave toolpath.",
    "scope": "engrave"
  }
] as const

export const fieldsForOperation = (operation: string) => engraveVcarveFields.filter(field => field.scope === 'both' || field.scope === operation)
