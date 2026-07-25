// PartSleuth — client-side checklist matching
//
// Ported from api/scan.py v3. Runs on the phone so the checklist never
// has to be re-uploaded with each scan, and results appear the instant
// Claude responds.

import type { ChecklistLine, Detection, DetectionStatus } from '@/lib/types'

// ── Raw piece as returned by /api/scan ──────────────────────────────────────

export interface RawPiece {
  part_num:   string | null
  color:      string | null
  confidence: 'high' | 'medium' | 'low' | 'none'
  bbox_pct:   [number, number, number, number]
}

// ── Local part-name lookup ───────────────────────────────────────────────────

const PART_NAMES: Record<string, string> = {
  '3001': 'Brick 2x4',     '3002': 'Brick 2x3',     '3003': 'Brick 2x2',
  '3004': 'Brick 1x2',     '3005': 'Brick 1x1',     '3009': 'Brick 1x6',
  '3010': 'Brick 1x4',     '3007': 'Brick 2x8',     '3008': 'Brick 1x8',
  '2456': 'Brick 2x6',     '3006': 'Brick 2x10',
  '3020': 'Plate 2x4',     '3021': 'Plate 2x3',     '3022': 'Plate 2x2',
  '3023': 'Plate 1x2',     '3024': 'Plate 1x1',     '3034': 'Plate 2x8',
  '3460': 'Plate 1x8',     '3710': 'Plate 1x4',     '3832': 'Plate 2x10',
  '3958': 'Plate 6x6',     '2420': 'Plate Corner 2x2',
  '3068b': 'Tile 2x2',     '3069b': 'Tile 1x2',     '3070b': 'Tile 1x1',
  '6636': 'Tile 1x6',      '4162': 'Tile 1x8',      '2412b': 'Tile 1x2 Grooved',
  '4150': 'Tile 2x2 Round', '98138': 'Tile 1x1 Round',
  '3040b': 'Slope 45 2x1', '3039': 'Slope 45 2x2',  '3665': 'Slope Inv 45 2x1',
  '3660': 'Slope Inv 45 2x2',
  '11477': 'Slope Curved 2x1', '61678': 'Slope Curved 4x1',
  '3062b': 'Brick 1x1 Round', '3941': 'Brick 2x2 Round',
  '32523': 'Technic Beam 3', '32316': 'Technic Beam 5', '32524': 'Technic Beam 7',
  '40490': 'Technic Beam 9', '32525': 'Technic Beam 11', '32278': 'Technic Beam 15',
  '3176': 'Plate 3x2 w/Bow', '32028': 'Plate 1x2 w/Handle',
  '30363': 'Shield 2x3',   '41855': 'Bar 4x2 Curved',
}

// ── Colour normalisation ─────────────────────────────────────────────────────

const COLOUR_ALIASES: Record<string, string> = {
  'light gray': 'light bluish gray',   'light grey': 'light bluish gray',
  'light bluish grey': 'light bluish gray',
  'dark gray': 'dark bluish gray',     'dark grey': 'dark bluish gray',
  'dark bluish grey': 'dark bluish gray',
  'gray': 'light bluish gray',         'grey': 'light bluish gray',
  'azure': 'medium azure',             'medium blue': 'blue',
  'bright blue': 'blue',               'bright red': 'red',
  'bright yellow': 'yellow',           'bright green': 'green',
  'transparent': 'trans-clear',        'clear': 'trans-clear',
  'brown': 'reddish brown',
  'lime green': 'lime',                'light green': 'lime',
  'gold': 'pearl gold',                'metallic gold': 'pearl gold',
  'silver': 'flat silver',             'metallic silver': 'flat silver',
  'nougat': 'medium nougat',           'light brown': 'medium nougat',
}

// Strip mold-variant suffixes for fuzzy part matching: "3062b" → "3062"
function stripVariant(p: string): string {
  return p.replace(/[a-z]+[0-9]*$/i, '')
}

// Colours that vision models routinely confuse under real lighting.
// Used ONLY when the part number matches a single-colour checklist entry —
// the exact part number (Brickognize-backed) is the strong signal there.
const NEAR_COLOURS: Record<string, string[]> = {
  'white':             ['light bluish gray', 'light aqua'],
  'light bluish gray': ['white', 'dark bluish gray', 'flat silver'],
  'dark bluish gray':  ['black', 'light bluish gray', 'dark purple'],
  'black':             ['dark bluish gray', 'dark brown', 'dark blue'],
  'medium azure':      ['light aqua', 'dark azure', 'blue'],
  'dark azure':        ['medium azure', 'blue'],
  'light aqua':        ['medium azure', 'white'],
  'reddish brown':     ['medium nougat', 'dark brown', 'dark orange', 'dark tan'],
  'medium nougat':     ['reddish brown', 'tan', 'dark tan'],
  'dark brown':        ['reddish brown', 'black'],
  'tan':               ['dark tan', 'medium nougat', 'pearl gold'],
  'dark tan':          ['tan', 'medium nougat', 'reddish brown'],
  'pearl gold':        ['tan', 'dark tan', 'flat silver'],
  'flat silver':       ['light bluish gray', 'pearl gold'],
  'orange':            ['dark orange', 'bright light orange'],
  'dark orange':       ['orange', 'reddish brown'],
  'bright light orange': ['orange', 'yellow'],
  'blue':              ['dark blue', 'medium azure'],
  'dark blue':         ['blue', 'black'],
  'red':               ['dark red'],
  'dark red':          ['red', 'reddish brown'],
  'dark purple':       ['dark bluish gray', 'dark blue'],
}

