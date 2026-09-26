// PartSleuth — on-device piece detection
//
// Why: vision LLMs are excellent at "what is this piece?" but poor at
// "where exactly is it?". So we split the job:
//   - THIS module finds each piece on the white paper (classic image
//     processing: paper segmentation + connected components) → exact boxes
//   - Claude only identifies close-up CROPS of each piece → far better IDs
//
// Pipeline (all on the phone, <100ms):
//   1. Classify pixels as "paper" (bright + unsaturated)
//   2. Largest connected paper region = the workspace
//   3. Non-paper pixels enclosed by paper = the pieces (dark table and
//      anything touching the image border is excluded automatically)
//   4. Connected components → per-piece bounding boxes
//   5. Crop each piece from the FULL-RESOLUTION source for identification

import { dominantColour } from './colour'

export interface SegmentedPiece {
  bboxPct: [number, number, number, number]   // x1,y1,x2,y2 as 0–1 fractions
  cropB64: string                             // high-res crop, JPEG base64
  rgb: [number, number, number] | null        // dominant piece colour (for free matching)
}

export interface SegmentResult {
  display: { dataUrl: string; b64: string }   // ≤800px image for display/fallback
  pieces:  SegmentedPiece[]                   // [] → caller falls back to whole-image scan
}

const DISPLAY_MAX = 800
const MASK_W      = 400     // working resolution for segmentation
const CROP_MAX    = 300     // max dimension of each identification crop
const MAX_PIECES  = 30

