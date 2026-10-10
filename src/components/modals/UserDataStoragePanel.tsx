import { textFor, useText } from '../../i18n'
import { useEffect, useState, type ChangeEvent } from 'react'
import { useCamStore } from '../../store'
import { DisclosureSection } from '../ui/DisclosureSection'
import {
  createShopDataBackup,
  inspectShopData,
  previewShopDataRestore,
  recoverPreviousUserSpaceGeneration,
  restoreShopDataBackup,
  SHOP_DATA_BACKUP_FILENAME,
  syncShopDataBackupToFolder,
  type ShopDataInventory,
  type ShopDataRestorePreview,
  type ShopDataServiceOptions,
} from '../../store/userSpaceStorage'
import { saveFile } from '../../lib/saveFile'

const shellText = textFor('app-shell-settings-menus')

type WindowWithDirectoryPicker = Window & {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
}

export interface UserDataStoragePanelProps {
  serviceOptions?: ShopDataServiceOptions
  reloadPage?: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return shellText('UserDataStoragePanel.kB', { value: (bytes / 1024).toFixed(1) })
  return shellText('UserDataStoragePanel.mB', { value: (bytes / (1024 * 1024)).toFixed(1) })
}

function shortGeneration(generation: string | null): string {
  if (generation === null) return 'none'
  return generation.length <= 18 ? generation : `${generation.slice(0, 8)}...${generation.slice(-6)}`
}

/** Where the backup went, or null when the operator cancelled the Save dialog. */
function downloadBackup(text: string): Promise<string | null> {
  return saveFile(SHOP_DATA_BACKUP_FILENAME, text, 'application/json')
}

