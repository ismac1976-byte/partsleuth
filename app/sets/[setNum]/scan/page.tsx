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

// ── Main component ───────────────────────────────────────────────────────────

export default function ScanPage() {
  const { setNum } = useParams<{ setNum: string }>()
  const fileRef    = useRef<HTMLInputElement>(null)
  const imgRef     = useRef<HTMLImageElement>(null)

  const [checklist,   setChecklist]   = useState<ChecklistLine[]>([])
  const [scanState,   setScanState]   = useState<ScanState>('idle')
  const [result,      setResult]      = useState<ScanResult | null>(null)
  const [previewUrl,  setPreviewUrl]  = useState<string | null>(null)
  const [errorMsg,    setErrorMsg]    = useState('')
  const [showOverlay, setShowOverlay] = useState(true)

  // Live checklist subscription
  useEffect(() => {
    return onSnapshot(collection(db, 'sets', setNum, 'checklist'), snap => {
      setChecklist(snap.docs.map(d => d.data() as ChecklistLine))
    })
  }, [setNum])

  // ── Scan handler ──

  const handleFile = useCallback(async (file: File) => {
    setScanState('processing')
    setResult(null)
    setErrorMsg('')

    const url = URL.createObjectURL(file)
    setPreviewUrl(url)

    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload  = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })

      const resp = await fetch('/api/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_b64: b64,
          checklist: checklist.map(lineToApiFormat),
        }),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.error || `Server error ${resp.status}`)
      }

      const data = await resp.json()
      const scanResult: ScanResult = {
        annotatedImageB64: data.annotated_image_b64,
        detections: (data.detections ?? []).map(mapDetection),
        summary: {
          totalDetected: data.summary.total_detected,
          needed:        data.summary.needed,
          haveEnough:    data.summary.have_enough,
          wrongColor:    data.summary.wrong_color  ?? 0,
          notInSet:      data.summary.not_in_set,
          unknown:       data.summary.unknown      ?? 0,
        },
      }

      setResult(scanResult)
      setScanState('result')

      // Persist found counts to Firestore
      await persistFinds(setNum, scanResult.detections)

    } catch (e: any) {
      setErrorMsg(e.message ?? 'Scan failed — please try again')
      setScanState('error')
    }
  }, [checklist, setNum])

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ''
  }

  const reset = () => {
    setScanState('idle')
    setResult(null)
    setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
  }
