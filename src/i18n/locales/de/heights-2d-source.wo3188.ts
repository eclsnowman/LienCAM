// WO-3188: German, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const heights2dSource: Translation<'heights-2d-source.wo3188'> = {
  chamferAssumed: 'Diese Kontur hat keine eigene Höhe: Die Fase beginnt an der Oberkante des Materials an dieser Stelle. Wählen Sie hier Rohteil oben, Rohteil unten oder einen Versatz, um sie zu platzieren.',
  geometryAssumed: 'Diese Kontur hat keine eigene Höhe: Geometrie ist die Ebene, auf der sie liegt, Z {{z}} {{unit}}. Wählen Sie hier Rohteil oben, Rohteil unten oder einen Versatz, um den Schnitt zu platzieren.',
}

export default heights2dSource
