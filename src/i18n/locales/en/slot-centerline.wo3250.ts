// WO-3250: the New Operation "Slot (centerline)" shortcut. It authors an
// ordinary Engrave set to Trace on the line; these lines name the card, the
// name it fills in, and the slot width each Style really cuts.
const slotCenterline = {
  card: 'Slot (centerline)',
  cardTooltip: 'Cuts a slot centred on the lines you pick. It makes an Engrave operation set to Trace, on the line, so it saves and edits as Engrave.',
  defaultName: 'Slot',
  plainWidth: 'Plain cuts a slot exactly one tool wide: {{width}} {{unit}}. Choose Trochoidal for a wider slot.',
  plainWidthNoTool: 'Plain cuts a slot exactly one tool wide. Pick a tool on the Tool tab to see the width.',
  trochoidalRange: 'Trochoidal cuts a slot from {{min}} to {{max}} {{unit}} wide with this tool. A Slot width typed outside that range is set to the nearest end of it.',
} as const

export default slotCenterline

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'slot-centerline.wo3250': typeof slotCenterline
  }
}
