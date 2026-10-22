// WO-3005: French, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const simulationDeviation: Translation<'simulation-deviation'> = {
  "title": "Écart de la pièce finale",
  "subtitle": "Brut usiné final par rapport à la géométrie prévue",
  "cellSizeLabel": "Cellule demandée (mm)",
  "cellSizeAria": "Taille de cellule de la comparaison",
  "toleranceLabel": "Tolérance (mm)",
  "toleranceAria": "Tolérance d'écart",
  "scaleLabel": "Échelle de couleur +/- {{value1}} mm",
  "scaleAria": "Échelle de couleur de l'écart",
  "opacityLabel": "Opacité de la superposition {{value1}}%",
  "opacityAria": "Opacité de l'écart",
  "legendAria": "Légende de l'écart",
  "legendGouge": "Surcoupe (-)",
  "legendResidual": "Excès de matière (+)",
  "legendMatch": "Dans la tolérance",
  "legendPossibleResidual": "Excès de matière possible",
  "legendUnknown": "Inconnu",
  "cells": "Cellule source {{value1}} mm ; cellule d'affichage {{value2}} mm",
  "samples": "{{value1}} échantillons ; {{value2}} ms ; ~{{value3}} MiB",
  "caveat": "Le brut à enveloppe supérieure n'a pas de limite verticale finie d'excès de matière. Excès de matière possible et inconnu ne valent pas certificat de dégagement. Les surfaces supérieures de triangles échantillonnées ne résolvent pas les contre-dépouilles.",
  "compareAgain": "Comparer à nouveau",
  "comparing": "Comparaison du brut final...",
  "needStock": "Sélectionnez une configuration et son brut pour comparer la pièce finale.",
  "domainUnavailable": "Le domaine de la configuration ou du brut sélectionné n'est pas disponible.",
  "waitingHeader": "Le brut final attend ces opérations. La comparaison se lance toute seule dès qu'elles sont prêtes :",
  "waitGenerate": "{{value1}} : à générer (aucun parcours d'outil actuel)",
  "waitComputing": "{{value1}} : calcul en cours",
  "waitRegenerate": "{{value1}} : à régénérer (son parcours d'outil est périmé)",
  "checkedAt": "Vérification {{value2}} à {{value1}}",
  "stockHint": "Fonctionne avec la simulation d'enlèvement de matière activée ou non.",
  "recomputing": "Le brut final est en cours de recalcul..."
}

export default simulationDeviation
