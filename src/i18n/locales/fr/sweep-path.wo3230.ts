// WO-3230: French, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const sweepPath: Translation<'sweep-path.wo3230'> = {
  pathSource: 'Trajectoire',
  modeAxis: 'Axe',
  modeSketch: 'Trajectoire d’esquisse',
  followPath: 'Suivre la trajectoire',
  chain: 'Courbes',
  choosePath: 'Choisir une chaîne ouverte de lignes ou d’arcs',
  chainOption: '{{sketch}} : {{curves}}',
  curveLine: 'ligne {{id}}',
  curveArc: 'arc {{id}}',
  startsAt: 'Commence à ({{x}}, {{y}}, {{z}}) mm, direction ({{dx}}, {{dy}}, {{dz}})',
  reverse: 'Inverser',
  noChains: 'Aucune esquisse avant ce balayage n’a de chaîne ouverte de lignes ou d’arcs à suivre.',
  notListed: '{{sketch}} n’est pas listée : {{message}}',
  branched: '{{sketch}} n’est pas listée : ses courbes {{curves}} se ramifient, elles ne forment donc pas une seule chaîne ouverte.',
  savedPathUnresolved: 'La trajectoire enregistrée ne peut pas être suivie : {{message}}',
  pathUnresolved: 'Trajectoire du balayage ({{code}}) : {{message}}',
  pathSketchMissing: 'L’esquisse de trajectoire {{sketchId}} n’existe pas à ce point du modèle (supprimée ou derrière le repère de retour arrière). Restaurez-la ou choisissez une autre trajectoire.',
  pathCycle: '{{sketch}} est construite à partir de {{feature}}, elle ne peut donc pas être sa trajectoire : cela formerait une boucle.',
  savedAsPath: 'Esquisse enregistrée comme trajectoire ouverte : elle n’a pas de profil fermé, et le balayage peut la suivre.',
}

export default sweepPath
