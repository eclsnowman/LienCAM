import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// Small display formatters for time durations. Pure, framework-agnostic.

/** Machine execution time: "45s", "2m 34s", or "1h 03m". */
export function formatDurationHMS(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return operatorText('format1')
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return operatorText('format2', { value1: String(h), value2: String(String(m).padStart(2, '0')) })
  if (m > 0) return operatorText('format3', { value1: String(m), value2: String(String(s).padStart(2, '0')) })
  return operatorText('format4', { value1: String(s) })
}

/** Compute (wall-clock) time for diagnostics: "123 ms" or "1.2 s". */
export function formatComputeMs(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '-'
  return ms < 1000 ? operatorText('format5', { value1: String(Math.round(ms)) }) : operatorText('format6', { value1: String((ms / 1000).toFixed(1)) })
}

/** Whole-second elapsed readout for a live "still working" timer: "0s", "12s".
 *  Floors (not rounds) so the displayed count never jumps ahead of real time. */
export function formatElapsedSeconds(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return operatorText('format7')
  return operatorText('format8', { value1: String(Math.floor(ms / 1000)) })
}
