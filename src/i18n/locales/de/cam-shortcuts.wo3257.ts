// WO-3257: remappable CAM shortcuts - the Settings editor, the Help map and the tooltip hints.
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'cam-shortcuts.wo3257'> = {
  section: 'Tastenkürzel',
  hint: 'Klicken Sie auf ein Tastenfeld und drücken Sie dann den gewünschten Buchstaben (mit gedrückter Umschalttaste, wenn sie dazugehören soll). Enter übernimmt, Escape bricht ab. Die Kürzel gelten in CAM außerhalb von Sketch, nicht während Sie in ein Feld tippen und nicht bei geöffnetem Fenster.',
  actionSelected: 'Gewählten Arbeitsschritt berechnen',
  actionAll: 'Alle Werkzeugwege berechnen',
  actionNewOperation: 'Neuer Arbeitsschritt',
  unassigned: 'Nicht belegt',
  apply: 'Übernehmen',
  clear: 'Leeren',
  restore: 'Zurücksetzen',
  restoreAll: 'Alle Standardwerte wiederherstellen',
  keyBoxLabel: 'Taste für {{action}}',
  conflict: '{{key}} wird bereits von „{{action}}“ verwendet. Leeren oder ändern Sie zuerst jenes Kürzel.',
  mapHeading: 'Ihre CAM-Tastenkürzel',
  mapScope: 'Gelten in CAM außerhalb von Sketch. Verfahr-, Transport-, Sketch-, Rückgängig- und Löschtasten gehören nicht zu dieser Liste.',
  mapTitle: 'LienCAM CAM-Tastenkürzel',
  mapScopeText: 'Geltungsbereich: CAM, außerhalb von Sketch',
  download: 'Druckbare CAM-Kürzelübersicht herunterladen',
  downloadName: 'liencam-cam-kuerzel.txt',
  computeToolpath: 'Werkzeugweg berechnen ({{key}})',
  computeToolpathNone: 'Werkzeugweg berechnen',
  regenerateAll: 'Alle Werkzeugwege neu berechnen ({{key}})',
  regenerateAllNone: 'Alle Werkzeugwege neu berechnen',
  addOperation: 'Arbeitsschritt hinzufügen ({{key}})',
  addOperationNone: 'Arbeitsschritt hinzufügen',
  computeRegenerate: 'Werkzeugweg dieses Arbeitsschritts berechnen (neu erzeugen) ({{key}})',
  computeRegenerateNone: 'Werkzeugweg dieses Arbeitsschritts berechnen (neu erzeugen)',
}

export default words
