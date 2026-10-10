// Image relief - the picture work off the page's thread (S9: "nothing blocks
// the page for more than 100 ms"). Opening a picture (decode, Auto) and
// filtering it (WO-2174: channel, denoise, levels, contrast, smooth, edge-keeping
// smooth) run here; the page keeps drawing.
// Each picture stays in the worker under the key the page gave it, so a new
// smoothing size sends only the numbers, never the picture again.

import { adjustAny, autoAdjust, autoParams, type AutoParams, type PictureAdjust } from './adjust'
import { capPicture, decodePicture, type Picture } from './picture'

export type ReliefWorkerRequest =
  | { id: number; kind: 'open'; key: number; bytes: ArrayBuffer; mime: string }
  | { id: number; kind: 'put'; key: number; picture: Picture }
  | { id: number; kind: 'adjust'; key: number; params: AutoParams | PictureAdjust; pitchMm: number }
  | { id: number; kind: 'drop'; key: number }

export type ReliefWorkerResponse =
  | { id: number; ok: true; picture?: Picture; auto?: AutoParams; autoAdjust?: PictureAdjust; adjusted?: Float32Array; sourceCols?: number; sourceRows?: number }
  | { id: number; ok: false; error: string }

const pictures = new Map<number, Picture>()

async function handle(req: ReliefWorkerRequest): Promise<{ res: ReliefWorkerResponse; transfer: Transferable[] }> {
  if (req.kind === 'open') {
    const decoded = await decodePicture(new Uint8Array(req.bytes), req.mime)
    const picture = capPicture(decoded)
    pictures.set(req.key, picture)
    const auto = autoParams(picture)
    const copy: Picture = { ...picture, grey: picture.grey.slice() }
    return { res: { id: req.id, ok: true, picture: copy, auto, autoAdjust: autoAdjust(picture, auto), sourceCols: decoded.cols, sourceRows: decoded.rows }, transfer: [copy.grey.buffer] }
  }
  if (req.kind === 'put') {
    pictures.set(req.key, req.picture)
    return { res: { id: req.id, ok: true }, transfer: [] }
  }
  if (req.kind === 'drop') {
    pictures.delete(req.key)
    return { res: { id: req.id, ok: true }, transfer: [] }
  }
  const picture = pictures.get(req.key)
  if (picture === undefined) return { res: { id: req.id, ok: false, error: `picture ${req.key} is not in the worker` }, transfer: [] }
  const adjusted = adjustAny(picture, req.params, req.pitchMm)
  // the filters may hand back the picture's own grey (no filter at all): send a copy then
  const out = adjusted === picture.grey ? adjusted.slice() : adjusted
  return { res: { id: req.id, ok: true, adjusted: out }, transfer: [out.buffer] }
}

self.onmessage = (e: MessageEvent<ReliefWorkerRequest>) => {
  void handle(e.data).then(
    ({ res, transfer }) => (self as unknown as Worker).postMessage(res, transfer),
    (err: unknown) => (self as unknown as Worker).postMessage({ id: e.data.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ReliefWorkerResponse),
  )
}
