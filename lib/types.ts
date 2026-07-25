// PartSleuth shared types

export interface PSSet {
  setNum: string           // e.g. "60197-1"
  name: string             // e.g. "Passenger Train"
  year: number
  totalParts: number
  imageUrl: string
  status: 'active' | 'complete' | 'archived'
  addedAt: number          // Unix ms
}

export interface ChecklistLine {
  lineId: string           // "{partNum}_{colorId}"
  partNum: string
  partName: string
  partImgUrl: string
  bricklinkIds: string[]
  colorId: number
  colorName: string
  colorRgb: string
  quantityNeeded: number
  quantityFound: number
  isSpare: boolean
  elementId: string
}

// Detection statuses (v2 — Claude Vision pipeline)
// needed      🟢  piece is in the set and still required
// have_enough 🟡  piece is in the set but you already have enough
// wrong_color 🟠  right shape, wrong color
// not_in_set  ⚫  identified but not needed for this set
// unknown     🔴  piece detected but could not be identified
export type DetectionStatus =
  | 'needed'
  | 'have_enough'
  | 'wrong_color'
  | 'not_in_set'
  | 'unknown'

export interface Detection {
  // From Claude Vision
  partNum:    string | null
  color:      string | null
  name:       string | null
  confidence: 'high' | 'medium' | 'low' | 'none'
  bboxPct:    [number, number, number, number]  // x1,y1,x2,y2 as 0–1 fractions

  // From checklist matching
  status: DetectionStatus
  checklistMatches: {
    lineId:         string
    colorName:      string
    quantityNeeded: number
    quantityFound:  number
  }[]
}

export interface ScanResult {
  annotatedImageB64: string
  detections: Detection[]
  summary: {
    totalDetected: number
    needed:        number
    haveEnough:    number
    wrongColor:    number
    notInSet:      number
    unknown:       number
  }
}
