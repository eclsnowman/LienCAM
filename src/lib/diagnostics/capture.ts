// WO-2911: the app picture for a problem report (ROUND-2.md, "Screenshot mechanics").
//
// A real frame of the app, in this order:
//   1. the desktop app's own window capture (liencamHost.captureApp), no prompt;
//   2. in a browser, only when the operator pressed "Capture the app": the
//      browser's tab-capture prompt (getDisplayMedia, current tab preferred);
//   3. otherwise the 3D view canvas alone, labelled "3D view only".
// No substitute is ever called a screenshot of the app. The report dialog hides
// itself before the capture (the caller does that) so it is not in the picture.
// Nothing here sends the picture anywhere: the bytes go to the report preview,
// where the operator sees it and can remove it.

import type { CaptureKind } from './failure'

/** ROUND-2: cap the picture at 16 million pixels. */
export const CAPTURE_MAX_PIXELS = 16_000_000
const TIMEOUT_MS = 8000

export interface AppCapture {
  bytes: Uint8Array
  kind: Exclude<CaptureKind, 'chosen-file'>
  width: number
  height: number
  takenAt: number
}

type CaptureHost = { captureApp?: () => Promise<Uint8Array | ArrayBuffer | null> }

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 16 * n); return }
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
    step(n)
  })
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

/** PNG width and height from its header, or null if it is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function scaledCanvas(width: number, height: number): { canvas: HTMLCanvasElement; scale: number } {
  const scale = Math.min(1, Math.sqrt(CAPTURE_MAX_PIXELS / Math.max(1, width * height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(width * scale))
  canvas.height = Math.max(1, Math.floor(height * scale))
  return { canvas, scale }
}

async function hostCapture(): Promise<AppCapture | null> {
  const host = (globalThis as { liencamHost?: CaptureHost }).liencamHost
  if (typeof host?.captureApp !== 'function') return null
  // Let the hidden report dialog leave the screen before the window is copied.
  await nextFrames(2)
  const raw = await withTimeout(host.captureApp())
  if (!raw) return null
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  const size = pngSize(bytes)
  if (!size || size.width * size.height > CAPTURE_MAX_PIXELS) return null
  return { bytes, kind: 'app-window', ...size, takenAt: Date.now() }
}

async function tabCapture(stillWanted: () => boolean): Promise<AppCapture | null> {
  const media = globalThis.navigator?.mediaDevices
  if (typeof media?.getDisplayMedia !== 'function' || typeof document === 'undefined') return null
  const acquiring = media.getDisplayMedia({
    video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include',
  } as DisplayMediaStreamOptions)
  let stream: MediaStream
  try {
    stream = await withTimeout(acquiring)
  } catch (error) {
    // Shared after we gave up (late permission): end that share the moment it starts; nothing is taken from it.
    acquiring.then((late) => { for (const track of late.getTracks()) track.stop() }, () => {})
    throw error
  }
  try {
    // Closed or cleared while the share prompt was open: end the share, take nothing.
    if (!stillWanted()) throw new Error('cancelled')
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    await withTimeout(video.play())
    // The browser's share prompt has just closed: let the page repaint first.
    await nextFrames(3)
    await new Promise((r) => setTimeout(r, 150))
    if (!stillWanted()) throw new Error('cancelled')
    const { canvas } = scaledCanvas(video.videoWidth, video.videoHeight)
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
    const bytes = await canvasPng(canvas)
    return bytes ? { bytes, kind: 'browser-tab', width: canvas.width, height: canvas.height, takenAt: Date.now() } : null
  } finally {
    for (const track of stream.getTracks()) track.stop()
  }
}

/** The largest visible canvas is the 3D view. Copied in the frame it is drawn. */
export async function viewCapture(): Promise<AppCapture | null> {
  if (typeof document === 'undefined') return null
  const source = Array.from(document.querySelectorAll('canvas')).filter((c) => {
    const rect = c.getBoundingClientRect()
    return rect.width > 100 && rect.height > 100 && c.checkVisibility?.() !== false
  }).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
  if (!source || source.width === 0 || source.height === 0) return null
  // The renderers do not keep their buffers: ask for a paint, copy in that frame.
  window.dispatchEvent(new Event('resize'))
  await nextFrames(1)
  const { canvas } = scaledCanvas(source.width, source.height)
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  const bytes = await canvasPng(canvas)
  return bytes ? { bytes, kind: 'view-only', width: canvas.width, height: canvas.height, takenAt: Date.now() } : null
}

/** `skipped`: why a better source was not used (declined prompt, timeout...), when one was tried. */
export type CaptureResult = { ok: true; capture: AppCapture; skipped: string | null } | { ok: false; reason: string }

/**
 * Take the app picture. `askBrowser` = the operator pressed "Capture the app",
 * so the browser's own tab-capture prompt may be shown; a report opened from a
 * console line never raises a prompt by itself. `stillWanted` false (the
 * report was closed or cleared) ends a browser share as soon as it arrives.
 */
export async function captureApp(askBrowser: boolean, stillWanted: () => boolean = () => true): Promise<CaptureResult> {
  const reasons: string[] = []
  const attempts: Array<() => Promise<AppCapture | null>> = [hostCapture, ...(askBrowser ? [() => tabCapture(stillWanted)] : []), viewCapture]
  for (const attempt of attempts) {
    try {
      const capture = await attempt()
      if (capture) return { ok: true, capture, skipped: reasons.length ? reasons.join('; ') : null }
    } catch (error) {
      // Declined prompt, lost graphics context, timeout: say so, try the next way.
      reasons.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { ok: false, reason: reasons.join('; ') || 'no picture source in this window' }
}
