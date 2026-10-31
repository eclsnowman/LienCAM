// WO-3227: the Programmed cut group in Tool Library > Cutting Data.
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'tool-cut-calculator.wo3227'> = {
  title: 'Programmierter Schnitt',
  depthOfCut: 'Schnitttiefe (ap)',
  stepover: 'Seitliche Zustellung (ae)',
  engagementAngle: 'Eingriffswinkel',
  maxChip: 'Maximale Spandicke',
  meanChip: 'Mittlere Spandicke',
  removalRate: 'Zerspanvolumen',
  degrees: '°',
  removalUnitMm: 'cm³/min',
  removalUnitInch: 'in³/min',
  rubbing: 'Der maximale Span ist dünner als {{value}}: die Schneide kann reiben statt schneiden.',
  trust: 'Dies schätzt den programmierten Schnitt; tatsächlicher Eingriff, Werkzeugsteifigkeit und Spannkraft wurden nicht geprüft.',
  notApplicableShape: 'Dieser Rechner bildet einen Schaftfräser mit flacher Stirn im Seitenschnitt ab; das Modell gilt nicht für dieses Werkzeug.',
  notApplicableDepth: 'Die Schnitttiefe ist größer als die Schneidenlänge; das Modell gilt nicht.',
  needsNumbers: 'braucht gültigen Durchmesser, Drehzahl, Vorschub, Tiefe und Zustellung',
  needsSpindle: 'braucht Drehzahl und Schneiden',
  noContact: 'keine Zustellung, kein Eingriff',
  stepoverOverDiameter: 'Zustellung ist größer als der Durchmesser',
}

export default words