function coloursNear(a: string, b: string): boolean {
  if (a === b) return true
  return NEAR_COLOURS[a]?.includes(b) ?? false
}

/**
 * Compact catalog of the set's parts, sent with each scan so Claude picks
 * from the REAL inventory (multiple-choice) instead of guessing part numbers.
 */
export function buildCatalog(checklist: ChecklistLine[]): string[] {
  const seen = new Set<string>()
  const rows: { line: string; qty: number }[] = []
  for (const l of checklist) {
    if (l.isSpare) continue
    const key = `${l.partNum}|${l.colorName}`
    if (seen.has(key)) continue
    seen.add(key)
    const name = (l.partName || '').replace(/\s+/g, ' ').slice(0, 52)
    rows.push({ line: `${l.partNum} | ${name} | ${l.colorName}`, qty: l.quantityNeeded })
  }
  rows.sort((a, b) => b.qty - a.qty)
  return rows.slice(0, 120).map(r => r.line)
}

function normColor(c: string | null | undefined): string {
  if (!c) return ''
  const k = c.toLowerCase().trim()
  return COLOUR_ALIASES[k] ?? k
}

// ── Matching ─────────────────────────────────────────────────────────────────

interface Lookup {
  byPartColor: Map<string, ChecklistLine[]>   // "part|color" → lines
  byPart:      Map<string, ChecklistLine[]>   // "part"       → lines
}

function buildLookup(checklist: ChecklistLine[]): Lookup {
  const byPartColor = new Map<string, ChecklistLine[]>()
  const byPart      = new Map<string, ChecklistLine[]>()
  for (const line of checklist) {
    const ids = [...(line.bricklinkIds ?? [])]
    if (line.partNum) ids.push(line.partNum)
    const ck = normColor(line.colorName)
    for (const pid of [...ids, ...ids.map(stripVariant)]) {
      if (!pid) continue
      const pcKey = `${pid}|${ck}`
      const pcArr = byPartColor.get(pcKey) ?? byPartColor.set(pcKey, []).get(pcKey)!
      if (!pcArr.includes(line)) pcArr.push(line)
      const pArr = byPart.get(pid) ?? byPart.set(pid, []).get(pid)!
      if (!pArr.includes(line)) pArr.push(line)
    }
  }
  return { byPartColor, byPart }
}

/**
 * Match raw Claude detections against the checklist.
 * Mirrors match_piece() from the old server implementation exactly.
 */
export function matchDetections(
  pieces: RawPiece[],
  checklist: ChecklistLine[],
): Detection[] {
  const lookup = buildLookup(checklist)
  const scanCounts = new Map<string, number>()

  return pieces.map(piece => {
    const pn = piece.part_num
    let status: DetectionStatus = 'unknown'
    let matches: ChecklistLine[] = []

    if (pn) {
      const ck   = normColor(piece.color)
      let rows = lookup.byPartColor.get(`${pn}|${ck}`)
              ?? lookup.byPartColor.get(`${stripVariant(pn)}|${ck}`)
              ?? []
      // Near-colour rescue: the part number is exact (Brickognize-backed).
      // If exactly ONE of the colours this set stocks that part in is a
      // known confusion-pair of the colour we saw → match that line.
      if (!rows.length) {
        const partRows = lookup.byPart.get(pn) ?? lookup.byPart.get(stripVariant(pn)) ?? []
        const colours = Array.from(new Set(partRows.map(r => normColor(r.colorName))))
        const nearCols = colours.filter(c => coloursNear(ck, c))
        if (nearCols.length === 1) {
          rows = partRows.filter(r => normColor(r.colorName) === nearCols[0])
        }
      }
      if (rows.length) {
        const needed = rows.filter(r =>
          (scanCounts.get(r.lineId) ?? 0) + (r.quantityFound ?? 0) < (r.quantityNeeded ?? 0))
        if (needed.length) {
          const lid = needed[0].lineId
          scanCounts.set(lid, (scanCounts.get(lid) ?? 0) + 1)
          status = 'needed'; matches = needed
        } else {
          status = 'have_enough'; matches = rows
        }
      } else {
        const partRows = lookup.byPart.get(pn)
                      ?? lookup.byPart.get(stripVariant(pn))
                      ?? []
        if (partRows.length) { status = 'wrong_color'; matches = partRows }
        else                 { status = 'not_in_set' }
      }
    }

    return {
      partNum:    pn,
      color:      piece.color,
      name:       pn ? (PART_NAMES[pn] ?? null) : null,
      confidence: piece.confidence ?? 'none',
      bboxPct:    piece.bbox_pct ?? [0, 0, 1, 1],
      status,
      checklistMatches: matches.map(m => ({
        lineId:         m.lineId,
        colorName:      m.colorName ?? '',
        quantityNeeded: m.quantityNeeded ?? 0,
        quantityFound:  m.quantityFound ?? 0,
      })),
    }
  })
}

