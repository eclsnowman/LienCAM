// WO-3257: remappable CAM shortcuts - the Settings editor, the Help map and the tooltip hints.
// Machine-translated against the English catalogue; linguistic review remains owed.
import type { Translation } from '../../index'

const words: Translation<'cam-shortcuts.wo3257'> = {
  section: 'Raccourcis clavier',
  hint: 'Cliquez sur une case de touche, puis appuyez sur la lettre voulue (maintenez Maj si elle doit en faire partie). Entrée applique, Échap annule. Ils fonctionnent en FAO hors Sketch, pas pendant la saisie dans un champ ni avec une fenêtre ouverte.',
  actionSelected: 'Générer l’opération sélectionnée',
  actionAll: 'Générer tous les parcours',
  actionNewOperation: 'Nouvelle opération',
  unassigned: 'Non attribué',
  apply: 'Appliquer',
  clear: 'Effacer',
  restore: 'Rétablir',
  restoreAll: 'Rétablir toutes les valeurs par défaut',
  keyBoxLabel: 'Touche pour {{action}}',
  conflict: '{{key}} est déjà utilisée par « {{action}} ». Effacez ou changez d’abord celle-ci.',
  mapHeading: 'Vos raccourcis FAO',
  mapScope: 'Ils fonctionnent en FAO hors Sketch. Les touches de déplacement, de transport, de Sketch, d’annulation et de suppression ne font pas partie de cette liste.',
  mapTitle: 'Raccourcis clavier FAO de LienCAM',
  mapScopeText: 'Portée : FAO, hors Sketch',
  download: 'Télécharger la carte imprimable des raccourcis FAO',
  downloadName: 'liencam-raccourcis-fao.txt',
  computeToolpath: 'Calculer le parcours ({{key}})',
  computeToolpathNone: 'Calculer le parcours',
  regenerateAll: 'Régénérer tous les parcours ({{key}})',
  regenerateAllNone: 'Régénérer tous les parcours',
  addOperation: 'Ajouter une opération ({{key}})',
  addOperationNone: 'Ajouter une opération',
  computeRegenerate: 'Calculer (régénérer) le parcours de cette opération ({{key}})',
  computeRegenerateNone: 'Calculer (régénérer) le parcours de cette opération',
}

export default words
