// WO-3303: "what needs fixing", one pure read. Every line is a fact the definition already
// reports (the validator's problems and what the profile import could not take); nothing is
// invented here and nothing refuses anything (rule 11).
import type { DefGroup } from '../../components/machine/definition/DefinitionNavigation'
import { definitionProblemGroup } from '../../components/machine/definition/DefinitionNavigation'

export interface FixingItem {
  readonly id: string
  readonly area: DefGroup
  readonly text: string
}

export interface FixingInput {
  readonly problems: readonly string[]
  readonly pinLabels: readonly string[]
  readonly importIssues: readonly { readonly key: string; readonly message: string }[]
}

export function fixingItems(input: FixingInput): readonly FixingItem[] {
  const out: FixingItem[] = []
  input.problems.forEach((text, i) => {
    out.push({ id: `problem-${i}`, area: definitionProblemGroup(text, [...input.pinLabels]), text })
  })
  input.importIssues.forEach((issue, i) => {
    out.push({ id: `import-${i}`, area: 'controller', text: `${issue.key}: ${issue.message}` })
  })
  return out
}

export function fixingCounts(items: readonly FixingItem[]): Record<DefGroup, number> {
  const counts: Record<DefGroup, number> = {
    overview: 0, machine: 0, spindle: 0, outputs: 0, probing: 0, controller: 0, allSettings: 0,
  }
  for (const item of items) counts[item.area] += 1
  return counts
}
