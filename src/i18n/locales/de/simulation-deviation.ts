// WO-3005: German, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const simulationDeviation: Translation<'simulation-deviation'> = {
  "title": "Abweichung des Fertigteils",
  "subtitle": "Fertig bearbeitetes Rohteil im Vergleich zur beabsichtigten Geometrie",
  "cellSizeLabel": "Angeforderte Zelle (mm)",
  "cellSizeAria": "Zellengröße des Vergleichs",
  "toleranceLabel": "Toleranz (mm)",
  "toleranceAria": "Abweichungstoleranz",
  "scaleLabel": "Farbskala +/- {{value1}} mm",
  "scaleAria": "Farbskala der Abweichung",
  "opacityLabel": "Deckkraft der Überlagerung {{value1}}%",
  "opacityAria": "Deckkraft der Abweichung",
  "legendAria": "Legende der Abweichung",
  "legendGouge": "Übertiefe (-)",
  "legendResidual": "Restmaterial (+)",
  "legendMatch": "Innerhalb der Toleranz",
  "legendPossibleResidual": "Mögliches Restmaterial",
  "legendUnknown": "Unbekannt",
  "cells": "Quellzelle {{value1}} mm; Anzeigezelle {{value2}} mm",
  "samples": "{{value1}} Messpunkte; {{value2}} ms; ~{{value3}} MiB",
  "caveat": "Das Rohteil der oberen Hüllfläche hat keine endliche vertikale Grenze für Restmaterial. Mögliches Restmaterial und Unbekannt sind keine Freigabe. Abgetastete Dreiecksoberseiten erfassen keine Hinterschneidungen.",
  "compareAgain": "Erneut vergleichen",
  "comparing": "Rohteil wird verglichen...",
  "needStock": "Wähle ein Setup und sein Rohteil, um das Fertigteil zu vergleichen.",
  "domainUnavailable": "Der Bereich des gewählten Setups bzw. Rohteils ist nicht verfügbar.",
  "waitingHeader": "Das Rohteil wartet auf diese Operationen. Der Vergleich startet von selbst, sobald sie fertig sind:",
  "waitGenerate": "{{value1}}: erzeugen (kein aktueller Werkzeugweg)",
  "waitComputing": "{{value1}}: wird gerade berechnet",
  "waitRegenerate": "{{value1}}: neu erzeugen (der Werkzeugweg ist veraltet)",
  "checkedAt": "Prüfung {{value2}} um {{value1}}",
  "stockHint": "Funktioniert mit ein- oder ausgeschalteter Materialabtrag-Simulation.",
  "recomputing": "Rohteil wird neu berechnet..."
}

export default simulationDeviation
