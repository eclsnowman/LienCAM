// WO-3005: exact English from DeviationPanel.tsx as landed with WO-2947.
const simulationDeviation = {
  "title": "Final part deviation",
  "subtitle": "Final machined stock vs intended geometry",
  "cellSizeLabel": "Requested cell (mm)",
  "cellSizeAria": "Comparison cell size",
  "toleranceLabel": "Tolerance (mm)",
  "toleranceAria": "Deviation tolerance",
  "scaleLabel": "Color scale +/- {{value1}} mm",
  "scaleAria": "Deviation color scale",
  "opacityLabel": "Overlay opacity {{value1}}%",
  "opacityAria": "Deviation opacity",
  "legendAria": "Deviation legend",
  "legendGouge": "Gouge (-)",
  "legendResidual": "Excess (+)",
  "legendMatch": "Within tolerance",
  "legendPossibleResidual": "Possible excess",
  "legendUnknown": "Unknown",
  "cells": "Source cell {{value1}} mm; display cell {{value2}} mm",
  "samples": "{{value1}} samples; {{value2}} ms; ~{{value3}} MiB",
  "caveat": "Upper-envelope stock has no finite vertical excess bound. Possible excess and unknown are not a clearance certificate. Sampled triangle top surfaces do not resolve undercuts.",
  "compareAgain": "Compare again",
  "comparing": "Comparing final stock...",
  "needStock": "Select a setup and its stock to compare the final part.",
  "domainUnavailable": "The selected setup/stock domain is unavailable.",
  "waitingHeader": "Final stock is waiting for these operations. The comparison runs by itself once they are ready:",
  "waitGenerate": "{{value1}}: generate it (no current toolpath)",
  "waitComputing": "{{value1}}: computing now",
  "waitRegenerate": "{{value1}}: regenerate it (its toolpath is out of date)",
  "checkedAt": "Check {{value2}} at {{value1}}",
  "stockHint": "Works with Simulate Stock Removal on or off.",
  "recomputing": "Final stock is recomputing..."
}

export default simulationDeviation

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'simulation-deviation': typeof simulationDeviation
  }
}
