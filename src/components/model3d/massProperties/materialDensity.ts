import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
// WO UI-4 acceptance #6 (BK-49 rider): built-in material density table.
// Densities are room-temperature nominal values (g/cm^3), standard
// engineering-handbook figures -- not tied to any specific alloy temper
// unless named. No density/material-table precedent existed anywhere in
// this codebase (checked before writing this), so naming here is this WO's
// own judgment call.

export interface Material {
  id: string
  label: string
  densityGPerCm3: number
}

export const BUILTIN_MATERIALS: readonly Material[] = [
  { id: 'al-6061', get label() { return workbenchText('materialDensity.aluminum6061') }, densityGPerCm3: 2.70 },
  { id: 'steel-1018', get label() { return workbenchText('materialDensity.steel1018Mild') }, densityGPerCm3: 7.87 },
  { id: 'stainless-304', get label() { return workbenchText('materialDensity.stainlessSteel304') }, densityGPerCm3: 8.00 },
  { id: 'brass-c360', get label() { return workbenchText('materialDensity.brassC360') }, densityGPerCm3: 8.50 },
  { id: 'copper-c110', get label() { return workbenchText('materialDensity.copperC110') }, densityGPerCm3: 8.96 },
  { id: 'titanium-grade5', get label() { return workbenchText('materialDensity.titaniumGrade5') }, densityGPerCm3: 4.43 },
  { id: 'abs', get label() { return workbenchText('materialDensity.abs') }, densityGPerCm3: 1.04 },
  { id: 'pla', get label() { return workbenchText('materialDensity.pla') }, densityGPerCm3: 1.24 },
  { id: 'nylon-pa6', get label() { return workbenchText('materialDensity.nylonPA6') }, densityGPerCm3: 1.14 },
]

export const CUSTOM_MATERIAL_ID = 'custom'

export function customMaterial(densityGPerCm3: number): Material {
  return { id: CUSTOM_MATERIAL_ID, label: workbenchText('materialDensity.custom'), densityGPerCm3 }
}

export function materialById(id: string): Material | undefined {
  return BUILTIN_MATERIALS.find((m) => m.id === id)
}
