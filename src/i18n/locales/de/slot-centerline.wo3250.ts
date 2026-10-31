// WO-3250: German, machine-translated and checked against docs/i18n/GLOSSARY.md.
// Screen names that still show in English (Engrave, Trace, Plain, Trochoidal,
// Slot width, Tool) stay in English so the text matches what is on screen.
import type { Translation } from '../../index'

const slotCenterline: Translation<'slot-centerline.wo3250'> = {
  card: 'Nut (Mittellinie)',
  cardTooltip: 'Fräst eine Nut mittig auf den gewählten Linien. Es entsteht ein Engrave-Arbeitsschritt mit Trace auf der Linie; er wird als Engrave gespeichert und bearbeitet.',
  defaultName: 'Nut',
  plainWidth: 'Plain fräst eine Nut von genau einer Werkzeugbreite: {{width}} {{unit}}. Für eine breitere Nut Trochoidal wählen.',
  plainWidthNoTool: 'Plain fräst eine Nut von genau einer Werkzeugbreite. Wählen Sie auf dem Reiter Tool ein Werkzeug, um die Breite zu sehen.',
  trochoidalRange: 'Trochoidal fräst mit diesem Werkzeug eine Nut von {{min}} bis {{max}} {{unit}} Breite. Eine Slot width außerhalb dieses Bereichs wird auf das nächstliegende Ende gesetzt.',
}

export default slotCenterline
