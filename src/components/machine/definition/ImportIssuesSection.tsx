import { textFor, useText } from '../../../i18n'
const controlText = textFor('control-screens-not-probing')

import { SectionHead } from './DefinitionFields'
import type { MachineDefinitionPanelState } from './useMachineDefinitionPanel'


type ImportIssuesSectionProps = Pick<MachineDefinitionPanelState, 'importIssues'>

export function ImportIssuesSection({ importIssues }: ImportIssuesSectionProps) {
  useText('control-screens-not-probing')
  return (
    <><div data-testid="machine-def-panel-import-issues">
            <SectionHead
              title={controlText('ImportIssuesSection.text001')}
              summary={`${importIssues.length} thing${importIssues.length === 1 ? '' : 's'} the import could not take verbatim`}
              testId="machine-def-panel-head-import"
            />
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
              {importIssues.map((issue, i) => (
                <li key={issue.key + i} data-testid={`machine-def-panel-import-issue-${i}`}>
                  <span className="mform-input-mono" style={{ color: 'var(--text-primary)' }}>{issue.key}</span>
                  {' - '}
                  {issue.message}
                </li>
              ))}
            </ul>
          </div></>
  )
}

