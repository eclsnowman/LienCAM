// WO-3244: French, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const bodyMirror: Translation<'body-mirror.wo3244'> = {
  railLabel: 'Symétrie',
  railTip: 'Symétriser un corps par rapport à un plan. Le symétrique remplace l\'original.',
  title: 'Symétrie de corps',
  editTitle: 'Modifier la symétrie',
  body: 'Corps',
  plane: 'Plan',
  result: 'Résultat',
  replaceOriginal: 'Remplacer l\'original',
  replaceOriginalTip: 'Le corps symétrique prend la place de l\'original ; l\'original reste dans l\'historique et revient si cette symétrie est supprimée ou désactivée.',
  noBody: 'Aucun corps solide à symétriser.',
  noPlane: 'Aucun plan de symétrie.',
  meshNeedsExactBody: 'La symétrie demande un corps exact ; ce maillage reste tel quel et ses propres outils restent disponibles.',
  previewReady: 'Aperçu : le symétrique de {{body}} par rapport à {{plane}}.',
  previewBuilding: 'Création de l\'aperçu...',
  defaultName: 'Symétrie {{id}}',
  notAMirror: '{{featureId}} n\'est pas une symétrie.',
  planeBuiltFromMirror: '{{choice}} est construit à partir du résultat de cette symétrie et ne peut donc pas la placer. Choisissez un plan créé avant elle.',
  bodyBuiltFromMirror: '{{choice}} est construit à partir du résultat de cette symétrie, elle ne peut donc pas le refléter. Choisissez un corps créé avant elle.',
  carryNotCarried: '{{feature}} vient plus tard sur ce corps et garde une référence ({{reference}}) que la symétrie ne peut pas reporter sur le corps reflété ; la symétrie n\'a donc pas été ajoutée ici. Ajoutez-la plutôt après {{feature}}.',
  carryNoPlane: '{{feature}} enregistre une position ({{reference}}) qui doit être reflétée, mais le plan de symétrie ne peut pas être placé pour l\'instant ; la symétrie n\'a donc pas été ajoutée ici.',
  carryBadReference: '{{feature}} a une référence ({{reference}}) qui n\'est ni une face ni une arête de ce corps ; la symétrie ne peut pas la reporter et n\'a pas été ajoutée ici.',
  replayNotCarried: '{{feature}} garde une référence ({{reference}}) qui ne peut pas suivre la symétrie {{mirror}} sur le corps reflété ; l\'élément n\'a donc pas été reconstruit.',
  replayNoPlane: '{{feature}} enregistre une position ({{reference}}) que la symétrie {{mirror}} doit refléter, mais le plan de symétrie ne peut pas être placé pour l\'instant ; l\'élément n\'a donc pas été reconstruit.',
  refusedMalformed: 'Il manque à la symétrie {{nodeId}} son corps ou son plan ; elle n\'a pas été reconstruite.',
  refusedSourceNotLive: 'Symétrie {{nodeId}} : le corps symétrisé ({{sourceBodyId}}) n\'existe plus ou a déjà été utilisé par une fonction ultérieure.',
  refusedPlaneUnresolved: 'Symétrie {{nodeId}} : son plan ({{planeNodeId}}) n\'a pas pu être placé, le corps n\'a donc pas été symétrisé.',
  refusedNoTransform: 'Symétrie {{nodeId}} : ce service de géométrie ne peut pas déplacer de corps, le corps n\'a donc pas été symétrisé.',
}

export default bodyMirror