export function segmentBricks(
  source: CanvasImageSource, srcW: number, srcH: number,
): SegmentResult {
  // ── Display image (≤800px) ──
  const dScale  = Math.min(1, DISPLAY_MAX / Math.max(srcW, srcH))
  const dCanvas = document.createElement('canvas')
  dCanvas.width  = Math.round(srcW * dScale)
  dCanvas.height = Math.round(srcH * dScale)
  dCanvas.getContext('2d')!.drawImage(source, 0, 0, dCanvas.width, dCanvas.height)
  const dataUrl = dCanvas.toDataURL('image/jpeg', 0.78)
  const display = { dataUrl, b64: dataUrl.split(',')[1] }

  // ── Mask canvas (low res for speed) ──
  const mw = MASK_W
  const mh = Math.max(1, Math.round(srcH * (MASK_W / srcW)))
  const mCanvas = document.createElement('canvas')
  mCanvas.width = mw; mCanvas.height = mh
  const mCtx = mCanvas.getContext('2d', { willReadFrequently: true })!
  mCtx.drawImage(source, 0, 0, mw, mh)
  const px = mCtx.getImageData(0, 0, mw, mh).data
  const n  = mw * mh

  // 1. Paper mask: bright + unsaturated
  const paper = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const r = px[i*4], g = px[i*4+1], b = px[i*4+2]
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    if (mx > 140 && (mx - mn) < 0.32 * mx) paper[i] = 1
  }

  // 2. Largest connected paper component
  const paperLabel = new Int32Array(n).fill(-1)
  let bestPaper = -1, bestSize = 0, nLabels = 0
  const stack = new Int32Array(n)
  for (let s = 0; s < n; s++) {
    if (!paper[s] || paperLabel[s] !== -1) continue
    let top = 0, size = 0
    stack[top++] = s; paperLabel[s] = nLabels
    while (top > 0) {
      const c = stack[--top]; size++
      const cx = c % mw, cy = (c / mw) | 0
      if (cx > 0      && paper[c-1]  && paperLabel[c-1]  === -1) { paperLabel[c-1]  = nLabels; stack[top++] = c-1 }
      if (cx < mw-1   && paper[c+1]  && paperLabel[c+1]  === -1) { paperLabel[c+1]  = nLabels; stack[top++] = c+1 }
      if (cy > 0      && paper[c-mw] && paperLabel[c-mw] === -1) { paperLabel[c-mw] = nLabels; stack[top++] = c-mw }
      if (cy < mh-1   && paper[c+mw] && paperLabel[c+mw] === -1) { paperLabel[c+mw] = nLabels; stack[top++] = c+mw }
    }
    if (size > bestSize) { bestSize = size; bestPaper = nLabels }
    nLabels++
  }
  // Paper must cover a meaningful share of the frame
  if (bestPaper === -1 || bestSize < 0.10 * n) return { display, pieces: [] }

  const isPaper = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (paperLabel[i] === bestPaper) isPaper[i] = 1

  // 3. Flood "outside" = non-paper connected to the image border.
  //    What remains (non-paper, not outside) is ENCLOSED by paper → pieces.
  const outside = new Uint8Array(n)
  let top = 0
  const pushIf = (i: number) => {
    if (!isPaper[i] && !outside[i]) { outside[i] = 1; stack[top++] = i }
  }
  for (let x = 0; x < mw; x++) { pushIf(x); pushIf((mh-1)*mw + x) }
  for (let y = 0; y < mh; y++) { pushIf(y*mw); pushIf(y*mw + mw-1) }
  while (top > 0) {
    const c = stack[--top]
    const cx = c % mw, cy = (c / mw) | 0
    if (cx > 0)    pushIf(c-1)
    if (cx < mw-1) pushIf(c+1)
    if (cy > 0)    pushIf(c-mw)
    if (cy < mh-1) pushIf(c+mw)
  }

  const enclosed = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (!isPaper[i] && !outside[i]) enclosed[i] = 1

  // Erode twice: cuts the thin shadow "bridges" along paper folds/seams that
  // would otherwise merge separate pieces into one blob. (Box padding below
  // compensates for the shrink.)
  const erode = (m: Uint8Array): Uint8Array => {
    const e = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (!m[i]) continue
      const cx = i % mw, cy = (i / mw) | 0
      if (cx > 0 && cx < mw-1 && cy > 0 && cy < mh-1 &&
          m[i-1] && m[i+1] && m[i-mw] && m[i+mw]) e[i] = 1
    }
    return e
  }
  const dilated = erode(erode(enclosed))

  // 4. Connected components of pieces
  const minArea = Math.max(10, 0.00015 * n)
  const maxDim  = 0.7 * Math.min(mw, mh)
  const label   = new Int32Array(n).fill(-1)
  const boxes: { x1: number; y1: number; x2: number; y2: number; area: number }[] = []

  for (let s = 0; s < n; s++) {
    if (!dilated[s] || label[s] !== -1) continue
    let t2 = 0, area = 0
    let x1 = mw, y1 = mh, x2 = 0, y2 = 0
    stack[t2++] = s; label[s] = 1
    while (t2 > 0) {
      const c = stack[--t2]; area++
      const cx = c % mw, cy = (c / mw) | 0
      if (cx < x1) x1 = cx; if (cx > x2) x2 = cx
      if (cy < y1) y1 = cy; if (cy > y2) y2 = cy
      if (cx > 0      && dilated[c-1]  && label[c-1]  === -1) { label[c-1]  = 1; stack[t2++] = c-1 }
      if (cx < mw-1   && dilated[c+1]  && label[c+1]  === -1) { label[c+1]  = 1; stack[t2++] = c+1 }
      if (cy > 0      && dilated[c-mw] && label[c-mw] === -1) { label[c-mw] = 1; stack[t2++] = c-mw }
      if (cy < mh-1   && dilated[c+mw] && label[c+mw] === -1) { label[c+mw] = 1; stack[t2++] = c+mw }
    }
    const w = x2 - x1 + 1, h = y2 - y1 + 1
    if (area < minArea) continue                    // noise / shadows
    if (w > maxDim || h > maxDim) continue          // paper folds, big shadows
    if (Math.max(w, h) / Math.min(w, h) > 10) continue  // seams between sheets
    if (area / (w * h) < 0.18) continue             // too sparse to be a brick
    boxes.push({ x1, y1, x2, y2, area })
  }

  // Largest first, cap, then reading order (top-to-bottom, left-to-right)
  boxes.sort((a, b) => b.area - a.area)
  const kept = boxes.slice(0, MAX_PIECES)
  kept.sort((a, b) => (a.y1 - b.y1) || (a.x1 - b.x1))

  // 5. High-res crops from the original source
  const pieces: SegmentedPiece[] = kept.map(bx => {
    const padX = 0.14 * (bx.x2 - bx.x1 + 1) + 4   // +4 compensates the 2-pass erosion
    const padY = 0.14 * (bx.y2 - bx.y1 + 1) + 4
    const fx1 = Math.max(0, (bx.x1 - padX) / mw)
    const fy1 = Math.max(0, (bx.y1 - padY) / mh)
    const fx2 = Math.min(1, (bx.x2 + 1 + padX) / mw)
    const fy2 = Math.min(1, (bx.y2 + 1 + padY) / mh)

    const sx = fx1 * srcW, sy = fy1 * srcH
    const sw = (fx2 - fx1) * srcW, sh = (fy2 - fy1) * srcH
    const cScale = Math.min(1, CROP_MAX / Math.max(sw, sh))
    const cc = document.createElement('canvas')
    cc.width  = Math.max(1, Math.round(sw * cScale))
    cc.height = Math.max(1, Math.round(sh * cScale))
    cc.getContext('2d')!.drawImage(source, sx, sy, sw, sh, 0, 0, cc.width, cc.height)

    return {
      bboxPct: [fx1, fy1, fx2, fy2] as [number, number, number, number],
      cropB64: cc.toDataURL('image/jpeg', 0.82).split(',')[1],
      rgb: dominantColour(cc),
    }
  })

  return { display, pieces }
}
