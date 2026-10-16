import { catalogChildren } from './definition/catalogText'
import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

import { Check, FileSearch, X } from 'lucide-react'
import {
  describeChangeHeadline,
  describeProfileReplacementSummary,
  describeProfileReplacementTooltip,
  describeProfileChange,
  profileChangePreviewStatus,
  profileFileName,
  profilePinPreviewStatus,
  type ProfileChangeRow,
  type ProfilePinRow,
  type ProfilePreview,
  type ProfilePreviewRowStatus,
} from '../../lib/machine/uccncProfileImport'

export interface ProfilePreviewViewProps {
  preview: ProfilePreview
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}

const changedFirst = <T extends { changed: boolean }>(rows: readonly T[]): T[] =>
  rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => Number(right.row.changed) - Number(left.row.changed) || left.index - right.index)
    .map(({ row }) => row)

function StatusWord({
  status,
  word,
  explanation,
  testId,
}: {
  status: ProfilePreviewRowStatus
  word?: string
  explanation: string
  testId: string
}) {
  return (
    <span
      className="profile-preview-status"
      data-status={status}
      data-testid={testId}
      data-tooltip={explanation}
      tabIndex={0}
    >
      {word ?? status}
    </span>
  )
}

function PinRow({ row }: { row: ProfilePinRow }) {
  useText('control-screens-not-probing')
  const status = profilePinPreviewStatus(row)
  const replacement = row.replacement
  return (
    <tr
      data-testid={`uccnc-profile-pin-${row.key}`}
      data-pin-state={row.state}
      data-pin-changed={String(row.changed)}
      data-translation-only={String(row.translationOnly)}
      data-raw-before={row.rawBefore}
      data-raw-after={row.rawAfter}
      data-board-before={row.boardBefore}
      data-board-after={row.boardAfter}
    >
      <td>{row.group} - {row.label}</td>
      <td>{row.rawBefore}</td>
      <td>{row.rawAfter}</td>
      <td>{row.boardBefore}</td>
      <td>{row.boardAfter}</td>
      <td>
        <StatusWord
          status={status}
          word={replacement ? controlText('ProfilePreviewView.text001') : undefined}
          explanation={replacement ? describeProfileReplacementTooltip(replacement) : row.outcome}
          testId={`profile-preview-status-pin-${row.key}`}
        />
      </td>
    </tr>
  )
}

function ChangeRow({ row }: { row: ProfileChangeRow }) {
  useText('control-screens-not-probing')
  const status = profileChangePreviewStatus(row)
  const replacement = row.replacement
  return (
    <tr
      data-testid={`uccnc-profile-change-${row.key}`}
      data-before={row.before}
      data-after={row.after}
      data-changed={String(row.changed)}
    >
      <td>{row.group} - {row.label}</td>
      <td>{row.before}</td>
      <td>{row.after}</td>
      <td>
        <StatusWord
          status={status}
          word={replacement ? controlText('ProfilePreviewView.text002') : undefined}
          explanation={replacement
            ? describeProfileReplacementTooltip(replacement)
            : describeProfileChange(row)}
          testId={`profile-preview-status-change-${row.key}`}
        />
      </td>
    </tr>
  )
}

/**
 * WO-1063: the profile report is an in-place Machine Library sub-view, using
 * the same "one host, switched full workspace" pattern as Control's auxiliary
 * views. The table body owns the scroll; the header and actions stay put.
 */
