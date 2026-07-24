'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { collection, onSnapshot, doc, updateDoc, increment } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useParams } from 'next/navigation'
import type { ChecklistLine, ScanResult, Detection } from '@/lib/types'
import Link from 'next/link'

type ScanState = 'idle' | 'processing' | 'result' | 'error'

// Convert camelCase ChecklistLine → snake_case for scan API
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

// Map snake_case detection response → camelCase Detection
function mapDetection(d: Record<string, any>): Detection {
  return {
    box:    d.box,
    status: d.status,
    topCandidate: d.top_candidate
      ? { id: d.top_candidate.id, name: d.top_candidate.name, score: d.top_candidate.score }
      : null,
    candidates: (d.candidates ?? []).map((c: any) => ({
      id: c.id, name: c.name, score: c.score,
    })),
    checklistMatches: (d.checklist_matches ?? []).map((m: any) => ({
      lineId:         m.line_id,
      colorName:      m.color_name,
      quantityNeeded: m.quantity_needed,
      quantityFound:  m.quantity_found,
    })),
  }
}

export default function ScanPage() {
  const { setNum } = useParams<{ setNum: string }>()
  const fileRef = useRef<HTMLInputElement>(null)

  const [checklist, setChecklist] = useState<ChecklistLine[]>([])
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [result, setResult]       = useState<ScanResult | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [errorMsg, setErrorMsg]   = useState('')

  // Subscribe to checklist (need live quantityFound values)
  useEffect(() => {
    return onSnapshot(collection(db, 'sets', setNum, 'checklist'), snap => {
      setChecklist(snap.docs.map(d => d.data() as ChecklistLine))
    })
  }, [setNum])

  const handleFile = useCallback(async (file: File) => {
    setScanState('processing')
    setResult(null)
    setErrorMsg('')

    // Show preview immediately
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)

    try {
      // Read as base64 (strip data: prefix)
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
          notInSet:      data.summary.not_in_set,
          unknown:       data.summary.unknown ?? 0,
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
    e.target.value = ''   // allow same file to be reselected
  }

  const reset = () => {
    setScanState('idle')
    setResult(null)
    setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
  }

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
              <p className="text-sm text-brand-900/50 mt-1">White cloth or a light table works best</p>
            </div>
            <button
              onClick={() => fileRef.current?.click()}
              className="btn-primary px-10 py-4 text-lg"
            >
              Take Photo
            </button>
            <p className="text-xs text-brand-900/30">
              Or choose from your camera roll
            </p>
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
                <div className="text-center">
                  <p className="text-white font-semibold text-lg">Identifying bricks…</p>
                  <p className="text-white/60 text-sm mt-1">This can take up to 30 seconds</p>
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
          <div className="rounded-2xl overflow-hidden bg-gray-50">
            <img
              src={`data:image/jpeg;base64,${result.annotatedImageB64}`}
              alt="Scan result"
              className="w-full object-contain"
            />
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-3">
            <StatCard count={result.summary.needed}     label="Found"        color="text-status-needed" />
            <StatCard count={result.summary.haveEnough} label="Have enough"   color="text-status-haveEnough" />
            <StatCard count={result.summary.notInSet}   label="Not in set"   color="text-brand-900/30" />
          </div>

          {/* Legend */}
          <div className="card py-3 flex flex-wrap gap-3 justify-center text-xs text-brand-900/50">
            <LegendDot color="bg-status-needed"     label="Found — counted towards your total" />
            <LegendDot color="bg-status-haveEnough" label="Already have enough" />
            <LegendDot color="bg-gray-200"           label="Not in this set" />
          </div>

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

          {/* Detected parts detail */}
          {result.detections.filter(d => d.topCandidate).length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                Detected parts
              </h2>
              <div className="space-y-2">
                {result.detections
                  .filter(d => d.topCandidate)
                  .map((d, i) => (
                    <div key={i} className={`card flex items-center gap-3 py-2.5
                      ${d.status === 'needed'      ? 'border-green-200 bg-green-50' : ''}
                      ${d.status === 'have_enough' ? 'border-yellow-200 bg-yellow-50' : ''}
                      ${d.status === 'not_in_set'  ? 'border-gray-200' : ''}
                    `}>
                      <StatusDot status={d.status} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {d.topCandidate!.name || d.topCandidate!.id}
                        </p>
                        {d.checklistMatches[0] && (
                          <p className="text-xs text-gray-400">{d.checklistMatches[0].colorName}</p>
                        )}
                      </div>
                      <span className="text-xs text-gray-400 flex-shrink-0">
                        {Math.round(d.topCandidate!.score * 100)}%
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatCard({ count, label, color }: { count: number; label: string; color: string }) {
  return (
    <div className="card text-center py-3">
      <p className={`text-3xl font-bold ${color}`}>{count}</p>
      <p className="text-xs text-gray-400 mt-0.5">{label}</p>
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-3 h-3 rounded-sm ${color} flex-shrink-0`} />
      {label}
    </span>
  )
}

function StatusDot({ status }: { status: Detection['status'] }) {
  const cls =
    status === 'needed'      ? 'bg-green-500'  :
    status === 'have_enough' ? 'bg-yellow-400' :
    status === 'not_in_set'  ? 'bg-gray-300'   : 'bg-gray-200'
  return <span className={`w-3 h-3 rounded-full flex-shrink-0 ${cls}`} />
}

// Increment quantityFound in Firestore for all 'needed' detections
async function persistFinds(setNum: string, detections: Detection[]) {
  // Tally how many of each lineId was spotted as "needed"
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
