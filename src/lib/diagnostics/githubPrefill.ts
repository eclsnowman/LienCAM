// WO-2759: "Open bug report on GitHub" (design section 2, Sharing). The issue
// form is opened only after the user has seen the exact prefill fields, and
// the URL carries only those fields: app version, coarse OS and controller
// type, each removable. A field whose report category is deselected is not
// offered at all, so a removed category cannot leak back through the URL.
// No logs, names, paths, attachment contents or free text ever enter it.

import type { BuiltReport } from './report'
import type { AppVersions, BasicEnvironment, MachineStateSnapshot } from './sources'

export const ISSUE_FORM_BASE = 'https://github.com/eclsnowman/LienCAM/issues/new'
export const ISSUE_TEMPLATE = 'bug_report.yml'

export type PrefillFieldId = 'version' | 'os' | 'controller'

export interface PrefillField {
  id: PrefillFieldId
  label: string
  value: string
}

const OS_LABEL: Record<BasicEnvironment['osFamily'], string> = {
  windows: 'Windows', macos: 'macOS', linux: 'Linux', other: 'Other',
}

// Option text must match .github/ISSUE_TEMPLATE/bug_report.yml exactly.
const CONTROLLER_OPTION: Record<string, string> = {
  none: 'None (simulator or just making toolpaths)',
  simulator: 'None (simulator or just making toolpaths)',
  bridge: 'UCCNC with UC100',
  serial: 'Other (name it in the steps below)',
  gateway: 'Other (name it in the steps below)',
}

/** The fields that MAY be offered, read from the report's own frozen
 *  categories - never from live state. */
export function prefillFields(
  report: Pick<BuiltReport, 'included'>,
  sources: { appVersions: AppVersions | null; basicEnvironment: BasicEnvironment | null; machineState: MachineStateSnapshot | null },
): PrefillField[] {
  const fields: PrefillField[] = []
  if (report.included.includes('appVersions') && sources.appVersions) {
    fields.push({ id: 'version', label: 'LienCAM version', value: `Version ${sources.appVersions.appVersion} (${sources.appVersions.surface})` })
  }
  if (report.included.includes('basicEnvironment') && sources.basicEnvironment) {
    fields.push({ id: 'os', label: 'Operating system', value: OS_LABEL[sources.basicEnvironment.osFamily] })
  }
  if (report.included.includes('machineState') && sources.machineState) {
    const option = CONTROLLER_OPTION[sources.machineState.transport]
    if (option) fields.push({ id: 'controller', label: 'Controller you were using', value: option })
  }
  return fields
}

/** The issue-form URL holding exactly the kept fields. */
export function issueFormUrl(fields: readonly PrefillField[]): string {
  const params = new URLSearchParams({ template: ISSUE_TEMPLATE })
  for (const f of fields) params.set(f.id, f.value)
  return `${ISSUE_FORM_BASE}?${params.toString()}`
}

type IssueHost = { openIssueForm?: (url: string) => Promise<void> }

/** Desktop: the main process opens it after re-checking the address. Web: a new tab. */
export async function openIssueForm(url: string): Promise<void> {
  const host = (globalThis as { liencamHost?: IssueHost }).liencamHost
  if (typeof host?.openIssueForm === 'function') return host.openIssueForm(url)
  globalThis.open?.(url, '_blank', 'noopener,noreferrer')
}