export function ProfilePreviewView({
  preview,
  onConfirm,
  onCancel,
  busy = false,
}: ProfilePreviewViewProps) {
  useText('control-screens-not-probing')
  const pins = changedFirst(preview.pins)
  const changes = changedFirst(preview.changes)
  const total = pins.length + changes.length
  const replacementSummary = describeProfileReplacementSummary(preview)
  const replacementCount = preview.replacements?.length ?? 0

  return (
    <section
      className="profile-preview-view"
      data-testid="uccnc-profile-preview"
      data-readable={String(preview.readable)}
      data-change-count={preview.changedCount}
      data-row-count={total}
      data-pin-count={pins.length}
      data-translation-only-count={preview.translationOnlyCount}
      data-profile-path={preview.path}
      data-replacement-count={replacementCount}
      data-replacement-source={preview.replacementSource ?? 'app'}
      aria-label={controlText('ProfilePreviewView.text003', { value1: String(profileFileName(preview.path)) })}
    >
      <header className="modal-header profile-preview-header">
        <FileSearch size={16} className="modal-header-icon" />
        <div className="profile-preview-heading-wrap">
          <span className="modal-title" data-testid="uccnc-profile-preview-heading">
            {profileFileName(preview.path)}
            {preview.profileName ? ` - ${preview.profileName}` : ''}
          </span>
          <span className="profile-preview-row-count" data-testid="uccnc-profile-row-count">{catalogChildren(controlText('ProfilePreviewView.text004', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000' }), { value1: total, value2: preview.changedCount })}</span>
          {replacementSummary && (
            <span
              className="profile-preview-replacement-summary"
              data-testid="uccnc-profile-replacement-summary"
              data-source={preview.replacementSource ?? 'app'}
              style={{ flexBasis: '100%', color: 'var(--accent-amber)', lineHeight: 1.35 }}
            >
              {replacementSummary}
            </span>
          )}
        </div>
        <button
          type="button"
          className="modal-btn modal-btn-ghost"
          data-testid="uccnc-profile-cancel"
          onClick={onCancel}
        >
          <X size={12} />{controlText('ProfilePreviewView.text005')}</button>
        {preview.readable && (
          <button
            type="button"
            className="modal-btn modal-btn-primary"
            data-testid="uccnc-profile-confirm"
            onClick={onConfirm}
            disabled={busy}
          >
            <Check size={12} />{controlText('ProfilePreviewView.text006')}</button>
        )}
      </header>

      <div className="profile-preview-scroll" data-testid="profile-preview-scroll" tabIndex={0}>
        <div className="profile-preview-meta">
          <div
            data-testid="uccnc-profile-board"
            data-pin-translation={String(preview.board.pinTranslation)}
          >
            {preview.board.type === null
              ? controlText('ProfilePreviewView.text007')
              : controlText('ProfilePreviewView.text008', { value1: String(preview.board.type) })}
            {!preview.board.pinTranslation
              && controlText('ProfilePreviewView.text009')}
          </div>
          {preview.warnings.map((warning, index) => (
            <div key={warning} data-testid={`uccnc-profile-warning-${index}`}>{warning}</div>
          ))}
        </div>

        {!preview.readable ? (
          <div className="profile-preview-unreadable" data-testid="uccnc-profile-unreadable">{catalogChildren(controlText('ProfilePreviewView.text010', { value1: '\u0000value1\u0000' }), { value1: preview.error })}</div>
        ) : (
          <>
            <div
              className="profile-preview-headline"
              data-testid="uccnc-profile-change-count"
              data-changed={preview.changedCount}
              data-rows={total}
            >
              {describeChangeHeadline(preview)}
            </div>

            {preview.translationOnlyCount > 0 && (
              <div
                className="profile-preview-warning"
                data-testid="uccnc-profile-translation-only"
                data-count={preview.translationOnlyCount}
              >{catalogChildren(controlText('ProfilePreviewView.text013', { value1: '\u0000value1\u0000' }), { value1: preview.translationOnlyCount === 1
                  ? controlText('ProfilePreviewView.text011')
                  : controlText('ProfilePreviewView.text012', { value1: String(preview.translationOnlyCount) }) })}</div>
            )}

            <section className="profile-preview-section" aria-labelledby="profile-preview-pins-title">
              <div
                className="profile-preview-section-heading"
                id="profile-preview-pins-title"
                data-testid="uccnc-profile-pins-heading"
                data-pin-count={pins.length}
              >{controlText('ProfilePreviewView.text014')}<span>{catalogChildren(controlText('ProfilePreviewView.text015', { value1: '\u0000value1\u0000' }), { value1: pins.length })}</span>
              </div>
              <table className="profile-preview-table profile-preview-pin-table">
                <thead>
                  <tr>
                    <th>{controlText('ProfilePreviewView.text016')}</th>
                    <th>{controlText('ProfilePreviewView.text017')}</th>
                    <th>{controlText('ProfilePreviewView.text018')}</th>
                    <th>{controlText('ProfilePreviewView.text019')}</th>
                    <th>{controlText('ProfilePreviewView.text020')}</th>
                    <th>{controlText('ProfilePreviewView.text021')}</th>
                  </tr>
                </thead>
                <tbody>{pins.map((row) => <PinRow key={row.key} row={row} />)}</tbody>
              </table>
            </section>

            <section className="profile-preview-section" aria-labelledby="profile-preview-values-title">
              <div
                className="profile-preview-section-heading"
                id="profile-preview-values-title"
                data-testid="uccnc-profile-values-heading"
                data-value-count={changes.length}
              >{controlText('ProfilePreviewView.text022')}<span>{catalogChildren(controlText('ProfilePreviewView.text023', { value1: '\u0000value1\u0000' }), { value1: changes.length })}</span>
              </div>
              <table className="profile-preview-table profile-preview-value-table">
                <thead>
                  <tr><th>{controlText('ProfilePreviewView.text024')}</th><th>{controlText('ProfilePreviewView.text025')}</th><th>{controlText('ProfilePreviewView.text026')}</th><th>{controlText('ProfilePreviewView.text027')}</th></tr>
                </thead>
                <tbody>{changes.map((row) => <ChangeRow key={row.key} row={row} />)}</tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </section>
  )
}
