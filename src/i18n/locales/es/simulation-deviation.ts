// WO-3005: Spanish, machine-translated and checked against docs/i18n/GLOSSARY.md.
import type { Translation } from '../../index'

const simulationDeviation: Translation<'simulation-deviation'> = {
  "title": "Desviación de la pieza final",
  "subtitle": "Material final mecanizado frente a la geometría prevista",
  "cellSizeLabel": "Celda solicitada (mm)",
  "cellSizeAria": "Tamaño de celda de la comparación",
  "toleranceLabel": "Tolerancia (mm)",
  "toleranceAria": "Tolerancia de desviación",
  "scaleLabel": "Escala de color +/- {{value1}} mm",
  "scaleAria": "Escala de color de la desviación",
  "opacityLabel": "Opacidad de la superposición {{value1}}%",
  "opacityAria": "Opacidad de la desviación",
  "legendAria": "Leyenda de la desviación",
  "legendGouge": "Exceso de corte (-)",
  "legendResidual": "Material sobrante (+)",
  "legendMatch": "Dentro de la tolerancia",
  "legendPossibleResidual": "Posible material sobrante",
  "legendUnknown": "Desconocido",
  "cells": "Celda de origen {{value1}} mm; celda de visualización {{value2}} mm",
  "samples": "{{value1}} muestras; {{value2}} ms; ~{{value3}} MiB",
  "caveat": "El material de envolvente superior no tiene un límite vertical finito de material sobrante. Posible material sobrante y desconocido no son un certificado de holgura. Las superficies superiores de triángulos muestreadas no resuelven los socavados.",
  "compareAgain": "Comparar de nuevo",
  "comparing": "Comparando el material final...",
  "needStock": "Selecciona una configuración y su material para comparar la pieza final.",
  "domainUnavailable": "El dominio de la configuración o material seleccionado no está disponible.",
  "waitingHeader": "El material final espera estas operaciones. La comparación se ejecuta sola cuando estén listas:",
  "waitGenerate": "{{value1}}: genérala (sin trayectoria actual)",
  "waitComputing": "{{value1}}: calculándose ahora",
  "waitRegenerate": "{{value1}}: regenérala (su trayectoria está desactualizada)",
  "checkedAt": "Comprobación {{value2}} a las {{value1}}",
  "stockHint": "Funciona con la simulación de arranque de material activada o desactivada.",
  "recomputing": "El material final se está recalculando..."
}

export default simulationDeviation
