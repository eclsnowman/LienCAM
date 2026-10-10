// The EAGER help index entries for Form's topics (collected by
// src/help/index-data.ts, listed under Modeling). The help census asserts each
// one matches its topic in ./index.ts FIELD FOR FIELD - edit both together
// (npx vite-node src/tests/evidence/WO-2252/gen-entries.ts form prints them).

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'form-workspace',
    title: 'Form (smooth organic shapes in the Model tab)',
    category: 'modeling',
    summary: 'Form shapes smooth organic parts - knobs, handles, grips - by moving a coarse control cage; a smooth surface follows it, and Finish Form makes it an exact solid in the design tree.',
    keywords: 'form subd subdivision catmull clark organic smooth cage skin knob handle grip start from box cylinder sphere torus plane pipe extrude revolve loft face from body segments move rotate scale gizmo alt drag extrude soft flatten straighten uniform pull pull to body insert loop crease uncrease weight insert point add face chain subdivide weld weld close unweld loop ring grow shrink all delete fill hole bridge thicken mirror circular between duplicate symmetry display cage both smooth tolerance level palette fold scroll finish exact bspline body undo redo limits',
    contextKeys: ['interaction:form', 'workspace:part'],
  },
  {
    id: 'form-walkthrough-lobed-knob',
    title: 'Form example: lobed knob',
    category: 'modeling',
    summary: 'A video of a four-lobed control knob made in Form and finished with a shaft, a bore and a fillet - with the steps beside it and an Open this example button for the finished project.',
    keywords: 'form example walkthrough tutorial video lobed knob control knob circular symmetry lobes valleys crown crease shaft bore hole fillet zebra open example project',
    contextKeys: ['interaction:form', 'workspace:part'],
  },
  {
    id: 'form-walkthrough-grip-handle',
    title: 'Form example: grip handle',
    category: 'modeling',
    summary: 'A video of a pull handle made as a Form pipe along a sketch, shaped by hand and joined to a machined mounting plate - with the steps beside it and an Open this example button for the finished project.',
    keywords: 'form example walkthrough tutorial video grip handle pull handle pipe along sketch arch palm swell soft mirror plate fillet offset plane mounting holes cut zebra open example project',
    contextKeys: ['interaction:form', 'workspace:part'],
  },
]
