// WO-2939: UI around G-code only; executable text and key names remain literal.
import type { Translation } from '../../index'
const words: Translation<'gcode-editor'> = {
  editor: {
    label: 'Éditeur G-code', goToLine: 'Aller à la ligne', go: 'Aller', find: 'Rechercher', findPlaceholder: 'Rechercher', replacePlaceholder: 'Remplacer par',
    findNext: 'Suivant', findPrevious: 'Précédent', replace: 'Remplacer', replaceAll: 'Tout remplacer', noMatches: 'Aucun résultat', matchOf: '{{index}} sur {{count}}',
    matchCount: '{{count}} résultats', replacedCount: '{{count}} remplacés', undo: 'Annuler', redo: 'Rétablir', undoTip: 'Annuler (Ctrl+Z)',
    redoTip: 'Rétablir (Ctrl+Y ou Ctrl+Shift+Z)', findTip: 'Rechercher et remplacer (Ctrl+F)', goToTip: 'Aller à la ligne (Ctrl+G)',
    position: 'Lig. {{line}}, col. {{column}} - {{lines}} lignes', readOnly: 'Lecture seule', markedLine: 'Ligne {{line}} : {{message}}',
    markTip: 'La lecture s’arrête à cette ligne : {{message}}', close: 'Fermer',
  },
  menu: {
    title: 'Ligne {{line}}', runFromHere: 'Exécuter à partir d’ici', insertLine: 'Insérer une ligne',
    insertPlaceholder: 'Nouvelle ligne après la ligne {{line}} - Enter pour ajouter, Esc pour annuler', findReplace: 'Rechercher / Remplacer',
    find: 'Rechercher', goToLine: 'Aller à la ligne', undo: 'Annuler', redo: 'Rétablir',
  },
  changes: {
    none: 'Aucune ligne modifiée', addedOne: '1 ligne ajoutée après la ligne {{after}}', addedMany: '{{count}} lignes ajoutées après la ligne {{after}}',
    addedAtStartOne: '1 ligne ajoutée au début', addedAtStartMany: '{{count}} lignes ajoutées au début', removedOne: 'ligne {{from}} supprimée',
    removedMany: '{{count}} lignes supprimées à partir de la ligne {{from}}', replacedOne: 'ligne {{line}} modifiée', replaced: 'lignes {{from}}-{{to}} remplacées par {{count}} lignes',
    replacedByOne: 'lignes {{from}}-{{to}} remplacées par 1 ligne', replacedLine: 'ligne {{line}} remplacée par {{count}} lignes', several: '{{changed}} lignes modifiées à {{places}} endroits',
  },
  post: {
    edit: 'Modifier', editTip: 'Modifier ce G-code manuellement. Exporter et Envoyer à la commande utilisent vos modifications.', handEdited: 'Modifié manuellement : {{summary}}',
    discardEdits: 'Abandonner les modifications', discardEditsTip: 'Revenir au programme généré en abandonnant vos modifications manuelles',
    staleEdits: 'Le post-processeur a changé depuis votre modification de ce programme. Une nouvelle génération remplace vos modifications manuelles ({{summary}}).',
    keepEdits: 'Conserver mes modifications', keepEditsTip: 'Conserver le texte modifié ; Exporter et Envoyer à la commande l’utilisent', repost: 'Générer à nouveau',
    repostTip: 'Utiliser le nouveau post-processeur et abandonner vos modifications manuelles', sendToControl: 'Envoyer à la commande',
    sendToControlTip: 'Charger ce programme dans l’espace Commande, exactement tel qu’il est affiché ici',
    sendToControlSeparateTip: 'Charger le fichier affiché ({{name}}) dans l’espace Commande, exactement tel qu’il est affiché ici',
    sentToControl: '{{name}} envoyé à la commande ({{lines}} lignes){{edited}}', sentEdited: ', modifié manuellement : {{summary}}', exportedEdited: '{{name}} exporté avec modifications manuelles : {{summary}}',
  },
  control: {
    editNothingTip: 'Chargez d’abord un programme', stagedNotRun: 'Cette exécution utilise le programme chargé ; vos modifications en attente ({{summary}}) n’y figurent pas - appliquez-les d’abord pour les exécuter.',
    stagedDropped: 'Les modifications en attente de « {{old}} » ont été abandonnées : « {{now}} » a été chargé à sa place.', title: 'Modifier le programme - {{name}}',
    apply: 'Appliquer', applyTip: 'Charger le programme modifié à la place du programme actuel', applyUnchangedTip: 'Aucune modification pour le moment', saveFile: 'Enregistrer dans un fichier',
    saveFileTip: 'Enregistrer le texte modifié dans un fichier G-code', discard: 'Abandonner', discardTip: 'Abandonner les modifications en attente ; le programme chargé reste inchangé',
    close: 'Fermer', closeTip: 'Fermer l’éditeur', closeStagedTip: 'Fermer l’éditeur. Vos modifications restent en attente jusqu’à Appliquer ou Abandonner.',
    runningReadOnly: 'Le programme est en cours ou en pause. Le contrôleur conserve le programme en cours, qui ne peut donc pas être modifié pendant son exécution - appuyez sur Arrêt (ou Reset) pour le modifier.',
    edited: 'Programme modifié : {{summary}}', savedFile: 'Programme modifié enregistré sous {{name}}', refused: 'Le programme modifié n’a pas été chargé : {{reason}}',
    postedForEdit: 'Ce programme a été chargé depuis les parcours du montage ; l’éditeur l’affiche donc généré pour {{controller}}. Appliquer charge le texte modifié comme fichier.',
    postRefused: 'Ce programme a été chargé depuis les parcours du montage et n’a pas pu être généré sous forme de texte à modifier : {{reason}}',
  },
}
export default words
