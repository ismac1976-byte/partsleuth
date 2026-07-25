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
  'brown': 'reddish brown',            'dark brown': 'reddish brown',
  'lime green': 'lime',                'light green': 'lime',
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
    for (const pid of ids) {
      if (!pid) continue
      const pcKey = `${pid}|${ck}`
      ;(byPartColor.get(pcKey) ?? byPartColor.set(pcKey, []).get(pcKey)!).push(line)
      ;(byPart.get(pid)        ?? byPart.set(pid, []).get(pid)!).push(line)
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
      const rows = lookup.byPartColor.get(`${pn}|${ck}`) ?? []
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
        const partRows = lookup.byPart.get(pn) ?? []
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