uctURL(prev); return null })
  }

  // ── Render ──

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 pt-1">
        <Link href={`/sets/${setNum}`} className="btn-ghost text-sm -ml-2">← Back</Link>
        <h1 className="text-2xl font-black text-brand-900">Scan Bricks</h1>
      </div>

      {/* Hidden camera input */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onFileChange}
      />

      {/* ── IDLE ── */}
      {scanState === 'idle' && (
        <div className="space-y-4">
          <div className="card text-center py-12 space-y-5">
            <p className="text-7xl">📷</p>
            <div>
              <p className="font-black text-brand-900 text-xl">Spread bricks on a plain surface</p>
              <p className="text-sm text-brand-900/50 mt-1">
                White cloth or a light table works best.<br />
                Aim to keep bricks separate so each can be identified.
              </p>
            </div>
            <button
              onClick={() => fileRef.current?.click()}
              className="btn-primary px-10 py-4 text-lg"
            >
              Take Photo
            </button>
            <p className="text-xs text-brand-900/30">Or choose from your camera roll</p>
          </div>

          {/* Legend */}
          <div className="card py-3">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2 text-center">
              What the colours mean
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              {(Object.entries(STATUS_CONFIG) as [DetectionStatus, typeof STATUS_CONFIG[DetectionStatus]][])
                .map(([status, cfg]) => (
                  <span key={status} className="flex items-center gap-1.5 text-xs text-brand-900/60">
                    <span className={`w-3 h-3 rounded-sm ${cfg.dot} flex-shrink-0`} />
                    {cfg.label}
                  </span>
                ))}
            </div>
          </div>

          {checklist.length === 0 && (
            <div className="card border-lego-yellow bg-lego-cream text-center py-4">
              <p className="text-sm font-semibold text-brand-900/70">
                ⚠️ Parts list not loaded yet.{' '}
                <Link href={`/sets/${setNum}`} className="text-brand-500 font-bold">Go back</Link>
                {' '}and tap "Load Parts List" first.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── PROCESSING ── */}
      {scanState === 'processing' && (
        <div className="space-y-4">
          {previewUrl && (
            <div className="relative rounded-2xl overflow-hidden">
              <img src={previewUrl} alt="Scanning…"
                   className="w-full object-contain max-h-[60vh] bg-gray-50" />
              <div className="absolute inset-0 flex flex-col items-center justify-center
                              bg-black/50 gap-4">
                <div className="w-12 h-12 border-4 border-white border-t-transparent
                                rounded-full animate-spin" />
                <div className="text-center px-4">
                  <p className="text-white font-semibold text-lg">Identifying bricks…</p>
                  <p className="text-white/60 text-sm mt-1">
                    Claude is scanning every piece in the photo
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── ERROR ── */}
      {scanState === 'error' && (
        <div className="card text-center py-12 space-y-4">
          <p className="text-5xl">❌</p>
          <p className="font-bold text-brand-500">{errorMsg}</p>
          <div className="flex gap-3 justify-center">
            <button onClick={reset} className="btn-primary px-8">Try Again</button>
            <Link href={`/sets/${setNum}`} className="btn-secondary px-8">Back</Link>
          </div>
        </div>
      )}

      {/* ── RESULT ── */}
      {scanState === 'result' && result && (
        <div className="space-y-4">

          {/* Annotated image */}
          <div className="rounded-2xl overflow-hidden bg-gray-50 relative">
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${result.annotatedImageB64}`}
              alt="Scan result"
              className="w-full object-contain"
            />
            {/* Toggle overlay button */}
            <button
              onClick={() => setShowOverlay(v => !v)}
              className="absolute top-3 right-3 bg-black/60 text-white text-xs px-3 py-1.5
                         rounded-full font-medium backdrop-blur-sm"
            >
              {showOverlay ? 'Hide labels' : 'Show labels'}
            </button>
          </div>

          {/* Summary stats */}
          <div className="grid grid-cols-5 gap-2">
            <StatCard count={result.summary.needed}     label="Needed"       dotClass="bg-green-500"  />
            <StatCard count={result.summary.haveEnough} label="Enough"       dotClass="bg-yellow-400" />
            <StatCard count={result.summary.wrongColor} label="Wrong clr"    dotClass="bg-orange-400" />
            <StatCard count={result.summary.notInSet}   label="Not in set"   dotClass="bg-gray-300"   />
            <StatCard count={result.summary.unknown}    label="Unknown"      dotClass="bg-red-500"    />
          </div>

          {/* Unknown pieces callout */}
          {result.summary.unknown > 0 && (
            <div className="card border-red-200 bg-red-50 py-3 text-center">
              <p className="text-sm font-semibold text-red-700">
                🔴 {result.summary.unknown} piece{result.summary.unknown !== 1 ? 's' : ''} couldn't be identified.
              </p>
              <p className="text-xs text-red-500 mt-0.5">
                Check the red boxes — try a clearer photo or better lighting.
              </p>
            </div>
          )}

          {/* Wrong-colour callout */}
          {result.summary.wrongColor > 0 && (
            <div className="card border-orange-200 bg-orange-50 py-3 text-center">
              <p className="text-sm font-semibold text-orange-700">
                🟠 {result.summary.wrongColor} piece{result.summary.wrongColor !== 1 ? 's' : ''} — right shape, wrong colour.
              </p>
              <p className="text-xs text-orange-500 mt-0.5">
                These exist in your set but in a different colour.
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button onClick={reset} className="btn-secondary flex-1 text-base py-3.5">
              📷 Scan Another
            </button>
            <Link href={`/sets/${setNum}/missing`}
                  className="btn-primary flex-1 text-center text-base py-3.5">
              View Missing
            </Link>
          </div>

          {/* Detected parts list */}
          {result.detections.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                All detected pieces ({result.detections.length})
              </h2>
              <div className="space-y-2">
                {result.detections.map((d, i) => {
                  const cfg = STATUS_CONFIG[d.status]
                  const badge = CONFIDENCE_BADGE[d.confidence] ?? '??'
                  const displayName = d.name
                    || (d.status === 'unknown' ? 'Could not identify' : d.partNum || '—')

                  return (
                    <div key={i} className={`card flex items-center gap-3 py-2.5 ${cfg.card}`}>
                      <span className={`w-3 h-3 rounded-full flex-shrink-0 ${cfg.dot}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {badge && (
                            <span className="text-xs font-bold text-gray-400 mr-1">{badge}</span>
                          )}
                          {displayName}
                        </p>
                        <p className="text-xs text-gray-400">
                          {d.partNum ? `Part ${d.partNum}` : 'Unknown part'}
                          {d.color ? ` · ${d.color}` : ''}
                          {d.checklistMatches[0]?.colorName &&
                           d.checklistMatches[0].colorName !== d.color
                            ? ` (set needs: ${d.checklistMatches[0].colorName})`
                            : ''}
                        </p>
                      </div>
                      <span className="text-xs font-medium text-gray-400 flex-shrink-0">
                        {cfg.label}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Empty state */}
          {result.detections.length === 0 && (
            <div className="card text-center py-8 space-y-2">
              <p className="text-3xl">🔍</p>
              <p className="font-semibold text-brand-900/70">No pieces detected</p>
              <p className="text-sm text-brand-900/40">
                Try spreading bricks further apart on a plain, well-lit surface.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  count, label, dotClass
}: { count: number; label: string; dotClass: string }) {
  return (
    <div className="card text-center py-2.5 px-1">
      <div className="flex items-center justify-center gap-1 mb-0.5">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <p className="text-2xl font-bold text-brand-900">{count}</p>
      </div>
      <p className="text-[10px] text-gray-400 leading-tight">{label}</p>
    </div>
  )
}

// ── Firestore persistence ────────────────────────────────────────────────────

async function persistFinds(setNum: string, detections: Detection[]) {
  // Only persist 'needed' detections (those actively counted towards the total)
  const counts: Record<string, number> = {}
  for (const det of detections) {
    if (det.status === 'needed' && det.checklistMatches.length > 0) {
      const lineId = det.checklistMatches[0].lineId
      counts[lineId] = (counts[lineId] ?? 0) + 1
    }
  }
  if (!Object.keys(counts).length) return

  await Promise.all(
    Object.entries(counts).map(([lineId, count]) =>
      updateDoc(doc(db, 'sets', setNum, 'checklist', lineId), {
        quantityFound: increment(count),
      })
    )
  )
}
