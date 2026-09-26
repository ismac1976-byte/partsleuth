// Dominant-colour extraction for the Single Brick scanner.
// Validated against 40 Rebrickable part photos: 95% correct line-colour
// matching (vs ~70% when asking a vision LLM to name the colour).

/**
 * Median RGB of the piece in a crop canvas, ignoring bright unsaturated
 * background pixels. Returns null if the crop is essentially empty.
 */
export function dominantColour(source: HTMLCanvasElement): [number, number, number] | null {
  const w0 = source.width, h0 = source.height
  if (!w0 || !h0) return null

  // Work at 64px for speed
  const c = document.createElement('canvas')
  const scale = Math.min(1, 64 / Math.max(w0, h0))
  c.width = Math.max(1, Math.round(w0 * scale))
  c.height = Math.max(1, Math.round(h0 * scale))
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, c.width, c.height)
  const px = ctx.getImageData(0, 0, c.width, c.height).data

  const x0 = Math.floor(c.width * 0.15), x1 = Math.ceil(c.width * 0.85)
  const y0 = Math.floor(c.height * 0.15), y1 = Math.ceil(c.height * 0.85)

  const rs: number[] = [], gs: number[] = [], bs: number[] = []
  const rsAll: number[] = [], gsAll: number[] = [], bsAll: number[] = []
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * c.width + x) * 4
      const r = px[i], g = px[i+1], b = px[i+2]
      rsAll.push(r); gsAll.push(g); bsAll.push(b)
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
      if (mx > 200 && (mx - mn) < 40) continue   // white-ish background
      rs.push(r); gs.push(g); bs.push(b)
    }
  }

  // White piece on white background: fall back to everything central
  const [R, G, B] = rs.length >= 10 ? [rs, gs, bs] : [rsAll, gsAll, bsAll]
  if (!R.length) return null
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
  return [med(R), med(G), med(B)]
}

/** Fraction of central pixels that are NOT bright unsaturated background. */
export function foregroundFraction(source: HTMLCanvasElement): number {
  const c = document.createElement('canvas')
  const scale = Math.min(1, 48 / Math.max(source.width || 1, source.height || 1))
  c.width = Math.max(1, Math.round(source.width * scale))
  c.height = Math.max(1, Math.round(source.height * scale))
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, c.width, c.height)
  const px = ctx.getImageData(0, 0, c.width, c.height).data
  let fg = 0, n = 0
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i+1], b = px[i+2]
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    n++
    if (!(mx > 200 && (mx - mn) < 40)) fg++
  }
  return n ? fg / n : 0
}

/** 16x16 grayscale signature for change detection between frames. */
export function frameSignature(source: HTMLCanvasElement): Uint8Array {
  const c = document.createElement('canvas')
  c.width = 16; c.height = 16
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, 16, 16)
  const px = ctx.getImageData(0, 0, 16, 16).data
  const sig = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    sig[i] = (px[i*4] * 3 + px[i*4+1] * 6 + px[i*4+2]) / 10
  }
  return sig
}

/** Mean absolute difference between two signatures (0–255). */
export function signatureDiff(a: Uint8Array | null, b: Uint8Array | null): number {
  if (!a || !b || a.length !== b.length) return 255
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length
}
