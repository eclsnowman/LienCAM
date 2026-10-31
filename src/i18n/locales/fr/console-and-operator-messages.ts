// WO-2939: LienCAM messages only; controller replies remain verbatim.
import type { Translation } from '../../index'
const words: Translation<'console-and-operator-messages'> = {
  "postToolNumberAssigned": "T{{number}} a été attribué à « {{name}} » pour ce programme.",
  "g53BottomOfTravel": "« {{name}} », ligne {{line}} : {{code}} va en Z machine {{z}}, le bas de la course Z de cette machine. Il s’exécute tel qu’écrit.",
  "g53BottomOfTravelMore": "« {{name}} » : {{count}} lignes de plus vont aussi au bas de la course Z, la suivante à la ligne {{line}}.",
  "interpreterHandover": "« {{name}} » : la ligne {{line}} ({{word}}) est lue par l'interpréteur de fichiers qu'utilise la passerelle de la machine, donc tout le fichier y est lu.",
  "interpreterHandoverNoLine": "« {{name}} » : ce fichier est lu par l'interpréteur de fichiers qu'utilise la passerelle de la machine, donc tout le fichier y est lu.",
  "index40": "{{value1}} : {{value3}} liaisons vérifiées ; {{value2}} déplacements rapides restent sous la hauteur de sécurité au-dessus de la matière déjà enlevée.",
  outdatedReasonEarlierChanged: '{{name}} a été modifié après ce calcul',
  outdatedReasonEarlierRemoved: '{{name}} a été supprimé après ce calcul',
  outdatedReasonEarlierEnabled: '{{name}} a été activé après ce calcul',
  outdatedReasonEarlierDisabled: '{{name}} a été désactivé après ce calcul',
  outdatedReasonOrder: 'l’ordre des opérations a changé après ce calcul',
  outdatedReasonTool: 'son outil a été modifié', outdatedReasonGeometry: 'sa géométrie a été modifiée',
  outdatedReasonSettings: 'ses paramètres ont été modifiés', outdatedReasonStock: 'le brut a été modifié',
  outdatedReasonOrigin: 'l’origine du montage a été modifiée', outdatedReasonParts: 'les pièces utilisées pour le calcul ont été modifiées',
  outdatedReasonWorkholding: 'les moyens de serrage ont été modifiés', outdatedReasonMachine: 'la machine a été modifiée',
  outdatedReasonNest: 'son imbrication doit être recalculée', outdatedReasonChangedWhileComputing: 'ses données ont changé pendant le calcul',
  outdatedReasonHistory: 'Annuler l’a restauré sans son parcours', outdatedReasonInterrupted: 'son calcul était en cours à la fermeture de l’application',
  outdatedReasonNoToolpath: 'aucun parcours n’est enregistré', outdatedReasonOpened: 'son parcours enregistré ne correspond pas aux données actuelles',
  outdatedReasonInputs: 'ses données ont changé après ce calcul',
}
export default words
