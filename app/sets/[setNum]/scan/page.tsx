'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { collection, onSnapshot, doc, updateDoc, increment } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useParams } from 'next/navigation'
import type { ChecklistLine, ScanResult, Detection, DetectionStatus } from '@/lib/types'
import Link from 'next/link'

type ScanState = 'idle' | 'processing' | 'result' | 'error'

// ── API format helpers ───────────────────────────────────────────────────────

function lineToApiFormat(l: ChecklistLine) {
  return {
    line_id:         l.lineId,
    part_num:        l.partNum,
    bricklink_ids:   l.bricklinkIds,
    color_id:        l.colorId,
    color_name:      l.colorName,
    quantity_needed: l.quantityNeeded,
    quantity_found:  l.quantityFound,
  }
}

function mapDetection(d: Record<string, any>): Detection {
  return {
    partNum:    d.part_num    ?? null,
    color:      d.color       ?? null,
    name:       d.name        ?? null,
    confidence: d.confidence  ?? 'none',
    bboxPct:    d.bbox_pct    ?? [0, 0, 1, 1],
    status:     d.status      ?? 'unknown',
    checklistMatches: (d.checklist_matches ?? []).map((m: any) => ({
      lineId:         m.line_id,
      colorName:      m.color_name,
      quantityNeeded: m.quantity_needed,
      quantityFound:  m.quantity_found,
    })),
  }
}

// ── Status config ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<DetectionStatus, {
  dot: string; card: string; label: string; emoji: string
}> = {
  needed:      { dot: 'bg-green-500',  card: 'border-green-200 bg-green-50',   label: 'Needed',       emoji: '🟢' },
  have_enough: { dot: 'bg-yellow-400', card: 'border-yellow-200 bg-yellow-50', label: 'Have enough',  emoji: '🟡' },
  wrong_color: { dot: 'bg-orange-400', card: 'border-orange-200 bg-orange-50', label: 'Wrong colour', emoji: '🟠' },
  not_in_set:  { dot: 'bg-gray-300',   card: 'border-gray-200',                label: 'Not in set',   emoji: '⚫' },
  unknown:     { dot: 'bg-red-500',    card: 'border-red-200 bg-red-50',       label: 'Unknown',      emoji: '🔴' },
}

const CONFIDENCE_BADGE: Record<string, string> = {
  high:   '',
  medium: '~',
  low:    '?',
  none:   '??',
}
