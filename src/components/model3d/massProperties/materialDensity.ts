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
  { id: 'al-6061', label: 'Aluminum 6061', densityGPerCm3: 2.70 },
  { id: 'steel-1018', label: 'Steel 1018 (mild)', densityGPerCm3: 7.87 },
  { id: 'stainless-304', label: 'Stainless Steel 304', densityGPerCm3: 8.00 },
  { id: 'brass-c360', label: 'Brass (C360)', densityGPerCm3: 8.50 },
  { id: 'copper-c110', label: 'Copper (C110)', densityGPerCm3: 8.96 },
  { id: 'titanium-grade5', label: 'Titanium (Grade 5)', densityGPerCm3: 4.43 },
  { id: 'abs', label: 'ABS', densityGPerCm3: 1.04 },
  { id: 'pla', label: 'PLA', densityGPerCm3: 1.24 },
  { id: 'nylon-pa6', label: 'Nylon (PA6)', densityGPerCm3: 1.14 },
]

export const CUSTOM_MATERIAL_ID = 'custom'

export function customMaterial(densityGPerCm3: number): Material {
  return { id: CUSTOM_MATERIAL_ID, label: 'Custom', densityGPerCm3 }
}

export function materialById(id: string): Material | undefined {
  return BUILTIN_MATERIALS.find((m) => m.id === id)
}
