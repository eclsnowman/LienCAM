// WO-3305: words of the New UI's sketch input (a model sketch as operation geometry).
const ui2SketchInput = {
  group: 'Sketch',
  open: 'Use sketch',
  title: 'Sketches for toolpaths',
  close: 'Close',
  intro: 'A sketch in use is a 2D part: pick its curves and profiles in the view, like any 2D layer. It follows every edit.',
  empty: 'No model sketch is open. Draw one in Model on a plane or a face.',
  available: 'Ready',
  inUse: 'In use',
  use: 'Use',
} as const

export default ui2SketchInput

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'ui2-sketch-input.wo3305': typeof ui2SketchInput
  }
}