export function UserDataStoragePanel({
  serviceOptions,
  reloadPage = () => window.location.reload(),
}: UserDataStoragePanelProps) {
  useText('app-shell-settings-menus')
  const [inventory, setInventory] = useState<ShopDataInventory | null>(null)
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>(shellText('UserDataStoragePanel.inspectingDurableShopData'))
  const [restoreText, setRestoreText] = useState<string | null>(null)
  const [restorePreview, setRestorePreview] = useState<ShopDataRestorePreview | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const next = await inspectShopData(serviceOptions)
      setInventory(next)
      setStatus(
        next.storageMode === 'opfs'
          ? shellText('UserDataStoragePanel.durableBrowserStorageIsAvailable')
          : shellText('UserDataStoragePanel.oPFSIsUnavailableShopDataHasLimitedBrowserLocal'),
      )
    } catch (error) {
      setStatus(shellText('UserDataStoragePanel.storageInspectionFailed', { value: errorMessage(error) }))
    }
  }

  useEffect(() => { void refresh() }, []) // service options are fixed for one modal mount

  const makeBackup = async () => createShopDataBackup(serviceOptions)

  const chooseFolderAndSync = async (): Promise<void> => {
    const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker
    if (!picker) return
    setBusy(true)
    try {
      const chosen = await picker()
      const backup = await makeBackup()
      const result = await syncShopDataBackupToFolder(chosen, backup)
      setFolder(chosen)
      setStatus(shellText('UserDataStoragePanel.verifiedInTheSelectedFolder', { filename: result.filename, value: formatBytes(result.bytes) }))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setStatus(shellText('UserDataStoragePanel.folderSelectionWasCanceledNoBackupWasWritten'))
      } else {
        setStatus(shellText('UserDataStoragePanel.folderBackupFailed', { value: errorMessage(error) }))
      }
    } finally {
      setBusy(false)
    }
  }

  const syncAgain = async (): Promise<void> => {
    if (folder === null) return
    setBusy(true)
    try {
      const backup = await makeBackup()
      const result = await syncShopDataBackupToFolder(folder, backup)
      setStatus(shellText('UserDataStoragePanel.verifiedInTheSelectedFolder', { filename: result.filename, value: formatBytes(result.bytes) }))
    } catch (error) {
      setStatus(shellText('UserDataStoragePanel.folderBackupFailed', { value: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  const exportDownload = async (): Promise<void> => {
    setBusy(true)
    try {
      const backup = await makeBackup()
      // Say "downloaded" only once the Save dialog is answered (machine seat 10-07: it showed first).
      const saved = await downloadBackup(backup.text)
      setStatus(saved === null
        ? shellText('UserDataStoragePanel.backupSaveCanceledNoBackupWasWritten')
        : shellText('UserDataStoragePanel.backupDownloadedMoveItToANormalFolderOr'))
    } catch (error) {
      setStatus(shellText('UserDataStoragePanel.backupExportFailed', { value: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  const importFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      const text = await file.text()
      const preview = await previewShopDataRestore(text, serviceOptions)
      setRestoreText(text)
      setRestorePreview(preview)
      setStatus(shellText('UserDataStoragePanel.bundleVerifiedReviewTheChangesBelowBeforeRestoring'))
    } catch (error) {
      setRestoreText(null)
      setRestorePreview(null)
      setStatus(shellText('UserDataStoragePanel.restoreRefused', { value: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  const confirmRestore = async (): Promise<void> => {
    if (restoreText === null) return
    setBusy(true)
    try {
      const result = await restoreShopDataBackup(restoreText, serviceOptions)
      setRestoreText(null)
      setRestorePreview(null)
      setStatus(
        shellText('UserDataStoragePanel.restoreVerifiedReloadingLienCAMNow', { value: result.checksum.slice(0, 12) }),
      )
      // The live Zustand store still contains the pre-restore snapshot. The
      // restore sealed its storage (WO-2627), so nothing it writes lands; the
      // reload is what loads the restored data into the running app.
      reloadPage()
    } catch (error) {
      setStatus(shellText('UserDataStoragePanel.restoreFailed', { value: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  const recoverPrevious = async (): Promise<void> => {
    // WO-1268: themed dialog. Recovery replaces the live shop data and reloads
    // the app; no Undo covers it, so the prompt is legitimate.
    const ok = await useCamStore.getState().requestConfirm({
      title: shellText('UserDataStoragePanel.recoverThePreviousShopDataGeneration'),
      body: shellText('UserDataStoragePanel.theCurrentDataStaysAvailableAsTheBackupGeneration'),
      confirmLabel: shellText('UserDataStoragePanel.recover'),
      cancelLabel: shellText('UserDataStoragePanel.cancel'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const result = await recoverPreviousUserSpaceGeneration(serviceOptions)
      setStatus(
        shellText('UserDataStoragePanel.recoveredGenerationReloadingLienCAMNow', { value: shortGeneration(result.recoveredGeneration) }),
      )
      // Recovery has the same stale-live-store window as bundle restore.
      reloadPage()
    } catch (error) {
      setStatus(shellText('UserDataStoragePanel.recoveryFailed', { value: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  const folderSupported = typeof (window as WindowWithDirectoryPicker).showDirectoryPicker === 'function'

  return (
    <section data-testid="user-data-storage-panel" aria-label={shellText('UserDataStoragePanel.userData')}>
      <p className="mform-help" data-testid="user-data-storage-status" role="status">
        {status}
      </p>

      <div data-testid="user-data-inventory">
        {inventory?.collections.map((collection) => (
          <div
            data-testid={`user-data-row-${collection.id}`}
            data-user-data-disclosure=""
            key={collection.id}
          >
            <DisclosureSection
              title={collection.label}
              summary={
                <>
                  {shellText('UserDataStoragePanel.items', { count: collection.itemCount })}
                  {collection.health === 'healthy' ? null : ` | ${collection.health}`}
                </>
              }
            >
              <div className="mform-row">
                <span className="mform-label">{shellText('UserDataStoragePanel.collectionDetails')}</span>
                <span className="mform-value">{shellText('UserDataStoragePanel.estimatedSize', { value: formatBytes(collection.estimatedBytes) })}<br />{shellText('UserDataStoragePanel.lastWriteCurrentBackup', { value: collection.lastSuccessfulWrite ?? '-', value2: ' | ', value3: shortGeneration(collection.currentGeneration), value4: ' | ', value5: shortGeneration(collection.backupGeneration) })}{collection.note ? <><br />{collection.note}</> : null}
                </span>
              </div>
            </DisclosureSection>
          </div>
        )) ?? null}
      </div>

      <div className="mform-row">
        <span className="mform-label">{shellText('UserDataStoragePanel.verifiedBackup')}</span>
        <span>
          {folderSupported ? (
            <>
              <button className="modal-btn modal-btn-ghost" disabled={busy} onClick={() => void chooseFolderAndSync()}>{shellText('UserDataStoragePanel.chooseFolderAndSync')}</button>
              {folder ? (
                <button className="modal-btn modal-btn-ghost" disabled={busy} onClick={() => void syncAgain()}>{shellText('UserDataStoragePanel.syncNow')}</button>
              ) : null}
            </>
          ) : (
            <span data-testid="user-data-folder-limitation">{shellText('UserDataStoragePanel.thisBrowserCannotSyncToAChosenLocalFolder')}</span>
          )}
          <button className="modal-btn modal-btn-ghost" disabled={busy} onClick={() => void exportDownload()}>{shellText('UserDataStoragePanel.downloadBackup')}</button>
        </span>
      </div>

      <div className="mform-row">
        <span className="mform-label">{shellText('UserDataStoragePanel.restoreBundle')}</span>
        <label className="modal-btn modal-btn-ghost">{shellText('UserDataStoragePanel.inspectBackup')}<input
            data-testid="user-data-import-input"
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(event) => void importFile(event)}
            hidden
          />
        </label>
      </div>

      {restorePreview ? (
        <div data-testid="user-data-restore-preview">
          <div className="mform-row">
            <span className="mform-label">{shellText('UserDataStoragePanel.restorePreview')}</span>
            <span className="mform-value">{shellText('UserDataStoragePanel.bundle', { value: new Date(restorePreview.createdAt).toLocaleString() })}<br />{shellText('UserDataStoragePanel.checksum', { value: restorePreview.checksum.slice(0, 16) })}<br />{shellText('UserDataStoragePanel.collections', { collectionCount: restorePreview.collectionCount })}<br />{shellText('UserDataStoragePanel.recoveryFiles', { recoveryFileCount: restorePreview.recoveryFileCount })}</span>
          </div>
          {restorePreview.differences.length === 0 ? null : restorePreview.differences.map((difference) => (
            <div className="mform-row" key={difference.id}>
              <span className="mform-label">{difference.label}</span>
              <span className="mform-value">{shellText('UserDataStoragePanel.currentIncoming', { currentCount: difference.currentCount, incomingCount: difference.incomingCount })}</span>
            </div>
          ))}
          <button className="modal-btn modal-btn-primary" disabled={busy} onClick={() => void confirmRestore()}>{shellText('UserDataStoragePanel.confirmRestore')}</button>
          <button
            className="modal-btn modal-btn-ghost"
            disabled={busy}
            onClick={() => { setRestorePreview(null); setRestoreText(null); setStatus(shellText('UserDataStoragePanel.restoreCanceledNoDataWasChanged')) }}
          >{shellText('UserDataStoragePanel.cancel')}</button>
        </div>
      ) : null}

      <div className="mform-row">
        <span className="mform-label">{shellText('UserDataStoragePanel.lastKnownGoodRecovery')}</span>
        <button className="modal-btn modal-btn-ghost" disabled={busy} onClick={() => void recoverPrevious()}>{shellText('UserDataStoragePanel.recoverPreviousGeneration')}</button>
      </div>
    </section>
  )
}
