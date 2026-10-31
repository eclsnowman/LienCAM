// WO-3283: words for the operation parameter schema (New UI): section captions, the Pocket
// pilot's fields and choices, and the reasons a field shows when its value cannot run.
const ui2Opschema = {
  readOnly: 'This operation cannot be edited right now',
  group: {
    tool: 'Tool',
    geometry: 'Geometry',
    heights: 'Heights',
    passes: 'Passes',
    linking: 'Linking',
    feeds: 'Feeds',
    input: 'Input',
    extent: 'Extent',
    result: 'Result',
    options: 'Options',
    corners: 'Corners',
    advanced: 'Advanced',
  },
  list: {
    item: '{{label}} {{index}}',
    add: 'Add to {{label}}',
    remove: 'Remove {{label}} {{index}}',
  },
  issue: {
    notANumber: '{{field}} needs a number',
    notWhole: '{{field}} needs a whole number',
    belowMin: '{{field}} must be at least {{limit}}',
    notAboveMin: '{{field}} must be more than {{limit}}',
    aboveMax: '{{field}} must be at most {{limit}}',
    entryNotForFill: '{{fill}} cannot start with {{entry}}: choose {{allowed}}',
    or: ' or ',
  },
  pocket: {
    tool: 'Tool',
    clearanceAllowanceMm: 'Shank clearance',
    boundarySource: 'Boundary',
    geometry: 'Geometry',
    direction: 'Milling direction',
    stepdown: 'Stepdown',
    stepover: 'Stepover',
    stockToLeave: 'Stock to leave, walls',
    floorStockToLeave: 'Stock to leave, floor',
    fillStrategy: 'Fill strategy',
    overlapMm: 'Ring overlap',
    stepoverLeadIn: 'Stepover lead-in',
    roundRingCorners: 'Rounded ring corners',
    orderStrategy: 'Multiple pocket order',
    finishContour: 'Finish contour pass on the pocket wall',
    finishPasses: 'Finish passes',
    springPasses: 'Spring passes',
    stayDown: 'Stay down to the finish contour',
    stayDownLift: 'Stay-down lift',
    entryType: 'Entry type',
    helixDiameter: 'Helix diameter',
    rampAngle: 'Ramp angle',
    entryClearance: 'Helix start above material',
    floorHop: 'Floor hop',
    slotFeedPercent: 'Slot feed',
    cornerRelief: 'Corner relief',
    cornerReliefGentle: 'Gentle corner (small orbits)',
    cornerReliefEngagement: 'Max engagement',
    help: {
      clearanceAllowanceMm: 'Clearance kept between the neck, shank or holder and the part or remaining stock',
      stepdown: 'Axial depth of cut per pass',
      stepover: 'Radial engagement between passes',
      stockToLeave: 'Material left on the walls for a finishing pass',
      entryType: 'How the cutter enters each pocket depth',
      helixDiameter: 'Helix path diameter as a percentage of the tool diameter',
      rampAngle: 'Entry descent angle',
      entryClearance: 'How far above the material still standing the helix begins',
      floorHop: 'Lift over cleared floors on travel moves',
      slotFeedPercent: 'Feed where the cutter cuts full width, as a percentage of the cutting feed',
      cornerRelief: 'Cut into each inside corner a round cutter leaves',
      cornerReliefEngagement: 'Widest cut the relief orbits may take; empty follows the tool',
    },
  },
  choice: {
    boundary: { geometry: 'Selected geometry', stock: 'Stock' },
    direction: { climb: 'Climb', conventional: 'Conventional' },
    fill: { outside_in: 'Outside in', inside_out: 'Inside out' },
    leadIn: { none: 'Direct', arc: 'Arc' },
    order: { by_region: 'By region', by_depth: 'By depth' },
    corner: { none: 'None', dogbone: 'Dogbone', t_bone: 'T-bone', longest_edge: 'Longest edge' },
    entry: { plunge: 'Plunge', ramp_linear: 'Profile ramp', ramp_helical: 'Helix' },
  },
} as const

export default ui2Opschema

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'ui2-opschema.wo3283': typeof ui2Opschema
  }
}
