// UI-PERF-PAIR: PropertiesPanel must not re-subscribe to the whole `project` /
// `viewer` objects. Those identities churn on every toolpath status tick and
// were measured on the op-row select path as idle panel rebuild noise. Narrow
// field selectors + the cascade branches are the contract this pins.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const panel = readFileSync(resolve(here, '../../components/panels/PropertiesPanel.tsx'), 'utf8')

describe('UI-PERF-PAIR: PropertiesPanel selection subscriptions', () => {
  it('does not subscribe to whole project/viewer identities at the panel root', () => {
    // The export function body previously did:
    //   const project = useCamStore((s) => s.project)
    //   const viewer = useCamStore((s) => s.viewer)
    // which re-rendered the full cascade on any nested project write.
    expect(panel).not.toMatch(/export function PropertiesPanel\(\)[\s\S]{0,400}useCamStore\(\(s\) => s\.project\)/)
    expect(panel).not.toMatch(/export function PropertiesPanel\(\)[\s\S]{0,400}useCamStore\(\(s\) => s\.viewer\)/)
    expect(panel).toMatch(/const activeOperationId = useCamStore\(\(s\) => s\.project\.activeOperationId\)/)
    expect(panel).toMatch(/const selectedGeometryId = useCamStore\(\(s\) => s\.viewer\.selectedGeometryId\)/)
  })
})
