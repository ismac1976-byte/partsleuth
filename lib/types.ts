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
  bricklinkIds: string[]   // Used to match Brickognize output
  colorId: number
  colorName: string
  colorRgb: string
  quantityNeeded: number
  quantityFound: number
  isSpare: boolean
  elementId: string
}

export interface Detection {
  box: [number, number, number, number]   // x1, y1, x2, y2
  status: 'needed' | 'have_enough' | 'not_in_set' | 'unknown'
  topCandidate: { id: string; name: string; score: number } | null
  candidates: { id: string; name: string; score: number }[]
  checklistMatches: {
    lineId: string
    colorName: string
    quantityNeeded: number
    quantityFound: number
  }[]
}

export interface ScanResult {
  annotatedImageB64: string
  detections: Detection[]
  summary: {
    totalDetected: number
    needed: number
    haveEnough: number
    notInSet: number
    unknown: number
  }
}
