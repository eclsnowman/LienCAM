// WO-3250: Spanish, machine-translated and checked against docs/i18n/GLOSSARY-es.md.
// Screen names that still show in English (Engrave, Trace, Plain, Trochoidal,
// Slot width, Tool) stay in English so the text matches what is on screen.
import type { Translation } from '../../index'

const slotCenterline: Translation<'slot-centerline.wo3250'> = {
  card: 'Ranura (línea central)',
  cardTooltip: 'Corta una ranura centrada en las líneas que elija. Crea una operación Engrave en modo Trace sobre la línea, que se guarda y se edita como Engrave.',
  defaultName: 'Ranura',
  plainWidth: 'Plain corta una ranura exactamente del ancho de la herramienta: {{width}} {{unit}}. Elija Trochoidal para una ranura más ancha.',
  plainWidthNoTool: 'Plain corta una ranura exactamente del ancho de la herramienta. Elija una herramienta en la pestaña Tool para ver el ancho.',
  trochoidalRange: 'Trochoidal corta con esta herramienta una ranura de {{min}} a {{max}} {{unit}} de ancho. Un Slot width fuera de ese rango se ajusta al extremo más cercano.',
}

export default slotCenterline