// ── Single-brick live mode ───────────────────────────────────────────────────

export interface BKCandidate { part_num: string; score: number }

export interface SingleResult {
  status: DetectionStatus
  line: ChecklistLine | null
  partNum: string | null
  colourDist: number          // weighted RGB distance to the matched line's colour
  score: number               // Brickognize confidence for the chosen part
}

/** Weighted RGB distance (green weighted highest, like human vision). */
function rgbDist(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]
  return Math.sqrt((2 * dr * dr + 4 * dg * dg + 3 * db * db) / 9)
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

function linesForPart(partId: string, checklist: ChecklistLine[]): ChecklistLine[] {
  const sid = stripVariant(partId)
  return checklist.filter(l => {
    if (l.isSpare) return false
    const ids = [l.partNum, ...(l.bricklinkIds ?? [])].filter(Boolean) as string[]
    return ids.some(id => id === partId || stripVariant(id) === sid)
  })
}

/**
 * Resolve one Brickognize candidate list + an observed pixel colour against
 * the checklist. Prefers candidates that exist in the set; colour picks the
 * nearest checklist line by true RGB distance.
 */
export function matchSingle(
  candidates: BKCandidate[],
  rgb: [number, number, number] | null,
  checklist: ChecklistLine[],
): SingleResult {
  if (!candidates.length) {
    return { status: 'unknown', line: null, partNum: null, colourDist: -1, score: 0 }
  }

  // Prefer the best-scoring candidate that's in the set (score ≥ 0.15);
  // otherwise the top candidate overall.
  let chosen = candidates[0]
  let lines  = linesForPart(chosen.part_num, checklist)
  if (!lines.length) {
    for (const c of candidates) {
      if (c.score < 0.15) break
      const ls = linesForPart(c.part_num, checklist)
      if (ls.length) { chosen = c; lines = ls; break }
    }
  }

  if (!lines.length) {
    return {
      status: chosen.score >= 0.35 ? 'not_in_set' : 'unknown',
      line: null, partNum: chosen.part_num, colourDist: -1, score: chosen.score,
    }
  }

  // Colour: nearest line by RGB (or the first still-needed line if no colour)
  let line = lines[0]
  let dist = -1
  if (rgb) {
    let best = Infinity
    for (const l of lines) {
      const lrgb = hexToRgb(l.colorRgb)
      if (!lrgb) continue
      const d = rgbDist(rgb, lrgb)
      if (d < best) { best = d; line = l }
    }
    dist = best === Infinity ? -1 : best
  } else {
    line = lines.find(l => l.quantityFound < l.quantityNeeded) ?? lines[0]
  }

  // Very far from every colour the set stocks this part in → wrong colour
  // (e.g. a blue 3001 when the set only has it in red).
  // Threshold 115: benchmarked — white pieces under shading measure d97-105
  // while genuine cross-colour mismatches sit at d17-45 or d140+.
  if (dist >= 0 && dist > 115) {
    return { status: 'wrong_color', line, partNum: chosen.part_num, colourDist: dist, score: chosen.score }
  }

  const status: DetectionStatus =
    line.quantityFound < line.quantityNeeded ? 'needed' : 'have_enough'
  return { status, line, partNum: chosen.part_num, colourDist: dist, score: chosen.score }
}

// ── Summary ──────────────────────────────────────────────────────────────────

export function summarize(detections: Detection[]) {
  const c = { needed: 0, haveEnough: 0, wrongColor: 0, notInSet: 0, unknown: 0 }
  for (const d of detections) {
    if      (d.status === 'needed')      c.needed++
    else if (d.status === 'have_enough') c.haveEnough++
    else if (d.status === 'wrong_color') c.wrongColor++
    else if (d.status === 'not_in_set')  c.notInSet++
    else                                 c.unknown++
  }
  return { totalDetected: detections.length, ...c }
}
